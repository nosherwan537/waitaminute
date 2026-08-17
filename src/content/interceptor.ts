/**
 * MAIN-world caption interceptor.
 *
 * SECURITY — read before editing this file:
 *
 *   This script shares a JavaScript context with the page. Anything it holds,
 *   any script on YouTube can read. Therefore:
 *
 *     1. NO API KEY, OAuth token, or user secret may EVER be referenced here.
 *        Those live in the service worker and never cross this boundary.
 *     2. The fetch/XHR patch ALLOWLISTS timedtext URLs. It must never inspect,
 *        buffer, or forward any other response. This page carries the user's
 *        Google session; a blocklist would be a data-exfiltration bug waiting
 *        to happen.
 *
 * Two ways to get cues, because they fail in different situations:
 *
 *   A) Passive intercept  — catch the timedtext response the player fetches.
 *                           Only fires when the user has captions turned ON.
 *   B) Active fetch       — read the caption track URL out of the player
 *                           response and fetch it ourselves. Works with
 *                           captions off, which is the common case.
 */

import type { Cue, InterceptorMessage } from "../types";

const TIMEDTEXT = "/api/timedtext";

/** Strict allowlist. Anything that is not a caption request is none of our business. */
function isCaptionUrl(url: string): boolean {
  try {
    const u = new URL(url, location.origin);
    return u.hostname.endsWith("youtube.com") && u.pathname === TIMEDTEXT;
  } catch {
    return false;
  }
}

/** YouTube's json3 caption format. Events without `segs` are window definitions, not text. */
interface Json3 {
  events?: Array<{
    tStartMs?: number;
    dDurationMs?: number;
    segs?: Array<{ utf8?: string }>;
  }>;
}

function parseJson3(raw: string): Cue[] {
  let data: Json3;
  try {
    data = JSON.parse(raw) as Json3;
  } catch {
    return [];
  }
  const cues: Cue[] = [];
  for (const ev of data.events ?? []) {
    if (!ev.segs || ev.tStartMs === undefined) continue;
    const text = ev.segs
      .map((s) => s.utf8 ?? "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || text === "\n") continue;
    cues.push({
      start: ev.tStartMs / 1000,
      dur: (ev.dDurationMs ?? 0) / 1000,
      text,
    });
  }
  return cues;
}

/** Language of the track currently being fetched, attached to whatever it yields. */
let activeLanguage: { code?: string; name?: string } = {};

function publish(cues: Cue[]): void {
  if (cues.length === 0) return;
  const msg: InterceptorMessage = {
    source: "heystop",
    kind: "cues",
    cues,
    language: activeLanguage.code,
    languageName: activeLanguage.name,
  };
  window.postMessage(msg, location.origin);
}

/** Tell the content script whether this video has any caption track at all. */
function publishStatus(available: boolean): void {
  const msg: InterceptorMessage = { source: "heystop", kind: "captions-status", available };
  window.postMessage(msg, location.origin);
}

// ── A) Passive intercept ────────────────────────────────────────────────────

const nativeFetch = window.fetch;
window.fetch = async function (...args: Parameters<typeof fetch>) {
  const response = await nativeFetch.apply(this, args);
  const url = args[0] instanceof Request ? args[0].url : String(args[0]);
  if (isCaptionUrl(url)) {
    // clone() so the player still gets an unread body.
    response
      .clone()
      .text()
      .then((raw) => publish(parseJson3(raw)))
      .catch(() => {
        /* a failed read must never break the player */
      });
  }
  return response;
};

const nativeOpen = XMLHttpRequest.prototype.open;
// `open` is overloaded (2-arg and 5-arg forms), so type the patch loosely here
// and forward the exact arguments we were handed.
XMLHttpRequest.prototype.open = function (
  this: XMLHttpRequest,
  ...args: [method: string, url: string | URL, ...rest: unknown[]]
): void {
  const url = String(args[1]);
  if (isCaptionUrl(url)) {
    this.addEventListener("load", () => {
      // responseText throws on non-text responseTypes; captions are always text.
      try {
        if (typeof this.responseText === "string") publish(parseJson3(this.responseText));
      } catch {
        /* not a text response after all */
      }
    });
  }
  // Cast past the overload set: we forward exactly what the caller passed.
  (nativeOpen as (...a: unknown[]) => void).apply(this, args);
};

// ── B) Active fetch ─────────────────────────────────────────────────────────

interface CaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  /** "asr" marks an auto-generated track. Anything else was authored by a human. */
  kind?: string;
  name?: { simpleText?: string; runs?: Array<{ text?: string }> };
}

interface PlayerResponse {
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[];
    };
  };
}

/** The track name YouTube shows in its own menu ("Spanish", "English (auto-generated)"). */
function trackName(track: CaptionTrack): string | undefined {
  return (
    track.name?.simpleText ??
    track.name?.runs?.map((r) => r.text ?? "").join("") ??
    track.languageCode
  );
}

/**
 * Choose which caption track to read.
 *
 * Preference order, and why:
 *   1. Human-written English  — punctuated, correct jargon. The best case.
 *   2. Auto-generated English — no punctuation, mangled terms, but it is what
 *                               the speaker said, and repairing it is the model's job.
 *   3. Human-written anything — a Spanish lecture with real subtitles beats
 *                               nothing; the note gets an English translation.
 *   4. Auto-generated anything.
 *
 * Old lectures and small channels frequently have only (4), or nothing at all —
 * which is why a null return has to be distinguishable from "not loaded yet".
 */
function pickTrack(pr: PlayerResponse): CaptionTrack | null {
  const tracks = (pr.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []).filter(
    (t) => t.baseUrl,
  );
  if (tracks.length === 0) return null;

  const isEnglish = (t: CaptionTrack) => t.languageCode?.toLowerCase().startsWith("en");
  const isManual = (t: CaptionTrack) => t.kind !== "asr";

  return (
    tracks.find((t) => isManual(t) && isEnglish(t)) ??
    tracks.find((t) => isEnglish(t)) ??
    tracks.find(isManual) ??
    tracks[0] ??
    null
  );
}

async function fetchTrack(track: CaptionTrack): Promise<void> {
  const url = new URL(track.baseUrl!);
  url.searchParams.set("fmt", "json3");
  // Deliberately NOT setting `tlang`: YouTube's machine translation is worse than
  // the model's, and it would replace the speaker's actual words — the one thing
  // this tool exists to preserve. The original goes in the note; English goes
  // underneath it.
  activeLanguage = { code: track.languageCode, name: trackName(track) };
  try {
    const res = await nativeFetch(url.toString());
    if (!res.ok) return;
    publish(parseJson3(await res.text()));
  } catch {
    /* a failed caption fetch is not worth surfacing; the hotkey path reports it */
  }
}

/** The player response lands on window at document_idle-ish, so poll briefly for it. */
function watchForPlayerResponse(): void {
  let tries = 0;
  let lastUrl = location.href;

  const tick = () => {
    // SPA navigation: YouTube swaps videos without a page load.
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      tries = 0;
      // The next video's language is unknown until its track is picked. Carrying
      // the previous one over would mislabel — and mistranslate — the new note.
      activeLanguage = {};
    }
    const pr = (window as unknown as { ytInitialPlayerResponse?: PlayerResponse })
      .ytInitialPlayerResponse;
    if (!pr) {
      tries += 1; // player response hasn't landed yet; keep waiting
      return;
    }

    const track = pickTrack(pr);
    if (track) {
      void fetchTrack(track);
      publishStatus(true);
      tries = 40; // found it; idle until the next navigation
      return;
    }

    // The player response is here and lists no usable track. That is a fact
    // about the video, not a timing problem — say so once and stop polling.
    publishStatus(false);
    tries = 40;
  };

  setInterval(() => {
    if (tries < 40) tick();
    else if (location.href !== lastUrl) {
      lastUrl = location.href;
      tries = 0;
      // The next video's language is unknown until its track is picked. Carrying
      // the previous one over would mislabel — and mistranslate — the new note.
      activeLanguage = {};
    }
  }, 500);
}

watchForPlayerResponse();
