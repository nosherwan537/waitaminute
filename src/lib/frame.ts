/**
 * Frame capture geometry (PLAN.md step 12).
 *
 * The frame is SUPPORTING CONTEXT, never the note. A lecturer says "as you can
 * see here, this term dominates" and the captions alone give you a note that
 * points at nothing; the slide has the equation. That is the whole case for it.
 *
 * WHY captureVisibleTab AND NOT canvas.drawImage(video): YouTube's media is
 * served cross-origin from googlevideo.com, so drawing the element onto a canvas
 * taints it and `toDataURL` throws SecurityError. PLAN.md predicted exactly this
 * ("cut it without regret if canvas tainting fights back"). Capturing the tab
 * sidesteps tainting entirely — at the cost of grabbing the whole viewport,
 * which is why every function here exists: to crop back down to the video and
 * refuse when it cannot.
 *
 * That refusal is a PRIVACY rule, not a quality one. A tab screenshot holds
 * whatever else is on screen — comments, other tabs' content bleeding into a
 * screenshot is not possible, but the page's own sidebar, email preview panes on
 * an embedded player, a half-composed message. Anything the crop cannot confine
 * to the video rectangle must not be sent to a model provider. When in doubt
 * this module returns null and the capture proceeds on captions alone.
 */

/** A rectangle in CSS pixels, relative to the viewport's top-left. */
export interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the content script measured at the moment of capture. */
export interface ViewportInfo {
  /** The <video> element's bounding rect, CSS pixels, viewport-relative. */
  rect: FrameRect;
  /** Viewport size in CSS pixels. Used to derive the capture's scale factor. */
  width: number;
  height: number;
}

/** A captured, cropped, re-encoded frame, ready to attach to a model request. */
export interface FrameImage {
  mimeType: string;
  /** Base64 WITHOUT a `data:` prefix — every provider wants the bare payload. */
  dataBase64: string;
  width: number;
  height: number;
}

/**
 * Below this the "video" is a thumbnail, a scrolled-away miniplayer, or a
 * player that has not laid out yet. Cropping it yields nothing legible and
 * spends tokens to say so.
 */
export const MIN_VIDEO_PX = 160;

/**
 * Longest edge of what we actually send. A 4K frame is not more readable to a
 * model than a 1024px one, and it is billed by area.
 */
export const MAX_EDGE_PX = 1024;

/**
 * Hard ceiling on the encoded payload. A frame that will not fit under this is
 * dropped rather than sent: the note matters, the picture is a bonus.
 */
export const MAX_BYTES = 1_500_000;

/** Pure. Scale (w,h) down to fit `max` on its longest edge. Never scales up. */
export function fitWithin(width: number, height: number, max: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= max || longest === 0) {
    return { width: Math.round(width), height: Math.round(height) };
  }
  const factor = max / longest;
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
  };
}

/**
 * Pure. Where to cut the video out of a full-viewport screenshot, or null to
 * send no frame at all.
 *
 * The scale factor is derived from the captured bitmap against the reported
 * viewport rather than read from `devicePixelRatio`. Same answer on an ordinary
 * display, but it stays correct when the two disagree — a zoomed page, a window
 * dragged between a Retina and an external monitor mid-video, a browser that
 * caps capture resolution. Trusting dpr there would crop the wrong rectangle,
 * and cropping the WRONG rectangle is the failure that leaks the rest of the
 * screen to a provider.
 *
 * Returns null when the video is too small, has no area, or lies entirely
 * outside the viewport. Every one of those means "no usable frame", and the
 * caller must treat null as ordinary, not as an error.
 */
export function cropFor(
  view: ViewportInfo,
  bitmapWidth: number,
  bitmapHeight: number,
): { sx: number; sy: number; sw: number; sh: number } | null {
  const { rect } = view;
  if (!(view.width > 0 && view.height > 0)) return null;
  if (!(bitmapWidth > 0 && bitmapHeight > 0)) return null;
  if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) return null;
  if (!(rect.width >= MIN_VIDEO_PX && rect.height >= MIN_VIDEO_PX)) return null;

  const scaleX = bitmapWidth / view.width;
  const scaleY = bitmapHeight / view.height;

  // Clamp to the bitmap. A player can hang off the edge of the viewport while
  // still being mostly visible; the visible part is the part we may send.
  const left = Math.max(0, Math.min(bitmapWidth, rect.x * scaleX));
  const top = Math.max(0, Math.min(bitmapHeight, rect.y * scaleY));
  const right = Math.max(0, Math.min(bitmapWidth, (rect.x + rect.width) * scaleX));
  const bottom = Math.max(0, Math.min(bitmapHeight, (rect.y + rect.height) * scaleY));

  const sw = Math.floor(right - left);
  const sh = Math.floor(bottom - top);
  // Scrolled away, collapsed, or clipped down to a sliver. Nothing to read.
  if (sw < MIN_VIDEO_PX * scaleX || sh < MIN_VIDEO_PX * scaleY) return null;

  return { sx: Math.floor(left), sy: Math.floor(top), sw, sh };
}

/** Pure. Split a `data:` URL into its mime type and bare base64 payload. */
export function splitDataUrl(dataUrl: string): { mimeType: string; dataBase64: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  if (!match?.[1] || !match[2]) return null;
  return { mimeType: match[1], dataBase64: match[2] };
}

/** Pure. Decoded byte length of a base64 string, without decoding it. */
export function base64Bytes(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}
