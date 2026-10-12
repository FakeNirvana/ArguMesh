import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "../../src/api";
import * as workspace from "../../src/state/workspace";
import { MatrixPage } from "../../src/pages/MatrixPage";

vi.mock("../../src/state/workspace", () => ({ useWorkspace: vi.fn() }));
vi.mock("../../src/state/project", () => ({ useProject: () => ({ setProjectId: setProject }) }));
vi.mock("../../src/pdf/document", () => ({ extractPdfText: vi.fn() }));
const setProject = vi.hoisted(() => vi.fn());
const cell = (id: string, changes: Partial<api.EvidenceCell> = {}): api.EvidenceCell => ({ id, value: "有来源的结论", status: "draft", locked: false, claim: "结论", confidence: 0.8, sourcePage: "第 3 页", sourceSection: "Results", sourceExcerpt: "Original quote", ...changes });
function fixture(): api.MatrixResponse {
  return {
    project: { id: "real-project", name: "Review matrix", description: "", extractionProgress: 0 },
    papers: ["paper-a", "paper-b"].map((id) => ({ id, name: id, title: id, venue: "", year: 2026, hasFile: true })),
    groups: [{ id: "group", label: "Dimensions", rows: [1, 2, 3].map((id) => ({ id: `dim:${id}`, label: `Dimension ${id}` })) }],
    cells: {
      "dim:1:paper-a": cell("evidence-a1"), "dim:2:paper-a": cell("evidence-a2", { status: "missing" }), "dim:3:paper-a": cell("evidence-a3", { value: "待提取", sourcePage: "—" }),
      "dim:1:paper-b": cell("evidence-b1"), "dim:2:paper-b": cell("evidence-b2", { status: "conflict" }), "dim:3:paper-b": cell("evidence-b3"),
    },
  };
}
let root: ReturnType<typeof createRoot>;
let localWorkspace: ReturnType<typeof workspace.useWorkspace>;
function Location() { return <span data-testid="location">{useLocation().pathname}{useLocation().search}</span>; }
async function render() {
  await act(async () => root.render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/projects/real-project/matrices/review-matrix"]}><Routes>
    <Route path="/projects/:projectId/matrices/:matrixId" element={<MatrixPage />} />
    <Route path="/projects/:projectId/library/:paperId/read" element={<Location />} />
  </Routes></MemoryRouter>));
}
function button(text: string) {
  const node = Array.from(document.querySelectorAll("button")).find((node) => node.textContent?.trim() === text);
  if (!node) throw new Error(`Missing button: ${text}`);
  return node;
}
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  localWorkspace = { matrices: [], papers: [], confirmMatrixCells: vi.fn() } as unknown as ReturnType<typeof workspace.useWorkspace>;
  vi.mocked(workspace.useWorkspace).mockReturnValue(localWorkspace);
  vi.spyOn(api, "getMatrixById").mockResolvedValue(fixture());
  vi.spyOn(api, "confirmMatrixEvidence").mockResolvedValue({ updatedIds: ["evidence-a1"], skipped: 0 });
  vi.spyOn(api, "updateEvidence");
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ""; vi.restoreAllMocks(); vi.clearAllMocks(); });

it("打开原文进入当前项目的应用内阅读器，携带证据页码", async () => {
  const popup = vi.spyOn(window, "open");
  await render();
  await act(async () => button("打开原文").click());
  expect(document.querySelector('[data-testid="location"]')?.textContent).toBe("/projects/real-project/library/paper-a/read?page=3");
  expect(popup).not.toHaveBeenCalled();
  expect(setProject).toHaveBeenCalledWith("real-project");
});

it("没有 PDF 时明确禁用原文入口", async () => {
  const data = fixture(); data.papers[0].hasFile = false;
  vi.mocked(api.getMatrixById).mockResolvedValue(data);
  await render(); expect(button("尚未上传").disabled).toBe(true);
});

it("本篇确认先展示范围，Escape 取消不写入并还原焦点", async () => {
  await render();
  const entry = button("确认本篇（1）"); entry.focus();
  await act(async () => entry.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("范围：1 篇文献，3 个证据单元格");
  expect(api.confirmMatrixEvidence).not.toHaveBeenCalled();
  expect(button("继续 AI 提取").disabled).toBe(true);
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(entry);
  expect(api.confirmMatrixEvidence).not.toHaveBeenCalled();
});

it("确认本篇只提交本篇合格草稿，更新状态并显示跳过数量", async () => {
  await render();
  await act(async () => button("确认本篇（1）").click());
  await act(async () => button("确认并锁定 1 项").click());
  expect(api.confirmMatrixEvidence).toHaveBeenCalledWith("review-matrix", ["evidence-a1"], "paper-a");
  expect(document.querySelector('[role="status"]')?.textContent).toContain("已确认并锁定 1 项，跳过 2 项");
  expect(document.querySelector(".matrix-cell")?.textContent).toContain("已确认");
});

it("整个矩阵包含被搜索隐藏的论文，并在确认前明确展示", async () => {
  await render();
  await act(async () => {
    const input = document.querySelector('input[placeholder="搜索论文"]') as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "paper-a");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(document.querySelectorAll(".paper-head")).toHaveLength(1);
  await act(async () => button("确认整个矩阵（3）").click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("包括搜索框隐藏的文献");
  vi.mocked(api.confirmMatrixEvidence).mockResolvedValue({ updatedIds: ["evidence-a1", "evidence-b1", "evidence-b3"], skipped: 0 });
  await act(async () => button("确认并锁定 3 项").click());
  expect(api.confirmMatrixEvidence).toHaveBeenCalledWith("review-matrix", ["evidence-a1", "evidence-b1", "evidence-b3"], undefined);
});

it("批量写入失败保留待确认状态，提示错误并允许重试", async () => {
  vi.mocked(api.confirmMatrixEvidence).mockRejectedValueOnce(new Error("API 不可用"));
  await render(); await act(async () => button("确认本篇（1）").click());
  await act(async () => button("确认并锁定 1 项").click());
  expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe("API 不可用");
  expect(document.querySelector(".matrix-cell")?.textContent).toContain("AI 草稿");
  expect(button("确认并锁定 1 项").disabled).toBe(false);
  await act(async () => button("确认并锁定 1 项").click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it("未同步的本地矩阵使用一次本地批量更新，保留已有核验路径", async () => {
  const data = fixture();
  localWorkspace.matrices = [{ id: "review-matrix", projectId: "real-project", name: "Local", description: "", source: "local", paperIds: data.papers.map((paper) => paper.id), dimensions: data.groups[0].rows, cells: data.cells, createdAt: "" }];
  localWorkspace.papers = data.papers.map((paper) => ({ ...paper, fileName: "paper.pdf" })) as unknown as typeof localWorkspace.papers;
  await render(); await act(async () => button("确认本篇（1）").click());
  await act(async () => button("确认并锁定 1 项").click());
  expect(localWorkspace.confirmMatrixCells).toHaveBeenCalledWith("review-matrix", ["dim:1:paper-a"]);
  expect(api.confirmMatrixEvidence).not.toHaveBeenCalled();
});
