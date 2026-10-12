// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { disposePiAgentSession, runPiAgentTurn } from "../../server/services/pi-agent";

const mock = vi.hoisted(() => ({ create: vi.fn(), append: vi.fn(), context: vi.fn(), action: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession: mock.create, defineTool: (tool: unknown) => tool,
  DefaultResourceLoader: class { reload = async () => {}; },
  SessionManager: { inMemory: () => ({ appendMessage: mock.append }) }, SettingsManager: { inMemory: () => ({}) },
}));
vi.mock("../../server/services/ai", () => ({ resolveAiForRequest: async () => ({ model: "step-5-preview", provider: {} }) }));
vi.mock("../../server/services/pi-runtime", () => ({ createPiModelBridge: async () => ({ agentDir: "test", modelRuntime: {}, model: { id: "step-5-preview", api: "openai-completions", provider: "test" } }) }));
vi.mock("../../server/services/project-context", () => ({ assembleProjectContext: mock.context }));
vi.mock("../../server/services/research-agent", async (original) => ({ ...await original<object>(), executeWhitelistedAgentAction: mock.action }));

const env = { DATABASE_URL: "file::memory:" };
const turn = { projectId: "project", conversationId: "lifecycle", assistantMessageId: "message", message: "请回答", history: [] };
const success = { role: "assistant", content: [{ type: "text", text: "完成" }], stopReason: "stop" };
function session() {
  return { isIdle: true, messages: [success], subscribe: vi.fn(() => vi.fn()), dispose: vi.fn(), prompt: vi.fn().mockResolvedValue(undefined), waitForIdle: vi.fn().mockResolvedValue(undefined) };
}
beforeEach(() => { mock.create.mockReset(); mock.append.mockClear(); mock.context.mockResolvedValue({ project: { id: "project" } }); mock.action.mockResolvedValue({ status: "completed" }); mock.action.mockClear(); });
afterEach(() => { disposePiAgentSession(turn.conversationId); });

it("并行工具调用每轮只允许一个白名单写入，下一回合重置额度", async () => {
  const sdk = session();
  let write!: { execute: (...args: unknown[]) => Promise<unknown> };
  mock.create.mockImplementation(async (options) => {
    write = options.customTools.find((tool: { name: string }) => tool.name === "latex_compile");
    return { session: sdk };
  });
  sdk.prompt.mockImplementation(async () => {
    const results = await Promise.all([write.execute(), write.execute()]);
    expect(JSON.stringify(results)).toContain("本回合已执行一个写入动作");
  });
  await runPiAgentTurn(env, turn, vi.fn());
  expect(mock.action).toHaveBeenCalledOnce();
  await runPiAgentTurn(env, turn, vi.fn());
  expect(mock.action).toHaveBeenCalledTimes(2);
});

it("SDK prompt 返回后仍等待后台重试完全结束，期间不会提前发出终止事件", async () => {
  const sdk = session(); let release!: () => void;
  sdk.waitForIdle.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
  mock.create.mockResolvedValue({ session: sdk });
  const events = vi.fn(); const running = runPiAgentTurn(env, turn, events);
  await vi.waitFor(() => expect(sdk.waitForIdle).toHaveBeenCalled());
  expect(events).not.toHaveBeenCalled();
  sdk.messages = [{ ...success, content: [{ type: "text", text: "重试后的完整回复" }] }]; release();
  expect((await running).reply).toBe("重试后的完整回复");
  expect(events).toHaveBeenCalledWith({ type: "agent_end" });
});

it("失败后丢弃仍处于 processing 的 SDK，会话可重建并恢复 SQLite 历史", async () => {
  const old = session(); old.isIdle = false; old.prompt.mockRejectedValue(new Error("网络中断"));
  const fresh = session(); mock.create.mockResolvedValueOnce({ session: old }).mockResolvedValueOnce({ session: fresh });
  await expect(runPiAgentTurn(env, turn, vi.fn())).rejects.toThrow("网络中断");
  expect(old.dispose).toHaveBeenCalledOnce();
  const result = await runPiAgentTurn(env, { ...turn, history: [{ role: "user", content: "之前的问题" }, { role: "assistant", content: "之前的回复" }] }, vi.fn());
  expect(result.reply).toBe("完成");
  expect(createAgentSession).toHaveBeenCalledTimes(2);
  expect(mock.append.mock.calls.map(([message]) => message.role)).toEqual(["user", "assistant"]);
});

it("连接中断即使模型请求永不返回也可结束等待，迟到结果不会销毁重试会话", async () => {
  const old = session(); let finish!: () => void;
  old.prompt.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  const fresh = session(); mock.create.mockResolvedValueOnce({ session: old }).mockResolvedValueOnce({ session: fresh });
  const controller = new AbortController(); const running = runPiAgentTurn(env, turn, vi.fn(), controller.signal);
  const rejection = expect(running).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(old.prompt).toHaveBeenCalled()); controller.abort(); await rejection;
  expect(old.dispose).toHaveBeenCalledOnce();
  await runPiAgentTurn(env, turn, vi.fn()); finish(); await Promise.resolve();
  expect(fresh.dispose).not.toHaveBeenCalled();
});

it("取消初始化后迟到的新会话也被销毁，不污染下一次重试", async () => {
  let created!: (value: { session: ReturnType<typeof session> }) => void;
  mock.create.mockImplementationOnce(() => new Promise((resolve) => { created = resolve; }));
  const controller = new AbortController(); const running = runPiAgentTurn(env, turn, vi.fn(), controller.signal);
  const rejection = expect(running).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(mock.create).toHaveBeenCalled()); controller.abort(); await rejection;
  const old = session(); created({ session: old });
  await vi.waitFor(() => expect(old.dispose).toHaveBeenCalledOnce());
  const fresh = session(); mock.create.mockResolvedValue({ session: fresh });
  await expect(runPiAgentTurn(env, turn, vi.fn())).resolves.toMatchObject({ reply: "完成" });
});

it("SDK 将错误放在最后一条 assistant 消息时仍报告失败并释放缓存", async () => {
  const sdk = session(); sdk.messages = [{ ...success, stopReason: "error", errorMessage: "HTTP 429" } as typeof success];
  mock.create.mockResolvedValue({ session: sdk });
  await expect(runPiAgentTurn(env, turn, vi.fn())).rejects.toThrow("HTTP 429");
  expect(sdk.dispose).toHaveBeenCalledOnce();
});
