/**
 * Options page. Picks a provider, holds the key.
 *
 * The key is written to storage.local (never .sync) so it cannot leave this
 * device via the Chrome profile.
 *
 * Host permission is requested here rather than declared up front. Two reasons:
 * the install prompt stays narrow (YouTube only), and the user grants access to
 * exactly the one provider they chose instead of all nine. `permissions.request`
 * needs a user gesture, so it hangs off the change/blur handlers — never off
 * page load, where Chrome would silently reject it.
 */

import { PRESETS, DEFAULT_PRESET_ID, findPreset, originFor } from "../lib/providers";
import type { ProviderConfig } from "../lib/providers";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const presetSelect = $<HTMLSelectElement>("preset");
const presetNote = $<HTMLDivElement>("preset-note");
const baseUrlRow = $<HTMLDivElement>("base-url-row");
const baseUrlInput = $<HTMLInputElement>("base-url");
const keyInput = $<HTMLInputElement>("key");
const modelInput = $<HTMLInputElement>("model");
// Not `status`: that name collides with the deprecated global `window.status`.
const statusEl = $<HTMLDivElement>("status");

let saveTimer: number | undefined;

function say(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("err", isError);
}

function currentConfig(): ProviderConfig {
  return {
    presetId: presetSelect.value,
    apiKey: keyInput.value.trim(),
    model: modelInput.value.trim(),
    baseUrl: baseUrlInput.value.trim(),
  };
}

/** Reflect the chosen preset: which fields are relevant, and what to prefill. */
function applyPreset(config: ProviderConfig, prefill: boolean): void {
  const preset = findPreset(config.presetId);

  presetNote.textContent = preset.note ?? "";
  baseUrlRow.hidden = !preset.needsBaseUrl;
  keyInput.placeholder = preset.keyHint;
  modelInput.placeholder = preset.defaultModel || "model name";

  if (prefill) {
    // Switching providers: the previous key and model are meaningless here.
    keyInput.value = "";
    modelInput.value = preset.defaultModel;
    baseUrlInput.value = preset.baseUrl;
  }
}

async function save(): Promise<void> {
  const provider = currentConfig();
  await chrome.storage.local.set({ provider });
  say(provider.apiKey || findPreset(provider.presetId).keyOptional ? "Saved." : "Add a key.");
}

/**
 * Ask for access to the provider's origin. Returns false when the user declines,
 * which is a real answer, not an error — say so and let them retry.
 */
async function ensurePermission(): Promise<boolean> {
  const origin = originFor(currentConfig());
  if (!origin) return true; // nothing to ask for yet; the URL isn't valid

  try {
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    // Thrown when there's no user gesture. Not fatal: the request retries on the
    // next interaction, and the capture path reports the failure if it never lands.
    return false;
  }
}

function queueSave(): void {
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void save(), 400);
}

presetSelect.addEventListener("change", async () => {
  applyPreset(currentConfig(), true);
  await save();
  if (!(await ensurePermission())) {
    say("Access to that provider was declined — pick it again to retry.", true);
  }
});

for (const input of [keyInput, modelInput, baseUrlInput]) {
  input.addEventListener("input", queueSave);
}

// The base URL is only a valid permission target once it's fully typed, so ask
// on blur rather than on every keystroke.
baseUrlInput.addEventListener("blur", () => void ensurePermission());
keyInput.addEventListener("blur", () => void ensurePermission());

async function load(): Promise<void> {
  for (const preset of PRESETS) {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.label;
    presetSelect.append(option);
  }

  const stored = (await chrome.storage.local.get(["provider", "captureCounts"])) as {
    provider?: ProviderConfig;
    captureCounts?: Record<string, number>;
  };
  const config: ProviderConfig = {
    presetId: DEFAULT_PRESET_ID,
    apiKey: "",
    model: "",
    ...stored.provider,
  };

  presetSelect.value = config.presetId;
  keyInput.value = config.apiKey;
  modelInput.value = config.model;
  baseUrlInput.value = config.baseUrl ?? "";
  applyPreset(config, false);

  const counts = stored.captureCounts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const today = counts[new Date().toISOString().slice(0, 10)] ?? 0;
  if (total > 0) say(`${total} notes captured (${today} today).`);
}

void load();
