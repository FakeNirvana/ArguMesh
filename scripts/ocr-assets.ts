import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type { Plugin } from "vite";

const require = createRequire(import.meta.url);
export const ocrAssets = {
  "worker.min.js": require.resolve("tesseract.js/dist/worker.min.js"),
  // This loader contains its WASM binary, so no CDN or additional WASM request is needed.
  "tesseract-core-lstm.wasm.js": require.resolve("tesseract.js-core/tesseract-core-lstm.wasm.js"),
  "eng.traineddata.gz": require.resolve("@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz"),
  "eng-package.json": require.resolve("@tesseract.js-data/eng/package.json"),
  "LICENSE-tesseract.txt": require.resolve("tesseract.js/LICENSE.md"),
  "LICENSE-core.txt": require.resolve("tesseract.js-core/LICENSE"),
};

/** Serve the same local OCR assets in development and desktop/Web builds. */
export function localOcrAssets(): Plugin {
  return {
    name: "argumesh-local-ocr",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const name = request.url?.split("?")[0].replace(/^\/ocr\//, "");
        if (!request.url?.startsWith("/ocr/") || !name || !Object.hasOwn(ocrAssets, name)) return next();
        void readFile(ocrAssets[name as keyof typeof ocrAssets]).then((bytes) => {
          response.setHeader("Content-Type", name.endsWith(".js") ? "application/javascript" : "application/octet-stream");
          response.end(bytes);
        }).catch(next);
      });
    },
    async generateBundle() {
      for (const [name, path] of Object.entries(ocrAssets)) {
        this.emitFile({ type: "asset", fileName: `ocr/${name}`, source: await readFile(path) });
      }
    },
  };
}
