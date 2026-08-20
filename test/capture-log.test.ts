import { describe, it, expect } from "vitest";
import {
  estimateCost,
  formatCost,
  summarize,
  withLogRetention,
  MAX_LOG,
  ZERO_RATES,
  type LogEntry,
  type Rates,
} from "../src/lib/capture-log";

function entry(over: Partial<LogEntry> = {}): LogEntry {
  return {
    id: 1000,
    command: "capture-now",
    source: "captions",
    latencyMs: 5000,
    outcome: "ok",
    usage: { input: 1000, output: 500 },
    model: "claude-opus-5",
    videoTitle: "V",
    ...over,
  };
}

const RATES: Rates = { inputPerMTok: 3, outputPerMTok: 15 };

describe("estimateCost", () => {
  it("prices input and output separately", () => {
    // 1000 in @ $3/Mtok = $0.003, 500 out @ $15/Mtok = $0.0075
    expect(estimateCost({ input: 1000, output: 500 }, RATES)).toBeCloseTo(0.0105, 10);
  });

  it("is null when the provider reported no usage", () => {
    // Not 0: an unpriced call must never render as a free one.
    expect(estimateCost(undefined, RATES)).toBeNull();
  });

  it("is null when the user has not entered rates", () => {
    expect(estimateCost({ input: 1000, output: 500 }, ZERO_RATES)).toBeNull();
  });

  it("prices when only one side of the rate is set", () => {
    expect(estimateCost({ input: 1_000_000, output: 99 }, { inputPerMTok: 3, outputPerMTok: 0 }))
      .toBeCloseTo(3, 10);
  });
});

describe("formatCost", () => {
  it("shows four places for sub-cent notes, which is the normal case", () => {
    expect(formatCost(0.0004)).toBe("$0.0004");
  });

  it("shows two places once a figure is worth reading in cents", () => {
    expect(formatCost(1.5)).toBe("$1.50");
  });

  it("renders unknown as a dash, never as zero", () => {
    expect(formatCost(null)).toBe("—");
  });

  it("renders a true zero as $0.00", () => {
    expect(formatCost(0)).toBe("$0.00");
  });
});

describe("withLogRetention", () => {
  it("sorts newest first", () => {
    const out = withLogRetention([entry({ id: 1 }), entry({ id: 3 }), entry({ id: 2 })]);
    expect(out.map((e) => e.id)).toEqual([3, 2, 1]);
  });

  it("caps at MAX_LOG and drops the oldest", () => {
    const many = Array.from({ length: MAX_LOG + 10 }, (_, i) => entry({ id: i }));
    const out = withLogRetention(many);
    expect(out).toHaveLength(MAX_LOG);
    expect(out[0]!.id).toBe(MAX_LOG + 9);
    expect(out.at(-1)!.id).toBe(10);
  });

  it("does not mutate its input", () => {
    const input = [entry({ id: 1 }), entry({ id: 2 })];
    withLogRetention(input);
    expect(input.map((e) => e.id)).toEqual([1, 2]);
  });
});

describe("summarize", () => {
  it("counts failures by registry name, worst first", () => {
    const out = summarize(
      [
        entry({ outcome: "ok" }),
        entry({ outcome: "NothingToNote" }),
        entry({ outcome: "NothingToNote" }),
        entry({ outcome: "RateLimited" }),
      ],
      ZERO_RATES,
    );
    expect(out.total).toBe(4);
    expect(out.ok).toBe(1);
    expect(out.failures).toEqual([
      ["NothingToNote", 2],
      ["RateLimited", 1],
    ]);
  });

  it("uses the median so one retry storm does not distort the typical press", () => {
    const out = summarize(
      [1000, 1200, 1100, 30000].map((latencyMs) => entry({ latencyMs })),
      ZERO_RATES,
    );
    // Mean would be 8325ms and would read as "this tool is slow".
    expect(out.medianLatencyMs).toBe(1150);
  });

  it("takes the middle value on an odd count", () => {
    const out = summarize([1000, 5000, 9000].map((latencyMs) => entry({ latencyMs })), ZERO_RATES);
    expect(out.medianLatencyMs).toBe(5000);
  });

  it("reports null latency and cost for an empty log", () => {
    const out = summarize([], RATES);
    expect(out).toEqual({
      total: 0,
      ok: 0,
      failures: [],
      medianLatencyMs: null,
      totalCost: null,
    });
  });

  it("totals cost across only the entries that can be priced", () => {
    const out = summarize(
      [entry(), entry({ usage: undefined, outcome: "ApiKeyMissing" }), entry()],
      RATES,
    );
    expect(out.totalCost).toBeCloseTo(0.021, 10);
  });

  it("leaves total cost unknown when nothing could be priced", () => {
    // The failure this guards: reporting "$0.00 spent" while every call was
    // billed, because the user never entered a rate.
    expect(summarize([entry(), entry()], ZERO_RATES).totalCost).toBeNull();
  });
});
