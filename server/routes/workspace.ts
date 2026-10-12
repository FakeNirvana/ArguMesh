import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Hono } from "hono";
import type { AppEnv } from "../types";

export const workspaceRoutes = new Hono<AppEnv>();

function workspacePath(env: AppEnv["Bindings"]): string | null {
  return env.ARGUMESH_DATA_DIR
    ? join(env.ARGUMESH_DATA_DIR, "workspace.json")
    : null;
}

function paperCacheDirectory(env: AppEnv["Bindings"], paperId: string): string | null {
  if (!env.ARGUMESH_DATA_DIR || !/^[A-Za-z0-9_-]{1,128}$/.test(paperId)) return null;
  return join(env.ARGUMESH_DATA_DIR, "workspace-cache", paperId);
}

function pageNumber(value: string): number | null {
  const page = Number(value);
  return Number.isInteger(page) && page >= 1 && page <= 10_000 ? page : null;
}

async function atomicWrite(path: string, body: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, body, { mode: 0o600 });
  await rename(temporary, path);
}

workspaceRoutes.get("/workspace/local", async (c) => {
  const path = workspacePath(c.env);
  if (!path) return c.json({ error: "NOT_DESKTOP" }, 404);
  try {
    return c.json({ data: JSON.parse(await readFile(path, "utf8")) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return c.json({ data: null });
    throw error;
  }
});

workspaceRoutes.put("/workspace/local", async (c) => {
  const path = workspacePath(c.env);
  if (!path) return c.json({ error: "NOT_DESKTOP" }, 404);
  const raw = await c.req.text();
  if (raw.length > 16_000_000) return c.json({ error: "WORKSPACE_TOO_LARGE" }, 413);
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return c.json({ error: "INVALID_JSON" }, 400); }
  if (!data || typeof data !== "object" || !Array.isArray((data as Record<string, unknown>).projects) || !Array.isArray((data as Record<string, unknown>).papers)) {
    return c.json({ error: "INVALID_WORKSPACE" }, 400);
  }
  await atomicWrite(path, raw);
  return c.json({ saved: true });
});

workspaceRoutes.get("/workspace/papers/:paperId/translations/:page", async (c) => {
  const directory = paperCacheDirectory(c.env, c.req.param("paperId"));
  const page = pageNumber(c.req.param("page"));
  const language = c.req.query("language") ?? "";
  if (!directory || !page || !language || language.length > 100) return c.json({ error: "INVALID_CACHE_KEY" }, 400);
  const digest = createHash("sha256").update(language).digest("hex").slice(0, 20);
  try {
    return c.json({ data: JSON.parse(await readFile(join(directory, "translations", `${page}-${digest}.json`), "utf8")) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return c.json({ data: null });
    throw error;
  }
});

workspaceRoutes.put("/workspace/papers/:paperId/translations/:page", async (c) => {
  const directory = paperCacheDirectory(c.env, c.req.param("paperId"));
  const page = pageNumber(c.req.param("page"));
  const language = c.req.query("language") ?? "";
  if (!directory || !page || !language || language.length > 100) return c.json({ error: "INVALID_CACHE_KEY" }, 400);
  const raw = await c.req.text();
  if (raw.length > 2_000_000) return c.json({ error: "CACHE_TOO_LARGE" }, 413);
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return c.json({ error: "INVALID_JSON" }, 400); }
  if (!data || typeof data !== "object" || typeof (data as Record<string, unknown>).source !== "string" || !Array.isArray((data as Record<string, unknown>).blocks)) {
    return c.json({ error: "INVALID_TRANSLATION" }, 400);
  }
  const digest = createHash("sha256").update(language).digest("hex").slice(0, 20);
  await atomicWrite(join(directory, "translations", `${page}-${digest}.json`), raw);
  return c.json({ saved: true });
});

workspaceRoutes.get("/workspace/papers/:paperId/ocr", async (c) => {
  const directory = paperCacheDirectory(c.env, c.req.param("paperId"));
  if (!directory) return c.json({ error: "INVALID_CACHE_KEY" }, 400);
  const result: Record<number, string> = {};
  const ocrDirectory = join(directory, "ocr");
  let names: string[];
  try { names = await readdir(ocrDirectory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return c.json({ data: result }); throw error; }
  await Promise.all(names.filter((name) => /^\d+\.txt$/.test(name)).map(async (name) => {
    const page = pageNumber(name.slice(0, -4));
    if (page) result[page] = await readFile(join(ocrDirectory, name), "utf8");
  }));
  return c.json({ data: result });
});

workspaceRoutes.put("/workspace/papers/:paperId/ocr/:page", async (c) => {
  const directory = paperCacheDirectory(c.env, c.req.param("paperId"));
  const page = pageNumber(c.req.param("page"));
  if (!directory || !page) return c.json({ error: "INVALID_CACHE_KEY" }, 400);
  const text = await c.req.text();
  if (text.length > 1_000_000) return c.json({ error: "CACHE_TOO_LARGE" }, 413);
  await atomicWrite(join(directory, "ocr", `${page}.txt`), text);
  return c.json({ saved: true });
});

workspaceRoutes.delete("/workspace/papers/:paperId/cache", async (c) => {
  const directory = paperCacheDirectory(c.env, c.req.param("paperId"));
  if (!directory) return c.json({ error: "INVALID_CACHE_KEY" }, 400);
  await rm(directory, { recursive: true, force: true });
  return c.json({ deleted: true });
});
