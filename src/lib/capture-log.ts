import type { CommandName } from "../types";
import type { TokenUsage } from "./providers/types";

export type { TokenUsage };

/**
 * The capture log — the dogfooding instrument PLAN.md step 9 asks for.
 *
 * Every hotkey press lands here, INCLUDING the ones that produced no note. That
 * is the whole point. The three questions two weeks of real use has to answer
 * are all about failures:
 *
 *   - does the prompt return `takeaway: null` during ads, or confabulate?
 *     Only visible as a run of `NothingToNote` outcomes lining up with ad breaks.
 *   - are the preset model names still current? Shows up as `ModelNotFound`.
 *   - is the tool actually fast enough to press and keep watching? `latencyMs`.
 *
 * A log of successes only would answer none of them. So the log is written on
 * every path, and the outcome field carries the error registry name verbatim.
 *
 * Storage is separate from `notes`: notes are the product, this is telemetry
 * about the product, and clearing one must never clear the other.
 */

/**
 * `"ok"`, or an `ErrorName` from the registry. Deliberately typed as a plain
 * string rather than `"ok" | ErrorName`: entries are read back from storage
 * written by an older version of the extension, and a narrowed union would be a
 * lie about data that is already on disk.
 */
export type Outcome = string;

export interface LogEntry {
  /** Capture time in ms. Also the sort key. */
  id: number;
  command: CommandName;
  /** Which TranscriptSource produced the slice. `"audio"` arrives in step 11. */
  source: "captions" | "audio";
  /** Hotkey press to final outcome, including retries and the disk write. */
  latencyMs: number;
  outcome: Outcome;
  /** Undefined when the call never reached a provider, or the provider was silent. */
  usage?: TokenUsage;
  /** Resolved model, not the configured one — they differ when a preset default fills in. */
  model: string;
  /**
   * True when a video frame was attached AND the provider accepted it
   * (PLAN.md step 12). Absent means caption-only, which is also what a rejected
   * frame produces — so a column of blanks with the setting switched on is the
   * signal that the chosen model does not take images.
   */
  frame?: boolean;
  videoTitle: string;
}

/** PLAN.md says the last 50 captures. Enough to review a study session, small enough to read. */
export const MAX_LOG = 50;

/**
 * What the user pays per million tokens.
 *
 * These are USER-SUPPLIED, not a built-in price table, and that is a deliberate
 * call. Prices drift as fast as model names do — but a stale model name fails
 * loudly with `ModelNotFound`, while a stale price silently reports a confident
 * wrong number. Prompt caching and tiered pricing would make a naive table wrong
 * even on the day it shipped. Tokens come off the wire and are always true; the
 * dollar conversion is the user's own rate, entered once.
 */
export interface Rates {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const ZERO_RATES: Rates = { inputPerMTok: 0, outputPerMTok: 0 };

/**
 * Pure. Dollars for one entry, or null when it cannot be known — no usage
 * reported, or no rates entered. Null means "unknown" and must render as such;
 * showing $0.00 for an unpriced call would read as "this was free".
 */
export function estimateCost(usage: TokenUsage | undefined, rates: Rates): number | null {
  if (!usage) return null;
  if (rates.inputPerMTok <= 0 && rates.outputPerMTok <= 0) return null;
  const perToken = (perM: number) => perM / 1_000_000;
  return usage.input * perToken(rates.inputPerMTok) + usage.output * perToken(rates.outputPerMTok);
}

/** Pure. Fractions of a cent matter here: one note can cost $0.0004. */
export function formatCost(dollars: number | null): string {
  if (dollars === null) return "—";
  return dollars < 0.01 && dollars > 0 ? `$${dollars.toFixed(4)}` : `$${dollars.toFixed(2)}`;
}

/** Pure. Newest first, capped. */
export function withLogRetention(entries: readonly LogEntry[]): LogEntry[] {
  return [...entries].sort((a, b) => b.id - a.id).slice(0, MAX_LOG);
}

export interface LogSummary {
  total: number;
  ok: number;
  /** Outcome name → count, worst-first by count. Excludes `"ok"`. */
  failures: Array<[Outcome, number]>;
  /** Median, not mean: one 30s retry storm must not distort the typical press. */
  medianLatencyMs: number | null;
  /** Null when nothing in the window could be priced. */
  totalCost: number | null;
}

/**
 * Pure. The read-at-a-glance version.
 *
 * `NothingToNote` sitting near the top of `failures` is the answer to the
 * confabulation question, and it is only legible as a rate.
 */
export function summarize(entries: readonly LogEntry[], rates: Rates): LogSummary {
  const counts = new Map<Outcome, number>();
  let ok = 0;
  let totalCost: number | null = null;

  for (const entry of entries) {
    if (entry.outcome === "ok") ok += 1;
    else counts.set(entry.outcome, (counts.get(entry.outcome) ?? 0) + 1);

    const cost = estimateCost(entry.usage, rates);
    if (cost !== null) totalCost = (totalCost ?? 0) + cost;
  }

  const latencies = entries.map((e) => e.latencyMs).sort((a, b) => a - b);
  const mid = Math.floor(latencies.length / 2);
  const medianLatencyMs =
    latencies.length === 0
      ? null
      : latencies.length % 2 === 1
        ? latencies[mid]!
        : Math.round((latencies[mid - 1]! + latencies[mid]!) / 2);

  return {
    total: entries.length,
    ok,
    failures: [...counts.entries()].sort((a, b) => b[1] - a[1]),
    medianLatencyMs,
    totalCost,
  };
}

export async function readLog(): Promise<LogEntry[]> {
  const { captureLog = [] } = (await chrome.storage.local.get("captureLog")) as {
    captureLog?: LogEntry[];
  };
  return captureLog;
}

/**
 * Append one entry. Never throws: telemetry that can fail a capture is worse
 * than no telemetry, and this runs on the error path too, where a second throw
 * would swallow the real error before the user ever sees the toast.
 */
export async function appendLog(entry: LogEntry): Promise<void> {
  try {
    const captureLog = withLogRetention([entry, ...(await readLog())]);
    await chrome.storage.local.set({ captureLog });
  } catch (cause) {
    console.warn("[heystop] capture log write failed", cause);
  }
}

export async function readRates(): Promise<Rates> {
  const { rates } = (await chrome.storage.local.get("rates")) as { rates?: Partial<Rates> };
  return { ...ZERO_RATES, ...rates };
}

export async function clearLog(): Promise<void> {
  await chrome.storage.local.remove("captureLog");
}
