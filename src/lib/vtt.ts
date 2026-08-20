import type { Cue } from "../types";

/**
 * WebVTT parsing. Pure — no DOM, no network.
 *
 * Needed because a cross-origin `<track src>` without a `crossorigin` attribute
 * yields `track.cues === null` in the isolated world: the browser loaded and is
 * rendering the subtitles, but script cannot read them. The fallback is to fetch
 * the same URL ourselves and parse it, which is what this file is for.
 *
 * The format is deceptively simple. The parts that actually bite:
 *   - timestamps come as `MM:SS.mmm` OR `HH:MM:SS.mmm`, and a two-part stamp is
 *     minutes:seconds, never hours:minutes
 *   - the cue timing line carries optional settings after the end stamp
 *     (`line:0 align:start`) that must not be parsed as time
 *   - a cue may be preceded by an identifier line, or not
 *   - NOTE, STYLE and REGION blocks are not cues and must be skipped whole
 *   - payloads carry inline markup (`<v Speaker>`, `<b>`, `<00:01:02.000>`)
 *   - files in the wild use CRLF
 */

/**
 * Pure. `00:01:02.500` or `01:02.500` → seconds.
 * Returns null for anything that isn't a timestamp, which is how the caller
 * tells a timing line from an identifier that happens to contain "-->".
 */
export function parseTimestamp(raw: string): number | null {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(raw.trim());
  if (!match) return null;

  // Two-part stamps are MINUTES:SECONDS. Reading them as hours:minutes turns a
  // 90-second clip into a 90-minute one and every cue lands past the playhead.
  const [, hours, minutes, seconds, millis] = match;
  const ms = millis ? Number(millis.padEnd(3, "0")) : 0;
  return Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds) + ms / 1000;
}

/** Pure. Strip WebVTT inline markup, leaving what the speaker said. */
export function stripCueMarkup(text: string): string {
  return text
    // `<v Speaker>`, `<b>`, `</i>`, and karaoke stamps like `<00:00:01.000>`.
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SKIPPED_BLOCK = /^(NOTE|STYLE|REGION)\b/;

/**
 * Pure. WebVTT text → cues, in file order.
 *
 * Unparseable blocks are skipped rather than throwing: a single malformed cue in
 * a two-hour lecture must not cost the user the other 3,000.
 */
export function parseVtt(raw: string): Cue[] {
  const cues: Cue[] = [];
  // Normalize CRLF first, or every payload keeps a trailing \r and the blank-line
  // split that separates cues never matches.
  const blocks = raw.replace(/\r\n?/g, "\n").split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.trim() !== "");
    if (lines.length === 0) continue;
    if (SKIPPED_BLOCK.test(lines[0]!.trim())) continue;

    const timingAt = lines.findIndex((line) => line.includes("-->"));
    if (timingAt === -1) continue; // header, identifier-only block, or junk

    const [startRaw, rest] = lines[timingAt]!.split("-->");
    if (startRaw === undefined || rest === undefined) continue;
    const start = parseTimestamp(startRaw);
    // Settings ride on the same line after the end stamp; take the first token.
    const end = parseTimestamp(rest.trim().split(/\s+/)[0] ?? "");
    if (start === null || end === null || end < start) continue;

    const text = stripCueMarkup(lines.slice(timingAt + 1).join(" "));
    if (!text) continue;

    cues.push({ start, dur: end - start, text });
  }

  return cues;
}
