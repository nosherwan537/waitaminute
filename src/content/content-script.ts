/**
 * Isolated-world content script. Owns the cue list.
 *
 * The cues live here rather than in the service worker because MV3 kills the
 * worker after ~30s idle and would take the transcript with it. This script
 * lives as long as the tab does, which is exactly the lifetime we need: the
 * user might load a lecture and not press the hotkey for an hour.
 */

import { slice, evictOldCues, deepLink } from "../lib/slice";
import { WINDOWS, type Cue, type InterceptorMessage, type ToastMessage, type CommandName } from "../types";
import { showToast } from "./toast";

/** Keyed by cue start time, so re-fetching the same track doesn't duplicate text. */
const cueIndex = new Map<number, Cue>();

/** Language of the track the cues came from. Decides whether the note gets translated. */
let trackLanguage: { code?: string; name?: string } = {};

/**
 * Null until the interceptor has read the player response.
 *
 * The three states are genuinely different and the user deserves to be told
 * which one they are in:
 *   null  — still loading. Pressing the key this early is a timing miss.
 *   true  — a track exists. If cues are empty, something went wrong fetching it.
 *   false — this video has no captions at all. Nothing to wait for, and the
 *           only real fix is the audio path (PLAN.md step 11).
 */
let captionsAvailable: boolean | null = null;

/** Bound memory: 30 minutes of cues. The longest window a hotkey can ask for is 240s. */
const RETAIN_SECONDS = 1800;

function currentVideo(): HTMLVideoElement | null {
  const videos = Array.from(document.querySelectorAll("video"));
  // The one that's actually playing beats the one that merely exists (ads, previews).
  return videos.find((v) => !v.paused && v.currentTime > 0) ?? videos[0] ?? null;
}

function ingest(cues: Cue[]): void {
  for (const c of cues) cueIndex.set(c.start, c);

  const video = currentVideo();
  if (!video) return;
  const kept = evictOldCues([...cueIndex.values()], video.currentTime, RETAIN_SECONDS);
  if (kept.length !== cueIndex.size) {
    cueIndex.clear();
    for (const c of kept) cueIndex.set(c.start, c);
  }
}

/**
 * SECURITY: this listener trusts a shape, not a sender. Any script on the page
 * can post `{source:"heystop", kind:"cues"}` and inject fake cue text, which
 * would end up in a note. The blast radius is one junk note the user can delete
 * — the same bounded risk PLAN.md already accepts for caption text itself, since
 * anyone can upload a video with hostile subtitles. It is NOT a code-execution
 * path: cues are only ever read as text and rendered escaped.
 */
window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as InterceptorMessage | undefined;
  if (data?.source !== "heystop") return;

  if (data.kind === "captions-status") {
    captionsAvailable = data.available;
    return;
  }

  if (data.kind !== "cues") return;
  if (data.language) trackLanguage = { code: data.language, name: data.languageName };
  ingest(data.cues);
  console.debug(
    `[heystop] ${data.cues.length} cues in (${trackLanguage.name ?? "?"}), ${cueIndex.size} held`,
  );
});

/** SPA navigation: drop the previous video's transcript before the next capture. */
function resetForNewVideo(): void {
  cueIndex.clear();
  trackLanguage = {};
  captionsAvailable = null;
}

let lastHref = location.href;
setInterval(() => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    resetForNewVideo();
  }
}, 1000);

/** Debounce so a double-press doesn't fire two captures (and two API calls). */
let lastCapture = 0;
const DEBOUNCE_MS = 2000;

chrome.runtime.onMessage.addListener((msg: { kind: string; command?: CommandName } | ToastMessage, _sender, sendResponse) => {
  if (msg.kind === "toast") {
    const t = msg as ToastMessage;
    showToast(t.state, t.text, t.count);
    return;
  }

  if (msg.kind === "requestSlice") {
    const command = (msg as { command: CommandName }).command;

    const now = Date.now();
    if (now - lastCapture < DEBOUNCE_MS) {
      sendResponse({ ok: false, reason: "Debounced" });
      showToast("info", "Already capturing that");
      return;
    }
    lastCapture = now;

    const video = currentVideo();
    if (!video) {
      sendResponse({ ok: false, reason: "NoVideo" });
      showToast("error", "No video on this page");
      return;
    }

    if (cueIndex.size === 0) {
      // Three different situations, three different things worth saying. Lumping
      // them together is how a tool teaches users to distrust its messages.
      if (captionsAvailable === false) {
        sendResponse({ ok: false, reason: "CaptionsUnavailable" });
        showToast("error", "This video has no captions");
      } else if (captionsAvailable === null) {
        sendResponse({ ok: false, reason: "CaptionsUnavailable" });
        showToast("info", "Still loading captions — try again in a second");
      } else {
        sendResponse({ ok: false, reason: "CaptionsUnavailable" });
        showToast("error", "Couldn't read this video's captions");
      }
      return;
    }

    const result = slice([...cueIndex.values()], video.currentTime, WINDOWS[command]);
    if (result.isEmpty) {
      sendResponse({ ok: false, reason: "EmptySlice" });
      showToast("info", "Nothing said in that window");
      return;
    }

    showToast("processing", "Noting that...");
    sendResponse({
      ok: true,
      slice: {
        text: result.text,
        startSec: result.startSec,
        endSec: result.endSec,
        videoTitle: document.title.replace(/ - YouTube$/, ""),
        videoUrl: location.href.split("&t=")[0] ?? location.href,
        deepLink: deepLink(location.href, result.startSec),
        language: trackLanguage.code,
        languageName: trackLanguage.name,
      },
    });
    return;
  }
});

console.debug("[heystop] content script ready");
