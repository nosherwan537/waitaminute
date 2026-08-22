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
import {
  clearLog,
  estimateCost,
  formatCost,
  readLog,
  readRates,
  summarize,
  type LogEntry,
  type Rates,
} from "../lib/capture-log";
import { localDay } from "../lib/notes-store";
import { connect, readDocRef, type DocRef } from "../background/docs-sink";
import { disconnect, isConfigured } from "../background/google-auth";
import { isNamedError } from "../lib/errors";
import { addSite, readSites, removeSite, toMatchPattern } from "../background/site-registry";
import { WINDOWS } from "../types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const presetSelect = $<HTMLSelectElement>("preset");
const presetNote = $<HTMLDivElement>("preset-note");
const baseUrlRow = $<HTMLDivElement>("base-url-row");
const baseUrlInput = $<HTMLInputElement>("base-url");
const keyInput = $<HTMLInputElement>("key");
const modelInput = $<HTMLInputElement>("model");
// Not `status`: that name collides with the deprecated global `window.status`.
const statusEl = $<HTMLDivElement>("status");
const rateInInput = $<HTMLInputElement>("rate-in");
const rateOutInput = $<HTMLInputElement>("rate-out");
const summaryEl = $<HTMLDivElement>("summary");
const logTable = $<HTMLTableElement>("log-table");
const clearButton = $<HTMLButtonElement>("clear-log");
const connectButton = $<HTMLButtonElement>("connect-google");
const disconnectButton = $<HTMLButtonElement>("disconnect-google");
const docStateEl = $<HTMLSpanElement>("doc-state");
const siteInput = $<HTMLInputElement>("site-input");
const siteAddButton = $<HTMLButtonElement>("site-add");
const siteList = $<HTMLUListElement>("site-list");
const frameCaptureInput = $<HTMLInputElement>("frame-capture");

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

/* ---------------------------------------------------------------- sites --- */

/** `https://vimeo.com/*` reads better as `vimeo.com` in a list of sites. */
function siteLabel(pattern: string): string {
  return pattern.replace(/^https?:\/\//, "").replace(/\/\*$/, "");
}

function renderSites(sites: readonly string[]): void {
  siteList.replaceChildren();
  for (const pattern of sites) {
    const item = document.createElement("li");
    const name = document.createElement("span");
    name.textContent = siteLabel(pattern);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.addEventListener("click", async () => {
      renderSites(await removeSite(pattern));
      say(`Removed ${siteLabel(pattern)}.`);
    });
    item.append(name, remove);
    siteList.append(item);
  }
}

siteAddButton.addEventListener("click", async () => {
  let pattern: string;
  try {
    pattern = toMatchPattern(siteInput.value);
  } catch (error) {
    say(isNamedError(error) ? error.userMessage : "That doesn't look like a site address", true);
    return;
  }

  // The request must happen in the click handler itself: Chrome requires a user
  // gesture, and awaiting anything else first can spend it.
  if (!(await chrome.permissions.request({ origins: [pattern] }))) {
    say(`Access to ${siteLabel(pattern)} was declined.`, true);
    return;
  }

  renderSites(await addSite(pattern));
  siteInput.value = "";
  say(`Added ${siteLabel(pattern)}. Reload any open tab there.`);
});

siteInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") siteAddButton.click();
});

/* --------------------------------------------------------------- google --- */

/** Origins the Docs calls need. Requested on click, where the gesture exists. */
const GOOGLE_ORIGINS = ["https://docs.googleapis.com/*", "https://www.googleapis.com/*"];

function renderDoc(doc: DocRef | undefined): void {
  docStateEl.replaceChildren();
  disconnectButton.hidden = !doc;
  connectButton.textContent = doc ? "Reconnect" : "Connect Google";

  if (!isConfigured()) {
    // Honest about a build-time gap rather than letting the click fail with an
    // opaque OAuth error. See scripts/build.mjs.
    connectButton.disabled = true;
    docStateEl.textContent = "Not available in this build — no OAuth client ID.";
    return;
  }
  if (!doc) {
    docStateEl.textContent = "Not connected. Notes are saved locally only.";
    return;
  }

  docStateEl.append("Saving to ");
  const link = document.createElement("a");
  link.href = doc.url;
  link.target = "_blank";
  link.rel = "noreferrer";
  // textContent: the title comes back from Google and is user-editable.
  link.textContent = doc.title;
  docStateEl.append(link);
}

connectButton.addEventListener("click", async () => {
  connectButton.disabled = true;
  try {
    if (!(await chrome.permissions.request({ origins: GOOGLE_ORIGINS }))) {
      say("Access to Google was declined — notes stay local.", true);
      return;
    }
    const doc = await connect();
    renderDoc(doc);
    say(`Connected. Notes will append to "${doc.title}".`);
  } catch (error) {
    // AuthCancelled is a decision, not a fault: the user closed the window.
    const cancelled = isNamedError(error) && error.name_ === "AuthCancelled";
    say(
      isNamedError(error) ? error.userMessage : "Couldn't connect to Google.",
      !cancelled,
    );
    console.error("[heystop] connect failed", error);
  } finally {
    connectButton.disabled = !isConfigured();
  }
});

disconnectButton.addEventListener("click", async () => {
  await disconnect();
  // The doc ref is dropped too, so a later reconnect does not silently resume
  // appending to a document the user thought they had detached from.
  await chrome.storage.local.remove("doc");
  renderDoc(undefined);
  say("Disconnected. Notes are saved locally only.");
});

/* ------------------------------------------------------------------ log --- */

/** Blank, negative and NaN all mean "no rate entered", which reads as unknown. */
function currentRates(): Rates {
  const read = (el: HTMLInputElement) => {
    const value = Number.parseFloat(el.value);
    return Number.isFinite(value) && value > 0 ? value : 0;
  };
  return { inputPerMTok: read(rateInInput), outputPerMTok: read(rateOutInput) };
}

/** Just the clock. The date is implied — 50 captures is a session, not a month. */
function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** "60s", "prev 60s", "3m" — which window the press asked for. */
function windowLabel(command: LogEntry["command"]): string {
  const spec = WINDOWS[command];
  const length = spec.length >= 180 ? `${spec.length / 60}m` : `${spec.length}s`;
  return spec.back > 0 ? `prev ${length}` : length;
}

function cell(row: HTMLTableRowElement, text: string, className?: string): HTMLTableCellElement {
  const td = row.insertCell();
  // textContent, never innerHTML: videoTitle comes off a page anyone can publish.
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function headerRow(): HTMLTableRowElement {
  const row = logTable.createTHead().insertRow();
  for (const [label, className] of [
    ["Time", ""],
    ["Window", ""],
    ["Video", "title"],
    ["Outcome", ""],
    ["Took", "num"],
    ["Tokens", "num"],
    ["Cost", "num"],
    ["Frame", "num"],
  ] as const) {
    const th = document.createElement("th");
    th.textContent = label;
    if (className) th.className = className;
    row.append(th);
  }
  return row;
}

function renderSummary(entries: readonly LogEntry[], rates: Rates): void {
  summaryEl.replaceChildren();
  if (entries.length === 0) {
    summaryEl.textContent = "No captures yet. Press the hotkey on a video.";
    return;
  }

  const s = summarize(entries, rates);
  const parts = [
    `${s.ok}/${s.total} produced a note`,
    s.medianLatencyMs === null ? "" : `median ${(s.medianLatencyMs / 1000).toFixed(1)}s`,
    s.totalCost === null ? "" : `${formatCost(s.totalCost)} total`,
  ].filter(Boolean);

  const line = document.createElement("div");
  line.textContent = parts.join(" · ");
  summaryEl.append(line);

  if (s.failures.length > 0) {
    const fails = document.createElement("div");
    fails.className = "fail";
    fails.textContent = s.failures.map(([name, n]) => `${name} ×${n}`).join(" · ");
    summaryEl.append(fails);
  }
}

function renderLog(entries: readonly LogEntry[], rates: Rates): void {
  logTable.replaceChildren();
  renderSummary(entries, rates);
  if (entries.length === 0) return;

  headerRow();
  const body = logTable.createTBody();

  for (const entry of entries) {
    const row = body.insertRow();
    cell(row, clockTime(entry.id));
    cell(row, windowLabel(entry.command));
    cell(row, entry.videoTitle || "—", "title");

    // NothingToNote is not a failure — it is the prompt correctly declining an
    // ad break. Colouring it red would train the eye to read a working feature
    // as breakage, which is exactly backwards.
    const outcome = cell(row, entry.outcome);
    if (entry.outcome === "NothingToNote") outcome.className = "meh";
    else if (entry.outcome !== "ok") outcome.className = "bad";

    cell(row, `${(entry.latencyMs / 1000).toFixed(1)}s`, "num");
    cell(row, entry.usage ? `${entry.usage.input}/${entry.usage.output}` : "—", "num");
    cell(row, formatCost(estimateCost(entry.usage, rates)), "num");
    // A dot, not a word: this column is scanned, not read. A run of blanks
    // while the setting is on means the model is refusing images.
    cell(row, entry.frame ? "●" : "", "num");
  }
}

async function refreshLog(): Promise<void> {
  renderLog(await readLog(), currentRates());
}

for (const input of [rateInInput, rateOutInput]) {
  input.addEventListener("input", () => {
    void chrome.storage.local.set({ rates: currentRates() });
    void refreshLog();
  });
}

frameCaptureInput.addEventListener("change", () => {
  void chrome.storage.local.set({ frameCapture: frameCaptureInput.checked });
  say(
    frameCaptureInput.checked
      ? "Frames on. Each note now sends a picture of the player to your provider."
      : "Frames off. Notes are written from captions alone.",
  );
});

clearButton.addEventListener("click", async () => {
  await clearLog();
  await refreshLog();
});

// The log is written by the service worker, which the options page cannot see
// happen. Without this, a capture taken with settings open leaves a stale table
// and the user concludes nothing was recorded.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes["captureLog"]) void refreshLog();
});

/* ----------------------------------------------------------------- boot --- */

async function load(): Promise<void> {
  for (const preset of PRESETS) {
    const option = document.createElement("option");
    option.value = preset.id;
    option.textContent = preset.label;
    presetSelect.append(option);
  }

  const stored = (await chrome.storage.local.get([
    "provider",
    "captureCounts",
    "frameCapture",
  ])) as {
    provider?: ProviderConfig;
    captureCounts?: Record<string, number>;
    frameCapture?: boolean;
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
  // localDay, matching what the service worker writes. toISOString would look
  // up the wrong key for most of the evening in a western timezone.
  const today = counts[localDay()] ?? 0;
  if (total > 0) say(`${total} notes captured (${today} today).`);

  // Strict true: anything else, including a value written by an older version
  // that never had this setting, reads as off.
  frameCaptureInput.checked = stored.frameCapture === true;

  renderDoc(await readDocRef());
  renderSites(await readSites());

  const rates = await readRates();
  if (rates.inputPerMTok > 0) rateInInput.value = String(rates.inputPerMTok);
  if (rates.outputPerMTok > 0) rateOutInput.value = String(rates.outputPerMTok);
  await refreshLog();
}

void load();
