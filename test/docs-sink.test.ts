import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { appendToDoc, readDocRef } from "../src/background/docs-sink";
import { tokenOf } from "../src/background/google-auth";
import type { Note } from "../src/lib/notegen";
import type { TranscriptSlice } from "../src/types";

const NOTE: Note = { takeaway: "T", cleaned: "body", translation: null };
const SLICE: TranscriptSlice = {
  text: "raw",
  startSec: 0,
  endSec: 60,
  videoTitle: "V",
  videoUrl: "https://www.youtube.com/watch?v=abc",
  deepLink: "https://www.youtube.com/watch?v=abc&t=0s",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

/** A document whose body ends at index 42. */
const DOC_BODY = { body: { content: [{ endIndex: 42 }] } };

let store: Record<string, unknown>;
let tokens: string[];
let removed: string[];

function stubChrome(manifestClientId = "real.apps.googleusercontent.com") {
  vi.stubGlobal("chrome", {
    runtime: { getManifest: () => ({ oauth2: { client_id: manifestClientId } }) },
    storage: {
      local: {
        get: async (key: string) => ({ [key]: store[key] }),
        set: async (values: Record<string, unknown>) => void Object.assign(store, values),
      },
    },
    identity: {
      getAuthToken: async () => ({ token: tokens.shift() ?? "t-last" }),
      removeCachedAuthToken: async ({ token }: { token: string }) => void removed.push(token),
    },
  });
}

beforeEach(() => {
  store = { doc: { id: "doc-1", title: "Notes", url: "https://docs.google.com/d/doc-1" } };
  tokens = ["t1", "t2", "t3"];
  removed = [];
  stubChrome();
});

afterEach(() => vi.unstubAllGlobals());

describe("tokenOf", () => {
  it("accepts both the object and the bare-string shapes Chrome returns", () => {
    expect(tokenOf({ token: "abc" })).toBe("abc");
    expect(tokenOf("abc")).toBe("abc");
  });

  it("returns undefined rather than a token-shaped nothing", () => {
    // The failure this guards: `Bearer undefined` / `Bearer [object Object]`,
    // which surfaces as an opaque 401 far from the real cause.
    expect(tokenOf(undefined)).toBeUndefined();
    expect(tokenOf("")).toBeUndefined();
    expect(tokenOf({})).toBeUndefined();
    expect(tokenOf({ token: 42 })).toBeUndefined();
  });
});

describe("appendToDoc", () => {
  it("reads the doc, then batch-updates at the append index", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(DOC_BODY))
      .mockResolvedValueOnce(json({}));
    vi.stubGlobal("fetch", fetchMock);

    await expect(appendToDoc(NOTE, SLICE)).resolves.toMatchObject({ id: "doc-1" });

    const update = fetchMock.mock.calls[1]!;
    const body = JSON.parse(update[1].body);
    // 42 - 1: the body's trailing newline is not writable.
    expect(body.requests[0].insertText.location.index).toBe(41);
    expect(update[0]).toContain(":batchUpdate");
  });

  it("invalidates the cached token on a 401 and retries once", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json(DOC_BODY))
      .mockResolvedValueOnce(json({}));
    vi.stubGlobal("fetch", fetchMock);

    await expect(appendToDoc(NOTE, SLICE)).resolves.toMatchObject({ id: "doc-1" });
    // Without the invalidate, Chrome hands back the same dead token forever.
    expect(removed).toEqual(["t1"]);
    expect(fetchMock.mock.calls[1]![1].headers.authorization).toBe("Bearer t2");
  });

  it("gives up after one refresh, rather than looping on a revoked grant", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({}, 401));
    vi.stubGlobal("fetch", fetchMock);

    await expect(appendToDoc(NOTE, SLICE)).rejects.toThrow(/NotAuthorized/);
    // One original attempt plus exactly one retry. A loop here would spin
    // forever against a grant the user revoked.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recreates a deleted doc and writes the note into the new one", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(json({ documentId: "doc-2", title: "Notes" }))
      .mockResolvedValueOnce(json(DOC_BODY))
      .mockResolvedValueOnce(json({}));
    vi.stubGlobal("fetch", fetchMock);

    await expect(appendToDoc(NOTE, SLICE)).resolves.toMatchObject({ id: "doc-2" });
    // The swap is persisted, or the next capture recreates the doc all over again.
    expect(await readDocRef()).toMatchObject({ id: "doc-2" });
  });

  it("recreates at most once, so a broken grant cannot spawn documents", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(json({ documentId: "doc-2", title: "Notes" }))
      .mockResolvedValue(json({}, 404));
    vi.stubGlobal("fetch", fetchMock);

    await expect(appendToDoc(NOTE, SLICE)).rejects.toThrow(/DocMissing/);
    const creates = fetchMock.mock.calls.filter(
      ([url, init]) => init?.method === "POST" && !String(url).includes("batchUpdate"),
    );
    expect(creates).toHaveLength(1);
  });

  it("creates a doc when there is no ref yet", async () => {
    store = {};
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ documentId: "doc-new", title: "Notes" }))
      .mockResolvedValueOnce(json(DOC_BODY))
      .mockResolvedValueOnce(json({}));
    vi.stubGlobal("fetch", fetchMock);

    await expect(appendToDoc(NOTE, SLICE)).resolves.toMatchObject({ id: "doc-new" });
  });

  it("reports a quota 403 as its own registry name, not as a permission problem", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(json({ error: { message: "userRateLimitExceeded" } }, 403)),
    );
    await expect(appendToDoc(NOTE, SLICE)).rejects.toThrow(/DocsQuotaExceeded/);
  });

  it("maps a dead network to NetworkUnavailable so the local copy still wins", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(appendToDoc(NOTE, SLICE)).rejects.toThrow(/NetworkUnavailable/);
  });

  it("refuses to run at all when the build has no client ID", async () => {
    stubChrome("REPLACE_ME.apps.googleusercontent.com");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(appendToDoc(NOTE, SLICE)).rejects.toThrow(/NotAuthorized/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
