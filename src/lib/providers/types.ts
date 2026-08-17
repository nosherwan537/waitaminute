/**
 * Provider routing: three adapters, many presets.
 *
 * An ADAPTER is a wire format. There are only three that matter:
 *   - anthropic          Anthropic's Messages API
 *   - openai-compatible  the de-facto standard /chat/completions shape, which
 *                        OpenAI, OpenRouter, Groq, Together, DeepSeek, Ollama,
 *                        LM Studio and vLLM all speak
 *   - gemini             Google's generateContent API
 *
 * A PRESET is a service: a label, an adapter, a base URL, and a suggested model.
 * Adding a provider is a row in `presets.ts`, not a new adapter — that is the
 * whole point of the split.
 *
 * Adapters are PURE. They build a request and read a response; they never touch
 * the network. The fetch, the retries, and the mapping from HTTP status onto
 * PLAN.md's error registry live once in `call.ts`, so a 429 behaves identically
 * no matter who returned it. That also makes every adapter testable with no
 * network and no mocks.
 *
 * SECURITY: adapters run in the service worker only. The API key must never be
 * passed toward a content script or the MAIN world — see AGENTS.md.
 */

export type AdapterId = "anthropic" | "openai-compatible" | "gemini";

/** What the user configured on the options page. Lives in `chrome.storage.local`. */
export interface ProviderConfig {
  /** Which preset row was chosen. */
  presetId: string;
  apiKey: string;
  model: string;
  /** Set only for presets whose base URL the user supplies (Custom, Ollama). */
  baseUrl?: string;
}

/** A single-turn completion. No conversation state — each capture stands alone. */
export interface CompletionRequest {
  system: string;
  user: string;
  maxTokens: number;
}

/** The resolved target of a call: adapter + endpoint + credentials. */
export interface ResolvedTarget {
  adapter: AdapterId;
  /** No trailing slash. Empty for adapters with a fixed endpoint. */
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface Adapter {
  readonly id: AdapterId;
  /** Pure. Build the request; never perform it. */
  buildRequest(target: ResolvedTarget, req: CompletionRequest): { url: string; init: RequestInit };
  /** Pure. Pull the assistant's text out of a parsed response body. */
  extractText(body: unknown): string;
}

/** A service the user can pick. Adding one is a row in `presets.ts`. */
export interface Preset {
  readonly id: string;
  readonly label: string;
  readonly adapter: AdapterId;
  /** Fixed endpoint, or "" when the user supplies it. */
  readonly baseUrl: string;
  /**
   * Prefilled model name. ALWAYS editable in the UI: model names change far more
   * often than this extension ships, and a stale default must never be a dead end.
   */
  readonly defaultModel: string;
  /** Placeholder for the key field, so a pasted key can be eyeballed for shape. */
  readonly keyHint: string;
  /** Origin for `chrome.permissions.request`. Null when the user supplies the URL. */
  readonly origin: string | null;
  /** True when the user must type a base URL (Custom, Ollama). */
  readonly needsBaseUrl?: boolean;
  /** True for local servers that accept any key. Suppresses the "key required" error. */
  readonly keyOptional?: boolean;
  /** One line under the fields telling the user where to find their model list. */
  readonly note?: string;
}

/** Thrown by extractText when the body isn't the shape we expected. */
export function shapeError(adapter: AdapterId, detail: string): Error {
  return new Error(`${adapter}: ${detail}`);
}
