import { shapeError, usageFrom, type Adapter } from "./types";

/**
 * The OpenAI `/chat/completions` shape — the de-facto standard.
 *
 * This one adapter is why the extension isn't locked to anybody: OpenAI,
 * OpenRouter, Groq, Together, DeepSeek, Fireworks, Ollama, LM Studio and vLLM
 * all speak it. A new service is a row in `presets.ts`, not code.
 *
 * Two compatibility notes that decide how the body is built:
 *
 *   - `max_tokens` vs `max_completion_tokens`: newer OpenAI models want the
 *     latter, but most third-party and local servers only understand the former.
 *     We send `max_tokens`, which every implementation accepts, including
 *     OpenAI's own for the models a BYOK user is realistically pointing at.
 *   - `response_format: {type: "json_object"}` is NOT sent. Support is uneven
 *     across compatible servers and a rejection there is a hard failure for the
 *     whole capture. The prompt asks for JSON and `parseNote` repairs what comes
 *     back, which works everywhere.
 */

interface OpenAIBody {
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>;
  error?: { message?: string };
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export const openAiCompatibleAdapter: Adapter = {
  id: "openai-compatible",

  buildRequest(target, req) {
    return {
      url: `${target.baseUrl}/chat/completions`,
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Local servers accept any bearer, so send one unconditionally rather
          // than branching on whether a key was supplied.
          authorization: `Bearer ${target.apiKey || "none"}`,
        },
        body: JSON.stringify({
          model: target.model,
          max_tokens: req.maxTokens,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
        }),
      },
    };
  },

  extractText(body) {
    const res = body as OpenAIBody;
    // Some compatible servers return 200 with an error payload instead of a
    // 4xx. Without this check that surfaces as a confusing empty note.
    if (res.error?.message) throw shapeError("openai-compatible", res.error.message);
    const text = res.choices?.[0]?.message?.content;
    if (!text) throw shapeError("openai-compatible", "response contained no text");
    return text;
  },

  extractUsage(body) {
    // Many compatible servers — local ones especially — omit `usage` entirely.
    // That is why the field is optional the whole way down.
    const usage = ((body ?? {}) as OpenAIBody).usage;
    return usageFrom(usage?.prompt_tokens, usage?.completion_tokens);
  },
};
