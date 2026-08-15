/**
 * Service worker. Stateless by design: MV3 kills it after ~30s idle, so it
 * holds nothing that must survive. It asks the content script for a slice on
 * each hotkey press and orchestrates what happens next.
 *
 * SECURITY: this is the ONLY context allowed to touch the user's API key or
 * OAuth token. Never pass either toward the content script, and never toward
 * the MAIN world (see interceptor.ts).
 */

import { formatTimestamp } from "../lib/slice";
import type { CommandName, TranscriptSlice, ToastMessage } from "../types";

type SliceResponse =
  | { ok: true; slice: TranscriptSlice }
  | { ok: false; reason: string };

function isCommand(name: string): name is CommandName {
  return name === "capture-now" || name === "capture-previous" || name === "capture-long";
}

async function toast(tabId: number, msg: Omit<ToastMessage, "kind">): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { kind: "toast", ...msg } satisfies ToastMessage);
  } catch {
    // Tab closed or navigated away mid-capture. The note still lands; only the
    // confirmation is lost. That is the correct trade.
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  if (!isCommand(command)) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  let response: SliceResponse | undefined;
  try {
    response = (await chrome.tabs.sendMessage(tab.id, {
      kind: "requestSlice",
      command,
    })) as SliceResponse;
  } catch {
    // No content script here: the extension isn't active on this page.
    return;
  }

  if (!response?.ok) return; // the content script already showed the right toast

  const { slice } = response;

  // STEP 4 lands here: noteGen -> {takeaway, cleaned}, then the two sinks.
  // Until then, prove the pipeline by printing what we captured.
  console.log(
    `[heystop] ${command} | ${formatTimestamp(slice.startSec)}-${formatTimestamp(slice.endSec)} | ${slice.videoTitle}\n` +
      `  ${slice.deepLink}\n` +
      `  ${slice.text}`,
  );

  await toast(tab.id, { state: "success", text: "Captured", count: await bumpCount() });
});

/** Captures completed today. This is the dogfooding instrument, not decoration. */
async function bumpCount(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const { captureCounts = {} } = (await chrome.storage.local.get("captureCounts")) as {
    captureCounts?: Record<string, number>;
  };
  const next = (captureCounts[today] ?? 0) + 1;
  // Keep 30 days, drop the rest.
  const trimmed = Object.fromEntries(
    Object.entries({ ...captureCounts, [today]: next })
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, 30),
  );
  await chrome.storage.local.set({ captureCounts: trimmed });
  return next;
}

console.debug("[heystop] service worker ready");
