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
});
