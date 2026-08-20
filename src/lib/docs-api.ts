import { NamedError } from "./errors";
import { isEnglish, type Note } from "./notegen";
import { formatTimestamp } from "./slice";
import type { TranscriptSlice } from "../types";

/**
 * Google Docs `batchUpdate` request building. Pure — no network, no `chrome`.
 *
 * The Docs API is an index-addressed document model, not a Markdown target, and
 * three of its rules decide the shape of everything here:
 *
 *   1. **Indices are UTF-16 code units**, the same unit `String.prototype.length`
 *      counts. That is a lucky alignment, not a coincidence to rely on blindly —
 *      an emoji in a video title advances the index by 2, and getting it wrong
 *      shifts every style range after it onto the wrong characters.
 *
 *   2. **The document body always ends with a newline you cannot write to.**
 *      `endIndex` of the last structural element points one past it, so text has
 *      to be inserted at `endIndex - 1`. Inserting at `endIndex` is a 400.
 *
 *   3. **Requests in one batchUpdate apply in order, and each one shifts the
 *      indices for the next.** Rather than track that, everything here inserts
 *      the whole note as a SINGLE `insertText`, then styles ranges computed
 *      against the known insertion point. One insert, no drift.
 */

/** Minimal shape of what `documents.get` returns. Only what the sink reads. */
export interface DocsDocument {
  documentId?: string;
  title?: string;
  body?: { content?: Array<{ endIndex?: number }> };
}

/**
 * Pure. Where new text goes.
 *
 * Returns `1` for an empty document: index 0 does not exist in the Docs model —
 * the body starts at 1 — so a document with no content still appends at 1.
 */
export function appendIndexOf(doc: DocsDocument): number {
  const content = doc.body?.content ?? [];
  let end = 1;
  for (const element of content) {
    if (typeof element.endIndex === "number" && element.endIndex > end) end = element.endIndex;
  }
  // Step back over the body's trailing newline, which is not writable.
  return Math.max(1, end - 1);
}

/** A `batchUpdate` request. Loosely typed on purpose — we build these, never read them. */
export type DocsRequest = Record<string, unknown>;

/**
 * Pure. The text of one note, exactly as it will appear in the doc, plus the
 * offsets of the parts that get styled.
 *
 * Split out from `buildNoteRequests` so the text and the ranges are computed in
 * one place from one cursor. Two independent walks over the same string is how
 * style ranges drift off by a character.
 */
export function renderNoteBlock(
  note: Note,
  slice: TranscriptSlice,
): { text: string; takeaway: [number, number]; meta: [number, number]; link: [number, number] } {
  const span = `${formatTimestamp(slice.startSec)}–${formatTimestamp(slice.endSec)}`;
  const tag = isEnglish(slice.language) ? "" : `[${slice.languageName ?? slice.language}]  `;

  let text = "";
  const push = (part: string): [number, number] => {
    const start = text.length;
    text += part;
    return [start, text.length];
  };

  // A leading newline separates this note from the previous one. The doc's own
  // trailing newline is not writable, so the gap has to come from this end.
  push("\n");
  // The heading line's range EXCLUDES its newline: a paragraph style applies to
  // the paragraph the range touches, and including the newline would pull the
  // following paragraph into the heading too.
  const takeawayStart = text.length;
  push(note.takeaway ?? "Untitled");
  const takeaway: [number, number] = [takeawayStart, text.length];
  push("\n");

  const metaStart = text.length;
  push(`${tag}${span} · ${slice.videoTitle}`);
  const meta: [number, number] = [metaStart, text.length];
  push("\n");

  push(note.cleaned);
  push("\n");

  if (note.translation) {
    push("— English —\n");
    push(note.translation);
    push("\n");
  }

  const linkStart = text.length;
  push(slice.deepLink);
  const link: [number, number] = [linkStart, text.length];
  push("\n");

  return { text, takeaway, meta, link };
}

/**
 * Pure. The full request list for appending one note at `at`.
 *
 * Order matters: the insert must come first, and every style range is expressed
 * against `at` — after the single insert, no later request moves anything.
 */
export function buildNoteRequests(at: number, note: Note, slice: TranscriptSlice): DocsRequest[] {
  const block = renderNoteBlock(note, slice);
  const range = ([start, end]: [number, number]) => ({
    startIndex: at + start,
    endIndex: at + end,
  });

  return [
    { insertText: { location: { index: at }, text: block.text } },
    {
      updateParagraphStyle: {
        range: range(block.takeaway),
        paragraphStyle: { namedStyleType: "HEADING_2" },
        fields: "namedStyleType",
      },
    },
    {
      updateTextStyle: {
        range: range(block.meta),
        textStyle: { fontSize: { magnitude: 9, unit: "PT" }, foregroundColor: GREY },
        fields: "fontSize,foregroundColor",
      },
    },
    {
      // The deep link is what turns a pile of notes into an index, so it has to
      // be clickable rather than pasted text.
      updateTextStyle: {
        range: range(block.link),
        textStyle: { link: { url: slice.deepLink } },
        fields: "link",
      },
    },
  ];
}

const GREY = { color: { rgbColor: { red: 0.45, green: 0.45, blue: 0.45 } } };

/**
 * Pure. Map a Docs/Drive HTTP status onto the error registry.
 *
 * Deliberately separate from `errorForStatus` in errors.ts: the same status
 * means something different here. A 404 from a provider is a bad model name; a
 * 404 from Docs is a document the user deleted, which is recoverable by making
 * a new one rather than something to tell the user to go fix.
 */
export function docsErrorForStatus(status: number, body: string): NamedError {
  const detail = body.slice(0, 500);
  switch (true) {
    case status === 401:
      // The caller refreshes and retries once before this ever reaches a toast.
      return new NamedError("NotAuthorized", "Reconnect Google to save notes", true, detail);
    case status === 403 && /quota|rateLimit|userRateLimit/i.test(detail):
      return new NamedError("DocsQuotaExceeded", "Google quota hit — saved locally", false, detail);
    case status === 403:
      return new NamedError("NotAuthorized", "Connect Google to save notes", false, detail);
    case status === 404:
      return new NamedError("DocMissing", "Doc was gone — made a new one", false, detail);
    case status === 429:
      return new NamedError("DocsQuotaExceeded", "Google quota hit — saved locally", false, detail);
    case status >= 500:
      return new NamedError("DocsWriteFailed", "Google Docs is down — saved locally", true, detail);
    default:
      return new NamedError("DocsWriteFailed", "Couldn't write to your doc", false, detail);
  }
}
