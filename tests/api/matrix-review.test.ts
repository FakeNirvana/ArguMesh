// @vitest-environment node
import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import app from "../../server/index";
import { createDatabase } from "../../server/db/client";
import { evidenceCells } from "../../server/db/schema";
import { createTestContext, jsonHeaders, type TestContext } from "./helpers";

let ctx: TestContext;
const matrix = "review-matrix";
const id = (dimension: number, paper = "paper-a") => `${matrix}:review-dim-${dimension}:${paper}`;
const request = (path: string, method = "GET", input?: unknown) => app.request(`http://localhost/api${path}`, {
  method, headers: jsonHeaders(), ...(input ? { body: JSON.stringify(input) } : {}),
}, ctx.bindings);
const confirm = (evidenceIds: string[], paperId?: string) => request(`/matrices/${matrix}/confirm`, "POST", { evidenceIds, paperId });

beforeAll(async () => {
  ctx = await createTestContext();
  await request("/projects/review-project", "PUT", { id: "review-project", name: "Review project" });
  for (const paper of ["paper-a", "paper-b"]) await request(`/projects/review-project/papers/${paper}`, "PUT", { id: paper, title: paper, authors: "", venue: "", year: 2026 });
  await request(`/matrices/${matrix}`, "PUT", { projectId: "review-project", name: "Review", paperIds: ["paper-a", "paper-b"], dimensions: Array.from({ length: 7 }, (_, i) => ({ id: `review-dim-${i + 1}`, label: `Dimension ${i + 1}` })) });
  const db = createDatabase(ctx.bindings);
  for (const paper of ["paper-a", "paper-b"]) for (let dimension = 1; dimension <= 7; dimension++) {
    await db.update(evidenceCells).set({ value: "Sourced conclusion", claim: "Claim from the paper", sourcePage: "第 3 页", sourceSection: "Results", sourceExcerpt: "Quoted source text.", status: "draft", locked: false, updatedAt: "2026-01-01T00:00:00Z" }).where(eq(evidenceCells.id, id(dimension, paper)));
  }
  await db.update(evidenceCells).set({ status: "missing" }).where(eq(evidenceCells.id, id(2)));
  await db.update(evidenceCells).set({ status: "conflict" }).where(eq(evidenceCells.id, id(3)));
  await db.update(evidenceCells).set({ status: "confirmed", locked: false }).where(eq(evidenceCells.id, id(4)));
  await db.update(evidenceCells).set({ locked: true }).where(eq(evidenceCells.id, id(5)));
  await db.update(evidenceCells).set({ value: "待提取", sourcePage: "—" }).where(eq(evidenceCells.id, id(6)));
  await db.update(evidenceCells).set({ sourceExcerpt: " " }).where(eq(evidenceCells.id, id(7)));
});
afterAll(() => ctx.cleanup());

it("单篇批量确认仅修改有来源的草稿，保护缺失、冲突、确认、锁定和占位内容", async () => {
  const response = await confirm(Array.from({ length: 7 }, (_, i) => id(i + 1)), "paper-a");
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ updatedIds: [id(1)], skipped: 6 });
  const db = createDatabase(ctx.bindings);
  const source = await db.select().from(evidenceCells).where(eq(evidenceCells.id, id(1))).get();
  expect(source).toMatchObject({ status: "confirmed", locked: true, value: "Sourced conclusion", claim: "Claim from the paper", sourcePage: "第 3 页", sourceExcerpt: "Quoted source text." });
  expect(source!.updatedAt).not.toBe("2026-01-01T00:00:00Z");
  expect(await db.select().from(evidenceCells).where(eq(evidenceCells.id, id(4))).get()).toMatchObject({ status: "confirmed", locked: false });
  expect(await db.select().from(evidenceCells).where(eq(evidenceCells.id, id(1, "paper-b"))).get()).toMatchObject({ status: "draft", locked: false });
});

it("范围中含其他论文的证据时整批拒绝，不产生部分确认", async () => {
  const response = await confirm([id(1, "paper-b"), id(1)], "paper-b");
  expect(response.status).toBe(400);
  expect(await createDatabase(ctx.bindings).select().from(evidenceCells).where(eq(evidenceCells.id, id(1, "paper-b"))).get()).toMatchObject({ status: "draft" });
});

it("范围中含其他矩阵或不存在的证据时整批拒绝", async () => {
  const response = await confirm([id(1, "paper-b"), "other-matrix:dim:paper"]);
  expect(response.status).toBe(400);
  expect(await createDatabase(ctx.bindings).select().from(evidenceCells).where(eq(evidenceCells.id, id(1, "paper-b"))).get()).toMatchObject({ status: "draft" });
});

it("整个矩阵确认去重、保留已确认内容，重复提交可安全重试", async () => {
  const ids = [id(1), ...Array.from({ length: 7 }, (_, i) => id(i + 1, "paper-b"))];
  const response = await confirm([...ids, ids[1]]);
  expect(response.status).toBe(200);
  const result = await response.json() as { updatedIds: string[]; skipped: number };
  expect(result.updatedIds.sort()).toEqual(ids.slice(1).sort());
  expect(result.skipped).toBe(1);
  expect(await (await confirm(ids)).json()).toEqual({ updatedIds: [], skipped: 8 });
});

it("批量确认锁定后，AI 内容写入仍受现有守卫保护", async () => {
  const response = await request(`/evidence/${id(1)}/content`, "PUT", { value: "Overwrite", status: "draft", confidence: 0.7, claim: "Overwrite", sourcePage: "1", sourceSection: "test", sourceExcerpt: "test" });
  expect(response.status).toBe(409);
});

it("空确认列表和缺失矩阵返回明确错误", async () => {
  expect((await confirm([])).status).toBe(400);
  expect((await request("/matrices/no-matrix/confirm", "POST", { evidenceIds: [id(1)] })).status).toBe(404);
});
