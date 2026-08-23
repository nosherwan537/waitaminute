import { NamedError } from "../lib/errors";

/**
 * Which sites the generic caption reader runs on.
 *
 * YouTube is registered statically in the manifest because it needs the
 * MAIN-world interceptor. Every other site gets only the ISOLATED-world content
 * script, registered at runtime once the user grants that origin.
 *
 * WHY runtime registration rather than a `<all_urls>` match: an extension that
 * asks to read every site you visit is one most people should decline, and this
 * one has no reason to. The install prompt stays "youtube.com", and each further
 * site is a decision the user makes for that site.
 *
 * The enabled list is stored explicitly rather than derived from
 * `chrome.permissions.getAll()`. That call also returns the model-provider
 * origins the options page requested, and injecting a content script into
 * api.anthropic.com would be both useless and alarming.
 */

const SCRIPT_ID_PREFIX = "waitaminute-site-";

/**
 * The pre-rename prefix. Registrations use `persistAcrossSessions: true`, so a
 * script registered under the old name survives in Chrome's registry and the
 * sweep below would no longer recognise it as ours — it would keep injecting on
 * a site the user may have since removed, with no way to remove it from the UI.
 * Safe to delete once no install can predate the rename.
 */
const LEGACY_SCRIPT_ID_PREFIXES = ["heystop-site-"];

export async function readSites(): Promise<string[]> {
  const { sites = [] } = (await chrome.storage.local.get("sites")) as { sites?: string[] };
  return sites;
}

/**
 * Pure. Turn whatever the user typed into a match pattern, or throw.
 *
 * Deliberately strict about the scheme: a pattern the user did not intend is a
 * permission prompt they will not understand, and `<all_urls>` typed by accident
 * is exactly what the runtime-registration design exists to avoid.
 */
export function toMatchPattern(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new NamedError("PermissionDenied", "Enter a site address");

  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    throw new NamedError("PermissionDenied", "That doesn't look like a site address");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new NamedError("PermissionDenied", "Only http and https sites are supported");
  }
  if (!url.hostname || !url.hostname.includes(".")) {
    throw new NamedError("PermissionDenied", "That doesn't look like a site address");
  }
  // Whole host, all paths. Narrower would break the SPA navigation these
  // platforms all use; wider would be a different site entirely.
  return `${url.protocol}//${url.hostname}/*`;
}

/**
 * YouTube's pair is declared statically in the manifest, not registered here,
 * because the MAIN-world interceptor must run at `document_start`. It still
 * counts as a page that should answer, so it lives alongside the stored list.
 */
export const STATIC_MATCH = "https://www.youtube.com/*";

/** Pure. Does a `scheme://host/*` match pattern cover this URL? */
export function patternCovers(pattern: string, url: string): boolean {
  const [scheme, rest] = pattern.split("://");
  if (!scheme || !rest) return false;
  const host = rest.replace(/\/\*$/, "");
  try {
    const parsed = new URL(url);
    return parsed.protocol === `${scheme}:` && parsed.hostname === host;
  } catch {
    return false;
  }
}

/**
 * Pure. Should this page have had a content script listening?
 *
 * Distinguishes the two cases a failed `sendMessage` collapses into one: an
 * ordinary page the extension has no business on (stay silent) versus a page it
 * IS registered for, whose script is dead. The second happens on every
 * unpacked-extension reload — the tab keeps the old, disconnected script — and
 * swallowing it means the hotkey does nothing at all with no explanation.
 */
export function shouldHaveContentScript(url: string | undefined, sites: string[]): boolean {
  if (!url) return false;
  return [STATIC_MATCH, ...sites].some((pattern) => patternCovers(pattern, url));
}

/** Pure. A stable, valid script ID derived from the pattern. */
export function scriptIdFor(pattern: string): string {
  return SCRIPT_ID_PREFIX + pattern.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Make the registered scripts match the stored list exactly.
 *
 * Idempotent, because it runs on startup, on install, and after every add or
 * remove. Registering an ID that already exists throws, so existing ones are
 * unregistered first rather than checked — same result, no race.
 */
export async function syncContentScripts(): Promise<void> {
  const sites = await readSites();
  const granted = await Promise.all(
    sites.map(async (pattern) => ({
      pattern,
      // A site whose permission the user revoked in Chrome's own UI must not
      // stay registered — registration would fail at inject time anyway, and
      // the stored list would quietly disagree with reality.
      ok: await chrome.permissions.contains({ origins: [pattern] }),
    })),
  );
  const active = granted.filter((g) => g.ok).map((g) => g.pattern);

  const existing = await chrome.scripting.getRegisteredContentScripts().catch(() => []);
  const prefixes = [SCRIPT_ID_PREFIX, ...LEGACY_SCRIPT_ID_PREFIXES];
  const ours = existing
    .filter((s) => prefixes.some((prefix) => s.id.startsWith(prefix)))
    .map((s) => s.id);
  if (ours.length > 0) await chrome.scripting.unregisterContentScripts({ ids: ours });

  if (active.length === 0) return;
  await chrome.scripting.registerContentScripts(
    active.map((pattern) => ({
      id: scriptIdFor(pattern),
      matches: [pattern],
      js: ["content/content-script.js"],
      runAt: "document_idle",
      world: "ISOLATED",
      allFrames: false,
      persistAcrossSessions: true,
    })),
  );
}

/** Add a site. The permission request must already have been granted. */
export async function addSite(pattern: string): Promise<string[]> {
  const sites = await readSites();
  if (!sites.includes(pattern)) sites.push(pattern);
  await chrome.storage.local.set({ sites });
  await syncContentScripts();
  return sites;
}

/** Remove a site and hand back the origin permission with it. */
export async function removeSite(pattern: string): Promise<string[]> {
  const sites = (await readSites()).filter((s) => s !== pattern);
  await chrome.storage.local.set({ sites });
  await syncContentScripts();
  // Dropping the permission too: leaving it granted would mean "removed" sites
  // still show up in Chrome's own permission list, which is not what the user
  // was told happened.
  await chrome.permissions.remove({ origins: [pattern] }).catch(() => false);
  return sites;
}
