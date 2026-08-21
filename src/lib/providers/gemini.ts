import { shapeError, usageFrom, type Adapter } from "./types";

/**
 * Google's native `generateContent` API.
 *
 * Google also ships an OpenAI-compatible endpoint, which would have let Gemini
 * be a preset instead of an adapter. It isn't worth it: Google describes that
 * layer as a migration convenience rather than the primary API, Gemini's free
 * tier makes it a likely-popular choice here, and an adapter in this codebase is
 * two pure functions. Thirty lines beats depending on a compatibility shim we
 * don't control with no fallback.
 *
 * Shape differences from every other provider, all of them load-bearing:
 *   - the key rides in the `x-goog-api-key` header, not a bearer token
 *   - the model name is part of the URL path, not the body
 *   - the system prompt is `system_instruction`, a sibling of `contents`
 *   - text arrives as an array of parts that must be joined
 */

interface GeminiBody {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { message?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
}

export const geminiAdapter: Adapter = {
  id: "gemini",

  buildRequest(target, req) {
    // encodeURIComponent: the model name is user-typed and lands in the path.
    const model = encodeURIComponent(target.model);
    return {
      url: `${target.baseUrl}/models/${model}:generateContent`,
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": target.apiKey,
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: req.system }] },
          contents: [{ role: "user", parts: [{ text: req.user }] }],
          generationConfig: {
            maxOutputTokens: req.maxTokens,
            // Gemini 2.5 thinks by DEFAULT, and its thoughts are billed as
            // output and drawn from the same `maxOutputTokens` budget. Left
            // unset, Flash spent ~7-8k tokens and 30-40s deliberating over a
            // transcript cleanup — a task the premise defines as reconstruction,
            // not judgement. Worse, thoughts can eat the entire budget and
            // return zero text, which surfaces as "response contained no text".
            //
            // 0 disables thinking on Flash. Note that 2.5 PRO cannot disable it
            // (its floor is 128) and rejects 0 with a 400 — hence the preset
            // note steering to Flash for this task.
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      },
    };
  },

  extractText(body) {
    const res = body as GeminiBody;
    if (res.error?.message) throw shapeError("gemini", res.error.message);
    // A safety block returns 200 with no candidates at all.
    if (res.promptFeedback?.blockReason) {
      throw shapeError("gemini", `blocked: ${res.promptFeedback.blockReason}`);
    }
    const candidate = res.candidates?.[0];
    const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("");

    // Truncation is a 200 with a partial body. Parsing it as if complete is how
    // a half-written note reaches the doc looking finished — the failure mode
    // that is worse than an error, because nothing tells you it happened.
    if (candidate?.finishReason === "MAX_TOKENS") {
      throw shapeError("gemini", "the model ran out of output budget mid-note");
    }
    if (!text) throw shapeError("gemini", "response contained no text");
    return text;
  },

  extractUsage(body) {
    const usage = ((body ?? {}) as GeminiBody).usageMetadata;
    if (typeof usage?.candidatesTokenCount !== "number") return undefined;
    // Gemini reports thinking tokens SEPARATELY from candidate tokens, unlike
    // Anthropic. Both are billed as output, so leaving thoughts out would
    // under-report cost on any thinking model — silently, and by a lot.
    //
    // Thoughts default to 0 because a non-thinking model genuinely omits the
    // field. Candidates do NOT default: a missing count there means Gemini
    // said nothing, and defaulting it would report a billed call as free.
    const output = usage.candidatesTokenCount + (usage.thoughtsTokenCount ?? 0);
    return usageFrom(usage.promptTokenCount, output);
  },
};
