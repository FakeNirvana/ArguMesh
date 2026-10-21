import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "../../src/api";
import { AgentSkillHistoryPreview, AgentSkillsPanel, prepareSkillImport } from "../../src/components/AgentSkillsPanel";

const instruction = "---\nname: evidence-check\ndescription: 核对项目证据\n---\n\n# 核对证据\n\n先读取项目上下文。";
const skill: api.AgentSkill = {
  id: "user:evidence-check", name: "evidence-check", description: "核对项目证据", source: "user", enabled: true,
  version: "a".repeat(64), installedAt: "2026-10-21", fileCount: 1, warnings: [], files: [{ path: "SKILL.md", content: instruction }],
};
let root: ReturnType<typeof createRoot>;
let refresh: ReturnType<typeof vi.fn<() => Promise<void>>>;
let close: ReturnType<typeof vi.fn<() => void>>;

function file(path: string, content: string) {
  const selected = new File([content], path.split("/").at(-1)!);
  Object.defineProperty(selected, "webkitRelativePath", { value: path.includes("/") ? path : "" });
  return selected;
}
function button(text: string) { return [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes(text))!; }
async function render(skills = [skill]) {
  await act(async () => root.render(<AgentSkillsPanel skills={skills} loading={false} error="" onRefresh={refresh} onClose={close} />));
}
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  refresh = vi.fn(async () => {}); close = vi.fn();
  vi.spyOn(api, "getAgentSkill").mockResolvedValue({ skill });
  vi.spyOn(api, "installAgentSkill").mockResolvedValue({ skill });
  vi.spyOn(api, "setAgentSkillEnabled").mockResolvedValue({ skill: { ...skill, enabled: false } });
  vi.spyOn(api, "uninstallAgentSkill").mockResolvedValue({ removed: true });
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ""; vi.restoreAllMocks(); });

it("folder import includes selected text resources and explicitly reports skipped binary assets", async () => {
  const preview = await prepareSkillImport([file("bundle/SKILL.md", instruction), file("bundle/references/checklist.md", "# Check"), file("bundle/scripts/check.py", "print('check')"), file("bundle/assets/image.png", "binary")]);
  expect(preview.files.map((item) => item.path)).toEqual(["bundle/SKILL.md", "bundle/references/checklist.md", "bundle/scripts/check.py"]);
  expect(preview.skipped).toEqual(["bundle/assets/image.png"]);
  expect(preview.name).toBe("evidence-check");
  expect(preview.hasScripts).toBe(true);
});

it("rejects multiple skill roots and non-text content before upload", async () => {
  await expect(prepareSkillImport([file("one/SKILL.md", instruction), file("two/SKILL.md", instruction)])).rejects.toThrow("唯一的 SKILL.md");
  await expect(prepareSkillImport([file("SKILL.md", `${instruction}\0`)] )).rejects.toThrow("UTF-8");
  expect(api.installAgentSkill).not.toHaveBeenCalled();
});

it("leaves the body limit to the server so frontmatter does not reject a valid-length body", async () => {
  const content = `---\nname: evidence-check\ndescription: 核对证据\nmetadata:\n  note: ${"x".repeat(400)}\n---\n\n${"y".repeat(31_900)}`;
  expect(content.length).toBeGreaterThan(32_000);
  await expect(prepareSkillImport([file("SKILL.md", content)])).resolves.toMatchObject({ instructions: content });
});

it("requires an installation preview confirmation before transferring selected files", async () => {
  await render([]);
  const input = document.querySelector<HTMLInputElement>('input[aria-label="选择技能说明文件"]')!;
  Object.defineProperty(input, "files", { value: [file("SKILL.md", instruction)], configurable: true });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
  expect(document.querySelector('[aria-label="安装预览"]')?.textContent).toContain("evidence-check");
  expect(api.installAgentSkill).not.toHaveBeenCalled();
  await act(async () => button("确认安装").click());
  expect(api.installAgentSkill).toHaveBeenCalledWith([{ path: "SKILL.md", content: instruction }]);
  expect(refresh).toHaveBeenCalledOnce();
  expect(document.body.textContent).toContain("技能已安装");
});

it("distinguishes builtin and user controls and refreshes after disabling", async () => {
  await render([{ ...skill, id: "builtin:evidence-check", source: "builtin" }, { ...skill, id: "user:other", name: "other" }]);
  expect(document.querySelectorAll('[aria-label^="卸载技能："]')).toHaveLength(1);
  const toggle = document.querySelector<HTMLInputElement>('input[aria-label="停用技能：evidence-check"]')!;
  await act(async () => toggle.click());
  expect(api.setAgentSkillEnabled).toHaveBeenCalledWith("builtin:evidence-check", false);
  expect(refresh).toHaveBeenCalledOnce();
});

it("uninstall requires explicit confirmation and preserves the cancellation path", async () => {
  await render();
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await act(async () => button("卸载").click());
  expect(api.uninstallAgentSkill).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  await act(async () => button("卸载").click());
  expect(api.uninstallAgentSkill).toHaveBeenCalledWith(skill.id);
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("已有会话"));
});

it("preview treats embedded HTML as inert content and Escape closes the dialog", async () => {
  vi.mocked(api.getAgentSkill).mockResolvedValue({ skill: { ...skill, files: [{ path: "SKILL.md", content: "<script>window.secret = 1</script>\n\n# Instructions\n\n![tracking image](https://example.org/tracker.png)" }] } });
  await render();
  await act(async () => button("查看内容").click());
  expect(document.querySelector("script")).toBeNull();
  expect(document.querySelector("img")).toBeNull();
  expect(document.querySelector('[aria-label^="技能内容："]')?.textContent).toContain("Instructions");
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(close).toHaveBeenCalledOnce();
});

it("historical preview loads the recorded snapshot rather than the current installation", async () => {
  const snapshot = { id: skill.id, name: skill.name, description: skill.description, source: skill.source, version: "b".repeat(64), loadedAt: "2026-10-21T10:00:00Z", files: [{ path: "SKILL.md", content: "# Recorded original instructions\n\n![tracking image](https://example.org/tracker.png)" }] };
  vi.spyOn(api, "getAgentSkillSnapshot").mockResolvedValue({ skill: snapshot });
  await act(async () => root.render(<AgentSkillHistoryPreview projectId="project" conversationId="conversation" messageId="message" usage={snapshot} onClose={close} />));
  expect(api.getAgentSkillSnapshot).toHaveBeenCalledWith("project", "conversation", "message", skill.id);
  expect(api.getAgentSkill).not.toHaveBeenCalled();
  expect(document.body.textContent).toContain("Recorded original instructions");
  expect(document.body.textContent).toContain("bbbbbbbb");
  expect(document.querySelector("img")).toBeNull();
});
