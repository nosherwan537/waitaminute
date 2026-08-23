/**
 * One Rollup build per MV3 execution context.
 *
 * Why not a single multi-entry build: Rollup hoists code shared between entries
 * into a chunk and emits `import` statements to reach it. MV3 content scripts are
 * NOT ES modules and cannot import anything, so a shared chunk silently breaks
 * them at load time. Building each entry separately guarantees every bundle is
 * self-contained.
 *
 * Formats:
 *   iife -> content scripts (classic scripts, both worlds)
 *   es   -> service worker (manifest declares "type": "module") and the options
 *           page (loaded with <script type="module">)
 */
import { build } from "vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { rm, cp, readFile, writeFile } from "node:fs/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ENTRIES = [
  { src: "src/content/interceptor.ts", out: "content/interceptor", format: "iife" },
  { src: "src/content/content-script.ts", out: "content/content-script", format: "iife" },
  { src: "src/background/service-worker.ts", out: "background/service-worker", format: "es" },
  { src: "src/options/options.ts", out: "options/options", format: "es" },
  { src: "src/offscreen/recorder.ts", out: "offscreen/recorder", format: "es" },
];

await rm(resolve(root, "dist"), { recursive: true, force: true });

for (const entry of ENTRIES) {
  await build({
    root,
    configFile: false,
    logLevel: "warn",
    build: {
      outDir: "dist",
      emptyOutDir: false,
      target: "es2022",
      minify: false, // readable stack traces beat a few KB in an unpacked extension
      lib: {
        entry: resolve(root, entry.src),
        formats: [entry.format],
        fileName: () => `${entry.out}.js`,
        // Required for iife. Nothing reads it: these bundles export nothing and
        // run for their side effects.
        name: "waitaminute",
      },
    },
  });
}

// Static assets that manifest.json and the options page reference by path.
await cp(resolve(root, "public"), resolve(root, "dist"), { recursive: true });
await cp(resolve(root, "src/options/options.html"), resolve(root, "dist/options/options.html"));
await cp(resolve(root, "src/offscreen/offscreen.html"), resolve(root, "dist/offscreen/offscreen.html"));

/**
 * Inject the Google OAuth client ID.
 *
 * `chrome.identity.getAuthToken` reads the client ID out of the manifest, and it
 * is specific to whoever built this — a personal Google Cloud project. Committing
 * one would mean every user shares a stranger's OAuth app and its quota. So the
 * real value lives in a gitignored `oauth.local.json` and gets stamped in here:
 *
 *   { "clientId": "…apps.googleusercontent.com", "key": "<optional>" }
 *
 * `key` pins the extension ID, which getAuthToken requires to be stable —
 * without it an unpacked extension gets a fresh ID on some reloads and Google
 * rejects the redirect URI it registered against.
 *
 * With no file present the oauth2 block is REMOVED rather than left holding a
 * placeholder. Chrome validates manifest keys at load time and a bogus client ID
 * is not worth betting the whole extension on — a missing block is a state
 * `isConfigured()` already understands, so Docs stays off and notes go local.
 */
const manifestPath = resolve(root, "dist/manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
let oauth;
try {
  oauth = JSON.parse(await readFile(resolve(root, "oauth.local.json"), "utf8"));
} catch {
  oauth = undefined;
}

if (oauth?.clientId) {
  manifest.oauth2.client_id = oauth.clientId;
  if (oauth.key) manifest.key = oauth.key;
  console.log("oauth  -> client id injected");
} else {
  delete manifest.oauth2;
  console.log("oauth  -> no oauth.local.json; Google Docs disabled, local .md only");
}
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

console.log("built -> dist/");
