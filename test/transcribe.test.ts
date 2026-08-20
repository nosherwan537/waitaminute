import { describe, it, expect, vi, afterEach } from "vitest";
import { buildTranscriptionForm, resolveTranscription, transcribe } from "../src/lib/providers";
import type { ProviderConfig } from "../src/lib/providers";

const config = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  presetId: "openai",
  apiKey: "sk-test",
  model: "",
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("resolveTranscription", () => {
  it("resolves a provider that offers speech to text", () => {
    expect(resolveTranscription(config())).toEqual({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "whisper-1",
    });
  });

  it("names the provider when it cannot transcribe, rather than failing vaguely", () => {
    // Anthropic has no /audio/transcriptions. That is a fact about the service,
    // not a bug to debug, so the message has to be actionable.
    expect(() => resolveTranscription(config({ presetId: "anthropic" }))).toThrow(
      /can't transcribe audio/,
    );
  });

  it("still requires a key", () => {
    expect(() => resolveTranscription(config({ apiKey: "" }))).toThrow(/ApiKeyMissing/);
  });

  it("uses the preset's audio model, never the chat model the user typed", () => {
    // "gpt-4.1-mini" in the model box must not be sent to a transcription endpoint.
    expect(resolveTranscription(config({ model: "gpt-4.1-mini" })).model).toBe("whisper-1");
  });
});

describe("buildTranscriptionForm", () => {
  const wav = new Blob([new Uint8Array(44)], { type: "audio/wav" });

  it("sends the file, the model and a json response format", () => {
    const form = buildTranscriptionForm(wav, "whisper-1");
    expect(form.get("model")).toBe("whisper-1");
    expect(form.get("response_format")).toBe("json");
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  it("omits language entirely when unknown, rather than defaulting to English", () => {
    // Defaulting to "en" would mangle exactly the foreign lectures this tool
    // goes out of its way to keep in the speaker's own language.
    expect(buildTranscriptionForm(wav, "whisper-1").has("language")).toBe(false);
    expect(buildTranscriptionForm(wav, "whisper-1", "es").get("language")).toBe("es");
  });
});

describe("transcribe", () => {
  const target = { baseUrl: "https://api.openai.com/v1", apiKey: "sk", model: "whisper-1" };
  const wav = new Blob([new Uint8Array(44)], { type: "audio/wav" });

  it("returns the transcribed text", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ text: "  hello there  " })));
    await expect(transcribe(target, wav)).resolves.toBe("hello there");
  });

  it("does not set content-type, which would break the multipart boundary", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ text: "hi" }));
    vi.stubGlobal("fetch", fetchMock);
    await transcribe(target, wav);
    const headers = fetchMock.mock.calls[0]![1].headers;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("content-type");
  });

  it("treats an empty transcription as EmptySlice, so silence costs nothing", async () => {
    // A silent window must never reach the note model or spend money.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ text: "   " })));
    await expect(transcribe(target, wav)).rejects.toThrow(/EmptySlice/);
  });

  it("maps HTTP failures onto the shared registry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 401 })));
    await expect(transcribe(target, wav)).rejects.toThrow(/ApiKeyInvalid/);
  });

  it("maps a dead network to NetworkUnavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(transcribe(target, wav)).rejects.toThrow(/NetworkUnavailable/);
  });
});
