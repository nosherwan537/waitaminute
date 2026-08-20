/**
 * Isolated-world content script. Owns the cue list.
 *
 * The cues live here rather than in the service worker because MV3 kills the
 * worker after ~30s idle and would take the transcript with it. This script
 * lives as long as the tab does, which is exactly the lifetime we need: the
 * user might load a lecture and not press the hotkey for an hour.
 */

import { slice, evictOldCues, deepLinkFor } from "../lib/slice";
import { readTrackCues } from "./track-source";
import {
  WINDOWS,
  type Cue,
  type InterceptorMessage,
  type ToastMessage,
  type CommandName,
  type TranscriptSlice,
} from "../types";
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

/** Strip the site's own suffix so the note heading reads as the lecture's name. */
function videoTitle(): string {
  return document.title.replace(/\s*[-|·—]\s*(YouTube|Vimeo|Coursera|edX)\s*$/i, "").trim();
}

type SliceReply = { ok: true; slice: TranscriptSlice } | { ok: false; reason: string };

/**
 * Produce a slice, or the reason there isn't one.
 *
 * Async because the generic TextTrack source (non-YouTube sites) has to wake a
 * track and wait for its cues. That costs a few hundred milliseconds on the
 * first capture of a page, which premise 7 explicitly makes affordable: the user
 * pressed the key and kept watching.
 */
async function buildSlice(command: CommandName): Promise<SliceReply> {
  const video = currentVideo();
  if (!video) {
    showToast("error", "No video on this page");
    return { ok: false, reason: "NoVideo" };
  }

  let cues = [...cueIndex.values()];
  let language = trackLanguage;

  if (cues.length === 0) {
    // No interceptor cues. Either this is not YouTube, or YouTube's path failed
    // — the DOM reader is worth trying in both cases before giving up.
    const fromTracks = await readTrackCues(video);
    if (fromTracks?.cues.length) {
      cues = fromTracks.cues;
      language = { code: fromTracks.language, name: fromTracks.languageName };
      // Cache it: a lecture's cues do not change, and the second capture on a
      // page should not pay the wake-up cost again.
      for (const cue of cues) cueIndex.set(cue.start, cue);
      trackLanguage = language;
    }
  }

  if (cues.length === 0) {
    // Four different situations, four different things worth saying. Lumping
    // them together is how a tool teaches users to distrust its messages.
    if (captionsAvailable === false) {
      showToast("error", "This video has no captions");
    } else if (captionsAvailable === null && isYouTube()) {
      showToast("info", "Still loading captions — try again in a second");
    } else {
      showToast("error", "Couldn't read this video's captions");
    }
    return { ok: false, reason: "CaptionsUnavailable" };
  }

  const result = slice(cues, video.currentTime, WINDOWS[command]);
  if (result.isEmpty) {
    showToast("info", "Nothing said in that window");
    return { ok: false, reason: "EmptySlice" };
  }

  showToast("processing", "Noting that...");
  return {
    ok: true,
    slice: {
      text: result.text,
      startSec: result.startSec,
      endSec: result.endSec,
      videoTitle: videoTitle(),
      videoUrl: location.href.split("&t=")[0] ?? location.href,
      deepLink: deepLinkFor(location.href, result.startSec),
      language: language.code,
      languageName: language.name,
      source: "captions",
    },
  };
}

function isYouTube(): boolean {
  return location.hostname.endsWith("youtube.com");
}

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

    // `return true` keeps the message channel open for the async reply. Without
    // it Chrome closes the port the moment this listener returns and the service
    // worker's sendMessage resolves with undefined — a capture that silently
    // does nothing.
    void buildSlice(command).then(sendResponse);
    return true;
  }
  return;
});

console.debug("[heystop] content script ready");
