import { describe, it, expect } from "vitest";
import { parseTimestamp, parseVtt, stripCueMarkup } from "../src/lib/vtt";

describe("parseTimestamp", () => {
  it("reads a two-part stamp as minutes:seconds, not hours:minutes", () => {
    // The failure this guards: reading 01:30.000 as 1h30m puts every cue an
    // hour and a half past the playhead, and every capture comes back empty.
    expect(parseTimestamp("01:30.000")).toBe(90);
  });

  it("reads a three-part stamp with hours", () => {
    expect(parseTimestamp("01:02:03.500")).toBe(3723.5);
  });

  it("accepts hours above 99, which long lectures actually reach", () => {
    expect(parseTimestamp("100:00:00.000")).toBe(360000);
  });

  it("pads truncated milliseconds rather than misreading them", () => {
    // ".5" is half a second, not five milliseconds.
    expect(parseTimestamp("00:00:01.5")).toBe(1.5);
  });

  it("accepts the comma decimal separator some tools emit", () => {
    expect(parseTimestamp("00:00:01,250")).toBe(1.25);
  });

  it("returns null for anything that is not a timestamp", () => {
    for (const junk of ["", "cue-7", "-->", "abc:de.fgh", "1.5"]) {
      expect(parseTimestamp(junk)).toBeNull();
    }
  });

  it("accepts a stamp with no milliseconds, which SRT-derived files omit", () => {
    // Lenient on purpose, and safe: parseTimestamp is only ever reached from a
    // line already known to contain "-->", never from a cue identifier.
    expect(parseTimestamp("00:00")).toBe(0);
    expect(parseTimestamp("02:30")).toBe(150);
  });
});

describe("stripCueMarkup", () => {
  it("removes voice spans and formatting but keeps the words", () => {
    expect(stripCueMarkup("<v Ana>The <b>chain</b> rule</v>")).toBe("The chain rule");
  });

  it("removes karaoke timestamps embedded in the payload", () => {
    expect(stripCueMarkup("the<00:00:01.000> chain<00:00:01.500> rule")).toBe("the chain rule");
  });

  it("decodes the entities WebVTT requires to be escaped", () => {
    expect(stripCueMarkup("a &lt;tag&gt; &amp; more")).toBe("a <tag> & more");
  });

  it("collapses the whitespace left behind by stripping", () => {
    expect(stripCueMarkup("  two   <i>  </i> words \n")).toBe("two words");
  });
});

describe("parseVtt", () => {
  const FILE = [
    "WEBVTT",
    "",
    "NOTE This file was machine generated",
    "and the note runs over two lines",
    "",
    "1",
    "00:00:01.000 --> 00:00:04.000 line:0 align:start",
    "Backpropagation is just",
    "the chain rule.",
    "",
    "00:01:00.500 --> 00:01:02.000",
    "<v Ana>Nothing more.</v>",
  ].join("\n");

  it("parses cues with and without identifier lines", () => {
    expect(parseVtt(FILE)).toEqual([
      { start: 1, dur: 3, text: "Backpropagation is just the chain rule." },
      { start: 60.5, dur: 1.5, text: "Nothing more." },
    ]);
  });

  it("does not read cue settings as a timestamp", () => {
    // `line:0` after the end stamp would otherwise poison the end time.
    expect(parseVtt(FILE)[0]!.dur).toBe(3);
  });

  it("skips NOTE, STYLE and REGION blocks whole", () => {
    const withBlocks = [
      "WEBVTT",
      "",
      "STYLE",
      "::cue { color: peachpuff }",
      "",
      "REGION",
      "id:speaker width:40%",
      "",
      "00:00:01.000 --> 00:00:02.000",
      "Only this.",
    ].join("\n");
    expect(parseVtt(withBlocks)).toEqual([{ start: 1, dur: 1, text: "Only this." }]);
  });

  it("handles CRLF files", () => {
    // Without normalizing first, the blank-line split never matches and the
    // whole file parses as one block.
    expect(parseVtt(FILE.replace(/\n/g, "\r\n"))).toHaveLength(2);
  });

  it("skips one malformed cue instead of losing the whole lecture", () => {
    const damaged = [
      "WEBVTT",
      "",
      "00:00:0X.000 --> 00:00:02.000",
      "Broken.",
      "",
      "00:00:03.000 --> 00:00:04.000",
      "Fine.",
    ].join("\n");
    expect(parseVtt(damaged)).toEqual([{ start: 3, dur: 1, text: "Fine." }]);
  });

  it("drops a cue whose end precedes its start", () => {
    expect(parseVtt("WEBVTT\n\n00:00:05.000 --> 00:00:02.000\nBackwards.")).toEqual([]);
  });

  it("drops cues with an empty payload rather than emitting blank text", () => {
    expect(parseVtt("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<i> </i>")).toEqual([]);
  });

  it("returns nothing for an empty or header-only file", () => {
    expect(parseVtt("")).toEqual([]);
    expect(parseVtt("WEBVTT")).toEqual([]);
  });
});
