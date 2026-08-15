/**
 * Options page. The key is written to storage.local (never .sync) so it cannot
 * leave this device via the Chrome profile.
 */

const keyInput = document.getElementById("key") as HTMLInputElement;
// Not `status`: that name collides with the deprecated global `window.status`.
const statusEl = document.getElementById("status") as HTMLDivElement;

let saveTimer: number | undefined;

function say(text: string): void {
  statusEl.textContent = text;
}

async function load(): Promise<void> {
  const { apiKey = "", captureCounts = {} } = (await chrome.storage.local.get([
    "apiKey",
    "captureCounts",
  ])) as { apiKey?: string; captureCounts?: Record<string, number> };

  keyInput.value = apiKey;

  const total = Object.values(captureCounts).reduce((a, b) => a + b, 0);
  const today = captureCounts[new Date().toISOString().slice(0, 10)] ?? 0;
  say(total > 0 ? `${total} notes captured (${today} today).` : "");
}

keyInput.addEventListener("input", () => {
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    const apiKey = keyInput.value.trim();
    await chrome.storage.local.set({ apiKey });
    say(apiKey ? "Key saved." : "Key cleared.");
  }, 400);
});

void load();
