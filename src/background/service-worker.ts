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

import { formatNote, generateNote, spentOf } from "../lib/notegen";
import { appendLog, type LogEntry } from "../lib/capture-log";
import { isNamedError, NamedError } from "../lib/errors";
import { DEFAULT_PRESET_ID, type ProviderConfig } from "../lib/providers";
import { appendNote, localDay } from "../lib/notes-store";
import { writeDayFile } from "./local-sink";
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

    // A failed disk write is a warning, not a failed capture: the note is safe
    // and GoogleDocsSink (step 6) will be the canonical destination anyway.
    let warning: string | undefined;
    try {
      await writeDayFile(notes, day);
    } catch (cause) {
      warning = isNamedError(cause) ? cause.userMessage : "Couldn't write the local copy";
      console.error("[heystop] LocalWriteFailed", cause);
    }

    // Logged before the toast: the toast can fail on a closed tab, and losing
    // the confirmation must not also lose the record that the capture happened.
    await logCapture(warning ? "LocalWriteFailed" : "ok", { usage, model });

    await toast(tabId, {
      state: warning ? "error" : "success",
      text: warning ?? "Noted",
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

/** Captures completed today. This is the dogfooding instrument, not decoration. */
async function bumpCount(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
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
