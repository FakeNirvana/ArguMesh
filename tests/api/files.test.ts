// @vitest-environment node
import { readFile } from "node:fs/promises";
import { createClient } from "@libsql/client";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../../server/index";
import { fileRoutes } from "../../server/routes/files";
import { paperRoutes } from "../../server/routes/papers";
import type { AppEnv } from "../../server/types";
import { createTestContext, jsonHeaders, type TestContext } from "./helpers";

let ctx: TestContext;
let pdf: Uint8Array;

beforeAll(async () => {
  ctx = await createTestContext();
  pdf = new Uint8Array(await readFile("tests/fixtures/reader-selection-sample.pdf"));

  // 准备论文:file-paper-1(将要上传)与 file-paper-2(无文件)。
  for (const paperId of ["file-paper-1", "file-paper-2", "file-paper-legacy", "file-paper-existing", "file-paper-invalid", "file-paper-transaction"]) {
    const projectId = "file-project";
    await app.request(
      `http://localhost/api/projects/${projectId}`,
      { method: "PUT", headers: jsonHeaders(), body: JSON.stringify({ id: projectId, name: "文件测试项目" }) },
      ctx.bindings,
    );
    await app.request(
      `http://localhost/api/projects/${projectId}/papers/${paperId}`,
      { method: "PUT", headers: jsonHeaders(), body: JSON.stringify({ id: paperId, title: "文件测试论文", authors: "测试作者", venue: "测试会议", year: 2024 }) },
      ctx.bindings,
    );
  }
});

afterAll(() => {
  ctx.cleanup();
});

describe("paper file upload (PDF in SQLite)", () => {
  it("persists the PDF and filename across a fresh API context and a different port", async () => {
    const fileName = "长期记忆 LongMemEval.pdf";
    const upload = await app.request(
      "http://localhost/api/papers/file-paper-1/file",
      {
        method: "PUT",
        headers: { "content-type": "application/pdf", "content-length": String(pdf.byteLength), "x-file-name": encodeURIComponent(fileName) },
        body: pdf.buffer as ArrayBuffer,
      },
      ctx.bindings,
    );
    expect(upload.status).toBe(201);
    const payload = (await upload.json()) as { paperId: string; size: number; cloudStored: boolean };
    // `cloudStored:false` = PDF 落在本地 SQLite,没有云端副本(本项目零云依赖)。
    expect(payload).toMatchObject({ paperId: "file-paper-1", size: pdf.byteLength, cloudStored: false });

    // 桌面重启会换端口,此处不复用上传请求的上下文或浏览器缓存。
    const reopenedApp = new Hono<AppEnv>().route("/api", fileRoutes).route("/api", paperRoutes);
    const reopenedBindings = { ...ctx.bindings };
    const metadata = await reopenedApp.request("http://127.0.0.1:31416/api/papers/file-paper-1", {}, reopenedBindings);
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({ paper: { fileName, hasFile: true, mimeType: "application/pdf", fileSize: pdf.byteLength } });

    const download = await reopenedApp.request(
      "http://127.0.0.1:31416/api/papers/file-paper-1/file",
      { },
      reopenedBindings,
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/pdf");
    const body = new Uint8Array(await download.arrayBuffer());
    expect(body.byteLength).toBe(pdf.byteLength);
    expect(body).toEqual(pdf);
  });

  it("fills a missing legacy filename when the caller sends no filename header", async () => {
    const upload = await app.request("http://localhost/api/papers/file-paper-legacy/file", {
      method: "PUT",
      headers: { "content-type": "application/pdf", "content-length": String(pdf.byteLength) },
      body: pdf.buffer as ArrayBuffer,
    }, ctx.bindings);
    expect(upload.status).toBe(201);
    const response = await app.request("http://localhost/api/papers/file-paper-legacy", {}, ctx.bindings);
    expect(await response.json()).toMatchObject({ paper: { fileName: "file-paper-legacy.pdf", hasFile: true } });
  });

  it("preserves an existing filename for callers that send no filename header", async () => {
    await app.request("http://localhost/api/papers/file-paper-existing", {
      method: "PATCH", headers: jsonHeaders(), body: JSON.stringify({ fileName: "original.pdf" }),
    }, ctx.bindings);
    const upload = await app.request("http://localhost/api/papers/file-paper-existing/file", {
      method: "PUT",
      headers: { "content-type": "application/pdf", "content-length": String(pdf.byteLength) },
      body: pdf.buffer as ArrayBuffer,
    }, ctx.bindings);
    expect(upload.status).toBe(201);
    const response = await app.request("http://localhost/api/papers/file-paper-existing", {}, ctx.bindings);
    expect(await response.json()).toMatchObject({ paper: { fileName: "original.pdf", hasFile: true } });
  });

  it("replaces PDF bytes and filename together", async () => {
    const replacement = new Uint8Array([...pdf, 10]);
    const upload = await app.request("http://localhost/api/papers/file-paper-1/file", {
      method: "PUT",
      headers: { "content-type": "application/pdf", "content-length": String(replacement.byteLength), "x-file-name": encodeURIComponent("修订稿.pdf") },
      body: replacement.buffer,
    }, ctx.bindings);
    expect(upload.status).toBe(201);
    const metadata = await app.request("http://127.0.0.1:31417/api/papers/file-paper-1", {}, { ...ctx.bindings });
    expect(await metadata.json()).toMatchObject({ paper: { fileName: "修订稿.pdf", fileSize: replacement.byteLength, hasFile: true } });
    const download = await app.request("http://127.0.0.1:31417/api/papers/file-paper-1/file", {}, { ...ctx.bindings });
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(replacement);
  });

  it.each(["", "%20%20", "%E0%A4%A", encodeURIComponent("x".repeat(301)), "bad%00name.pdf"])("rejects invalid filename %s without writing PDF or metadata", async (fileName) => {
    const response = await app.request("http://localhost/api/papers/file-paper-invalid/file", {
      method: "PUT",
      headers: { "content-type": "application/pdf", "content-length": String(pdf.byteLength), "x-file-name": fileName },
      body: pdf.buffer as ArrayBuffer,
    }, ctx.bindings);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "INVALID_FILE_NAME" });
    const metadata = await app.request("http://localhost/api/papers/file-paper-invalid", {}, ctx.bindings);
    expect(await metadata.json()).toMatchObject({ paper: { fileName: null, fileSize: null, hasFile: false } });
    const download = await app.request("http://localhost/api/papers/file-paper-invalid/file", {}, ctx.bindings);
    expect(download.status).toBe(404);
  });

  it("rejects actual oversized bytes even when Content-Length is smaller", async () => {
    const response = await app.request("http://localhost/api/papers/file-paper-invalid/file", {
      method: "PUT",
      headers: { "content-type": "application/pdf", "content-length": "1", "x-file-name": "too-large.pdf" },
      body: new Uint8Array(25 * 1024 * 1024 + 1),
    }, ctx.bindings);
    expect(response.status).toBe(413);
    const metadata = await app.request("http://localhost/api/papers/file-paper-invalid", {}, ctx.bindings);
    expect(await metadata.json()).toMatchObject({ paper: { fileName: null, fileSize: null, hasFile: false } });
  });

  it("rolls back the PDF if its metadata cannot be saved", async () => {
    const client = createClient({ url: ctx.dbUrl });
    try {
      await client.execute(`CREATE TRIGGER fail_file_metadata BEFORE UPDATE ON papers
        WHEN NEW.id = 'file-paper-transaction' BEGIN SELECT RAISE(ABORT, 'metadata update rejected'); END`);
      const response = await app.request("http://localhost/api/papers/file-paper-transaction/file", {
        method: "PUT",
        headers: { "content-type": "application/pdf", "content-length": String(pdf.byteLength), "x-file-name": "rollback.pdf" },
        body: pdf.buffer as ArrayBuffer,
      }, ctx.bindings);
      expect(response.status).toBe(500);
      const files = await client.execute("SELECT paper_id FROM paper_files WHERE paper_id = 'file-paper-transaction'");
      expect(files.rows).toHaveLength(0);
      const metadata = await client.execute("SELECT file_name, file_size FROM papers WHERE id = 'file-paper-transaction'");
      expect(metadata.rows[0]).toMatchObject({ file_name: null, file_size: null });
    } finally {
      await client.execute("DROP TRIGGER IF EXISTS fail_file_metadata");
      client.close();
    }
  });

  it("rejects non-PDF content types with 415", async () => {
    const response = await app.request(
      "http://localhost/api/papers/file-paper-1/file",
      { method: "PUT", headers: { "content-type": "text/plain" }, body: new TextEncoder().encode("not a pdf") },
      ctx.bindings,
    );
    expect(response.status).toBe(415);
  });

  it("returns 404 when the paper has no PDF", async () => {
    const response = await app.request(
      "http://localhost/api/papers/file-paper-2/file",
      { },
      ctx.bindings,
    );
    expect(response.status).toBe(404);
    const payload = (await response.json()) as { error?: string };
    expect(payload.error).toBe("FILE_NOT_FOUND");
  });
});

describe("paper hasFile reflects the paper_files table", () => {
  it("is true only for papers that actually have a PDF row", async () => {
    const response = await app.request(
      "http://localhost/api/papers?projectId=file-project",
      { },
      ctx.bindings,
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { papers: Array<{ id: string; hasFile: boolean }> };
    const byId = new Map(payload.papers.map((paper) => [paper.id, paper.hasFile]));
    // 回归:hasFile 曾恒为 false(读的是从不写入的 papers.r2_key)。
    expect(byId.get("file-paper-1")).toBe(true);
    expect(byId.get("file-paper-2")).toBe(false);
  });
});
