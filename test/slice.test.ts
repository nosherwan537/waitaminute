import { describe, it, expect } from "vitest";
import { slice, evictOldCues, formatTimestamp, deepLink } from "../src/lib/slice";
import { WINDOWS, type Cue } from "../src/types";

/** Cues at 0-5, 5-10, 10-15, ... each labelled with its start second. */
function ladder(count: number, step = 5): Cue[] {
  return Array.from({ length: count }, (_, i) => ({
    start: i * step,
    dur: step,
    text: `t${i * step}`,
  }));
}

describe("slice", () => {
  it("takes the last 60s ending at the playhead", () => {
    const r = slice(ladder(40), 100, WINDOWS["capture-now"]);
    expect(r.startSec).toBe(40);
    expect(r.endSec).toBe(100);
    expect(r.text).toBe("t40 t45 t50 t55 t60 t65 t70 t75 t80 t85 t90 t95");
    expect(r.isEmpty).toBe(false);
  });

  it("capture-previous takes the 60s before that, with no overlap of new text", () => {
    const now = slice(ladder(40), 100, WINDOWS["capture-now"]);
    const prev = slice(ladder(40), 100, WINDOWS["capture-previous"]);
    expect(prev.startSec).toBe(0);
    expect(prev.endSec).toBe(40);
    expect(prev.text.startsWith("t0")).toBe(true);
    expect(prev.endSec).toBeLessThanOrEqual(now.startSec);
  });

  it("capture-long takes 3 minutes", () => {
    const r = slice(ladder(80), 400, WINDOWS["capture-long"]);
    expect(r.endSec - r.startSec).toBe(180);
  });

  it("clamps at the start of the video", () => {
    const r = slice(ladder(10), 20, WINDOWS["capture-now"]);
    expect(r.startSec).toBe(0);
    expect(r.endSec).toBe(20);
  });

  it("returns a 3-minute request on a 90s video without going negative", () => {
    const r = slice(ladder(18), 90, WINDOWS["capture-long"]);
    expect(r.startSec).toBe(0);
    expect(r.endSec).toBe(90);
    expect(r.isEmpty).toBe(false);
  });

  it("is empty when capture-previous reaches back before the video started", () => {
    const r = slice(ladder(10), 30, WINDOWS["capture-previous"]);
    expect(r.endSec).toBe(0);
    expect(r.isEmpty).toBe(true);
    expect(r.text).toBe("");
  });

  it("is empty across a caption gap (ad break, dead air)", () => {
    const cues: Cue[] = [
      { start: 0, dur: 5, text: "before the gap" },
      { start: 200, dur: 5, text: "after the gap" },
    ];
    const r = slice(cues, 100, WINDOWS["capture-now"]);
    expect(r.isEmpty).toBe(true);
    expect(r.text).toBe("");
  });

  it("includes a cue that began before the window but runs into it", () => {
    const cues: Cue[] = [{ start: 35, dur: 20, text: "a long sentence starting early" }];
    const r = slice(cues, 100, WINDOWS["capture-now"]); // window 40..100
    expect(r.text).toBe("a long sentence starting early");
  });

  it("excludes a cue that ends exactly at the window start", () => {
    const cues: Cue[] = [{ start: 30, dur: 10, text: "ends at 40" }];
    const r = slice(cues, 100, WINDOWS["capture-now"]); // window 40..100
    expect(r.isEmpty).toBe(true);
  });

  it("sorts cues that arrive out of order", () => {
    const cues: Cue[] = [
      { start: 90, dur: 5, text: "third" },
      { start: 50, dur: 5, text: "first" },
      { start: 70, dur: 5, text: "second" },
    ];
    expect(slice(cues, 100, WINDOWS["capture-now"]).text).toBe("first second third");
  });

  it("handles an empty cue list", () => {
    const r = slice([], 100, WINDOWS["capture-now"]);
    expect(r.isEmpty).toBe(true);
  });

  it("handles currentTime of 0", () => {
    const r = slice(ladder(10), 0, WINDOWS["capture-now"]);
    expect(r.isEmpty).toBe(true);
  });

  it("collapses whitespace and drops blank cues", () => {
    const cues: Cue[] = [
      { start: 50, dur: 5, text: "  spaced   out  " },
      { start: 55, dur: 5, text: "   " },
      { start: 60, dur: 5, text: "text" },
    ];
    expect(slice(cues, 100, WINDOWS["capture-now"]).text).toBe("spaced out text");
  });

  it("does not mutate the input", () => {
    const cues = [
      { start: 90, dur: 5, text: "b" },
      { start: 50, dur: 5, text: "a" },
    ];
    const before = JSON.stringify(cues);
    slice(cues, 100, WINDOWS["capture-now"]);
    expect(JSON.stringify(cues)).toBe(before);
  });
});

describe("evictOldCues", () => {
  it("keeps everything before the cap is reached", () => {
    expect(evictOldCues(ladder(10), 50, 1800)).toHaveLength(10);
  });

  it("drops cues older than the window", () => {
    const kept = evictOldCues(ladder(1000), 5000, 1800); // keep from 3200s on
    expect(kept.every((c) => c.start + c.dur >= 3200)).toBe(true);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(1000);
  });

  it("keeps enough history for the longest window plus the shift", () => {
    // Worst case a hotkey can ask for: back=60 + length=180 = 240s.
    const kept = evictOldCues(ladder(2000), 9000, 1800);
    const oldest = Math.min(...kept.map((c) => c.start));
    expect(9000 - oldest).toBeGreaterThan(240);
  });
});

describe("formatTimestamp", () => {
  it.each([
    [0, "0:00"],
    [9, "0:09"],
    [61, "1:01"],
    [1247.8, "20:47"],
    [3600, "1:00:00"],
    [3725, "1:02:05"],
    [-5, "0:00"],
  ])("formats %s as %s", (input, expected) => {
    expect(formatTimestamp(input)).toBe(expected);
  });
});

describe("deepLink", () => {
  it("appends a t= parameter", () => {
    expect(deepLink("https://www.youtube.com/watch?v=abc", 1247.8)).toBe(
      "https://www.youtube.com/watch?v=abc&t=1247s",
    );
  });

  it("replaces an existing t= parameter", () => {
    expect(deepLink("https://www.youtube.com/watch?v=abc&t=10s", 90)).toContain("t=90s");
  });

  it("returns the input unchanged when the url is unparseable", () => {
    expect(deepLink("not a url", 90)).toBe("not a url");
  });
});
