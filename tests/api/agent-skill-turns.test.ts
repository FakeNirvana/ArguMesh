// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import app from "../../server/index";
import { createDatabase } from "../../server/db/client";
import { aiMessages } from "../../server/db/schema";
import type { AgentSkill, AgentSkillSnapshot } from "../../shared/agent-skills";
import type { AgentTurnInput } from "../../server/services/research-agent";
import { createTestContext, jsonHeaders, type TestContext } from "./helpers";

const mock = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../server/services/pi-agent", () => ({ runPiAgentTurn: mock.run, disposePiAgentSession: vi.fn() }));
let context: TestContext;
const projectId = "skills-turn-project";
const completed = { reply: "技能分析完成", model: "test-model", citations: [], actions: [] };
beforeAll(async () => {
  context = await createTestContext();
  await app.request(`/api/projects/${projectId}`, { method: "PUT", headers: jsonHeaders(), body: JSON.stringify({ name: "技能回合" }) }, context.bindings);
});
beforeEach(() => mock.run.mockReset().mockResolvedValue(completed));
afterAll(() => context.cleanup());
async function install(name: string, body = "保留原始证据。") {
  const response = await app.request("/api/agent/skills", { method: "POST", headers: jsonHeaders(), body: JSON.stringify({
    files: [{ path: "SKILL.md", content: `---\nname: ${name}\ndescription: 研究工作流\n---\n${body}` }],
  }) }, context.bindings);
  expect(response.status).toBe(201);
  return (await response.json() as { skill: AgentSkill }).skill;
}
async function conversation() {
  const response = await app.request(`/api/projects/${projectId}/ai/conversations`, { method: "POST", headers: jsonHeaders(), body: "{}" }, context.bindings);
  const { conversation } = await response.json() as { conversation: { id: string } };
  return `/api/projects/${projectId}/ai/conversations/${conversation.id}`;
}
function send(path: string, skillIds?: string[], content = "检查项目证据") {
  return app.request(`${path}/messages`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ content, skillIds }) }, context.bindings);
}
async function recordSelected(_env: unknown, turn: AgentTurnInput) {
  const skill = turn.availableSkills![0];
  const snapshot: AgentSkillSnapshot = {
    id: skill.id, name: skill.name, description: skill.description, source: skill.source,
    version: skill.version, files: skill.files, loadedAt: new Date().toISOString(),
  };
  await turn.onSkillLoaded!(snapshot);
  return completed;
}

it("会话记录所选模式与实际加载版本，卸载重装后仍可查看原内容", async () => {
  const skill = await install("turn-snapshot");
  const path = await conversation();
  mock.run.mockImplementationOnce(recordSelected);
  expect(await (await send(path, [skill.id])).text()).toContain("event: done");
  const detail = await (await app.request(path, {}, context.bindings)).json() as { messages: Array<{ id: string; role: string; skills: unknown[]; skillSelection: string[]; skillsJson?: string }> };
  const message = detail.messages.find((item) => item.role === "assistant")!;
  expect(message.skillSelection).toEqual([skill.id]);
  expect(message.skills).toEqual([expect.objectContaining({ id: skill.id, version: skill.version, source: "user" })]);
  expect(message.skillsJson).toBeUndefined();
  expect(message.skills[0]).not.toHaveProperty("files");
  await app.request(`/api/agent/skills/${encodeURIComponent(skill.id)}`, { method: "DELETE" }, context.bindings);
  const replacement = await install("turn-snapshot", "替换后的新说明。");
  expect(replacement.version).not.toBe(skill.version);
  const snapshot = await (await app.request(`${path}/messages/${message.id}/skills/${encodeURIComponent(skill.id)}`, {}, context.bindings)).json() as { skill: AgentSkillSnapshot };
  expect(snapshot.skill.version).toBe(skill.version);
  expect(snapshot.skill.files[0].content).toContain("保留原始证据");
  expect((await app.request(`${path.replace(projectId, "another-project")}/messages/${message.id}/skills/${encodeURIComponent(skill.id)}`, {}, context.bindings)).status).toBe(404);
});

it("失败回合仍保留已加载的技能快照", async () => {
  const skill = await install("failed-turn-skill");
  const path = await conversation();
  mock.run.mockImplementationOnce(async (...args: Parameters<typeof recordSelected>) => { await recordSelected(...args); throw new Error("模型连接中断"); });
  expect(await (await send(path, [skill.id])).text()).toContain("event: error");
  const detail = await (await app.request(path, {}, context.bindings)).json() as { messages: Array<{ role: string; status: string; skills: unknown[] }> };
  expect(detail.messages.find((item) => item.role === "assistant")).toMatchObject({ status: "failed", skills: [expect.objectContaining({ version: skill.version })] });
});

it("消息被另一入口删除后，快照保存失败会停止技能加载", async () => {
  const skill = await install("deleted-message-skill");
  const path = await conversation();
  mock.run.mockImplementationOnce(async (env: unknown, turn: AgentTurnInput) => {
    await createDatabase(context.bindings).delete(aiMessages).where(eq(aiMessages.id, turn.assistantMessageId));
    return recordSelected(env, turn);
  });
  const stream = await (await send(path, [skill.id])).text();
  expect(stream).toContain("无法保存本回合技能快照");
  expect(stream).not.toContain("event: done");
});

it("不使用技能时不给模型目录，手动命令仅解析本轮可用技能", async () => {
  const skill = await install("manual-turn-skill");
  const path = await conversation();
  await (await send(path, [])).text();
  expect(mock.run.mock.calls[0][1].availableSkills).toEqual([]);
  expect((await send(path, [], "/skill:manual-turn-skill 检查证据")).status).toBe(400);
  await (await send(path, [skill.id], "/skill:manual-turn-skill 检查证据")).text();
  expect(mock.run.mock.calls[1][1]).toMatchObject({ message: "检查证据", selectedSkillIds: [skill.id] });
  await app.request(`/api/agent/skills/${encodeURIComponent(skill.id)}`, { method: "PATCH", headers: jsonHeaders(), body: '{"enabled":false}' }, context.bindings);
  expect((await send(path, [skill.id])).status).toBe(409);
  const detail = await (await app.request(path, {}, context.bindings)).json() as { messages: unknown[] };
  expect(detail.messages).toHaveLength(4);
});
