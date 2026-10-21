// @vitest-environment node
import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentSkill, AgentSkillSummary } from "../../shared/agent-skills";
import { migrateDatabase } from "../../scripts/migrate-custom";
import { createDatabase } from "../../server/db/client";
import { agentSkills, aiConversations, aiMessages, projects } from "../../server/db/schema";
import { agentSkillRoutes } from "../../server/routes/agent-skills";
import { getAvailableAgentSkills, prepareSkillInstall, skillInstructions, validateSkillResourcePath } from "../../server/services/agent-skills";
import type { AppEnv } from "../../server/types";
import { createTestContext, jsonHeaders, type TestContext } from "./helpers";

const app = new Hono<AppEnv>().route("/api", agentSkillRoutes);
const content = (name: string, body = "先读取项目上下文，再根据实际证据给出分析。") => `---\nname: ${name}\ndescription: "自定义科研分析技能"\n---\n\n${body}\n`;
let context: TestContext;
function request(path: string, method = "GET", body?: unknown) {
  return app.request(`/api/agent/skills${path}`, { method, headers: jsonHeaders(), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, context.bindings);
}
async function install(name: string) {
  const response = await request("", "POST", { files: [{ path: "SKILL.md", content: content(name) }] });
  expect(response.status).toBe(201);
  return ((await response.json()) as { skill: AgentSkill }).skill;
}

beforeAll(async () => { context = await createTestContext(); });
afterAll(() => context.cleanup());

describe("Research Agent skill installation and management", () => {
  it("ships builtin instructions with stable content versions and previews", async () => {
    const response = await request("");
    expect(response.status).toBe(200);
    const { skills } = await response.json() as { skills: AgentSkillSummary[] };
    expect(skills.filter((skill) => skill.source === "builtin")).toHaveLength(3);
    expect(skills.every((skill) => skill.enabled && /^[a-f0-9]{64}$/.test(skill.version))).toBe(true);
    expect(skills.every((skill) => !("files" in skill))).toBe(true);
    const detail = await request(`/${encodeURIComponent(skills[0].id)}`);
    const { skill } = await detail.json() as { skill: AgentSkill };
    expect(skill.files[0]).toMatchObject({ path: "SKILL.md" });
    expect(skill.files[0].content).toContain("project_context");
  });

  it("imports a folder with quoted/multiline metadata and retains package-relative text resources", async () => {
    const response = await request("", "POST", { files: [
      { path: "my-skill/SKILL.md", content: "---\nname: 'folder-research'\ndescription: >-\n  Compare evidence\n  for this project.\n---\n\nRead references/checklist.md before comparing evidence." },
      { path: "my-skill/references/checklist.md", content: "# Checklist\nCheck evidence and its limits." },
      { path: "my-skill/scripts/analyze.py", content: "print('This script is stored, not executed')" },
    ] });
    expect(response.status).toBe(201);
    const { skill } = await response.json() as { skill: AgentSkill };
    expect(skill).toMatchObject({ id: "user:folder-research", name: "folder-research", description: "Compare evidence for this project.", source: "user", enabled: true, fileCount: 3 });
    expect(skill.files.map((file) => file.path)).toEqual(["SKILL.md", "references/checklist.md", "scripts/analyze.py"]);
    expect(skill.warnings).toContain("此技能包含脚本；Research Agent 仅使用说明与文本资料，不执行这些脚本。");
    expect(skillInstructions(skill.files[0].content)).toBe("Read references/checklist.md before comparing evidence.");
    const again = prepareSkillInstall([...skill.files].reverse());
    expect(again.version).toBe(skill.version);
  });

  it("never overwrites installed content or shadows builtin skills", async () => {
    const original = await install("immutable-research");
    const duplicate = await request("", "POST", { files: [{ path: "SKILL.md", content: content("immutable-research", "Replace everything") }] });
    expect(duplicate.status).toBe(409);
    const detail = await request(`/${encodeURIComponent(original.id)}`);
    expect(((await detail.json()) as { skill: AgentSkill }).skill.version).toBe(original.version);
    expect((await request("", "POST", { files: [{ path: "SKILL.md", content: content("evidence-review") }] })).status).toBe(409);
  });

  it("requires JSON media types for installation instead of accepting cross-origin simple form requests", async () => {
    for (const mediaType of ["text/plain", "application/x-www-form-urlencoded"]) {
      const response = await app.request("/api/agent/skills", {
        method: "POST", headers: { "content-type": mediaType },
        body: JSON.stringify({ files: [{ path: "SKILL.md", content: content("cross-origin-skill") }] }),
      }, context.bindings);
      expect(response.status).toBe(415);
    }
    expect((await request("/user:cross-origin-skill")).status).toBe(404);
  });

  it("persists builtin enablement and protects builtin uninstallation", async () => {
    const id = encodeURIComponent("builtin:evidence-review");
    expect((await request(`/${id}`, "PATCH", { enabled: false })).status).toBe(200);
    const { skill } = await (await request(`/${id}`)).json() as { skill: AgentSkill };
    expect(skill.enabled).toBe(false);
    expect((await request(`/${id}`, "DELETE")).status).toBe(409);
    await expect(getAvailableAgentSkills(context.bindings, [skill.id])).rejects.toMatchObject({ code: "SKILL_DISABLED", status: 409 });
    expect((await request(`/${id}`, "PATCH", { enabled: true })).status).toBe(200);
  });

  it("excludes disabled skills from automatic selection and rejects stale explicit selections", async () => {
    const skill = await install("toggle-research");
    expect((await getAvailableAgentSkills(context.bindings)).some((entry) => entry.id === skill.id)).toBe(true);
    await request(`/${encodeURIComponent(skill.id)}`, "PATCH", { enabled: false });
    expect((await getAvailableAgentSkills(context.bindings)).some((entry) => entry.id === skill.id)).toBe(false);
    expect(await getAvailableAgentSkills(context.bindings, [])).toEqual([]);
    await expect(getAvailableAgentSkills(context.bindings, ["user:missing"])).rejects.toMatchObject({ code: "SKILL_NOT_FOUND", status: 404 });
    await expect(getAvailableAgentSkills(context.bindings, [skill.id, skill.id])).rejects.toMatchObject({ code: "INVALID_SKILL_SELECTION", status: 400 });
    await request(`/${encodeURIComponent(skill.id)}`, "DELETE");
    expect((await request(`/${encodeURIComponent(skill.id)}`)).status).toBe(404);
  });

  it("rejects traversal, absolute/hidden paths, duplicate files and multi-skill folders before writing", async () => {
    const before = await createDatabase(context.bindings).select().from(agentSkills);
    for (const path of ["../SKILL.md", "/SKILL.md", "C:/SKILL.md", "skill\\SKILL.md", "skill/../SKILL.md", "skill/.env", "references/a\u0000.md"]) {
      expect((await request("", "POST", { files: [{ path, content: content("bad-path") }] })).status, path).toBe(400);
    }
    expect((await request("", "POST", { files: [{ path: "SKILL.md", content: content("duplicate-path") }, { path: "skill.md", content: content("duplicate-path") }] })).status).toBe(400);
    expect((await request("", "POST", { files: [{ path: "a/SKILL.md", content: content("multi-a") }, { path: "b/SKILL.md", content: content("multi-b") }] })).status).toBe(400);
    expect((await createDatabase(context.bindings).select().from(agentSkills)).length).toBe(before.length);
    expect(validateSkillResourcePath("references/checklist.md")).toBe(true);
    expect(validateSkillResourcePath("references/../SKILL.md")).toBe(false);
  });

  it("rejects malformed YAML, missing descriptions, empty bodies and invalid names", async () => {
    for (const text of [
      "No frontmatter", "---\nname: incomplete\n---\nbody", "---\nname: [invalid\ndescription: invalid\n---\nbody",
      content("UPPER_CASE"), content("double--hyphen"), content("empty-body", ""),
      "---\nname: invalid-description\ndescription: [one, two]\n---\nbody",
    ]) {
      expect((await request("", "POST", { files: [{ path: "SKILL.md", content: text }] })).status).toBe(400);
    }
    expect((await request("", "POST", { path: "C:/skills" })).status).toBe(400);
  });

  it("enforces file, body, package and text-only upload limits", async () => {
    expect((await request("", "POST", { files: [{ path: "SKILL.md", content: content("too-big", "x".repeat(65_536)) }] })).status).toBe(413);
    expect((await request("", "POST", { files: [{ path: "SKILL.md", content: content("body-too-long", "x".repeat(32_001)) }] })).status).toBe(400);
    expect((await request("", "POST", { files: [{ path: "SKILL.md", content: content("binary-data") }, { path: "references/data.txt", content: "binary\u0000content" }] })).status).toBe(400);
    const files = [{ path: "SKILL.md", content: content("package-too-large") }, ...Array.from({ length: 8 }, (_, index) => ({ path: `references/${index}.txt`, content: "x".repeat(65_536) }))];
    expect((await request("", "POST", { files })).status).toBe(413);
    expect((await request("", "POST", { files: [...Array.from({ length: 65 }, (_, index) => ({ path: `references/${index}.txt`, content: "x" }))] })).status).toBe(400);
  });

  it("uninstall/reinstall leaves previously captured message content and selection unchanged", async () => {
    const skill = await install("historical-skill");
    const db = createDatabase(context.bindings);
    const now = new Date().toISOString();
    await db.insert(projects).values({ id: "skill-history-project", name: "技能历史", createdAt: now });
    await db.insert(aiConversations).values({ id: "skill-history-conversation", projectId: "skill-history-project", createdAt: now, updatedAt: now });
    const snapshot = [{ id: skill.id, name: skill.name, description: skill.description, source: skill.source, version: skill.version, files: skill.files, loadedAt: now }];
    await db.insert(aiMessages).values({ id: "skill-history-message", projectId: "skill-history-project", conversationId: "skill-history-conversation", role: "assistant", content: "保留证据分析", skillsJson: JSON.stringify(snapshot), skillSelectionJson: JSON.stringify([skill.id]), createdAt: now });
    expect((await request(`/${encodeURIComponent(skill.id)}`, "DELETE")).status).toBe(200);
    const reinstall = await request("", "POST", { files: [{ path: "SKILL.md", content: content("historical-skill", "Updated workflow") }] });
    expect(reinstall.status).toBe(201);
    expect(((await reinstall.json()) as { skill: AgentSkill }).skill.version).not.toBe(skill.version);
    const message = await db.select().from(aiMessages).where(eq(aiMessages.id, "skill-history-message")).get();
    expect(JSON.parse(message!.skillsJson)).toEqual(snapshot);
    expect(JSON.parse(message!.skillSelectionJson)).toEqual([skill.id]);
  });
});

it("upgrades an existing message database idempotently without replacing message history", async () => {
  const legacy = await createTestContext();
  const client = createClient({ url: legacy.dbUrl });
  try {
    await client.execute("INSERT INTO projects (id, name, created_at) VALUES ('legacy-skill-project', 'legacy', '2026-10-21')");
    await client.execute("INSERT INTO ai_conversations (id, project_id, created_at, updated_at) VALUES ('legacy-skill-conversation', 'legacy-skill-project', '2026-10-21', '2026-10-21')");
    await client.execute("INSERT INTO ai_messages (id, project_id, conversation_id, role, content, created_at) VALUES ('legacy-skill-message', 'legacy-skill-project', 'legacy-skill-conversation', 'user', 'original message', '2026-10-21')");
    await client.execute("DROP TABLE agent_skills");
    await client.execute("ALTER TABLE ai_messages DROP COLUMN skills_json");
    await client.execute("ALTER TABLE ai_messages DROP COLUMN skill_selection_json");
    await client.execute("DELETE FROM __drizzle_migrations WHERE hash = '0015_agent_skills'");
    await migrateDatabase(legacy.dbUrl);
    await migrateDatabase(legacy.dbUrl);
    const message = await client.execute("SELECT content, skills_json, skill_selection_json FROM ai_messages WHERE id = 'legacy-skill-message'");
    expect(message.rows[0]).toMatchObject({ content: "original message", skills_json: "[]", skill_selection_json: "null" });
    const applied = await client.execute("SELECT count(*) AS total FROM __drizzle_migrations WHERE hash = '0015_agent_skills'");
    expect(applied.rows[0].total).toBe(1);
  } finally {
    client.close();
    legacy.cleanup();
  }
});

it("fresh source seed applies the same skill migration and stays idempotent", async () => {
  const fixture = resolve(mkdtempSync(join(tmpdir(), "argumesh-skills-seed-")));
  const databaseUrl = `file:${join(fixture, "seed.db")}`;
  const runSeed = () => promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/seed.ts"], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl, DATABASE_AUTH_TOKEN: "", ARGUMESH_DATA_DIR: fixture },
    windowsHide: true, timeout: 20_000,
  });
  const client = createClient({ url: databaseUrl });
  try {
    await runSeed();
    const columns = await client.execute("PRAGMA table_info(ai_messages)");
    expect(columns.rows.map((column) => column.name)).toEqual(expect.arrayContaining(["skills_json", "skill_selection_json"]));
    await client.execute("INSERT INTO agent_skills (id, name, source, updated_at) VALUES ('user:seed-preserved', 'seed-preserved', 'user', '2026-10-21')");
    await runSeed();
    expect((await client.execute("SELECT id FROM agent_skills")).rows[0].id).toBe("user:seed-preserved");
    const demo = await client.execute("SELECT count(*) AS total FROM projects WHERE id = 'demo-occluded-pose'");
    expect(demo.rows[0].total).toBe(1);
    const applied = await client.execute("SELECT count(*) AS total FROM __drizzle_migrations WHERE hash = '0015_agent_skills'");
    expect(applied.rows[0].total).toBe(1);
  } finally {
    client.close();
    const relativeFixture = relative(resolve(tmpdir()), fixture);
    if (relativeFixture && !relativeFixture.startsWith("..") && !relativeFixture.includes(":")) {
      try { rmSync(fixture, { recursive: true, force: true }); }
      catch { /* libSQL may retain a Windows file handle after close, as in the API fixture helper. */ }
    }
  }
}, 30_000);
