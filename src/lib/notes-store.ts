import type { CommandName } from "../types";

/**
 * The local note store.
 *
 * `chrome.storage.local` is the source of truth; the .md file on disk is a
 * projection of it. That ordering is the whole design: a capture is durable the
 * instant it lands here, so a failed or cancelled download costs the user
 * nothing — the next capture rewrites the file from storage and it self-heals.
 *
 * The reverse (file as truth, storage as cache) would mean every download
 * failure is a lost note, and PLAN.md calls this sink the safety net.
 */

export interface StoredNote {
  /** Capture time in ms, also the sort key. */
  id: number;
  /** Local calendar day, `YYYY-MM-DD`. One file per day. */
  day: string;
  /** The rendered note, exactly as it appears in the file. */
  markdown: string;
  videoTitle: string;
  deepLink: string;
  command: CommandName;
}

/**
 * How much history to keep. A note is ~1KB, so 500 is well under the 10MB
 * storage.local quota with room to spare, and covers a couple of months of
 * heavy study — long enough to answer "did I stop scrubbing back?".
 */
export const MAX_NOTES = 500;

/** Local day, not UTC: a note taken at 11pm belongs to that evening's file. */
export function localDay(at: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** Pure. Newest first, capped. Exported so the retention rule is testable. */
export function withRetention(notes: readonly StoredNote[]): StoredNote[] {
  return [...notes].sort((a, b) => b.id - a.id).slice(0, MAX_NOTES);
}

/**
 * Pure. Render one day's file.
 *
 * Chronological within the day even though storage is newest-first: a study
 * session reads forward, and the deep links only make sense in the order the
 * video played.
 */
export function dayMarkdown(notes: readonly StoredNote[], day: string): string {
  const ordered = notes.filter((n) => n.day === day).sort((a, b) => a.id - b.id);
  return [`# ${day}`, "", ...ordered.map((n) => n.markdown)].join("\n\n").trimEnd() + "\n";
}

export async function readNotes(): Promise<StoredNote[]> {
  const { notes = [] } = (await chrome.storage.local.get("notes")) as { notes?: StoredNote[] };
  return notes;
}

/** Persist a note and return the full retained set, so the caller can rewrite the file. */
export async function appendNote(note: StoredNote): Promise<StoredNote[]> {
  const notes = withRetention([note, ...(await readNotes())]);
  await chrome.storage.local.set({ notes });
  return notes;
}
