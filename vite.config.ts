import { defineConfig } from "vite";
import { resolve } from "node:path";

// Each entry is its own bundle with a fixed filename, because manifest.json
// references these paths literally. No hashing, no shared chunks: MV3 content
// scripts and the service worker are separate execution contexts and cannot
// share a runtime chunk.
export default defineConfig({
  publicDir: "public",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    rollupOptions: {
      input: {
        "background/service-worker": resolve(__dirname, "src/background/service-worker.ts"),
        "content/content-script": resolve(__dirname, "src/content/content-script.ts"),
        "content/interceptor": resolve(__dirname, "src/content/interceptor.ts"),
        "options/options": resolve(__dirname, "src/options/options.ts"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name].js",
        assetFileNames: "[name].[ext]",
        format: "es",
      },
    },
  },
});
