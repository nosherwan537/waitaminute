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

function publish(cues: Cue[]): void {
  if (cues.length === 0) return;
  const msg: InterceptorMessage = { source: "heystop", kind: "cues", cues };
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
XMLHttpRequest.prototype.open = function (
  method: string,
  url: string | URL,
  ...rest: unknown[]
) {
  if (isCaptionUrl(String(url))) {
    this.addEventListener("load", () => {
      if (typeof this.responseText === "string") publish(parseJson3(this.responseText));
    });
  }
  // eslint-disable-next-line prefer-rest-params
  return nativeOpen.apply(this, arguments as never);
} as typeof XMLHttpRequest.prototype.open;

// ── B) Active fetch ─────────────────────────────────────────────────────────

interface PlayerResponse {
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: Array<{ baseUrl?: string; languageCode?: string; kind?: string }>;
    };
  };
}

function pickTrack(pr: PlayerResponse): string | null {
  const tracks = pr.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (tracks.length === 0) return null;
  // Prefer a manually authored English track; auto-generated ("asr") is the fallback
  // because it has no punctuation and mangles technical terms.
  const manual = tracks.find((t) => t.kind !== "asr" && t.languageCode?.startsWith("en"));
  const anyManual = tracks.find((t) => t.kind !== "asr");
  return (manual ?? anyManual ?? tracks[0])?.baseUrl ?? null;
}

async function fetchTrack(baseUrl: string): Promise<void> {
  const url = new URL(baseUrl);
  url.searchParams.set("fmt", "json3");
  try {
    const res = await nativeFetch(url.toString());
    if (!res.ok) return;
    publish(parseJson3(await res.text()));
  } catch {
    /* no captions is a normal state, not an error worth surfacing here */
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
    }
    const pr = (window as unknown as { ytInitialPlayerResponse?: PlayerResponse })
      .ytInitialPlayerResponse;
    const baseUrl = pr ? pickTrack(pr) : null;
    if (baseUrl) {
      void fetchTrack(baseUrl);
      tries = 40; // found it; idle until the next navigation
      return;
    }
    tries += 1;
  };

  setInterval(() => {
    if (tries < 40) tick();
    else if (location.href !== lastUrl) {
      lastUrl = location.href;
      tries = 0;
    }
  }, 500);
}

watchForPlayerResponse();
