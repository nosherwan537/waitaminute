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
 *   - how you turn thinking DOWN changed between model generations, see below
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

/**
 * Pure. How to hold thinking down for one model, or `undefined` to say nothing.
 *
 * Gemini 2.5 thinks by DEFAULT, its thoughts are billed as output, and they are
 * drawn from the same `maxOutputTokens` budget as the note. Left alone, Flash
 * spent ~8k tokens and 30-40s deliberating over a transcript cleanup — a task
 * the premise defines as reconstruction, not judgement. Thoughts can also eat
 * the whole budget and return no text at all.
 *
 * There is NO single request shape that holds thinking down across generations,
 * which is why this is a function and not a constant:
 *
 *   - 2.x  `thinkingBudget: 0` switches thinking off outright.
 *   - 3.x  `thinkingBudget: 0` is a hard 400 INVALID_ARGUMENT — 3.x cannot turn
 *          thinking off at all, the same way 2.5 PRO could not. `thinkingLevel`
 *          is its replacement, and `"low"` is the floor. Measured on
 *          gemini-3.6-flash: no field 90 thought tokens, `"low"` 66.
 *
 * The model name is user-typed and drifts faster than this extension ships, so
 * an unrecognised name gets NO thinking field. That fails toward "works, costs
 * more" rather than a 400 mid-lecture — losing a capture is the expensive
 * failure here, spending extra tokens is the cheap one.
 */
export function thinkingConfigFor(model: string): Record<string, unknown> | undefined {
  const generation = /(?:^|[^0-9])gemini-([0-9]+)/i.exec(model)?.[1];
  if (generation === undefined) return undefined;
  const n = Number(generation);
  if (n >= 3) return { thinkingLevel: "low" };
  if (n >= 1) return { thinkingBudget: 0 };
  return undefined;
}

export const geminiAdapter: Adapter = {
  id: "gemini",

  buildRequest(target, req) {
    // encodeURIComponent: the model name is user-typed and lands in the path.
    const model = encodeURIComponent(target.model);
    const thinking = thinkingConfigFor(target.model);
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
          contents: [
            {
              role: "user",
              // Image FIRST, text second. Google's own guidance for
              // single-image prompts, and the text is what carries the
              // instructions about how to use the picture.
              parts: [
                ...(req.image
                  ? [{ inline_data: { mime_type: req.image.mimeType, data: req.image.dataBase64 } }]
                  : []),
                { text: req.user },
              ],
            },
          ],
          generationConfig: {
            maxOutputTokens: req.maxTokens,
            // See thinkingConfigFor: the shape depends on the model generation,
            // and the wrong one is a 400 rather than a slow note. Spread so an
            // unrecognised model sends no thinking field at all.
            ...(thinking ? { thinkingConfig: thinking } : {}),
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
