import { describe, it, expect, vi, afterEach } from "vitest";
import {
  utf8ToBase64,
  toDataUrl,
  fileNameFor,
  awaitDownload,
  writeDayFile,
} from "../src/background/local-sink";
import { dayMarkdown, withRetention, localDay, MAX_NOTES } from "../src/lib/notes-store";
import type { StoredNote } from "../src/lib/notes-store";

function note(over: Partial<StoredNote> = {}): StoredNote {
  return {
    id: 1000,
    day: "2026-08-17",
    markdown: "## A\n\nbody",
    videoTitle: "V",
    deepLink: "https://y/watch?v=1&t=0s",
    command: "capture-now",
    ...over,
  };
}

describe("utf8ToBase64", () => {
  it("round-trips ASCII", () => {
    expect(atob(utf8ToBase64("hello"))).toBe("hello");
  });

  it("encodes characters btoa alone would throw on", () => {
    // The failure this guards: btoa("El gradiente… 日本語") throws InvalidCharacterError.
    // Captions are foreign-language often enough that this is the first thing
    // that breaks in the field, not an edge case.
    for (const text of ["El gradiente está aquí", "ग्रेडिएंट", "日本語のテキスト", "emoji 🎧"]) {
      const decoded = new TextDecoder().decode(
        Uint8Array.from(atob(utf8ToBase64(text)), (c) => c.charCodeAt(0)),
      );
      expect(decoded).toBe(text);
    }
  });

  it("handles a payload larger than the chunk size without blowing the stack", () => {
    const big = "é".repeat(100_000); // 200KB of bytes, well past the 0x8000 chunk
    expect(() => utf8ToBase64(big)).not.toThrow();
    const decoded = new TextDecoder().decode(
      Uint8Array.from(atob(utf8ToBase64(big)), (c) => c.charCodeAt(0)),
    );
    expect(decoded).toBe(big);
  });

  it("handles an empty string", () => {
    expect(utf8ToBase64("")).toBe("");
  });
});

describe("toDataUrl", () => {
  it("declares markdown and utf-8, so the file opens correctly", () => {
    expect(toDataUrl("hi")).toMatch(/^data:text\/markdown;charset=utf-8;base64,/);
  });

  it("carries the content", () => {
    const url = toDataUrl("hello");
    expect(atob(url.split(",")[1]!)).toBe("hello");
  });
});

describe("fileNameFor", () => {
  it("puts the day file in the heystop folder", () => {
    expect(fileNameFor("2026-08-17")).toBe("heystop-notes/2026-08-17.md");
  });

  it("strips path traversal, which Chrome would reject the download for", () => {
    // Dots go too: leaving them is exactly what lets `..` survive sanitizing.
    expect(fileNameFor("../../etc/passwd")).toBe("heystop-notes/------etc-passwd.md");
    expect(fileNameFor("2026/08/17")).toBe("heystop-notes/2026-08-17.md");
    expect(fileNameFor("a/../b")).not.toContain("..");
  });

  it("never produces an empty filename", () => {
    expect(fileNameFor("")).toBe("heystop-notes/untitled.md");
    expect(fileNameFor("///")).toBe("heystop-notes/---.md");
  });

  it("bounds the length, since some filesystems cap at 255 bytes", () => {
    expect(fileNameFor("x".repeat(500)).length).toBeLessThan(120);
  });
});

describe("localDay", () => {
  it("formats as YYYY-MM-DD with zero padding", () => {
    expect(localDay(new Date(2026, 0, 5, 12))).toBe("2026-01-05");
    expect(localDay(new Date(2026, 11, 31, 12))).toBe("2026-12-31");
  });

  it("uses the local calendar day, not UTC", () => {
    // 11pm local on the 17th belongs to that evening's study session, even
    // though it is already the 18th in UTC for much of the world.
    const late = new Date(2026, 7, 17, 23, 30);
    expect(localDay(late)).toBe("2026-08-17");
  });
});

describe("withRetention", () => {
  it("keeps newest first", () => {
    const kept = withRetention([note({ id: 1 }), note({ id: 3 }), note({ id: 2 })]);
    expect(kept.map((n) => n.id)).toEqual([3, 2, 1]);
  });

  it("caps the store so storage.local cannot fill up", () => {
    const many = Array.from({ length: MAX_NOTES + 50 }, (_, i) => note({ id: i }));
    expect(withRetention(many)).toHaveLength(MAX_NOTES);
  });

  it("drops the oldest when capping, never the newest", () => {
    const many = Array.from({ length: MAX_NOTES + 10 }, (_, i) => note({ id: i }));
    const kept = withRetention(many);
    expect(kept[0]!.id).toBe(MAX_NOTES + 9);
    expect(kept.at(-1)!.id).toBe(10);
  });

  it("does not mutate its input", () => {
    const input = [note({ id: 1 }), note({ id: 2 })];
    withRetention(input);
    expect(input.map((n) => n.id)).toEqual([1, 2]);
  });
});

describe("dayMarkdown", () => {
  it("heads the file with the day", () => {
    expect(dayMarkdown([note()], "2026-08-17").startsWith("# 2026-08-17\n")).toBe(true);
  });

  it("orders notes chronologically, not newest-first like storage", () => {
    // Storage is newest-first for the UI; the file reads forward because that's
    // the order the video played and the deep links only make sense that way.
    const out = dayMarkdown(
      [note({ id: 3, markdown: "third" }), note({ id: 1, markdown: "first" })],
      "2026-08-17",
    );
    expect(out.indexOf("first")).toBeLessThan(out.indexOf("third"));
  });

  it("includes only the requested day", () => {
    const out = dayMarkdown(
      [note({ day: "2026-08-17", markdown: "today" }), note({ day: "2026-08-16", markdown: "yesterday" })],
      "2026-08-17",
    );
    expect(out).toContain("today");
    expect(out).not.toContain("yesterday");
  });

  it("produces a valid file for a day with no notes", () => {
    expect(dayMarkdown([], "2026-08-17")).toBe("# 2026-08-17\n");
  });

  it("ends with exactly one trailing newline", () => {
    const out = dayMarkdown([note()], "2026-08-17");
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });

  it("separates notes with a blank line so headings render", () => {
    const out = dayMarkdown(
      [note({ id: 1, markdown: "## One\n\na" }), note({ id: 2, markdown: "## Two\n\nb" })],
      "2026-08-17",
    );
    expect(out).toContain("a\n\n## Two");
  });
});

/**
 * A stand-in for `chrome.downloads` good enough to test the completion wait.
 *
 * `settle` fires the state change the way Chrome would, so a test can decide
 * whether the download finishes, breaks, or never reports back at all.
 */
function fakeDownloads(options: { startState?: string; downloadId?: number } = {}) {
  const listeners = new Set<(delta: { id: number; state?: { current: string } }) => void>();
  const id = options.downloadId ?? 7;
  let state = options.startState ?? "in_progress";

  const downloads = {
    download: vi.fn(async () => id),
    erase: vi.fn(async () => [id]),
    search: vi.fn(async ({ id: wanted }: { id: number }) => (wanted === id ? [{ id, state }] : [])),
    onChanged: {
      addListener: (fn: (delta: { id: number; state?: { current: string } }) => void) =>
        void listeners.add(fn),
      removeListener: (fn: (delta: { id: number; state?: { current: string } }) => void) =>
        void listeners.delete(fn),
    },
  };

  const settle = (next: string, forId = id) => {
    state = next;
    for (const fn of [...listeners]) fn({ id: forId, state: { current: next } });
  };

  (globalThis as { chrome?: unknown }).chrome = { downloads };
  return { downloads, settle, listenerCount: () => listeners.size };
}

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
  vi.useRealTimers();
});

describe("awaitDownload", () => {
  it("resolves complete when the state change arrives", async () => {
    const { settle } = fakeDownloads();
    const pending = awaitDownload(7);
    settle("complete");
    await expect(pending).resolves.toBe("complete");
  });

  it("reports an interrupted download rather than treating it as done", async () => {
    const { settle } = fakeDownloads();
    const pending = awaitDownload(7);
    settle("interrupted");
    await expect(pending).resolves.toBe("interrupted");
  });

  it("catches a download that finished before the listener attached", async () => {
    // The race that matters: a small data: URL can be on disk before we
    // subscribe, and the missed event would otherwise strand the capture.
    fakeDownloads({ startState: "complete" });
    await expect(awaitDownload(7)).resolves.toBe("complete");
  });

  it("ignores state changes belonging to another download", async () => {
    vi.useFakeTimers();
    const { settle } = fakeDownloads({ downloadId: 7 });
    const pending = awaitDownload(7, 50);
    settle("complete", 99); // some other file the user downloaded mid-capture
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toBe("timeout");
  });

  it("times out instead of hanging the capture forever", async () => {
    vi.useFakeTimers();
    fakeDownloads();
    const pending = awaitDownload(7, 50);
    await vi.advanceTimersByTimeAsync(50);
    await expect(pending).resolves.toBe("timeout");
  });

  it("unsubscribes once settled, so listeners cannot pile up per keypress", async () => {
    const { settle, listenerCount } = fakeDownloads();
    const pending = awaitDownload(7);
    settle("complete");
    await pending;
    expect(listenerCount()).toBe(0);
  });
});

describe("writeDayFile", () => {
  const notes = [note()];

  it("erases the history row only after the file is on disk", async () => {
    // The bug this guards: erase() on an in-flight download CANCELS it, so the
    // old code deleted every note file and still reported success.
    const { downloads, settle } = fakeDownloads();
    const pending = writeDayFile(notes, "2026-08-17");
    expect(downloads.erase).not.toHaveBeenCalled();
    settle("complete");
    await pending;
    expect(downloads.erase).toHaveBeenCalledWith({ id: 7 });
  });

  it("fails loudly when the download is interrupted", async () => {
    // An interrupted write must reach the capture log as LocalWriteFailed —
    // a green `ok` row next to a missing file is what hid this for two days.
    const { downloads, settle } = fakeDownloads();
    const pending = writeDayFile(notes, "2026-08-17");
    settle("interrupted");
    await expect(pending).rejects.toThrow(/local copy/i);
    expect(downloads.erase).not.toHaveBeenCalled();
  });

  it("leaves a slow download alone rather than cancelling it", async () => {
    vi.useFakeTimers();
    const { downloads } = fakeDownloads();
    const pending = writeDayFile(notes, "2026-08-17");
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toBeUndefined();
    expect(downloads.erase).not.toHaveBeenCalled();
  });

  it("surfaces a refused download as LocalWriteFailed", async () => {
    const { downloads } = fakeDownloads();
    downloads.download.mockRejectedValueOnce(new Error("Download failed"));
    await expect(writeDayFile(notes, "2026-08-17")).rejects.toThrow(/local copy/i);
  });

  it("writes one overwriting file per day", async () => {
    const { downloads, settle } = fakeDownloads();
    const pending = writeDayFile(notes, "2026-08-17");
    settle("complete");
    await pending;
    expect(downloads.download).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "heystop-notes/2026-08-17.md",
        conflictAction: "overwrite",
        saveAs: false,
      }),
    );
  });

  it("does not fail the capture when only the tidy-up erase fails", async () => {
    const { downloads, settle } = fakeDownloads();
    downloads.erase.mockRejectedValueOnce(new Error("no such download"));
    const pending = writeDayFile(notes, "2026-08-17");
    settle("complete");
    await expect(pending).resolves.toBeUndefined();
  });
});
