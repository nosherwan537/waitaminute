import { NamedError } from "../lib/errors";
import { dayMarkdown, type StoredNote } from "../lib/notes-store";

/**
 * LocalMdSink — one Markdown file per day, under Downloads/heystop/.
 *
 * Two MV3 constraints shape this, and neither is obvious:
 *
 *   1. `URL.createObjectURL` does not exist in a service worker, so the usual
 *      Blob-to-download trick is unavailable. The file has to be a `data:` URL.
 *   2. `btoa` throws on any character above U+00FF. Captions are frequently
 *      Spanish, Hindi or Japanese, so the text MUST be UTF-8 encoded to bytes
 *      before base64. Skipping that step works fine in testing and then breaks
 *      on the first non-English video.
 *
 * The file is rewritten in full on every capture rather than appended to —
 * `chrome.downloads` cannot append. That is affordable because storage holds the
 * day and a day is a few dozen KB.
 */

const FOLDER = "heystop";

/** Pure. UTF-8 safe base64, chunked so a long day doesn't blow the call stack. */
export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Pure. The `data:` URL `chrome.downloads` is handed. */
export function toDataUrl(markdown: string): string {
  return `data:text/markdown;charset=utf-8;base64,${utf8ToBase64(markdown)}`;
}

/**
 * Pure. `heystop/2026-08-17.md`.
 *
 * Chrome rejects a download whose filename escapes the Downloads directory, so
 * anything path-like is stripped rather than trusted. Dots are dropped along
 * with separators — the `.md` extension is appended here, so the caller's string
 * never needs one, and allowing dots is what lets `..` survive sanitizing.
 *
 * The day is generated internally today, but this is the function a future
 * "one file per video" option would reuse with a user-controlled title.
 */
export function fileNameFor(name: string): string {
  const safe = name.replace(/[^0-9A-Za-z_-]/g, "-").slice(0, 100) || "untitled";
  return `${FOLDER}/${safe}.md`;
}

/**
 * Rewrite one day's file. Resolves when the download is queued.
 *
 * `conflictAction: "overwrite"` is what keeps this to a single file per day
 * instead of `2026-08-17 (1).md`, `(2)`, `(3)` climbing all afternoon.
 */
export async function writeDayFile(notes: readonly StoredNote[], day: string): Promise<void> {
  let downloadId: number;
  try {
    downloadId = await chrome.downloads.download({
      url: toDataUrl(dayMarkdown(notes, day)),
      filename: fileNameFor(day),
      conflictAction: "overwrite",
      saveAs: false,
    });
  } catch (cause) {
    // The note is already in storage, so this is a degraded state, not data
    // loss. The next capture rewrites the file and it repairs itself.
    throw new NamedError("LocalWriteFailed", "Couldn't write the local copy", false, cause);
  }

  // Drop the history row. The file stays; chrome://downloads doesn't fill up
  // with one entry per keypress. Failure here is cosmetic only.
  try {
    await chrome.downloads.erase({ id: downloadId });
  } catch {
    /* erase is a tidiness pass, never worth failing a capture over */
  }
}
