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

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as InterceptorMessage | undefined;
  if (data?.source !== "heystop" || data.kind !== "cues") return;
  ingest(data.cues);
  console.debug(`[heystop] ${data.cues.length} cues in, ${cueIndex.size} held`);
});

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
      sendResponse({ ok: false, reason: "CaptionsUnavailable" });
      showToast("error", "No captions on this video");
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
      },
    });
    return;
  }
});

console.debug("[heystop] content script ready");
