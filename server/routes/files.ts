import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { createDatabase } from "../db/client";
import { paperFiles, papers } from "../db/schema";
import type { AppEnv } from "../types";

const MAX_FILE_SIZE = 25 * 1024 * 1024;

export const fileRoutes = new Hono<AppEnv>();

// PDF 文件本体存本地 SQLite 的 paper_files 表。单文件 ≤ 25 MB,行内 BLOB 存储。

fileRoutes.put("/papers/:paperId/file", async (c) => {
  const paperId = c.req.param("paperId");
  const contentType = c.req.header("content-type") ?? "application/pdf";
  const contentLengthHeader = c.req.header("content-length");
  const contentLength = Number(contentLengthHeader ?? "0");

  if (!contentType.toLowerCase().startsWith("application/pdf")) {
    return c.json({ error: "UNSUPPORTED_FILE_TYPE", message: "当前仅支持 PDF" }, 415);
  }
  if (!contentLengthHeader || !Number.isSafeInteger(contentLength) || contentLength <= 0) {
    return c.json({ error: "CONTENT_LENGTH_REQUIRED", message: "上传 PDF 时必须提供有效的 Content-Length" }, 411);
  }
  if (contentLength > MAX_FILE_SIZE) {
    return c.json({ error: "FILE_TOO_LARGE", message: "PDF 不能超过 25 MB" }, 413);
  }
  if (!c.req.raw.body) {
    return c.json({ error: "EMPTY_FILE", message: "请求体中没有文件" }, 400);
  }

  const encodedFileName = c.req.header("x-file-name");
  let uploadedFileName: string | undefined;
  if (encodedFileName !== undefined) {
    try {
      uploadedFileName = decodeURIComponent(encodedFileName).trim();
    } catch {
      return c.json({ error: "INVALID_FILE_NAME", message: "PDF 文件名编码不合法" }, 400);
    }
    if (!uploadedFileName || uploadedFileName.length > 300 || /[\u0000-\u001f\u007f]/.test(uploadedFileName)) {
      return c.json({ error: "INVALID_FILE_NAME", message: "PDF 文件名须为 1–300 个字符且不能包含控制字符" }, 400);
    }
  }

  const db = createDatabase(c.env);
  const paper = await db.select().from(papers).where(eq(papers.id, paperId)).get();
  if (!paper) {
    return c.json({ error: "PAPER_NOT_FOUND", message: "论文不存在" }, 404);
  }

  const data = new Uint8Array(await c.req.arrayBuffer());
  // Content-Length 由调用方提供,实际字节数也必须校验后才能入库。
  if (data.byteLength > MAX_FILE_SIZE) {
    return c.json({ error: "FILE_TOO_LARGE", message: "PDF 不能超过 25 MB" }, 413);
  }
  if (data.byteLength === 0) {
    return c.json({ error: "EMPTY_FILE", message: "请求体中没有文件" }, 400);
  }
  const fileName = uploadedFileName ?? (paper.fileName?.trim() || `${paperId}.pdf`);
  const now = new Date().toISOString();

  await db.transaction(async (tx) => {
    await tx
      .insert(paperFiles)
      .values({
        paperId,
        data,
        mimeType: "application/pdf",
        fileSize: data.byteLength,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: paperFiles.paperId,
        set: { data, mimeType: "application/pdf", fileSize: data.byteLength, updatedAt: now },
      });

    await tx
      .update(papers)
      .set({ fileName, mimeType: "application/pdf", fileSize: data.byteLength })
      .where(eq(papers.id, paperId));
  });

  // `cloudStored: false` —— PDF 落在本地 SQLite(`paper_files` 表),没有云端副本。
  // 前端据此区分「已入库」与「只存在当前浏览器 IndexedDB」两种上传结果。
  return c.json({ paperId, size: data.byteLength, cloudStored: false }, 201);
});

fileRoutes.get("/papers/:paperId/file", async (c) => {
  const db = createDatabase(c.env);
  const paperId = c.req.param("paperId");
  const paper = await db.select().from(papers).where(eq(papers.id, paperId)).get();

  if (!paper) {
    return c.json({ error: "PAPER_NOT_FOUND", message: "论文不存在" }, 404);
  }

  const file = await db.select().from(paperFiles).where(eq(paperFiles.paperId, paperId)).get();
  if (!file) {
    return c.json({ error: "FILE_NOT_FOUND", message: "该论文尚未上传 PDF" }, 404);
  }

  const headers = new Headers();
  headers.set("content-type", file.mimeType);
  headers.set("content-disposition", `inline; filename="${paperId}.pdf"`);
  headers.set("content-length", String(file.fileSize));
  return new Response(new Uint8Array(file.data), { headers });
});
