import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "../../src/api";
import { Sidebar } from "../../src/components/Sidebar";
import * as workspace from "../../src/state/workspace";

vi.mock("../../src/state/workspace", () => ({ useWorkspace: vi.fn() }));
let root: ReturnType<typeof createRoot>;
const skill: api.AgentSkillSummary = {
  id: "builtin:evidence-check", name: "evidence-check", description: "核对证据", source: "builtin", enabled: true,
  version: "a".repeat(64), installedAt: null, fileCount: 1, warnings: [],
};
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.mocked(workspace.useWorkspace).mockReturnValue({ settings: { displayName: "研究员" }, projects: [] } as unknown as ReturnType<typeof workspace.useWorkspace>);
  vi.spyOn(api, "listAgentSkills").mockResolvedValue({ skills: [skill] });
  vi.spyOn(api, "setAgentSkillEnabled").mockResolvedValue({ skill: { ...skill, enabled: false, files: [] } });
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ""; vi.restoreAllMocks(); });

it("侧栏在项目外提供管理入口，按需加载并在变更后通知对话区", async () => {
  await act(async () => root.render(<MemoryRouter initialEntries={["/settings"]}><Sidebar open onToggle={() => {}} /></MemoryRouter>));
  expect(api.listAgentSkills).not.toHaveBeenCalled();
  const manage = [...document.querySelectorAll<HTMLButtonElement>(".sidebar button")].find((button) => button.textContent?.includes("管理技能"))!;
  expect(manage).toBeDefined();
  expect(manage.disabled).toBe(false);
  await act(async () => manage.click());
  expect(api.listAgentSkills).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("研究技能");
  const onChanged = vi.fn();
  window.addEventListener("paperidea:agent-skills-changed", onChanged);
  try {
    vi.mocked(api.listAgentSkills).mockResolvedValue({ skills: [{ ...skill, enabled: false }] });
    await act(async () => document.querySelector<HTMLInputElement>('input[aria-label="停用技能：evidence-check"]')!.click());
    expect(api.setAgentSkillEnabled).toHaveBeenCalledWith(skill.id, false);
    expect(api.listAgentSkills).toHaveBeenCalledTimes(2);
    expect(onChanged).toHaveBeenCalledOnce();
    expect(document.querySelector('input[aria-label="启用技能：evidence-check"]')).not.toBeNull();
  } finally { window.removeEventListener("paperidea:agent-skills-changed", onChanged); }
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(manage.isConnected).toBe(true);
});
