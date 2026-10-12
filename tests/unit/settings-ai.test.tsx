import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "../../src/api";
import { SettingsPage } from "../../src/pages/SettingsPage";

vi.mock("../../src/state/workspace", () => ({ useWorkspace: () => ({
  settings: { displayName: "Researcher", autoSave: true, evidenceFirst: true, provider: "semantic-scholar" }, trash: [],
}) }));
vi.mock("../../src/components/UpdateNotice", () => ({ UpdateSettings: () => null }));

const config: api.AiConfig = { configured: true, baseUrl: "https://model.example/v1", model: "test-model", apiKeyMasked: "sk-…1234", envProviders: [] };
const result: api.AiConnectionCheck = { ok: true, model: "test-model", provider: "自定义配置", apiFormat: "openai", latencyMs: 150, checkedAt: "2026-10-11T10:00:00Z" };
let root: ReturnType<typeof createRoot>;
function button(label: string) {
  const found = Array.from(document.querySelectorAll("button")).find((node) => node.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
async function render() { await act(async () => root.render(<SettingsPage />)); }
async function changeModel(value: string) {
  await act(async () => {
    const input = document.querySelector("#ai-model") as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.spyOn(api, "getAiConfig").mockResolvedValue(config);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ""; vi.restoreAllMocks(); });

it("显示已保存配置，真实自检成功后展示模型与耗时", async () => {
  const check = vi.spyOn(api, "testAiConnection").mockResolvedValue(result);
  await render();
  expect(document.querySelector(".environment-badge")?.textContent).toContain("自定义配置 · test-model");
  expect(document.body.textContent).not.toContain("未检测到");
  await act(async () => button("连接自检").click());
  expect(check).toHaveBeenCalledWith(expect.any(AbortSignal));
  expect(document.querySelector('[role="status"]')?.textContent).toContain("连接成功");
  expect(document.body.textContent).toContain("0.15 秒");
});

it("修改后清除旧自检结果，并要求先保存再自检", async () => {
  vi.spyOn(api, "testAiConnection").mockResolvedValue(result);
  const save = vi.spyOn(api, "saveAiConfig").mockResolvedValue({ ...config, model: "new-model" });
  await render();
  await act(async () => button("连接自检").click());
  await changeModel("new-model");
  expect(document.body.textContent).not.toContain("连接成功");
  expect(button("连接自检").disabled).toBe(true);
  expect(document.body.textContent).toContain("先保存再自检");
  await act(async () => button("保存 AI 配置").click());
  expect(save).toHaveBeenCalledWith({ baseUrl: config.baseUrl, apiKey: "", model: "new-model" });
  expect(button("连接自检").disabled).toBe(false);
});

it("失败原因以警告状态展示，可以重新自检", async () => {
  vi.spyOn(api, "testAiConnection").mockRejectedValue(new Error("连接失败（HTTP 401）：API Key 无效。"));
  await render();
  await act(async () => button("连接自检").click());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("HTTP 401");
  expect(button("连接自检").disabled).toBe(false);
});

it("自检期间锁定表单，取消后恢复操作", async () => {
  vi.spyOn(api, "testAiConnection").mockImplementation((signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }));
  await render();
  await act(async () => button("连接自检").click());
  expect(button("自检中…").disabled).toBe(true);
  expect((document.querySelector("#ai-model") as HTMLInputElement).disabled).toBe(true);
  await act(async () => button("取消自检").click());
  expect(document.body.textContent).toContain("连接自检已取消");
  expect(button("连接自检").disabled).toBe(false);
});

it("清除自定义配置后刷新实际环境回退", async () => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(api, "deleteAiConfig").mockResolvedValue({ cleared: true });
  vi.mocked(api.getAiConfig).mockResolvedValueOnce(config).mockResolvedValueOnce({ configured: false, baseUrl: "", model: "", apiKeyMasked: null, envProviders: [{ id: "env", label: "Environment", models: ["env-model"] }] });
  await render();
  await act(async () => button("清除配置").click());
  expect(document.querySelector(".environment-badge")?.textContent).toContain("环境配置 · Environment · env-model");
  expect(button("连接自检").disabled).toBe(false);
});

it("配置读取失败时显示错误，不误报未配置", async () => {
  vi.mocked(api.getAiConfig).mockRejectedValue(new Error("offline"));
  await render();
  expect(document.querySelector(".environment-badge")?.textContent).toContain("状态读取失败");
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("无法读取 AI 配置");
  expect(button("连接自检").disabled).toBe(true);
});
