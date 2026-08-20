/**
 * Service worker. Stateless by design: MV3 kills it after ~30s idle, so it
 * holds nothing that must survive. It asks the content script for a slice on
 * each hotkey press and orchestrates what happens next.
 *
 * SECURITY: this is the ONLY context allowed to touch the user's API key. Never
 * pass it toward the content script, and never toward the MAIN world (see
 * interceptor.ts). Everything the key touches happens inside this file's call
 * into `generateNote`.
 */

import { formatNote, generateNote, spentOf, type Note } from "../lib/notegen";
import { appendLog, type LogEntry } from "../lib/capture-log";
import { isNamedError, NamedError } from "../lib/errors";
import { DEFAULT_PRESET_ID, type ProviderConfig } from "../lib/providers";
import { appendNote, localDay } from "../lib/notes-store";
import { writeDayFile } from "./local-sink";
import { appendToDoc, readDocRef } from "./docs-sink";
import { isConfigured } from "./google-auth";
import type { CommandName, TranscriptSlice, ToastMessage } from "../types";

type SliceResponse =
  | { ok: true; slice: TranscriptSlice }
  | { ok: false; reason: string };

function isCommand(name: string): name is CommandName {
  return name === "capture-now" || name === "capture-previous" || name === "capture-long";
}

async function toast(tabId: number, msg: Omit<ToastMessage, "kind">): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { kind: "toast", ...msg } satisfies ToastMessage);
  } catch {
    // Tab closed or navigated away mid-capture. The note still lands; only the
    // confirmation is lost. That is the correct trade.
  }
}

/** Provider settings, with the defaults a fresh install starts from. */
async function loadConfig(): Promise<ProviderConfig> {
  const stored = (await chrome.storage.local.get("provider")) as { provider?: ProviderConfig };
  return {
    presetId: DEFAULT_PRESET_ID,
    apiKey: "",
    model: "",
    ...stored.provider,
  };
}

/** Errors whose only fix is on the options page. Opening it IS the useful action. */
const OPENS_OPTIONS = new Set(["ApiKeyMissing", "ApiKeyInvalid", "ModelNotFound"]);

chrome.commands.onCommand.addListener(async (command) => {
  if (!isCommand(command)) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const tabId = tab.id;

  let response: SliceResponse | undefined;
  try {
    response = (await chrome.tabs.sendMessage(tabId, {
      kind: "requestSlice",
      command,
    })) as SliceResponse;
  } catch {
    // No content script here: the extension isn't active on this page.
    return;
  }

  if (!response?.ok) return; // the content script already showed the right toast

  const { slice } = response;

  // Started before the provider call so the log measures what the user feels:
  // press to outcome, retries and disk write included.
  const startedAt = Date.now();
  const logCapture = (
    outcome: string,
    spent: { usage?: LogEntry["usage"]; model: string } | undefined,
  ) =>
    appendLog({
      id: startedAt,
      command,
      source: slice.source ?? "captions",
      latencyMs: Date.now() - startedAt,
      outcome,
      usage: spent?.usage,
      model: spent?.model ?? "",
      videoTitle: slice.videoTitle,
    });

  try {
    const config = await loadConfig();
    const { note, usage, model } = await generateNote(config, slice);

    // Persist BEFORE writing the file. Storage is the source of truth, so from
    // this line on the note cannot be lost — only the file can be out of date,
    // and the next capture repairs that.
    const day = localDay();
    const notes = await appendNote({
      id: Date.now(),
      day,
      markdown: formatNote(note, slice),
      videoTitle: slice.videoTitle,
      deepLink: slice.deepLink,
      command,
    });

    // Docs is the canonical destination; the local .md stays the safety net.
    // Both are written, and neither failing loses the note — storage already has it.
    const docFailure = await saveToDoc(note, slice);

    // A failed disk write is a warning, not a failed capture: the note is safe.
    let warning: string | undefined;
    try {
      await writeDayFile(notes, day);
    } catch (cause) {
      warning = isNamedError(cause) ? cause.userMessage : "Couldn't write the local copy";
      console.error("[heystop] LocalWriteFailed", cause);
    }

    // A Docs problem outranks a local one in the toast: Docs is where the user
    // will go looking, and the local copy is the thing that already worked.
    const problem = docFailure ?? (warning ? { name: "LocalWriteFailed", text: warning } : undefined);

    // Logged before the toast: the toast can fail on a closed tab, and losing
    // the confirmation must not also lose the record that the capture happened.
    await logCapture(problem?.name ?? "ok", { usage, model });

    await toast(tabId, {
      state: problem ? "error" : "success",
      text: problem?.text ?? "Noted",
      count: await bumpCount(),
    });
  } catch (error) {
    const named: NamedError = isNamedError(error)
      ? error
      : new NamedError("MalformedNoteResponse", "Something went wrong", false, error);

    // Full detail to the console, one actionable line to the user. Never the
    // reverse: an error the user can't act on is noise, and one they never see
    // is a silent failure.
    console.error(`[heystop] ${named.name_}`, named.userMessage, named.cause ?? "");

    // Every failure is logged, including NothingToNote. That row IS the answer
    // to "does the prompt refuse during ads, or confabulate?" — the question
    // PLAN.md says kills the product quietly if it goes the wrong way. A log of
    // successes only would never show it.
    await logCapture(named.name_, spentOf(named.cause));

    // NothingToNote is a correct outcome, not a failure: the user pressed during
    // an ad or dead air. Say so calmly and write nothing at all.
    await toast(tabId, {
      state: named.name_ === "NothingToNote" ? "info" : "error",
      text: named.userMessage,
    });

    if (OPENS_OPTIONS.has(named.name_)) chrome.runtime.openOptionsPage();
  }
});

/**
 * Write the note to Google Docs. Returns the failure to report, or undefined
 * when there was nothing to do or it worked.
 *
 * JUDGMENT CALL — silence when Google was never connected. The registry maps
 * `NotAuthorized` to "Connect Google to save notes", but firing that on every
 * capture would nag a user who is deliberately running local-only, which is a
 * complete product on its own (PLAN.md step 5 shipped it that way). So the
 * prompt appears only once a doc ref exists: the user opted in, and now
 * something is broken, which IS worth interrupting for.
 */
async function saveToDoc(
  note: Note,
  slice: TranscriptSlice,
): Promise<{ name: string; text: string } | undefined> {
  if (!isConfigured()) return undefined;
  const connected = await readDocRef();
  if (!connected) return undefined;

  try {
    await appendToDoc(note, slice);
    return undefined;
  } catch (cause) {
    const named: NamedError = isNamedError(cause)
      ? cause
      : new NamedError("DocsWriteFailed", "Couldn't write to your doc", false, cause);
    console.error(`[heystop] ${named.name_}`, named.userMessage, named.cause ?? "");
    return { name: named.name_, text: named.userMessage };
  }
}

/** Captures completed today. This is the dogfooding instrument, not decoration. */
async function bumpCount(): Promise<number> {
  // localDay, not toISOString: the counter must roll over at the user's
  // midnight, the same one the day file uses. UTC would reset the count
  // mid-evening for anyone west of Greenwich and disagree with the .md filename.
  const today = localDay();
  const { captureCounts = {} } = (await chrome.storage.local.get("captureCounts")) as {
    captureCounts?: Record<string, number>;
  };
  const next = (captureCounts[today] ?? 0) + 1;
  // Keep 30 days, drop the rest.
  const trimmed = Object.fromEntries(
    Object.entries({ ...captureCounts, [today]: next })
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, 30),
  );
  await chrome.storage.local.set({ captureCounts: trimmed });
  return next;
}

console.debug("[heystop] service worker ready");
