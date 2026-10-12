// @vitest-environment node
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import app from "../../server/index";
import { createDatabase } from "../../server/db/client";
import { aiMessages } from "../../server/db/schema";
import type { RunPiAgentTurnResult } from "../../server/services/pi-agent";
import { createTestContext, jsonHeaders, type TestContext } from "./helpers";

const sdk = vi.hoisted(() => ({ run: vi.fn(), dispose: vi.fn() }));
vi.mock("../../server/services/pi-agent", () => ({ runPiAgentTurn: sdk.run, disposePiAgentSession: sdk.dispose }));
let context: TestContext;
let path: string;
const result: RunPiAgentTurnResult = { reply: "恢复后的回复", model: "step-5-preview", citations: [], actions: [] };
beforeAll(async () => {
  context = await createTestContext();
  await app.request("/api/projects/recovery", { method: "PUT", headers: jsonHeaders(), body: JSON.stringify({ name: "恢复测试" }) }, context.bindings);
});
afterAll(() => context.cleanup());
beforeEach(async () => {
  sdk.run.mockReset(); sdk.dispose.mockClear();
  const response = await app.request("/api/projects/recovery/ai/conversations", { method: "POST", headers: jsonHeaders(), body: "{}" }, context.bindings);
  const { conversation } = await response.json() as { conversation: { id: string } };
  path = `/api/projects/recovery/ai/conversations/${conversation.id}`;
});
function submit() { return app.request(`${path}/messages`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ content: "梳理证据" }) }, context.bindings); }
async function detail() { return (await (await app.request(path, {}, context.bindings)).json()) as { messages: Array<{ id: string; role: string; status: string; content: string; error: string }> }; }
function hold(ignoreAbort = false) {
  let resolve!: (value: RunPiAgentTurnResult) => void;
  let signal!: AbortSignal;
  sdk.run.mockImplementationOnce((_env, _turn, _events, current: AbortSignal) => {
    signal = current;
    return new Promise<RunPiAgentTurnResult>((done, reject) => {
      resolve = done;
      if (!ignoreAbort) current.addEventListener("abort", () => reject(current.reason), { once: true });
    });
  });
  return { finish: () => resolve(result), signal: () => signal };
}

it("重复提交返回中文忙碌提示，保留正在运行的消息且不调用第二次 SDK", async () => {
  const run = hold(); const first = await submit();
  const duplicate = await submit();
  expect(duplicate.status).toBe(409);
  expect(await duplicate.json()).toMatchObject({ error: "AGENT_TURN_BUSY", message: expect.stringContaining("上一回合") });
  expect((await detail()).messages.map((message) => message.status)).toEqual(["completed", "pending"]);
  expect(sdk.run).toHaveBeenCalledOnce();
  run.finish(); expect(await first.text()).toContain("event: done");
});

it("运行超过 25 秒仍保持 pending，明确恢复中断会释放旧会话并允许重试", async () => {
  const run = hold(); const first = await submit();
  const pending = (await detail()).messages.find((message) => message.status === "pending")!;
  await createDatabase(context.bindings).update(aiMessages).set({ createdAt: new Date(Date.now() - 60_000).toISOString() }).where(eq(aiMessages.id, pending.id));
  expect((await detail()).messages.find((message) => message.id === pending.id)?.status).toBe("pending");
  await app.request(`${path}?healPending=1`, {}, context.bindings);
  expect(run.signal().aborted).toBe(true);
  expect(sdk.dispose).toHaveBeenCalled();
  await first.text();
  sdk.run.mockResolvedValueOnce(result);
  expect(await (await submit()).text()).toContain("恢复后的回复");
  const messages = (await detail()).messages;
  expect(messages.find((message) => message.id === pending.id)?.status).toBe("failed");
  expect(messages.filter((message) => message.role === "user")).toHaveLength(2);
});

it("客户端取消流后旧回复迟到也不能恢复失败状态或影响新回合", async () => {
  const run = hold(true); const first = await submit();
  const pending = (await detail()).messages.find((message) => message.status === "pending")!;
  await first.body!.cancel();
  expect(run.signal().aborted).toBe(true);
  sdk.run.mockResolvedValueOnce(result);
  expect(await (await submit()).text()).toContain("event: done");
  run.finish();
  await vi.waitFor(async () => expect((await detail()).messages.find((message) => message.id === pending.id)?.status).toBe("failed"));
  expect((await detail()).messages.filter((message) => message.role === "assistant" && message.status === "completed")).toHaveLength(1);
});

it("结束会话会取消 SDK 与 pending 消息，结束后禁止继续写入", async () => {
  const run = hold(); const first = await submit();
  expect((await app.request(`${path}/cancel`, { method: "POST" }, context.bindings)).status).toBe(200);
  expect(run.signal().aborted).toBe(true); await first.text();
  expect((await detail()).messages.find((message) => message.role === "assistant")?.status).toBe("cancelled");
  expect((await submit()).status).toBe(409);
});

it("超时在流与数据库中使用一致的中文提示，随后可以重试", async () => {
  const timeout = new AbortController();
  const timer = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
  try {
    hold(); const first = await submit();
    timeout.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    expect(await first.text()).toContain("5 分钟");
    expect((await detail()).messages.find((message) => message.role === "assistant")?.error).toContain("5 分钟");
  } finally { timer.mockRestore(); }
  sdk.run.mockResolvedValueOnce(result);
  expect(await (await submit()).text()).toContain("event: done");
});
