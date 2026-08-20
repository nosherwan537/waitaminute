import { describe, it, expect } from "vitest";
import {
  appendIndexOf,
  buildNoteRequests,
  docsErrorForStatus,
  renderNoteBlock,
} from "../src/lib/docs-api";
import type { Note } from "../src/lib/notegen";
import type { TranscriptSlice } from "../src/types";

function note(over: Partial<Note> = {}): Note {
  return { takeaway: "Backprop is just the chain rule", cleaned: "The body.", translation: null, ...over };
}

function slice(over: Partial<TranscriptSlice> = {}): TranscriptSlice {
  return {
    text: "raw",
    startSec: 90,
    endSec: 150,
    videoTitle: "Lecture 3",
    videoUrl: "https://www.youtube.com/watch?v=abc",
    deepLink: "https://www.youtube.com/watch?v=abc&t=90s",
    ...over,
  };
}

describe("appendIndexOf", () => {
  it("steps back over the body's unwritable trailing newline", () => {
    // The failure this guards: inserting at endIndex is a 400 from the API.
    expect(appendIndexOf({ body: { content: [{ endIndex: 1 }, { endIndex: 42 }] } })).toBe(41);
  });

  it("returns 1 for an empty document, since the model has no index 0", () => {
    expect(appendIndexOf({})).toBe(1);
    expect(appendIndexOf({ body: { content: [] } })).toBe(1);
  });

  it("takes the largest endIndex, not the last element's", () => {
    // Structural elements are not guaranteed to arrive in index order.
    expect(appendIndexOf({ body: { content: [{ endIndex: 99 }, { endIndex: 12 }] } })).toBe(98);
  });

  it("never returns less than 1 on a malformed body", () => {
    expect(appendIndexOf({ body: { content: [{ endIndex: 0 }] } })).toBe(1);
  });
});

describe("renderNoteBlock", () => {
  it("puts the takeaway on its own line with the meta line under it", () => {
    const block = renderNoteBlock(note(), slice());
    expect(block.text).toBe(
      "\nBackprop is just the chain rule\n1:30–2:30 · Lecture 3\nThe body.\n" +
        "https://www.youtube.com/watch?v=abc&t=90s\n",
    );
  });

  it("excludes the newline from the heading range", () => {
    // Including it would apply HEADING_2 to the meta paragraph as well, because
    // a paragraph style claims every paragraph the range touches.
    const block = renderNoteBlock(note(), slice());
    expect(block.text.slice(...block.takeaway)).toBe("Backprop is just the chain rule");
    expect(block.text[block.takeaway[1]]).toBe("\n");
  });

  it("marks the deep link range exactly, so the link style covers no stray newline", () => {
    const block = renderNoteBlock(note(), slice());
    expect(block.text.slice(...block.link)).toBe("https://www.youtube.com/watch?v=abc&t=90s");
  });

  it("tags the language and adds the translation section for foreign captions", () => {
    const block = renderNoteBlock(
      note({ cleaned: "El cuerpo.", translation: "The body." }),
      slice({ language: "es", languageName: "Spanish" }),
    );
    expect(block.text).toContain("[Spanish]  1:30–2:30 · Lecture 3");
    expect(block.text).toContain("— English —\nThe body.\n");
    expect(block.text.slice(...block.link)).toBe("https://www.youtube.com/watch?v=abc&t=90s");
  });

  it("counts an emoji in the title as two units, matching Docs' UTF-16 indexing", () => {
    // The failure this guards: treating indices as code points shifts every
    // style range after the emoji by one and underlines the wrong characters.
    const plain = renderNoteBlock(note(), slice({ videoTitle: "Lecture" }));
    const emoji = renderNoteBlock(note(), slice({ videoTitle: "Lecture🎓" }));
    expect(emoji.link[0] - plain.link[0]).toBe(2);
  });

  it("falls back to Untitled rather than emitting an empty heading", () => {
    expect(renderNoteBlock(note({ takeaway: null }), slice()).text).toContain("\nUntitled\n");
  });
});

describe("buildNoteRequests", () => {
  const at = 500;
  const requests = buildNoteRequests(at, note(), slice());

  it("inserts once, then styles — so no request shifts another's indices", () => {
    expect(requests.filter((r) => "insertText" in r)).toHaveLength(1);
    expect(requests[0]).toHaveProperty("insertText");
  });

  it("offsets every style range by the insertion point", () => {
    const block = renderNoteBlock(note(), slice());
    const paragraph = requests[1] as any;
    expect(paragraph.updateParagraphStyle.range).toEqual({
      startIndex: at + block.takeaway[0],
      endIndex: at + block.takeaway[1],
    });
    expect(paragraph.updateParagraphStyle.paragraphStyle.namedStyleType).toBe("HEADING_2");
  });

  it("links the deep link to its own url", () => {
    const link = requests.at(-1) as any;
    expect(link.updateTextStyle.textStyle.link.url).toBe("https://www.youtube.com/watch?v=abc&t=90s");
    expect(link.updateTextStyle.fields).toBe("link");
  });

  it("keeps every range inside the inserted text", () => {
    const block = renderNoteBlock(note(), slice());
    const end = at + block.text.length;
    for (const request of requests.slice(1)) {
      const range = (Object.values(request)[0] as any).range;
      expect(range.startIndex).toBeGreaterThanOrEqual(at);
      expect(range.endIndex).toBeLessThanOrEqual(end);
      expect(range.endIndex).toBeGreaterThan(range.startIndex);
    }
  });
});

describe("docsErrorForStatus", () => {
  it("reads a 404 as a deleted doc, not a bad request", () => {
    // The same status from a model provider means ModelNotFound. Docs is
    // different: the user deleted the doc and we can just make another.
    expect(docsErrorForStatus(404, "").name_).toBe("DocMissing");
  });

  it("separates a quota 403 from a permission 403", () => {
    expect(docsErrorForStatus(403, '{"reason":"userRateLimitExceeded"}').name_).toBe(
      "DocsQuotaExceeded",
    );
    expect(docsErrorForStatus(403, '{"reason":"forbidden"}').name_).toBe("NotAuthorized");
  });

  it("marks a 401 retryable, since a token refresh is worth one attempt", () => {
    const error = docsErrorForStatus(401, "");
    expect(error.name_).toBe("NotAuthorized");
    expect(error.retryable).toBe(true);
  });

  it("maps 429 and 5xx to quota and outage", () => {
    expect(docsErrorForStatus(429, "").name_).toBe("DocsQuotaExceeded");
    expect(docsErrorForStatus(503, "").name_).toBe("DocsWriteFailed");
    expect(docsErrorForStatus(503, "").retryable).toBe(true);
  });

  it("never leaks the response body into the user-facing message", () => {
    const error = docsErrorForStatus(500, "internal stack trace with an email in it");
    expect(error.userMessage).not.toContain("stack trace");
  });
});
