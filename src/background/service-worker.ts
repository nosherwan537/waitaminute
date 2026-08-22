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
import { readSites, shouldHaveContentScript, syncContentScripts } from "./site-registry";
import { captureFrame } from "./frame-capture";
import type { ViewportInfo } from "../lib/frame";
import { armTab, armedTab, audioSlice, disarm, wavBlob } from "./audio-capture";
import { resolveTranscription, transcribe } from "../lib/providers";
import { WINDOWS } from "../types";
import type { CommandName, TranscriptSlice, ToastMessage } from "../types";

type SliceResponse =
  | { ok: true; slice: TranscriptSlice; viewport?: ViewportInfo }
  | { ok: false; reason: string };

function isCommand(name: string): name is CommandName {
  return name === "capture-now" || name === "capture-previous" || name === "capture-long";
}

async function toastTo(tabId: number, msg: Omit<ToastMessage, "kind">): Promise<void> {
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

/**
 * Is the optional frame capture (PLAN.md step 12) switched on?
 *
 * OFF by default, deliberately. It photographs the visible tab before cropping
 * to the player, and it sends that picture to whichever model provider the user
 * chose. Neither is something to start doing on a user's behalf — it has to be a
 * decision they made on the options page, having read what it does.
 */
async function frameCaptureEnabled(): Promise<boolean> {
  const { frameCapture } = (await chrome.storage.local.get("frameCapture")) as {
    frameCapture?: boolean;
  };
  return frameCapture === true;
}

/** Errors whose only fix is on the options page. Opening it IS the useful action. */
const OPENS_OPTIONS = new Set(["ApiKeyMissing", "ApiKeyInvalid", "ModelNotFound"]);

/**
 * Say "reload this page" from the service worker side, because the content
 * script that would have shown a toast is the thing that died.
 *
 * A badge rather than a notification: it needs no extra permission, it cannot
 * steal focus from the video, and Chrome clears per-tab badge text on
 * navigation — so the warning disappears exactly when the reload fixes it.
 *
 * Re-injecting automatically is NOT the fix. YouTube's interceptor must run at
 * `document_start` to see the caption fetches, so a script injected mid-page
 * would answer the next hotkey with an empty buffer: a capture that fails for a
 * second, more confusing reason.
 */
async function flagStalePage(
  tabId: number,
  command: CommandName,
  videoTitle: string,
): Promise<void> {
  console.warn("[heystop] PageNeedsReload", "content script is stale; reload the tab");
  // AGENTS.md: every failure path reaches the log, or it is invisible during
  // dogfooding. This one especially — how often an extension reload silently
  // costs a capture is a number worth having.
  await appendLog({
    id: Date.now(),
    command,
    source: "captions",
    latencyMs: 0,
    outcome: "PageNeedsReload",
    model: "",
    videoTitle,
  });
  try {
    await chrome.action.setBadgeText({ tabId, text: "!" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#b3261e" });
    await chrome.action.setTitle({ tabId, title: "heystop: reload this page to reconnect" });
  } catch {
    // The tab closed between the failed sendMessage and here. Nothing to warn.
  }
}

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
    // Two very different cases arrive here as the same rejection, and treating
    // them alike is what made the hotkey do nothing at all after an extension
    // reload — no toast, no log, premise 8 broken.
    //
    // A page the extension has no business on is correct and stays silent. A
    // page it IS registered for means the content script is dead: reloading an
    // unpacked extension orphans every script already running in an open tab.
    if (shouldHaveContentScript(tab.url, await readSites())) {
      await flagStalePage(tabId, command, tab.title ?? "");
    }
    return;
  }

  // CaptionsUnavailable is the one refusal worth overriding: it is exactly the
  // case PLAN.md step 11 exists for. Every other refusal (debounced, no video,
  // empty window) is correct and already toasted.
  let slice: TranscriptSlice;
  // Where the player sits, for the optional frame. Absent on the audio path,
  // which has no picture by definition.
  let viewport: ViewportInfo | undefined;
  if (response?.ok) {
    slice = response.slice;
    viewport = response.viewport;
  } else if (response?.reason === "CaptionsUnavailable" && (await armedTab()) === tabId) {
    const fromAudio = await sliceFromAudio(tabId, command);
    if (!fromAudio) return; // sliceFromAudio toasted the reason
    slice = fromAudio;
  } else {
    return;
  }

  // Started before the provider call so the log measures what the user feels:
  // press to outcome, retries and disk write included.
  const startedAt = Date.now();
  const logCapture = (
    outcome: string,
    spent: { usage?: LogEntry["usage"]; model: string } | undefined,
    frameUsed = false,
  ) =>
    appendLog({
      ...(frameUsed ? { frame: true as const } : {}),
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

    // Captions come first and the frame is a bonus, so this is the one place
    // allowed to be slow-ish and the one place allowed to give up quietly.
    // `captureFrame` never throws; `viewport` is absent on the audio path,
    // which has no picture by definition.
    const frame =
      viewport && tab.windowId !== undefined && (await frameCaptureEnabled())
        ? await captureFrame(tab.windowId, viewport)
        : undefined;

    const { note, usage, model, frameUsed } = await generateNote(config, slice, frame);

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
    await logCapture(problem?.name ?? "ok", { usage, model }, frameUsed);

    await toastTo(tabId, {
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
    await toastTo(tabId, {
      state: named.name_ === "NothingToNote" ? "info" : "error",
      text: named.userMessage,
    });

    if (OPENS_OPTIONS.has(named.name_)) chrome.runtime.openOptionsPage();
  }
});

/**
 * Transcribe the last N seconds of tab audio into a slice.
 *
 * Same `TranscriptSlice` shape the caption path produces, which is the whole
 * point of the abstraction: everything downstream — the prompt, the note format,
 * both sinks, the capture log — was written once and does not know which source
 * it is looking at.
 */
async function sliceFromAudio(
  tabId: number,
  command: CommandName,
): Promise<TranscriptSlice | undefined> {
  const spec = WINDOWS[command];
  try {
    await toastTo(tabId, { state: "processing", text: "No captions — using audio..." });

    const audio = await audioSlice(tabId, spec.back, spec.length);
    const config = await loadConfig();
    const text = await transcribe(resolveTranscription(config), wavBlob(audio.wavBase64));

    const tab = await chrome.tabs.get(tabId);
    const url = tab.url ?? "";
    // The ring holds the last N seconds of REAL TIME, which is the playhead only
    // while the video plays at 1x and never buffers. Timestamps from the audio
    // path are therefore approximate, and the deep link is a best effort — worth
    // having, not worth trusting to the second.
    const endSec = Math.max(0, audio.seconds);
    return {
      text,
      startSec: 0,
      endSec,
      videoTitle: (tab.title ?? "Untitled").replace(/\s*[-|·—]\s*(YouTube|Vimeo)\s*$/i, ""),
      videoUrl: url,
      deepLink: url,
      source: "audio",
    };
  } catch (error) {
    const named: NamedError = isNamedError(error)
      ? error
      : new NamedError("CaptionsUnavailable", "Couldn't capture audio", false, error);
    console.error(`[heystop] ${named.name_}`, named.userMessage, named.cause ?? "");
    await toastTo(tabId, { state: "error", text: named.userMessage });
    return undefined;
  }
}

/** Arm/disarm audio for a tab. The click IS the user gesture the API requires. */
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  const tabId = tab.id;

  if ((await armedTab()) === tabId) {
    await disarm();
    await toastTo(tabId, { state: "info", text: "Audio capture off" });
    return;
  }

  try {
    await armTab(tabId);
    // Honest about the platform limit: only one offscreen document may exist,
    // so arming this tab took audio away from any other.
    await toastTo(tabId, { state: "success", text: "Audio capture on for this tab" });
  } catch (error) {
    const text = isNamedError(error) ? error.userMessage : "Couldn't capture this tab's audio";
    console.error("[heystop] armTab", error);
    await toastTo(tabId, { state: "error", text });
  }
});

/** The armed tab closing must release the capture, or the indicator never clears. */
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if ((await armedTab()) === tabId) await disarm();
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

// Runtime-registered content scripts survive a browser restart via
// `persistAcrossSessions`, but not an extension update or a permission the user
// revoked from Chrome's own UI. Re-syncing on both events is what keeps the
// stored site list and the actually-registered scripts from drifting apart.
chrome.runtime.onStartup.addListener(() => void syncContentScripts());
chrome.runtime.onInstalled.addListener(() => void syncContentScripts());
chrome.permissions.onRemoved.addListener(() => void syncContentScripts());

console.debug("[heystop] service worker ready");
