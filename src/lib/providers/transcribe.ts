import { NamedError, errorForStatus } from "../errors";
import { findPreset } from "./presets";
import type { ProviderConfig } from "./types";

/**
 * Speech to text, for the audio fallback (PLAN.md step 11).
 *
 * Uses the OpenAI `/audio/transcriptions` shape, which OpenAI, Groq and most
 * local servers implement. Deliberately NOT an `Adapter`: transcription takes
 * multipart form data rather than JSON and returns text rather than a note, so
 * folding it into that interface would mean widening it for one caller.
 *
 * A provider with no `audioModel` is not an error to debug — it is a fact about
 * the service, and the toast should say so plainly.
 */

export interface TranscriptionTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/**
 * Pure. Resolve the transcription target, or throw a registry error explaining
 * why this provider cannot do it.
 */
export function resolveTranscription(config: ProviderConfig): TranscriptionTarget {
  const preset = findPreset(config.presetId);
  if (!preset.audioModel) {
    throw new NamedError(
      "CaptionsUnavailable",
      `${preset.label} can't transcribe audio — switch provider in settings`,
    );
  }
  if (!config.apiKey && !preset.keyOptional) {
    throw new NamedError("ApiKeyMissing", "Add your API key in settings");
  }

  const baseUrl = ((preset.needsBaseUrl ? config.baseUrl : preset.baseUrl) ?? "").replace(
    /\/+$/,
    "",
  );
  if (!baseUrl) throw new NamedError("ModelNotFound", "Add the server URL in settings");

  return { baseUrl, apiKey: config.apiKey, model: preset.audioModel };
}

/**
 * Pure. Build the multipart body.
 *
 * `FormData` sets its own boundary, so the Content-Type header must NOT be set
 * by hand here — doing so produces a boundary mismatch and a 400 that reads like
 * a malformed file rather than a header problem.
 */
export function buildTranscriptionForm(wav: Blob, model: string, language?: string): FormData {
  const form = new FormData();
  form.append("file", wav, "capture.wav");
  form.append("model", model);
  // Naming the language when we know it measurably improves accuracy, and
  // omitting it lets the model detect — never guess "en" as a default, which
  // would mangle exactly the foreign lectures this tool goes out of its way
  // to keep in the original language.
  if (language) form.append("language", language);
  form.append("response_format", "json");
  return form;
}

interface TranscriptionBody {
  text?: string;
  error?: { message?: string };
}

/** See TIMEOUT_MS in ./index — same reasoning, bigger budget for the upload. */
export const TRANSCRIBE_TIMEOUT_MS = 90_000;

export async function transcribe(
  target: TranscriptionTarget,
  wav: Blob,
  language?: string,
): Promise<string> {
  // Longer than the completion budget: this one uploads a WAV before any work
  // starts, and a slow connection must not read as a dead provider.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), TRANSCRIBE_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${target.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${target.apiKey || "none"}` },
      body: buildTranscriptionForm(wav, target.model, language),
      signal: abort.signal,
    });
  } catch (cause) {
    if (abort.signal.aborted) {
      throw new NamedError("ProviderTimeout", "Transcription timed out — try again", false, cause);
    }
    throw new NamedError("NetworkUnavailable", "Offline — note not saved", false, cause);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw errorForStatus(response.status, await response.text().catch(() => ""));
  }

  const body = (await response.json().catch(() => ({}))) as TranscriptionBody;
  if (body.error?.message) {
    throw new NamedError("MalformedNoteResponse", "Transcription failed", false, body.error.message);
  }
  const text = (body.text ?? "").trim();
  if (!text) {
    // Silence in the window. Not a failure — the same thing the caption path
    // calls EmptySlice, and it must not reach the model or cost money.
    throw new NamedError("EmptySlice", "Nothing said in that window");
  }
  return text;
}
