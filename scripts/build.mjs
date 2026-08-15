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
import { rm, cp } from "node:fs/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ENTRIES = [
  { src: "src/content/interceptor.ts", out: "content/interceptor", format: "iife" },
  { src: "src/content/content-script.ts", out: "content/content-script", format: "iife" },
  { src: "src/background/service-worker.ts", out: "background/service-worker", format: "es" },
  { src: "src/options/options.ts", out: "options/options", format: "es" },
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
        name: "heystop",
      },
    },
  });
}

// Static assets that manifest.json and the options page reference by path.
await cp(resolve(root, "public"), resolve(root, "dist"), { recursive: true });
await cp(resolve(root, "src/options/options.html"), resolve(root, "dist/options/options.html"));

console.log("built -> dist/");
