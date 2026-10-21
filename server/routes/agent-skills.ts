import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { createDatabase } from "../db/client";
import { agentSkills } from "../db/schema";
import { AGENT_SKILL_LIMITS, AgentSkillError, getAgentSkill, listAgentSkills, prepareSkillInstall } from "../services/agent-skills";
import type { AppEnv } from "../types";

export const agentSkillRoutes = new Hono<AppEnv>();

agentSkillRoutes.onError((error, c) => {
  if (error instanceof AgentSkillError) return c.json({ error: error.code, message: error.message }, error.status);
  console.error("Agent skills request failed", error);
  return c.json({ error: "SKILL_REQUEST_FAILED", message: "技能操作失败，请重试。" }, 500);
});

agentSkillRoutes.get("/agent/skills", async (c) => c.json({ skills: await listAgentSkills(c.env) }));

agentSkillRoutes.post("/agent/skills", bodyLimit({ maxSize: 4 * 1024 * 1024, onError: (c) =>
  c.json({ error: "SKILL_TOO_LARGE", message: "技能包上传大小超出限制。" }, 413) }), async (c) => {
  if (c.req.header("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return c.json({ error: "UNSUPPORTED_CONTENT_TYPE", message: "技能安装请求必须使用 application/json。" }, 415);
  }
  const body = await c.req.json().catch(() => null);
  const parsed = z.object({ files: z.unknown() }).strict().safeParse(body);
  if (!parsed.success) throw new AgentSkillError("INVALID_SKILL_FILES", "请选择 SKILL.md 或一个技能文件夹。");
  const skill = prepareSkillInstall(parsed.data.files);
  const installed = await listAgentSkills(c.env);
  if (installed.some((entry) => entry.name === skill.name)) throw new AgentSkillError("SKILL_ALREADY_INSTALLED", "同名技能已存在。内置技能不能覆盖；用户技能请先卸载再重新安装。", 409);
  if (installed.filter((entry) => entry.source === "user").length >= AGENT_SKILL_LIMITS.installed) throw new AgentSkillError("SKILL_LIMIT_REACHED", "最多安装 50 个用户技能，请先卸载不需要的技能。", 409);
  const db = createDatabase(c.env);
  const inserted = await db.insert(agentSkills).values({
    id: skill.id, name: skill.name, description: skill.description, source: "user", filesJson: JSON.stringify(skill.files),
    enabled: true, version: skill.version, installedAt: skill.installedAt, updatedAt: skill.installedAt!,
  }).onConflictDoNothing().returning({ id: agentSkills.id });
  if (!inserted.length) throw new AgentSkillError("SKILL_ALREADY_INSTALLED", "同名技能已存在，请刷新技能列表。", 409);
  return c.json({ skill }, 201);
});

agentSkillRoutes.get("/agent/skills/:id", async (c) => {
  const skill = await getAgentSkill(c.env, c.req.param("id"));
  if (!skill) throw new AgentSkillError("SKILL_NOT_FOUND", "技能不存在或已卸载。", 404);
  return c.json({ skill });
});

agentSkillRoutes.patch("/agent/skills/:id", bodyLimit({ maxSize: 1024, onError: (c) =>
  c.json({ error: "SKILL_TOO_LARGE", message: "技能设置请求超出限制。" }, 413) }), async (c) => {
  if (c.req.header("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return c.json({ error: "UNSUPPORTED_CONTENT_TYPE", message: "技能设置请求必须使用 application/json。" }, 415);
  }
  const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new AgentSkillError("INVALID_SKILL_SETTINGS", "请指定技能启用状态。");
  const skill = await getAgentSkill(c.env, c.req.param("id"));
  if (!skill) throw new AgentSkillError("SKILL_NOT_FOUND", "技能不存在或已卸载。", 404);
  const db = createDatabase(c.env);
  if (skill.source === "builtin") {
    await db.insert(agentSkills).values({
      id: skill.id, name: skill.name, source: "builtin", enabled: parsed.data.enabled, updatedAt: new Date().toISOString(),
    }).onConflictDoUpdate({ target: agentSkills.id, set: { enabled: parsed.data.enabled, updatedAt: new Date().toISOString() } });
  } else {
    const updated = await db.update(agentSkills).set({ enabled: parsed.data.enabled, updatedAt: new Date().toISOString() }).where(eq(agentSkills.id, skill.id)).returning({ id: agentSkills.id });
    if (!updated.length) throw new AgentSkillError("SKILL_NOT_FOUND", "技能已卸载，请刷新列表。", 404);
  }
  return c.json({ skill: { ...skill, enabled: parsed.data.enabled } });
});

agentSkillRoutes.delete("/agent/skills/:id", async (c) => {
  const skill = await getAgentSkill(c.env, c.req.param("id"));
  if (!skill) throw new AgentSkillError("SKILL_NOT_FOUND", "技能不存在或已卸载。", 404);
  if (skill.source === "builtin") throw new AgentSkillError("BUILTIN_SKILL_PROTECTED", "内置技能不能卸载，可以将其停用。", 409);
  await createDatabase(c.env).delete(agentSkills).where(eq(agentSkills.id, skill.id));
  return c.json({ removed: true });
});
