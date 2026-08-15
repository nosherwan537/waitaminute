import type { Cue, WindowSpec } from "../types";

export interface SliceResult {
  text: string;
  startSec: number;
  endSec: number;
  /** True when the window contained no speech: an ad, a tangent, dead air. */
  isEmpty: boolean;
}

/**
 * Pull the transcript for a window ending `spec.back` seconds behind the playhead.
 *
 *   0                                              currentTime
 *   ├──────────────────────────────────────────────────┤
 *                        ├─── length ───┤├── back ──┤
 *                     startSec        endSec
 *
 * Pure, no I/O. Every hotkey routes through here, which is why it carries the
 * test coverage for all three.
 *
 * A cue is included when it OVERLAPS the window at all, not only when it starts
 * inside it. A sentence that began two seconds before the window is exactly the
 * sentence the user pressed the key for.
 */
export function slice(cues: readonly Cue[], currentTime: number, spec: WindowSpec): SliceResult {
  const endSec = Math.max(0, currentTime - spec.back);
  const startSec = Math.max(0, endSec - spec.length);

  // Window sits entirely before the video started, or has no width.
  if (endSec <= 0 || endSec <= startSec) {
    return { text: "", startSec, endSec, isEmpty: true };
  }

  const hits = cues
    .filter((c) => c.start < endSec && c.start + c.dur > startSec)
    .slice()
    .sort((a, b) => a.start - b.start);

  const text = hits
    .map((c) => c.text.trim())
    .filter((t) => t.length > 0)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return { text, startSec, endSec, isEmpty: text.length === 0 };
}

/** Keep only cues from the last `windowSec` of playback. Bounds memory on long lectures. */
export function evictOldCues(cues: readonly Cue[], currentTime: number, windowSec = 1800): Cue[] {
  const cutoff = currentTime - windowSec;
  if (cutoff <= 0) return cues.slice();
  return cues.filter((c) => c.start + c.dur >= cutoff);
}

/** 1247.8 -> "20:47". Used in note headings. */
export function formatTimestamp(seconds: number): string {
  const total = Math.floor(Math.max(0, seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Deep-link back into the video at `seconds`. This is what makes the doc an index. */
export function deepLink(videoUrl: string, seconds: number): string {
  try {
    const u = new URL(videoUrl);
    u.searchParams.set("t", `${Math.floor(Math.max(0, seconds))}s`);
    return u.toString();
  } catch {
    return videoUrl;
  }
}
