import { describe, it, expect, vi } from "vitest";
import { anthropicAdapter } from "../src/lib/providers/anthropic";
import { openAiCompatibleAdapter } from "../src/lib/providers/openai";
import { geminiAdapter } from "../src/lib/providers/gemini";
import { PRESETS, resolveTarget, originFor, complete } from "../src/lib/providers";
import type { ProviderConfig, ResolvedTarget } from "../src/lib/providers";
import { NamedError } from "../src/lib/errors";

const REQ = { system: "sys", user: "usr", maxTokens: 4096 };

function target(over: Partial<ResolvedTarget> = {}): ResolvedTarget {
  return { adapter: "anthropic", baseUrl: "", apiKey: "k", model: "m", ...over };
}

function bodyOf(init: RequestInit): Record<string, unknown> {
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe("anthropic adapter", () => {
  it("sends the key as x-api-key with the version header", () => {
    const { url, init } = anthropicAdapter.buildRequest(target({ apiKey: "sk-ant-x" }), REQ);
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-x");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("sets the browser-access header, without which the call is CORS-blocked", () => {
    const { init } = anthropicAdapter.buildRequest(target(), REQ);
    const headers = init.headers as Record<string, string>;
    expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
  });

  it("never sends sampling parameters, which current models reject with a 400", () => {
    const body = bodyOf(anthropicAdapter.buildRequest(target(), REQ).init);
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("top_k");
  });

  it("puts the system prompt in the top-level field, not in messages", () => {
    const body = bodyOf(anthropicAdapter.buildRequest(target(), REQ).init);
    expect(body["system"]).toBe("sys");
    expect(body["messages"]).toEqual([{ role: "user", content: "usr" }]);
  });

  it("extracts and concatenates text blocks", () => {
    const text = anthropicAdapter.extractText({
      content: [
        { type: "thinking", thinking: "..." },
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
    });
    expect(text).toBe("ab");
  });

  it("throws on a refusal rather than returning an empty note", () => {
    expect(() => anthropicAdapter.extractText({ stop_reason: "refusal", content: [] })).toThrow(
      /declined/,
    );
  });

  it("throws when there is no text at all", () => {
    expect(() => anthropicAdapter.extractText({ content: [] })).toThrow(/no text/);
  });
});

describe("openai-compatible adapter", () => {
  it("appends /chat/completions to the base url", () => {
    const { url } = openAiCompatibleAdapter.buildRequest(
      target({ adapter: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1" }),
      REQ,
    );
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
  });

  it("sends the key as a bearer token", () => {
    const { init } = openAiCompatibleAdapter.buildRequest(target({ apiKey: "sk-x" }), REQ);
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer sk-x");
  });

  it("still sends a bearer when no key is set, for local servers", () => {
    const { init } = openAiCompatibleAdapter.buildRequest(target({ apiKey: "" }), REQ);
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer none");
  });

  it("uses max_tokens, which every compatible server understands", () => {
    const body = bodyOf(openAiCompatibleAdapter.buildRequest(target(), REQ).init);
    expect(body["max_tokens"]).toBe(4096);
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it("does not request a json response_format, which support for is uneven", () => {
    const body = bodyOf(openAiCompatibleAdapter.buildRequest(target(), REQ).init);
    expect(body).not.toHaveProperty("response_format");
  });

  it("puts the system prompt in the messages array", () => {
    const body = bodyOf(openAiCompatibleAdapter.buildRequest(target(), REQ).init);
    expect(body["messages"]).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "usr" },
    ]);
  });

  it("extracts the first choice", () => {
    expect(
      openAiCompatibleAdapter.extractText({ choices: [{ message: { content: "hi" } }] }),
    ).toBe("hi");
  });

  it("surfaces an error payload returned with a 200", () => {
    expect(() =>
      openAiCompatibleAdapter.extractText({ error: { message: "model not found" } }),
    ).toThrow(/model not found/);
  });

  it("throws on a null content, which some servers return on a refusal", () => {
    expect(() =>
      openAiCompatibleAdapter.extractText({ choices: [{ message: { content: null } }] }),
    ).toThrow(/no text/);
  });
});

describe("gemini adapter", () => {
  it("puts the model in the path and the key in x-goog-api-key", () => {
    const { url, init } = geminiAdapter.buildRequest(
      target({
        adapter: "gemini",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        model: "gemini-2.5-flash",
        apiKey: "AIza-x",
      }),
      REQ,
    );
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("AIza-x");
  });

  it("url-encodes a user-typed model name before it reaches the path", () => {
    const { url } = geminiAdapter.buildRequest(
      target({ adapter: "gemini", baseUrl: "https://x/v1", model: "a/b c" }),
      REQ,
    );
    expect(url).toContain("models/a%2Fb%20c:generateContent");
  });

  it("uses system_instruction rather than a system turn", () => {
    const body = bodyOf(geminiAdapter.buildRequest(target({ adapter: "gemini" }), REQ).init);
    expect(body["system_instruction"]).toEqual({ parts: [{ text: "sys" }] });
    expect(body["contents"]).toEqual([{ role: "user", parts: [{ text: "usr" }] }]);
  });

  it("joins the parts of the first candidate", () => {
    expect(
      geminiAdapter.extractText({
        candidates: [{ content: { parts: [{ text: "a" }, { text: "b" }] } }],
      }),
    ).toBe("ab");
  });

  it("surfaces a safety block, which arrives as a 200 with no candidates", () => {
    expect(() => geminiAdapter.extractText({ promptFeedback: { blockReason: "SAFETY" } })).toThrow(
      /SAFETY/,
    );
  });
});

describe("extractUsage", () => {
  it("reads Anthropic's input/output token counts", () => {
    expect(
      anthropicAdapter.extractUsage({ usage: { input_tokens: 1200, output_tokens: 300 } }),
    ).toEqual({ input: 1200, output: 300 });
  });

  it("reads the OpenAI-compatible prompt/completion names", () => {
    expect(
      openAiCompatibleAdapter.extractUsage({
        usage: { prompt_tokens: 1200, completion_tokens: 300 },
      }),
    ).toEqual({ input: 1200, output: 300 });
  });

  it("adds Gemini's thinking tokens into output, since both are billed as output", () => {
    // The failure this guards: Gemini reports thoughts SEPARATELY from
    // candidates. Reading candidatesTokenCount alone under-reports the bill on
    // any thinking model — silently, and by a large factor.
    expect(
      geminiAdapter.extractUsage({
        usageMetadata: {
          promptTokenCount: 1200,
          candidatesTokenCount: 300,
          thoughtsTokenCount: 900,
        },
      }),
    ).toEqual({ input: 1200, output: 1200 });
  });

  it("handles Gemini responses with no thinking tokens", () => {
    expect(
      geminiAdapter.extractUsage({
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      }),
    ).toEqual({ input: 10, output: 5 });
  });

  for (const [name, adapter] of [
    ["anthropic", anthropicAdapter],
    ["openai-compatible", openAiCompatibleAdapter],
    ["gemini", geminiAdapter],
  ] as const) {
    describe(name, () => {
      // The contract in types.ts: extractUsage MUST NOT throw. It runs on every
      // successful capture, and telemetry may never be why a note is lost.
      for (const [label, body] of [
        ["a missing usage block", {}],
        ["null", null],
        ["a string body", "nonsense"],
        ["a half-reported usage block", { usage: { input_tokens: 5 }, usageMetadata: { promptTokenCount: 5 } }],
        ["non-numeric counts", { usage: { input_tokens: "5", output_tokens: "1" } }],
      ] as const) {
        it(`returns undefined for ${label} without throwing`, () => {
          expect(adapter.extractUsage(body)).toBeUndefined();
        });
      }
    });
  }
});

describe("presets", () => {
  it("has unique ids", () => {
    const ids = PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("gives every fixed-endpoint preset a base url, and every custom one none", () => {
    for (const p of PRESETS) {
      if (p.needsBaseUrl) continue;
      if (p.adapter === "anthropic") expect(p.baseUrl).toBe("");
      else expect(p.baseUrl).toMatch(/^https?:\/\//);
    }
  });

  it("declares an origin for every preset with a fixed endpoint", () => {
    for (const p of PRESETS.filter((p) => p.id !== "custom")) {
      expect(p.origin, p.id).toBeTruthy();
    }
  });

  it("routes every preset to an adapter that exists", () => {
    for (const p of PRESETS) {
      expect(["anthropic", "openai-compatible", "gemini"]).toContain(p.adapter);
    }
  });
});

describe("resolveTarget", () => {
  const base: ProviderConfig = { presetId: "anthropic", apiKey: "sk-ant-x", model: "" };

  it("falls back to the preset's default model when none is set", () => {
    expect(resolveTarget(base).model).toBe("claude-opus-5");
  });

  it("prefers a user-supplied model", () => {
    expect(resolveTarget({ ...base, model: "claude-haiku-4-5" }).model).toBe("claude-haiku-4-5");
  });

  it("throws ApiKeyMissing rather than firing a doomed request", () => {
    expect(() => resolveTarget({ ...base, apiKey: "" })).toThrow(/ApiKeyMissing/);
  });

  it("allows an empty key for local servers", () => {
    const t = resolveTarget({ presetId: "ollama", apiKey: "", model: "llama3.1", baseUrl: "http://localhost:11434/v1" });
    expect(t.apiKey).toBe("");
    expect(t.adapter).toBe("openai-compatible");
  });

  it("strips a trailing slash that would produce a double slash in the path", () => {
    const t = resolveTarget({
      presetId: "custom",
      apiKey: "k",
      model: "m",
      baseUrl: "https://example.com/v1/",
    });
    expect(t.baseUrl).toBe("https://example.com/v1");
  });

  it("requires a base url for a custom endpoint", () => {
    expect(() => resolveTarget({ presetId: "custom", apiKey: "k", model: "m" })).toThrow(
      /server URL/,
    );
  });

  it("uses the preset's fixed url even if a stale one is stored", () => {
    const t = resolveTarget({
      presetId: "groq",
      apiKey: "k",
      model: "m",
      baseUrl: "https://leftover.example",
    });
    expect(t.baseUrl).toBe("https://api.groq.com/openai/v1");
  });
});

describe("originFor", () => {
  it("returns the preset origin for a known service", () => {
    expect(originFor({ presetId: "openai", apiKey: "k", model: "m" })).toBe(
      "https://api.openai.com/*",
    );
  });

  it("derives the origin from a custom base url", () => {
    expect(
      originFor({ presetId: "custom", apiKey: "k", model: "m", baseUrl: "https://x.dev/v1/foo" }),
    ).toBe("https://x.dev/*");
  });

  it("returns null for an unparseable custom url instead of throwing", () => {
    expect(originFor({ presetId: "custom", apiKey: "k", model: "m", baseUrl: "junk" })).toBeNull();
  });
});

describe("complete", () => {
  const t = target({ adapter: "openai-compatible", baseUrl: "https://x/v1" });
  const ok = (text: string) =>
    new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });

  it("returns the extracted text on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok("hello")));
    await expect(complete(t, REQ)).resolves.toMatchObject({ text: "hello" });
    vi.unstubAllGlobals();
  });

  it("retries a 429 twice, then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(ok("done"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(complete(t, REQ, async () => {})).resolves.toMatchObject({ text: "done" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });

  it("gives up after two retries and throws the last retryable error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("down", { status: 503 })));
    await expect(complete(t, REQ, async () => {})).rejects.toThrow(/ProviderUnavailable/);
    vi.unstubAllGlobals();
  });

  it("does not retry a bad key, which would only waste the user's time", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(complete(t, REQ, async () => {})).rejects.toThrow(/ApiKeyInvalid/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("maps a 404 to ModelNotFound", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));
    await expect(complete(t, REQ, async () => {})).rejects.toThrow(/ModelNotFound/);
    vi.unstubAllGlobals();
  });

  it("maps a rejected fetch to NetworkUnavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(complete(t, REQ)).rejects.toThrow(/NetworkUnavailable/);
    vi.unstubAllGlobals();
  });

  it("maps an unreadable body to MalformedNoteResponse", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    await expect(complete(t, REQ)).rejects.toThrow(/MalformedNoteResponse/);
    vi.unstubAllGlobals();
  });

  it("carries token usage through when the provider reported it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "hi" } }],
            usage: { prompt_tokens: 900, completion_tokens: 120 },
          }),
          { status: 200 },
        ),
      ),
    );
    await expect(complete(t, REQ)).resolves.toEqual({
      text: "hi",
      usage: { input: 900, output: 120 },
    });
    vi.unstubAllGlobals();
  });

  it("still returns the note when the provider reports no usage at all", async () => {
    // Local servers (Ollama, LM Studio) routinely omit `usage`. A missing token
    // count must never cost the user their note.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(ok("hi")));
    await expect(complete(t, REQ)).resolves.toEqual({ text: "hi", usage: undefined });
    vi.unstubAllGlobals();
  });

  it("throws only NamedErrors, so every path maps to a toast", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("x", { status: 418 })));
    await expect(complete(t, REQ, async () => {})).rejects.toBeInstanceOf(NamedError);
    vi.unstubAllGlobals();
  });
});
