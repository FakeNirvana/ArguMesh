import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "../../src/api";
import { ProjectHomePage } from "../../src/pages/ProjectHomePage";
import * as workspace from "../../src/state/workspace";

vi.mock("../../src/state/workspace", () => ({ useWorkspace: vi.fn() }));
let root: ReturnType<typeof createRoot>;
const conversation = { id: "conversation", projectId: "project", title: "研究对话", mode: "research_agent", status: "active", createdAt: "2026-10-11", updatedAt: "2026-10-11" } as api.AiConversation;
const user = { id: "user", conversationId: "conversation", projectId: "project", role: "user", content: "梳理研究洞见", citations: [], model: null, status: "completed", error: "", createdAt: "2026-10-11" } as api.AiMessage;
const failure = { ...user, id: "assistant", role: "assistant", content: "", status: "failed", error: "回合连接中断，请重试" } as api.AiMessage;
let rejectTurn!: (cause: Error) => void;
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.mocked(workspace.useWorkspace).mockReturnValue({ projects: [{ id: "project", name: "测试项目" }], papers: [], matrices: [] } as unknown as ReturnType<typeof workspace.useWorkspace>);
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  vi.spyOn(api, "listAiConversations").mockResolvedValue({ conversations: [conversation] });
  vi.spyOn(api, "listAgentSkills").mockResolvedValue({ skills: [] });
  vi.spyOn(api, "getResearchThread").mockResolvedValue({ stats: { insights: 0, questions: 0 } } as unknown as api.ResearchThread);
  vi.spyOn(api, "listExperiments").mockResolvedValue({ experiments: [] });
  vi.spyOn(api, "getAiConversation").mockResolvedValue({ conversation, messages: [], actions: [] });
  vi.spyOn(api, "cancelAiConversation").mockResolvedValue({ id: "conversation", status: "cancelled" });
  vi.spyOn(api, "sendAiMessage").mockImplementation((_pid, _cid, _content, _event, signal) => new Promise((_resolve, reject) => {
    rejectTurn = reject;
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ""; vi.restoreAllMocks(); });
async function render() {
  await act(async () => root.render(<MemoryRouter initialEntries={["/projects/project"]}><Routes><Route path="/projects/:projectId" element={<ProjectHomePage />} /></Routes></MemoryRouter>));
}
function suggest() { return document.querySelector(".agent-suggestions button") as HTMLButtonElement; }

it("同一轮连续点击只发送一次，并在离开页面时取消请求", async () => {
  await render(); const button = suggest();
  await act(async () => { button.click(); button.click(); });
  expect(api.sendAiMessage).toHaveBeenCalledOnce();
  const signal = vi.mocked(api.sendAiMessage).mock.calls[0][4]!;
  expect(signal.aborted).toBe(false);
  await act(async () => root.unmount()); expect(signal.aborted).toBe(true);
});

it("失败先恢复服务器消息，再允许点击重试且保留失败记录", async () => {
  await render(); await act(async () => suggest().click());
  vi.mocked(api.getAiConversation).mockResolvedValue({ conversation, messages: [user, failure], actions: [] });
  await act(async () => rejectTurn(new Error("回合连接中断")));
  expect(api.getAiConversation).toHaveBeenLastCalledWith("project", "conversation", { healPending: true });
  const retry = document.querySelector(".agent-failure button") as HTMLButtonElement;
  expect(retry.disabled).toBe(false);
  await act(async () => retry.click());
  expect(api.sendAiMessage).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.sendAiMessage).mock.calls[1][2]).toBe(user.content);
  expect(document.querySelector(".agent-failure")?.textContent).toContain("回合连接中断");
});

it("结束运行中的会话会取消请求，并解除发送等待状态", async () => {
  await render(); await act(async () => suggest().click());
  const signal = vi.mocked(api.sendAiMessage).mock.calls[0][4]!;
  await act(async () => (document.querySelector(".agent-end-session") as HTMLButtonElement).click());
  expect(api.cancelAiConversation).toHaveBeenCalledWith("project", "conversation");
  expect(signal.aborted).toBe(true);
  expect(document.querySelector(".agent-thinking")).toBeNull();
  expect((document.querySelector("textarea") as HTMLTextAreaElement).placeholder).toContain("该会话已结束");
});

it("另一页面仍在运行时忙碌响应只刷新消息，不中断其回合", async () => {
  await render(); await act(async () => suggest().click());
  await act(async () => rejectTurn(new api.AgentTurnBusyError("上一回合仍在处理")));
  expect(api.getAiConversation).toHaveBeenLastCalledWith("project", "conversation", { healPending: false });
});

const availableSkill = { id: "builtin:evidence-check", name: "evidence-check", description: "核对证据", source: "builtin", enabled: true, version: "a".repeat(64), installedAt: null, fileCount: 1, warnings: [] } as api.AgentSkillSummary;

it("指定技能随消息发送，运行中禁止更改技能或打开管理", async () => {
  vi.mocked(api.listAgentSkills).mockResolvedValue({ skills: [availableSkill] });
  await render();
  const selector = document.querySelector<HTMLSelectElement>('select[aria-label="本回合研究技能"]')!;
  await act(async () => { selector.value = availableSkill.id; selector.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => suggest().click());
  expect(vi.mocked(api.sendAiMessage).mock.calls[0][5]).toEqual({ skillIds: [availableSkill.id] });
  expect(selector.disabled).toBe(true);
  const manage = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("管理技能"))!;
  expect(manage.disabled).toBe(true);
});

it("重试沿用原回合的不使用技能选择，不随当前选择改变", async () => {
  vi.mocked(api.listAgentSkills).mockResolvedValue({ skills: [availableSkill] });
  vi.mocked(api.getAiConversation).mockResolvedValue({ conversation, messages: [{ ...user, skillSelection: [] }, failure], actions: [] });
  await render();
  const selector = document.querySelector<HTMLSelectElement>('select[aria-label="本回合研究技能"]')!;
  await act(async () => { selector.value = availableSkill.id; selector.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => (document.querySelector(".agent-failure button") as HTMLButtonElement).click());
  expect(vi.mocked(api.sendAiMessage).mock.calls[0][5]).toEqual({ skillIds: [] });
});
