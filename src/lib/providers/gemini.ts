import { shapeError, type Adapter } from "./types";

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
          generationConfig: { maxOutputTokens: req.maxTokens },
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
    const text = (res.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? "")
      .join("");
    if (!text) throw shapeError("gemini", "response contained no text");
    return text;
  },
};
