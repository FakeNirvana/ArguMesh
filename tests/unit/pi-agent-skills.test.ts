// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentSkill, AgentSkillSnapshot } from "../../shared/agent-skills";
import { disposePiAgentSession, runPiAgentTurn } from "../../server/services/pi-agent";

const mock = vi.hoisted(() => ({ create: vi.fn(), action: vi.fn(), loader: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: mock.create, defineTool: (tool: unknown) => tool,
  DefaultResourceLoader: class { constructor(options: unknown) { mock.loader(options); } reload = async () => {}; },
  SessionManager: { inMemory: () => ({ appendMessage: vi.fn() }) }, SettingsManager: { inMemory: () => ({}) },
}));
vi.mock("../../server/services/ai", () => ({ resolveAiForRequest: async () => ({ model: "test-model", provider: {} }) }));
vi.mock("../../server/services/pi-runtime", () => ({ createPiModelBridge: async () => ({ agentDir: "test", modelRuntime: {}, model: { id: "test-model", api: "openai-completions", provider: "test" } }) }));
vi.mock("../../server/services/project-context", () => ({ assembleProjectContext: async () => ({ project: { id: "project" } }) }));
vi.mock("../../server/services/research-agent", async (original) => ({ ...await original<object>(), executeWhitelistedAgentAction: mock.action }));

type Tool = { name: string; execute: (id: string, input: Record<string, unknown>) => Promise<unknown> };
type Options = { customTools: Tool[]; tools: string[] };
const env = { DATABASE_URL: "file::memory:" };
const base = { projectId: "project", conversationId: "skill-runtime", assistantMessageId: "message", message: "梳理证据", history: [] };
const skill: AgentSkill = {
  id: "user:test-skill", name: "test-skill", description: "测试科研指令", source: "user", enabled: true,
  version: "a".repeat(64), installedAt: null, fileCount: 2, warnings: [],
  files: [{ path: "SKILL.md", content: "---\nname: test-skill\ndescription: 测试科研指令\n---\n用证据支撑结论。" }, { path: "references/guide.md", content: "引用实际项目对象，不编造结果。" }],
};
function session(prompt: (...args: unknown[]) => Promise<void>) {
  return { isIdle: true, messages: [{ role: "assistant", content: [{ type: "text", text: "完成" }], stopReason: "stop" }],
    subscribe: vi.fn(() => vi.fn()), dispose: vi.fn(), prompt: vi.fn(prompt), waitForIdle: vi.fn().mockResolvedValue(undefined) };
}
beforeEach(() => { mock.create.mockReset(); mock.loader.mockClear(); mock.action.mockReset().mockResolvedValue({ status: "completed" }); });
afterEach(() => disposePiAgentSession(base.conversationId));

it("自动技能加载保存内容快照，资源读取限包内且不消耗领域写入额度", async () => {
  const loaded: AgentSkillSnapshot[] = [];
  mock.create.mockImplementation(async (options: Options) => ({ session: session(async () => {
    const tool = (name: string) => options.customTools.find((item) => item.name === name)!;
    expect(JSON.stringify(await tool("skill_read").execute("read", { skillId: skill.id, path: "references/guide.md" }))).toContain("请先");
    await tool("skill_load").execute("load", { skillId: skill.id });
    expect(JSON.stringify(await tool("skill_read").execute("read", { skillId: skill.id, path: "references/guide.md" }))).toContain("不编造");
    for (const path of ["../secret.md", "/etc/passwd", "C:\\secret", "https://example.com"]) {
      expect(JSON.stringify(await tool("skill_read").execute("read", { skillId: skill.id, path }))).not.toContain("不编造");
    }
    expect(JSON.stringify(await tool("skill_load").execute("load", { skillId: "user:unavailable" }))).toContain("不在");
    await tool("latex_compile").execute("write", {});
    await tool("latex_compile").execute("write-again", {});
  }) }));
  const result = await runPiAgentTurn(env, { ...base, availableSkills: [skill], onSkillLoaded: async (snapshot) => { loaded.push(snapshot); } }, vi.fn());
  expect(mock.action).toHaveBeenCalledOnce();
  expect(loaded).toHaveLength(1);
  expect(loaded[0]).toMatchObject({ id: skill.id, version: skill.version, files: skill.files });
  expect(result.skills).toEqual(loaded);
  expect(mock.loader.mock.calls[0][0]).toMatchObject({ noSkills: true, noExtensions: true, noPromptTemplates: true, noContextFiles: true, systemPrompt: "", appendSystemPrompt: [] });
  expect(mock.create.mock.calls[0][0].tools).not.toContain("read");
});

it("指定技能先记录快照再给模型，不依赖SDK命令展开", async () => {
  const onSkillLoaded = vi.fn().mockResolvedValue(undefined);
  const sdk = session(async () => { expect(onSkillLoaded).toHaveBeenCalledOnce(); });
  mock.create.mockResolvedValue({ session: sdk });
  await runPiAgentTurn(env, { ...base, availableSkills: [skill], selectedSkillIds: [skill.id], onSkillLoaded }, vi.fn());
  expect(sdk.prompt.mock.calls[0][0]).toContain("用证据支撑结论");
  expect(sdk.prompt.mock.calls[0][1]).toEqual({ expandPromptTemplates: false });
});

it("技能使用后的下一回合重建会话，避免指令跨轮静默生效", async () => {
  const old = session(async () => {});
  const fresh = session(async () => {});
  mock.create.mockResolvedValueOnce({ session: old }).mockResolvedValueOnce({ session: fresh });
  await runPiAgentTurn(env, { ...base, availableSkills: [skill], selectedSkillIds: [skill.id] }, vi.fn());
  await runPiAgentTurn(env, { ...base, availableSkills: [skill] }, vi.fn());
  expect(old.dispose).toHaveBeenCalledOnce();
  expect(mock.create).toHaveBeenCalledTimes(2);
});

it("快照保存失败时不向模型发送指定技能正文", async () => {
  const sdk = session(async () => {});
  mock.create.mockResolvedValue({ session: sdk });
  await expect(runPiAgentTurn(env, {
    ...base, availableSkills: [skill], selectedSkillIds: [skill.id],
    onSkillLoaded: async () => { throw new Error("快照保存失败"); },
  }, vi.fn())).rejects.toThrow("快照保存失败");
  expect(sdk.prompt).not.toHaveBeenCalled();
  expect(sdk.dispose).toHaveBeenCalledOnce();
});

it("不合法的领域输出被Zod拒绝后不会写入", async () => {
  mock.create.mockImplementation(async (options: Options) => ({ session: session(async () => {
    const tool = options.customTools.find((item) => item.name === "experiment_design_create_draft")!;
    const response = await tool.execute("bad", { title: "绕过", design: { datasets: "invalid-type" } });
    expect(JSON.stringify(response)).toContain("未通过校验");
  }) }));
  await runPiAgentTurn(env, { ...base, availableSkills: [skill] }, vi.fn());
  expect(mock.action).not.toHaveBeenCalled();
});
