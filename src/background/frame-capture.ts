import {
  MAX_BYTES,
  MAX_EDGE_PX,
  base64Bytes,
  cropFor,
  fitWithin,
  splitDataUrl,
  type FrameImage,
  type ViewportInfo,
} from "../lib/frame";

/**
 * Take one frame of the video, cropped to the player, ready to attach to a
 * model request. Returns undefined whenever a frame is not available — which is
 * ordinary, not an error.
 *
 * THIS FUNCTION MUST NEVER THROW. A frame is supporting context; the note is
 * the product. Every failure path here — a tainted capture, a DRM-black frame,
 * a page that scrolled, an OffscreenCanvas that refused — degrades to "no
 * frame" and the capture continues on captions alone. Letting any of it reach
 * the caller would mean an optional feature could cost the user a note.
 *
 * PRIVACY: `captureVisibleTab` photographs the WHOLE viewport, so the crop is
 * the only thing standing between the model provider and the rest of the page.
 * If `cropFor` cannot confine the image to the video rectangle it returns null
 * and nothing is sent. The uncropped bitmap never leaves this function.
 *
 * PERMISSIONS: this needs `activeTab`, and host permission is NOT enough —
 * `captureVisibleTab` accepts only `<all_urls>` or `activeTab`. That was
 * assumed wrong when this was written and only a real run caught it; the error
 * is literally "Either the '<all_urls>' or 'activeTab' permission is required."
 *
 * `activeTab` over `<all_urls>` is the whole difference between a reasonable
 * extension and one people should decline. It grants access to ONE tab, only at
 * the moment the user invokes the extension — the `chrome.commands` hotkey
 * counts as that invocation — and it lapses when the tab navigates. It also
 * adds no line to the install prompt, so installing still reads only
 * "youtube.com". `<all_urls>` would ask to read every site the user visits, to
 * take one screenshot of a video they are already watching.
 */
export async function captureFrame(
  tabId: number,
  windowId: number,
  view: ViewportInfo,
): Promise<FrameImage | undefined> {
  try {
    // `captureVisibleTab` photographs whatever is ACTIVE in the window, not the
    // tab that answered the hotkey — and several awaits have passed since then.
    // Switch tabs in that gap and this would photograph the new one, measured
    // against the old one's geometry: the wrong page, cropped by the wrong
    // rectangle. Usually the permission check would refuse it, but not if the
    // user happens to have opted that site in too.
    //
    // Premise 7 says the user is still watching and has not moved, so this
    // costs nothing in the normal case and closes the one case where it matters.
    const [active] = await chrome.tabs.query({ active: true, windowId });
    if (active?.id !== tabId) return undefined;

    // JPEG, not PNG: a video frame is photographic, and PNG of one runs several
    // megabytes before it is even cropped.
    const shot = await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 80 });
    if (!shot) return undefined;

    // Check what came back before decoding it. A capture that is not a base64
    // image data URL is not something to hand to createImageBitmap.
    const parts = splitDataUrl(shot);
    if (!parts?.mimeType.startsWith("image/")) return undefined;

    // `fetch` on the data URL is how a service worker gets a Blob — there is no
    // `URL.createObjectURL` here, and `createImageBitmap` needs a Blob.
    const blob = await (await fetch(shot)).blob();
    const bitmap = await createImageBitmap(blob);

    try {
      const crop = cropFor(view, bitmap.width, bitmap.height);
      if (!crop) return undefined;

      const out = fitWithin(crop.sw, crop.sh, MAX_EDGE_PX);
      const canvas = new OffscreenCanvas(out.width, out.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) return undefined;

      ctx.drawImage(bitmap, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, out.width, out.height);

      const encoded = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.75 });
      const dataBase64 = await blobToBase64(encoded);
      if (!dataBase64) return undefined;

      // Oversize is dropped rather than downscaled again. A frame this large
      // after a 1024px cap means something is wrong with the measurement, and
      // guessing at it would be how the wrong rectangle gets sent.
      if (base64Bytes(dataBase64) > MAX_BYTES) return undefined;

      return { mimeType: "image/jpeg", dataBase64, width: out.width, height: out.height };
    } finally {
      // Bitmaps hold real memory and the service worker may live for hours.
      bitmap.close();
    }
  } catch (cause) {
    console.warn("[heystop] frame capture skipped", cause);
    return undefined;
  }
}

/**
 * Blob to bare base64. `FileReader` does not exist in a service worker, so this
 * goes through the bytes directly, chunked so a megapixel frame does not blow
 * the argument limit on `String.fromCharCode`.
 */
async function blobToBase64(blob: Blob): Promise<string | undefined> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length === 0) return undefined;
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
