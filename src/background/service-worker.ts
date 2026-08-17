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

import { formatNote, generateNote } from "../lib/notegen";
import { isNamedError, NamedError } from "../lib/errors";
import { DEFAULT_PRESET_ID, type ProviderConfig } from "../lib/providers";
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

  try {
    const config = await loadConfig();
    const note = await generateNote(config, slice);

    // STEP 5 lands here: LocalMdSink, then GoogleDocsSink. Until then, prove the
    // pass end to end by printing exactly what would be written.
    console.log(formatNote(note, slice));

    await toast(tabId, { state: "success", text: "Noted", count: await bumpCount() });
  } catch (error) {
    const named: NamedError = isNamedError(error)
      ? error
      : new NamedError("MalformedNoteResponse", "Something went wrong", false, error);

    // Full detail to the console, one actionable line to the user. Never the
    // reverse: an error the user can't act on is noise, and one they never see
    // is a silent failure.
    console.error(`[heystop] ${named.name_}`, named.userMessage, named.cause ?? "");

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
