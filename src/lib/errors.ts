/**
 * Named errors from PLAN.md's error registry.
 *
 * The registry is the contract: every failure path maps to one of these names,
 * and every name maps to a toast the user can act on. A raw `throw new Error(...)`
 * anywhere in the capture path is a bug — it becomes a silent failure, which
 * premise 8 forbids.
 */

export type ErrorName =
  | "PageNeedsReload"
  | "CaptionsUnavailable"
  | "CaptionsNotEnglish"
  | "EmptySlice"
  | "ApiKeyMissing"
  | "ApiKeyInvalid"
  | "ModelNotFound"
  | "RateLimited"
  | "ProviderUnavailable"
  | "NetworkUnavailable"
  | "ProviderTimeout"
  | "MalformedNoteResponse"
  | "NothingToNote"
  | "LocalWriteFailed"
  | "PermissionDenied"
  | "NotAuthorized"
  | "AuthCancelled"
  | "DocMissing"
  | "DocsQuotaExceeded"
  | "DocsWriteFailed";

export class NamedError extends Error {
  constructor(
    readonly name_: ErrorName,
    /** What the toast says. Must be actionable — the user reads only this. */
    readonly userMessage: string,
    /** True when a retry with backoff might succeed. */
    readonly retryable = false,
    /** Provider detail for the console. Never shown to the user. */
    override readonly cause?: unknown,
  ) {
    super(`${name_}: ${userMessage}`);
    this.name = name_;
  }
}

export function isNamedError(e: unknown): e is NamedError {
  return e instanceof NamedError;
}

/**
 * Map an HTTP status onto the registry. Shared by every provider so a 429 from
 * Gemini behaves exactly like a 429 from Anthropic.
 */
export function errorForStatus(status: number, body: string): NamedError {
  const detail = body.slice(0, 500);
  switch (true) {
    case status === 401 || status === 403:
      return new NamedError("ApiKeyInvalid", "Check your API key", false, detail);
    case status === 404:
      return new NamedError("ModelNotFound", "That model name isn't valid", false, detail);
    case status === 429:
      return new NamedError("RateLimited", "Rate limited, retrying...", true, detail);
    case status >= 500:
      return new NamedError("ProviderUnavailable", "Provider down, retrying...", true, detail);
    default:
      return new NamedError(
        "MalformedNoteResponse",
        "The model rejected that request",
        false,
        detail,
      );
  }
}
