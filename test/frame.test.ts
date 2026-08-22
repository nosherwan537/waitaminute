import { describe, it, expect } from "vitest";
import {
  MAX_EDGE_PX,
  MIN_VIDEO_PX,
  base64Bytes,
  cropFor,
  fitWithin,
  splitDataUrl,
  type ViewportInfo,
} from "../src/lib/frame";

/** A 1280x720 player centred in a 1600x900 viewport, the ordinary case. */
function view(over: Partial<ViewportInfo> = {}): ViewportInfo {
  return {
    rect: { x: 160, y: 90, width: 1280, height: 720 },
    width: 1600,
    height: 900,
    ...over,
  };
}

describe("fitWithin", () => {
  it("leaves anything already inside the box alone", () => {
    expect(fitWithin(800, 450, 1024)).toEqual({ width: 800, height: 450 });
  });

  it("scales the longest edge down to the cap and keeps the aspect ratio", () => {
    expect(fitWithin(1920, 1080, 1024)).toEqual({ width: 1024, height: 576 });
    expect(fitWithin(1080, 1920, 1024)).toEqual({ width: 576, height: 1024 });
  });

  it("never scales up, because a model reads an upscaled frame no better", () => {
    expect(fitWithin(320, 180, 1024)).toEqual({ width: 320, height: 180 });
  });

  it("never rounds an edge away to zero", () => {
    expect(fitWithin(10000, 3, 1024).height).toBeGreaterThanOrEqual(1);
  });

  it("survives a zero-sized input rather than dividing by it", () => {
    expect(fitWithin(0, 0, 1024)).toEqual({ width: 0, height: 0 });
  });
});

describe("cropFor", () => {
  it("cuts the player out of a same-scale screenshot", () => {
    expect(cropFor(view(), 1600, 900)).toEqual({ sx: 160, sy: 90, sw: 1280, sh: 720 });
  });

  it("derives the scale from the bitmap, so a 2x Retina capture still lines up", () => {
    // The whole reason scale is measured rather than read from devicePixelRatio.
    expect(cropFor(view(), 3200, 1800)).toEqual({ sx: 320, sy: 180, sw: 2560, sh: 1440 });
  });

  it("handles a capture the browser downscaled below the viewport", () => {
    expect(cropFor(view(), 800, 450)).toEqual({ sx: 80, sy: 45, sw: 640, sh: 360 });
  });

  it("clamps a player hanging off the edge to what is actually on screen", () => {
    // PRIVACY: the crop may never read outside the bitmap, and it may never
    // widen to compensate for the part that is off-screen.
    const crop = cropFor(view({ rect: { x: -200, y: 0, width: 1280, height: 720 } }), 1600, 900);
    expect(crop).toEqual({ sx: 0, sy: 0, sw: 1080, sh: 720 });
  });

  it("clamps a player running off the bottom right", () => {
    const crop = cropFor(view({ rect: { x: 1000, y: 500, width: 1280, height: 720 } }), 1600, 900);
    expect(crop).toEqual({ sx: 1000, sy: 500, sw: 600, sh: 400 });
  });

  it("refuses a player too small to read", () => {
    const tiny = MIN_VIDEO_PX - 1;
    expect(cropFor(view({ rect: { x: 0, y: 0, width: tiny, height: 400 } }), 1600, 900)).toBeNull();
    expect(cropFor(view({ rect: { x: 0, y: 0, width: 400, height: tiny } }), 1600, 900)).toBeNull();
  });

  it("refuses a player scrolled entirely out of view", () => {
    expect(cropFor(view({ rect: { x: 0, y: -900, width: 1280, height: 720 } }), 1600, 900)).toBeNull();
    expect(cropFor(view({ rect: { x: 2000, y: 0, width: 1280, height: 720 } }), 1600, 900)).toBeNull();
  });

  it("refuses when only a sliver of a large player is on screen", () => {
    // Mostly scrolled off: what is left is not the frame the user is watching.
    const crop = cropFor(view({ rect: { x: 0, y: 860, width: 1280, height: 720 } }), 1600, 900);
    expect(crop).toBeNull();
  });

  it("refuses a viewport or bitmap with no area rather than dividing by zero", () => {
    expect(cropFor(view({ width: 0 }), 1600, 900)).toBeNull();
    expect(cropFor(view({ height: 0 }), 1600, 900)).toBeNull();
    expect(cropFor(view(), 0, 900)).toBeNull();
    expect(cropFor(view(), 1600, 0)).toBeNull();
  });

  it("refuses a rect carrying NaN or Infinity", () => {
    // getBoundingClientRect on a detached or transformed element can produce
    // these, and a NaN crop is an unbounded read.
    expect(cropFor(view({ rect: { x: NaN, y: 0, width: 1280, height: 720 } }), 1600, 900)).toBeNull();
    expect(
      cropFor(view({ rect: { x: 0, y: Infinity, width: 1280, height: 720 } }), 1600, 900),
    ).toBeNull();
  });

  it("never returns a crop reaching past the bitmap, whatever it is handed", () => {
    // The invariant that matters: anything outside these bounds is a screenshot
    // of something the user did not agree to send.
    const cases: ViewportInfo[] = [
      view(),
      view({ rect: { x: -5000, y: -5000, width: 20000, height: 20000 } }),
      view({ rect: { x: 1599, y: 899, width: 5000, height: 5000 } }),
      view({ width: 1, height: 1 }),
    ];
    for (const v of cases) {
      const crop = cropFor(v, 1600, 900);
      if (!crop) continue;
      expect(crop.sx).toBeGreaterThanOrEqual(0);
      expect(crop.sy).toBeGreaterThanOrEqual(0);
      expect(crop.sx + crop.sw).toBeLessThanOrEqual(1600);
      expect(crop.sy + crop.sh).toBeLessThanOrEqual(900);
    }
  });

  it("produces a crop that the size cap then brings under the wire", () => {
    const crop = cropFor(view(), 3200, 1800);
    const out = fitWithin(crop!.sw, crop!.sh, MAX_EDGE_PX);
    expect(Math.max(out.width, out.height)).toBe(MAX_EDGE_PX);
  });
});

describe("splitDataUrl", () => {
  it("separates the mime type from the payload", () => {
    expect(splitDataUrl("data:image/jpeg;base64,AAAB")).toEqual({
      mimeType: "image/jpeg",
      dataBase64: "AAAB",
    });
  });

  it("returns null for anything that is not a base64 data URL", () => {
    expect(splitDataUrl("")).toBeNull();
    expect(splitDataUrl("https://example.com/a.jpg")).toBeNull();
    expect(splitDataUrl("data:image/jpeg,notbase64")).toBeNull();
    expect(splitDataUrl("data:image/jpeg;base64,")).toBeNull();
  });
});

describe("base64Bytes", () => {
  it("counts decoded bytes without decoding", () => {
    expect(base64Bytes(btoa("hello"))).toBe(5);
    expect(base64Bytes(btoa("hi"))).toBe(2);
    expect(base64Bytes(btoa("abc"))).toBe(3);
    expect(base64Bytes("")).toBe(0);
  });
});
