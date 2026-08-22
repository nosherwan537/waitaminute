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
 * PERMISSIONS: no new manifest entry. `captureVisibleTab` is satisfied by the
 * host permission the extension already holds for the page it is capturing on —
 * youtube.com statically, and each opt-in site at runtime. An extension that
 * asked for `<all_urls>` to screenshot would deserve to be declined.
 */
export async function captureFrame(
  windowId: number,
  view: ViewportInfo,
): Promise<FrameImage | undefined> {
  try {
    // JPEG, not PNG: a video frame is photographic, and PNG of one runs several
    // megabytes before it is even cropped.
    const shot = await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 80 });
    if (!shot) return undefined;

    const parts = splitDataUrl(shot);
    if (!parts) return undefined;

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
