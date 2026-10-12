// @vitest-environment node
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { ocrAssets } from "../../scripts/ocr-assets";

it("构建所需的 OCR worker、内嵌 WASM 核心和英文数据均存在本地依赖中", async () => {
  const files = await Promise.all(Object.entries(ocrAssets).map(async ([name, path]) => ({ name, bytes: await readFile(path) })));
  expect(files.every((file) => file.bytes.length > 0)).toBe(true);
  const core = files.find((file) => file.name === "tesseract-core-lstm.wasm.js")!.bytes.toString();
  expect(core).toContain("base64");
  expect(gunzipSync(files.find((file) => file.name === "eng.traineddata.gz")!.bytes).length).toBeGreaterThan(1_000_000);
});

it("桌面安装包保留 OCR 子目录供 sidecar 本地提供", async () => {
  const config = JSON.parse(await readFile(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const resources = config.bundle.resources as Record<string, string>;
  expect(
    resources["../build/sidecar/dist/ocr/*"] === "sidecar/dist/ocr/"
    || resources["../build/sidecar/"] === "sidecar/",
  ).toBe(true);
});
