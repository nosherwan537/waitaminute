import type { Preset } from "./types";

/**
 * The services offered in the options dropdown.
 *
 * Adding a provider means adding a row here. If a new service speaks the
 * `/chat/completions` shape — most do — that is the entire change: no adapter,
 * no new failure modes, no new tests.
 *
 * On `defaultModel`: these are starting points, not guarantees. Model names
 * change far faster than an extension ships, so every one of these is editable
 * in the UI and each preset carries a `note` pointing at the provider's own
 * model list. A stale default here is an annoyance, never a dead end.
 */
export const PRESETS: readonly Preset[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    adapter: "anthropic",
    baseUrl: "",
    defaultModel: "claude-opus-5",
    keyHint: "sk-ant-...",
    origin: "https://api.anthropic.com/*",
    note: "Keys at console.anthropic.com. Try claude-haiku-4-5 for a cheaper pass.",
  },
  {
    id: "openai",
    label: "OpenAI",
    adapter: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4.1-mini",
    keyHint: "sk-...",
    origin: "https://api.openai.com/*",
    audioModel: "whisper-1",
    note: "Keys at platform.openai.com. Check their model list for current names.",
  },
  {
    id: "openrouter",
    label: "OpenRouter (any model, one key)",
    adapter: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "anthropic/claude-opus-5",
    keyHint: "sk-or-v1-...",
    origin: "https://openrouter.ai/*",
    note: "One key reaches most models. Note your transcripts pass through OpenRouter.",
  },
  {
    id: "gemini",
    label: "Google Gemini",
    adapter: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    defaultModel: "gemini-2.5-flash",
    keyHint: "AIza...",
    origin: "https://generativelanguage.googleapis.com/*",
    note: "Free tier at aistudio.google.com. Prefer a Flash model: 2.5 Pro cannot turn thinking off, which makes every capture slow and expensive for a cleanup pass.",
  },
  {
    id: "groq",
    label: "Groq (fast, free tier)",
    adapter: "openai-compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    keyHint: "gsk_...",
    origin: "https://api.groq.com/*",
    audioModel: "whisper-large-v3-turbo",
    note: "Keys at console.groq.com. Check their model list for current names.",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    adapter: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    keyHint: "sk-...",
    origin: "https://api.deepseek.com/*",
  },
  {
    id: "together",
    label: "Together AI",
    adapter: "openai-compatible",
    baseUrl: "https://api.together.xyz/v1",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    keyHint: "...",
    origin: "https://api.together.xyz/*",
    note: "Check together.ai for current model names.",
  },
  {
    id: "ollama",
    label: "Local (Ollama / LM Studio)",
    adapter: "openai-compatible",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "llama3.1",
    keyHint: "not needed",
    origin: "http://localhost/*",
    needsBaseUrl: true,
    keyOptional: true,
    note: "Nothing leaves your machine. LM Studio usually runs on port 1234.",
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    adapter: "openai-compatible",
    baseUrl: "",
    defaultModel: "",
    keyHint: "your key",
    origin: null,
    needsBaseUrl: true,
    note: "Any server speaking /chat/completions. Enter the base URL up to /v1.",
  },
];

export const DEFAULT_PRESET_ID = "anthropic";

export function findPreset(id: string): Preset {
  return PRESETS.find((p) => p.id === id) ?? PRESETS[0]!;
}
