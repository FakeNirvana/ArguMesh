import { afterEach, expect, it, vi } from "vitest";
import { AgentTurnBusyError, sendAiMessage } from "../../src/api";

afterEach(() => vi.restoreAllMocks());

it("409 忙碌响应与断连错误区分，保留中文服务端提示", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ error: "AGENT_TURN_BUSY", message: "上一回合仍在处理" }), { status: 409, headers: { "content-type": "application/json" } }));
  await expect(sendAiMessage("project", "conversation", "问题")).rejects.toBeInstanceOf(AgentTurnBusyError);
});
const message = { id: "assistant", role: "assistant", content: "完整回复", citations: [], status: "completed" };
function stream(chunks: string[]) {
  const cancelled = vi.fn(); const encoder = new TextEncoder();
  const body = new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); }, cancel: cancelled });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { headers: { "content-type": "text/event-stream" } }));
  return cancelled;
}

it("收到终止错误时立即释放 SSE，不等待服务端关闭，SDK busy 提示转为中文", async () => {
  const cancel = stream(['event: error\ndata: {"message":"Agent is already processing. Specify streamingBehavior"}\n\n']);
  await expect(sendAiMessage("project", "conversation", "问题")).rejects.toThrow("上一回合仍在处理");
  expect(cancel).toHaveBeenCalledOnce();
});

it("分段 CRLF 事件与心跳可以解析，done 后立即释放流", async () => {
  const cancel = stream([": keepalive\r\n\r\n", "event: do", `ne\r\ndata: ${JSON.stringify({ message })}\r`, "\n\r\n"]);
  await expect(sendAiMessage("project", "conversation", "问题")).resolves.toMatchObject({ message });
  expect(cancel).toHaveBeenCalledOnce();
});

it("页面退出的取消信号传给真实 fetch 请求", async () => {
  stream([`event: done\ndata: ${JSON.stringify({ message })}\n\n`]);
  const controller = new AbortController();
  await sendAiMessage("project", "conversation", "问题", undefined, controller.signal);
  expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ signal: controller.signal }));
});
