import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "../../src/api";
import { PaperPage } from "../../src/pages/PaperPage";
import type { LocalPaper } from "../../src/state/workspace";
import * as workspace from "../../src/state/workspace";

vi.mock("../../src/state/workspace", () => ({ useWorkspace: vi.fn() }));
vi.mock("../../src/pdf/document", () => ({ extractPdfText: vi.fn() }));
vi.mock("../../src/storage/paperFiles", () => ({ getPaperPdf: vi.fn().mockResolvedValue(null) }));

const fields = { problem: "问题", method: "方法", data: "数据", findings: "发现", limitations: "局限" };
const sources = { ...fields };
const paper: LocalPaper = { id: "paper", title: "Paper", authors: "Author", venue: "Test", year: 2026, status: "待读", tags: [], projectIds: ["project"], abstract: "Evidence from the abstract. ".repeat(10) };
const result: api.GeneratedPaperCard = { card: fields, sources, model: "step-5-preview", generatedAt: "2026-10-11T10:00:00Z", source: "论文摘要" };
let root: ReturnType<typeof createRoot>;
let finish: (result: api.GeneratedPaperCard) => void;
function generateButton() { return document.querySelector(".paper-card-editor header button") as HTMLButtonElement; }
async function render() {
  await act(async () => root.render(<MemoryRouter initialEntries={["/projects/project/library/paper"]}><Routes><Route path="/projects/:projectId/library/:paperId" element={<PaperPage />} /></Routes></MemoryRouter>));
}
function mockWorkspace(card?: LocalPaper["card"]) {
  vi.mocked(workspace.useWorkspace).mockReturnValue({ papers: [{ ...paper, card }], projects: [], readerAnswers: [], readerExcerpts: [], knowledge: [], settings: {}, updatePaper: vi.fn() } as unknown as ReturnType<typeof workspace.useWorkspace>);
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  mockWorkspace();
  vi.spyOn(api, "getAiModels").mockResolvedValue({ model: "step-5-preview", models: ["step-5-preview"], providers: [] });
  vi.spyOn(api, "generatePaperCard").mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ""; vi.restoreAllMocks(); });

it("第一次生成使用当前模型，提示和请求均不写死 step-3.7-flash", async () => {
  await render();
  expect(generateButton().title).toContain("step-5-preview");
  await act(async () => generateButton().click());
  expect(document.querySelector('[role="status"]')?.textContent).toContain("正在调用 step-5-preview");
  expect(api.generatePaperCard).toHaveBeenCalledWith("paper", expect.objectContaining({ model: "step-5-preview" }));
  expect(document.body.textContent).not.toContain("step-3.7-flash");
  await act(async () => finish(result));
  expect(document.querySelector(".ai-evidence-panel")?.textContent).toContain("step-5-preview");
});

it("生成前刷新配置，旧卡片的模型只用于历史来源", async () => {
  mockWorkspace({ ...fields, confirmed: true, updatedAt: "2026-10-01T10:00:00Z", generatedBy: "old-model", generatedAt: "2026-10-01T10:00:00Z", sources });
  vi.mocked(api.getAiModels).mockResolvedValueOnce({ model: "old-current-model", models: [], providers: [] }).mockResolvedValueOnce({ model: "step-5-preview", models: [], providers: [] });
  await render();
  expect(generateButton().title).toContain("old-current-model");
  await act(async () => generateButton().click());
  expect(document.querySelector('[role="status"]')?.textContent).toContain("step-5-preview");
  expect(generateButton().title).toContain("step-5-preview");
  expect(document.querySelector(".ai-evidence-panel")?.textContent).toContain("old-model");
  expect(api.getAiModels).toHaveBeenCalledTimes(2);
  await act(async () => finish(result));
  expect(document.querySelector(".ai-evidence-panel")?.textContent).toContain("step-5-preview");
});

it("配置尚未读到时展示准备状态，不沿用上一张卡片的模型", async () => {
  let readModel: (models: Awaited<ReturnType<typeof api.getAiModels>>) => void;
  vi.mocked(api.getAiModels).mockResolvedValueOnce({ model: "step-5-preview", models: [], providers: [] }).mockImplementationOnce(() => new Promise((resolve) => { readModel = resolve; }));
  await render();
  await act(async () => generateButton().click());
  expect(document.querySelector('[role="status"]')?.textContent).toContain("正在准备原文并读取当前模型配置");
  expect(api.generatePaperCard).not.toHaveBeenCalled();
  await act(async () => readModel!({ model: "step-5-preview", models: [], providers: [] }));
  expect(document.querySelector('[role="status"]')?.textContent).toContain("step-5-preview");
  await act(async () => finish(result));
});

it("配置读取失败时使用中性提示，最终来源以实际响应为准", async () => {
  vi.mocked(api.getAiModels).mockResolvedValue({ model: "", models: [], providers: [] });
  await render();
  expect(generateButton().title).toContain("以设置页当前配置为准");
  await act(async () => generateButton().click());
  expect(document.querySelector('[role="status"]')?.textContent).toContain("当前配置的模型");
  expect(document.body.textContent).not.toContain("step-3.7-flash");
  await act(async () => finish(result));
  expect(generateButton().title).toContain("step-5-preview");
});
