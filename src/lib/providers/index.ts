import { NamedError, errorForStatus } from "../errors";
import { anthropicAdapter } from "./anthropic";
import { openAiCompatibleAdapter } from "./openai";
import { geminiAdapter } from "./gemini";
import { findPreset } from "./presets";
import type {
  Adapter,
  AdapterId,
  CompletionRequest,
  ProviderConfig,
  ResolvedTarget,
  TokenUsage,
} from "./types";

export * from "./types";
export { PRESETS, DEFAULT_PRESET_ID, findPreset } from "./presets";
export { resolveTranscription, transcribe, buildTranscriptionForm } from "./transcribe";
export type { TranscriptionTarget } from "./transcribe";

const ADAPTERS: Record<AdapterId, Adapter> = {
  anthropic: anthropicAdapter,
  "openai-compatible": openAiCompatibleAdapter,
  gemini: geminiAdapter,
};

/** Trailing slashes produce `//chat/completions`, which some servers 404. */
function trimUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Turn stored settings into a callable target. Pure, so the validation rules are
 * testable without a network or a fake `chrome`.
 *
 * Throws `ApiKeyMissing` rather than letting an unconfigured extension fire a
 * doomed request — the toast tells the user to open options, which is the only
 * useful thing to say.
 */
export function resolveTarget(config: ProviderConfig): ResolvedTarget {
  const preset = findPreset(config.presetId);

  if (!config.apiKey && !preset.keyOptional) {
    throw new NamedError("ApiKeyMissing", "Add your API key in settings");
  }
  const model = config.model.trim() || preset.defaultModel;
  if (!model) {
    throw new NamedError("ModelNotFound", "Choose a model in settings");
  }

  const baseUrl = trimUrl((preset.needsBaseUrl ? config.baseUrl : preset.baseUrl) ?? "");
  if (!baseUrl && preset.adapter !== "anthropic") {
    throw new NamedError("ModelNotFound", "Add the server URL in settings");
  }

  return { adapter: preset.adapter, baseUrl, apiKey: config.apiKey, model };
}

/** Origin to request via `chrome.permissions.request`, derived from the live config. */
export function originFor(config: ProviderConfig): string | null {
  const preset = findPreset(config.presetId);
  if (preset.origin) return preset.origin;
  try {
    return `${new URL(config.baseUrl ?? "").origin}/*`;
  } catch {
    return null;
  }
}

/**
 * Perform one completion, with the retry policy from PLAN.md's error registry:
 * backoff 2s then 4s for RateLimited and ProviderUnavailable, two retries, then
 * give up. Everything else fails immediately — retrying a bad key wastes the
 * user's time and tells them nothing new.
 *
 * Returns the text alongside whatever token counts the provider volunteered.
 * Usage is best-effort: it feeds the capture log, and a provider that stays
 * silent about tokens must still produce a note.
 *
 * SECURITY: this runs in the service worker. `target.apiKey` must never travel
 * anywhere else.
 */
/**
 * No provider call may hang forever. Without this the toast sits on
 * "Noting that..." with no error and no timeout — the exact silent failure
 * premise 8 forbids, and indistinguishable from a crash to the user.
 */
export const TIMEOUT_MS = 45_000;

export interface Completion {
  text: string;
  usage?: TokenUsage;
}

export async function complete(
  target: ResolvedTarget,
  req: CompletionRequest,
  sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
): Promise<Completion> {
  const adapter = ADAPTERS[target.adapter];

  const BACKOFF_MS = [2000, 4000];
  let lastError: NamedError | undefined;

  let attempt = 0;

  while (attempt <= BACKOFF_MS.length) {
    if (attempt > 0) await sleep(BACKOFF_MS[attempt - 1]!);
    const { url, init } = adapter.buildRequest(target, req);

    // A fresh signal per attempt: an aborted one stays aborted, so a reused
    // signal would fail every retry instantly.
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: abort.signal });
    } catch (cause) {
      // A timeout is NOT retried. Retrying would put the user in front of a
      // motionless toast for minutes; premise 7 says they are still watching,
      // so an honest failure they can act on beats a long silent wait.
      if (abort.signal.aborted) {
        throw new NamedError(
          "ProviderTimeout",
          `${target.model} didn't respond — try again`,
          false,
          cause,
        );
      }
      // fetch rejects only on network failure. Nothing to retry against here:
      // the queue-and-replay path in the registry owns this case.
      throw new NamedError("NetworkUnavailable", "Offline — note not saved", false, cause);
    } finally {
      // Always cleared: a live timer holds the service worker awake, and an
      // abort firing after the response lands would reject the next read.
      clearTimeout(timer);
    }

    if (!response.ok) {
      const error = errorForStatus(response.status, await response.text().catch(() => ""));
      // Dropping a rejected frame is NOT handled here. It is a `generateNote`
      // decision, because the prompt has to change with it — see the comment
      // on `retryWithoutFrame`.
      if (!error.retryable) throw error;
      lastError = error;
      attempt += 1;
      continue;
    }

    let body: unknown;
    let text: string;
    try {
      body = await response.json();
      text = adapter.extractText(body);
    } catch (cause) {
      throw new NamedError(
        "MalformedNoteResponse",
        "The model returned something unusable",
        false,
        cause,
      );
    }

    // Outside the try on purpose. `extractUsage` is contractually non-throwing,
    // but if one ever did, a missing token count must not turn a good note into
    // a MalformedNoteResponse.
    let usage: TokenUsage | undefined;
    try {
      usage = adapter.extractUsage(body);
    } catch (cause) {
      console.warn("[waitaminute] usage extraction failed", cause);
    }

    return { text, usage };
  }

  throw lastError ?? new NamedError("ProviderUnavailable", "Provider unreachable", false);
}
