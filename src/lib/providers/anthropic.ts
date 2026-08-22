import { shapeError, usageFrom, type Adapter } from "./types";

/**
 * Anthropic Messages API.
 *
 * Three details that are easy to get wrong and fail loudly:
 *
 *   1. `anthropic-dangerous-direct-browser-access` is required to reach the API
 *      from a browser context at all; without it the request is CORS-blocked.
 *      The scary name is about shipping keys to untrusted pages — here the key
 *      lives in the service worker and never reaches the page, which is exactly
 *      the case the flag exists for.
 *   2. `temperature` / `top_p` / `top_k` are REJECTED with a 400 on current
 *      models. Steer with the prompt, not with sampling.
 *   3. `max_tokens` caps thinking AND response text together. Thinking is on by
 *      default, so the budget has to cover both; `effort: "low"` keeps the
 *      thinking share small, which is right for a cleanup pass.
 */

interface AnthropicBody {
  content?: Array<{ type?: string; text?: string }>;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export const anthropicAdapter: Adapter = {
  id: "anthropic",

  buildRequest(target, req) {
    return {
      url: "https://api.anthropic.com/v1/messages",
      init: {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": target.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: target.model,
          max_tokens: req.maxTokens,
          system: req.system,
          // Cleanup is a shallow task. Low effort keeps spend down without the
          // failure modes that come from disabling thinking outright.
          output_config: { effort: "low" },
          messages: [
            {
              role: "user",
              // A bare string when there is no frame: the block form is
              // equivalent, but the string form is what every older model and
              // proxy in front of this API is certain to accept.
              content: req.image
                ? [
                    {
                      type: "image",
                      source: {
                        type: "base64",
                        media_type: req.image.mimeType,
                        data: req.image.dataBase64,
                      },
                    },
                    { type: "text", text: req.user },
                  ]
                : req.user,
            },
          ],
        }),
      },
    };
  },

  extractText(body) {
    const res = body as AnthropicBody;
    // A safety refusal is a successful 200 with an empty content array. Treating
    // it as a shape failure surfaces it instead of writing an empty note.
    if (res.stop_reason === "refusal") {
      throw shapeError("anthropic", "the model declined this transcript");
    }
    const text = (res.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("");
    if (!text) throw shapeError("anthropic", "response contained no text");
    return text;
  },

  extractUsage(body) {
    // `output_tokens` already includes thinking tokens, which are billed as
    // output — no separate field to add in.
    const usage = ((body ?? {}) as AnthropicBody).usage;
    return usageFrom(usage?.input_tokens, usage?.output_tokens);
  },
};
