import { NamedError } from "../lib/errors";

/**
 * Tab audio capture, driven from the service worker.
 *
 * Three MV3 facts shape all of this:
 *
 *   1. `chrome.tabCapture.capture()` is NOT exposed to offscreen documents. The
 *      worker calls `getMediaStreamId()` and the offscreen document turns that
 *      ID into a stream with `getUserMedia`. Chrome 116+.
 *   2. `getMediaStreamId` requires a USER GESTURE on the target tab. That is why
 *      audio is armed by clicking the toolbar icon rather than starting on its
 *      own — the registry calls this `CaptureGestureRequired`.
 *   3. An extension may have **exactly one** offscreen document. So audio
 *      capture is one tab at a time, and arming a second tab moves it. This is
 *      a platform limit, not a decision, and the UI has to say so honestly.
 */

const OFFSCREEN_PATH = "offscreen/offscreen.html";

/** Which tab is armed. Re-derived on demand: the worker is killed after ~30s idle. */
export async function armedTab(): Promise<number | undefined> {
  const { audioTab } = (await chrome.storage.session.get("audioTab")) as { audioTab?: number };
  return audioTab;
}

async function setArmedTab(tabId: number | undefined): Promise<void> {
  if (tabId === undefined) await chrome.storage.session.remove("audioTab");
  else await chrome.storage.session.set({ audioTab: tabId });
}

async function hasOffscreen(): Promise<boolean> {
  // getContexts is the only reliable check. Calling createDocument twice throws,
  // and catching that error is indistinguishable from a real failure.
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as chrome.runtime.ContextType],
  });
  return contexts.length > 0;
}

async function ensureOffscreen(): Promise<void> {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["USER_MEDIA" as chrome.offscreen.Reason],
    justification: "Recording tab audio for videos that have no captions.",
  });
}

/**
 * Promisified `getMediaStreamId`. This API is callback-only in the typings and
 * reports failure through `runtime.lastError` rather than by throwing, so a
 * plain await would silently resolve with undefined on a DRM-protected tab.
 */
function getMediaStreamId(targetTabId: number): Promise<string> {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId }, (streamId) => {
      const error = chrome.runtime.lastError;
      if (error || !streamId) reject(new Error(error?.message ?? "no stream id"));
      else resolve(streamId);
    });
  });
}

/** Talk to the offscreen document. It answers only `audio-*` messages. */
async function ask<T>(message: Record<string, unknown>): Promise<T> {
  return (await chrome.runtime.sendMessage(message)) as T;
}

/**
 * Arm a tab. Must be called from a user gesture — the toolbar click.
 *
 * Starting capture is what makes the "this tab is being shared" indicator
 * appear, so this is deliberately explicit rather than automatic: a tool that
 * silently starts recording your audio is not one to trust.
 */
export async function armTab(tabId: number): Promise<void> {
  let streamId: string;
  try {
    streamId = await getMediaStreamId(tabId);
  } catch (cause) {
    throw new NamedError(
      "PermissionDenied",
      "Couldn't capture this tab's audio (DRM or restricted page)",
      false,
      cause,
    );
  }

  await ensureOffscreen();
  const result = await ask<{ ok: boolean; reason?: string }>({
    kind: "audio-start",
    streamId,
  });
  if (!result?.ok) {
    throw new NamedError("PermissionDenied", "Couldn't start audio capture", false, result?.reason);
  }
  await setArmedTab(tabId);
}

export async function disarm(): Promise<void> {
  if (await hasOffscreen()) {
    await ask({ kind: "audio-stop" }).catch(() => undefined);
    // Closing the document is what actually releases the tab and clears the
    // sharing indicator. Stopping the tracks alone leaves both in place.
    await chrome.offscreen.closeDocument().catch(() => undefined);
  }
  await setArmedTab(undefined);
}

export interface AudioSlice {
  wavBase64: string;
  seconds: number;
}

/**
 * Pull a window out of the ring. Throws a registry error when audio isn't
 * available, so the caller can report it the same way it reports everything else.
 */
export async function audioSlice(tabId: number, back: number, length: number): Promise<AudioSlice> {
  if ((await armedTab()) !== tabId) {
    throw new NamedError("CaptionsUnavailable", "Click the extension icon once to enable audio");
  }
  if (!(await hasOffscreen())) {
    // The document went away — a browser restart, or a crash. The arm state is
    // stale, so clear it rather than reporting a confusing failure twice.
    await setArmedTab(undefined);
    throw new NamedError("CaptionsUnavailable", "Click the extension icon once to enable audio");
  }

  const result = await ask<{ ok: boolean; reason?: string } & Partial<AudioSlice>>({
    kind: "audio-slice",
    back,
    length,
  });

  if (!result?.ok || !result.wavBase64) {
    if (result?.reason === "EmptySlice") {
      throw new NamedError("EmptySlice", "Nothing said in that window");
    }
    throw new NamedError("CaptionsUnavailable", "No audio captured yet", false, result?.reason);
  }
  return { wavBase64: result.wavBase64, seconds: result.seconds ?? 0 };
}

/** Base64 → Blob. The worker has no `atob`-free path and no createObjectURL. */
export function wavBlob(base64: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: "audio/wav" });
}
