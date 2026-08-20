import { NamedError } from "../lib/errors";

/**
 * Google OAuth, via `chrome.identity.getAuthToken`.
 *
 * WHY getAuthToken and not launchWebAuthFlow: the error registry promises
 * `TokenExpired → silent refresh + retry → (transparent)`. launchWebAuthFlow's
 * implicit flow returns a one-hour token and NO refresh token, so honouring that
 * promise would mean a consent popup every hour — mid-video, which premise 7
 * forbids outright. getAuthToken lets Chrome hold the refresh token and hand
 * back a fresh access token silently, which is exactly the registry's behaviour.
 *
 * The cost is that the OAuth client ID must live in the manifest, and the
 * extension needs a stable ID. `scripts/build.mjs` injects the client ID from a
 * gitignored `oauth.local.json` so a personal Cloud project never lands in git.
 *
 * SECURITY: tokens are secrets. They live in this file and `docs-sink.ts` only,
 * never in storage, never toward a content script, never toward the MAIN world.
 */

/**
 * Exactly the scopes PLAN.md allows. `drive.file` grants access ONLY to files
 * this extension created — never the user's existing Drive. Widening this to
 * `drive` would be a security rule violation, not a convenience.
 */
export const SCOPES = [
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/drive.file",
];

/** True when the build injected a client ID. False means Google was never set up. */
export function isConfigured(): boolean {
  const oauth2 = chrome.runtime.getManifest().oauth2;
  return Boolean(oauth2?.client_id) && !oauth2!.client_id.startsWith("REPLACE_ME");
}

/**
 * Chrome returns a bare string on older versions and an object on newer ones.
 * Exported for tests: getting this wrong yields `Bearer [object Object]`, which
 * fails as an opaque 401 three layers away from the cause.
 */
export function tokenOf(result: unknown): string | undefined {
  if (typeof result === "string") return result || undefined;
  if (typeof result === "object" && result !== null) {
    const token = (result as { token?: unknown }).token;
    if (typeof token === "string" && token) return token;
  }
  return undefined;
}

/**
 * Get an access token.
 *
 * `interactive: false` is the capture path: it must never open a consent window
 * over the video. A silent failure there is `NotAuthorized`, which the toast
 * turns into "connect Google in settings" — an instruction the user acts on
 * later, not a popup that steals the moment.
 *
 * `interactive: true` is the options page only, behind an explicit click.
 */
export async function getToken(interactive: boolean): Promise<string> {
  if (!isConfigured()) {
    throw new NamedError(
      "NotAuthorized",
      "Google Docs isn't set up in this build",
      false,
      "no oauth2.client_id in the manifest",
    );
  }

  let result: unknown;
  try {
    result = await chrome.identity.getAuthToken({ interactive, scopes: SCOPES });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // Chrome reports a closed consent window and a never-granted grant with
    // different text but the same type. They mean different things to the user:
    // one is a decision, the other is a state.
    if (/did not approve|canceled|cancelled/i.test(message)) {
      throw new NamedError("AuthCancelled", "Saved locally — Google not connected", false, cause);
    }
    throw new NamedError("NotAuthorized", "Connect Google to save notes", false, cause);
  }

  const token = tokenOf(result);
  if (!token) {
    // A non-interactive call with no grant resolves with nothing rather than
    // throwing. Without this check that becomes an Authorization header reading
    // "Bearer undefined" and a confusing 401 two layers down.
    throw new NamedError("NotAuthorized", "Connect Google to save notes", false, "empty token");
  }
  return token;
}

/**
 * Drop a token Chrome still thinks is good.
 *
 * Chrome caches access tokens and will keep handing back a revoked one until it
 * is explicitly removed, so a 401 has to invalidate before retrying. Skipping
 * this turns one revoked token into an unrecoverable loop of 401s.
 */
export async function invalidate(token: string): Promise<void> {
  try {
    await chrome.identity.removeCachedAuthToken({ token });
  } catch {
    /* nothing to recover: the next getToken decides whether we are connected */
  }
}

/** Options-page only. Revokes locally so "Disconnect" actually disconnects. */
export async function disconnect(): Promise<void> {
  try {
    const token = tokenOf(await chrome.identity.getAuthToken({ interactive: false }));
    if (token) await invalidate(token);
  } catch {
    /* already disconnected */
  }
}
