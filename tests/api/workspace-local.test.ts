// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import app from "../../server/index";

describe("desktop workspace persistence", () => {
  it("saves and reloads local workspace data", async () => {
    const directory = mkdtempSync(join(tmpdir(), "argumesh-workspace-"));
    const bindings = { ARGUMESH_DESKTOP: "1", ARGUMESH_DATA_DIR: directory, DATABASE_URL: "file:unused.db" };
    const data = { projects: [], papers: [{ id: "paper-1", card: { problem: "kept" } }], matrices: [{ id: "matrix-1" }] };
    try {
      const empty = await app.request("http://localhost/api/workspace/local", {}, bindings);
      expect((await empty.json()) as unknown).toEqual({ data: null });
      const saved = await app.request("http://localhost/api/workspace/local", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(data) }, bindings);
      expect(saved.status).toBe(200);
      expect(JSON.parse(readFileSync(join(directory, "workspace.json"), "utf8")) as unknown).toEqual(data);
      const loaded = await app.request("http://localhost/api/workspace/local", {}, bindings);
      expect((await loaded.json()) as unknown).toEqual({ data });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("shares page translations and OCR text across local server origins", async () => {
    const directory = mkdtempSync(join(tmpdir(), "argumesh-reader-cache-"));
    const bindings = { ARGUMESH_DATA_DIR: directory, DATABASE_URL: "file:unused.db" };
    const translation = { source: "Test sentence", blocks: [{ index: 0, source: "Test sentence", translation: "测试句子", model: "test-model" }] };
    const base = "http://localhost/api/workspace/papers/paper-1";
    try {
      const saved = await app.request(`${base}/translations/2?language=${encodeURIComponent("中文:layout-v2")}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(translation) }, bindings);
      expect(saved.status).toBe(200);
      const loaded = await app.request(`${base}/translations/2?language=${encodeURIComponent("中文:layout-v2")}`, {}, bindings);
      expect((await loaded.json()) as unknown).toEqual({ data: translation });
      const otherPage = await app.request(`${base}/translations/1?language=${encodeURIComponent("中文:layout-v2")}`, {}, bindings);
      expect((await otherPage.json()) as unknown).toEqual({ data: null });

      const ocrSaved = await app.request(`${base}/ocr/2`, { method: "PUT", body: "Saved OCR text" }, bindings);
      expect(ocrSaved.status).toBe(200);
      const ocrLoaded = await app.request(`${base}/ocr`, {}, bindings);
      expect((await ocrLoaded.json()) as unknown).toEqual({ data: { 2: "Saved OCR text" } });

      const deleted = await app.request(`${base}/cache`, { method: "DELETE" }, bindings);
      expect(deleted.status).toBe(200);
      const afterDelete = await app.request(`${base}/translations/2?language=${encodeURIComponent("中文:layout-v2")}`, {}, bindings);
      expect((await afterDelete.json()) as unknown).toEqual({ data: null });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
