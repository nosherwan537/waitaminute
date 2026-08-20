import { parseVtt } from "../lib/vtt";
import type { Cue } from "../types";

/**
 * Generic caption source: the native `TextTrack` API.
 *
 * This is the second platform (PLAN.md step 10), and it is deliberately not a
 * second site-specific scraper. YouTube needs a MAIN-world fetch interceptor
 * because its captions arrive through an internal API; every site that uses a
 * plain `<video>` with `<track>` elements — Vimeo, Coursera's web player, MDN,
 * most university course platforms — exposes the same cues through the DOM.
 * One implementation, no reverse engineering, and it runs entirely in the
 * ISOLATED world, so it touches no page JavaScript at all.
 *
 * That difference is the point: if `TranscriptSlice` can be produced by both a
 * network interceptor and a DOM reader without anything downstream noticing,
 * the abstraction is real rather than YouTube-shaped.
 *
 * THE TRAP: reading `track.cues` requires the track be loaded, and a track is
 * only loaded when its mode is not `"disabled"`. The obvious fix — set mode to
 * `"showing"` — burns subtitles onto the user's video, which they did not ask
 * for and cannot easily undo. `"hidden"` loads the cues with no display. Never
 * change this to "showing", and never clobber a mode the user chose themselves.
 */

export interface TrackCues {
  cues: Cue[];
  language?: string;
  languageName?: string;
}

/** Cues a `<track>` may expose. Typed locally: lib.dom's VTTCue is not guaranteed. */
interface ReadableCue {
  startTime?: number;
  endTime?: number;
  text?: string;
}

function toCues(list: ArrayLike<ReadableCue> | null | undefined): Cue[] {
  const out: Cue[] = [];
  for (let i = 0; i < (list?.length ?? 0); i += 1) {
    const cue = list![i]!;
    if (typeof cue.startTime !== "number" || typeof cue.endTime !== "number") continue;
    // The same markup stripping the VTT path does, since cue.text keeps its tags.
    const text = String(cue.text ?? "")
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    out.push({ start: cue.startTime, dur: Math.max(0, cue.endTime - cue.startTime), text });
  }
  return out;
}

/**
 * Preference order mirrors the YouTube interceptor's: subtitles a human wrote,
 * then anything English, then anything at all. `kind` distinguishes real
 * subtitles from descriptions and chapter lists, which are not speech.
 */
export function pickTextTrack(tracks: TextTrackList): TextTrack | null {
  const usable: TextTrack[] = [];
  for (let i = 0; i < tracks.length; i += 1) {
    const track = tracks[i]!;
    if (track.kind === "subtitles" || track.kind === "captions") usable.push(track);
  }
  if (usable.length === 0) return null;

  const isEnglish = (t: TextTrack) => (t.language || "").toLowerCase().startsWith("en");
  return (
    usable.find((t) => isEnglish(t) && t.kind === "subtitles") ??
    usable.find(isEnglish) ??
    usable[0] ??
    null
  );
}

/**
 * Nudge a track into loading its cues without displaying them.
 *
 * Returns a restore function. A user who had subtitles on keeps them on; a track
 * we woke up gets put back to sleep. Leaving a page permanently altered because
 * the extension read from it once is not acceptable.
 */
export function enableQuietly(track: TextTrack): () => void {
  const original = track.mode;
  if (original === "disabled") track.mode = "hidden";
  return () => {
    if (track.mode !== original) track.mode = original;
  };
}

/**
 * Read cues out of a video element.
 *
 * Two paths, because a cross-origin `<track src>` without a `crossorigin`
 * attribute loads and renders but reports `cues === null` to script. In that
 * case the URL is still readable, so fetch and parse it ourselves.
 */
export async function readTrackCues(video: HTMLVideoElement): Promise<TrackCues | null> {
  const track = pickTextTrack(video.textTracks);
  if (!track) return null;

  const restore = enableQuietly(track);
  try {
    // Cues populate asynchronously after the mode change; one frame is not enough.
    for (let attempt = 0; attempt < 10 && !track.cues?.length; attempt += 1) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const direct = toCues(track.cues as unknown as ArrayLike<ReadableCue> | null);
    if (direct.length > 0) {
      return { cues: direct, language: track.language || undefined, languageName: track.label || undefined };
    }

    const src = sourceUrlFor(video, track);
    if (!src) return null;
    const response = await fetch(src, { credentials: "include" });
    if (!response.ok) return null;
    return {
      cues: parseVtt(await response.text()),
      language: track.language || undefined,
      languageName: track.label || undefined,
    };
  } catch {
    // A caption read must never break the page it is reading from.
    return null;
  } finally {
    restore();
  }
}

/**
 * Find the `<track>` element behind a TextTrack, to recover its URL.
 *
 * TextTrack does not expose its own source, so this matches on the identifying
 * fields. Tracks added by script (`addTextTrack`) have no element and no URL,
 * which is a real dead end rather than an error — those either expose cues
 * directly or cannot be read at all.
 */
function sourceUrlFor(video: HTMLVideoElement, track: TextTrack): string | null {
  const elements = Array.from(video.querySelectorAll("track"));
  const match =
    elements.find((el) => el.track === track) ??
    elements.find((el) => el.srclang === track.language && el.label === track.label);
  return match?.src || null;
}
