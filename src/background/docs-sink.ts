import { NamedError, isNamedError } from "../lib/errors";
import { appendIndexOf, buildNoteRequests, docsErrorForStatus } from "../lib/docs-api";
import type { DocsDocument } from "../lib/docs-api";
import type { Note } from "../lib/notegen";
import type { TranscriptSlice } from "../types";
import { getToken, invalidate } from "./google-auth";

/**
 * GoogleDocsSink — the canonical destination (PLAN.md step 6).
 *
 * Two recovery paths, both from the error registry, both invisible to the user:
 *
 *   TokenExpired  a 401 invalidates Chrome's cached token and retries once.
 *                 Chrome hands out stale tokens until told otherwise, so
 *                 without the invalidate the retry gets the same dead token.
 *   DocMissing    a 404 means the user deleted the doc. Make a new one, record
 *                 the swap, and write the note into it. Failing here would lose
 *                 a note over something the user did on purpose months ago.
 *
 * Everything else falls back to the local .md, which is why LocalMdSink stays
 * the safety net rather than becoming dead code once this ships.
 */

const DOCS = "https://docs.googleapis.com/v1/documents";
const DOC_TITLE = "Wait a Minute — Notes";

export interface DocRef {
  id: string;
  title: string;
  url: string;
}

export async function readDocRef(): Promise<DocRef | undefined> {
  const { doc } = (await chrome.storage.local.get("doc")) as { doc?: DocRef };
  return doc?.id ? doc : undefined;
}

async function writeDocRef(doc: DocRef): Promise<void> {
  await chrome.storage.local.set({ doc });
}

/** One authorized call. Maps every non-2xx onto the registry before returning. */
async function call(token: string, url: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        ...init?.headers,
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    });
  } catch (cause) {
    throw new NamedError("NetworkUnavailable", "Offline — saved locally", false, cause);
  }

  if (!response.ok) {
    throw docsErrorForStatus(response.status, await response.text().catch(() => ""));
  }
  return response.json().catch(() => ({}));
}

/**
 * Run one authorized operation, refreshing the token once on a 401.
 *
 * The retry is deliberately not a loop: if a freshly minted token is also
 * rejected, the problem is the grant, not the token, and retrying again would
 * just spin.
 */
async function withToken<T>(work: (token: string) => Promise<T>): Promise<T> {
  const token = await getToken(false);
  try {
    return await work(token);
  } catch (error) {
    if (!isNamedError(error) || error.name_ !== "NotAuthorized" || !error.retryable) throw error;
    await invalidate(token);
    return work(await getToken(false));
  }
}

async function createDoc(token: string): Promise<DocRef> {
  const created = (await call(token, DOCS, {
    method: "POST",
    body: JSON.stringify({ title: DOC_TITLE }),
  })) as DocsDocument;

  if (!created.documentId) {
    throw new NamedError("DocsWriteFailed", "Google didn't return a document", false, created);
  }
  const doc: DocRef = {
    id: created.documentId,
    title: created.title ?? DOC_TITLE,
    url: `https://docs.google.com/document/d/${created.documentId}/edit`,
  };
  await writeDocRef(doc);
  return doc;
}

/** Options page: connect, creating the doc if this is the first time. */
export async function connect(): Promise<DocRef> {
  const token = await getToken(true);
  const existing = await readDocRef();
  if (!existing) return createDoc(token);

  try {
    await call(token, `${DOCS}/${existing.id}`);
    return existing;
  } catch (error) {
    if (isNamedError(error) && error.name_ === "DocMissing") return createDoc(token);
    throw error;
  }
}

/**
 * Append one note. Resolves with the doc it landed in — which may not be the doc
 * it started with, when the old one had been deleted.
 *
 * Throws a registry error on every failure so the caller can fall back to the
 * local .md and log the outcome without a default branch.
 */
export async function appendToDoc(note: Note, slice: TranscriptSlice): Promise<DocRef> {
  return withToken(async (token) => {
    let doc = await readDocRef();
    if (!doc) doc = await createDoc(token);

    let recreated = false;
    for (;;) {
      try {
        // Read immediately before writing. The append index is only valid for
        // this instant — the user may have the doc open and be typing in it.
        const current = (await call(token, `${DOCS}/${doc.id}`)) as DocsDocument;
        await call(token, `${DOCS}/${doc.id}:batchUpdate`, {
          method: "POST",
          body: JSON.stringify({
            requests: buildNoteRequests(appendIndexOf(current), note, slice),
          }),
        });
        return doc;
      } catch (error) {
        // One recreation only. If the brand-new doc also 404s, something is
        // wrong that making a third document will not fix.
        if (recreated || !isNamedError(error) || error.name_ !== "DocMissing") throw error;
        recreated = true;
        doc = await createDoc(token);
      }
    }
  });
}
