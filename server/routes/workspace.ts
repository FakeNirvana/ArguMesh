import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import type { AppEnv } from "../types";

export const workspaceRoutes = new Hono<AppEnv>();

function workspacePath(env: AppEnv["Bindings"]): string | null {
  return env.ARGUMESH_DATA_DIR
    ? join(env.ARGUMESH_DATA_DIR, "workspace.json")
    : null;
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
  await mkdir(c.env.ARGUMESH_DATA_DIR!, { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, raw, { mode: 0o600 });
  await rename(temporary, path);
  return c.json({ saved: true });
});
