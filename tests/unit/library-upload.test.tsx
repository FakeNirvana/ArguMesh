import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "../../src/api";
import * as pdf from "../../src/pdf/document";
import * as storage from "../../src/storage/paperFiles";
import * as workspace from "../../src/state/workspace";
import { LibraryPage } from "../../src/pages/LibraryPage";

vi.mock("../../src/state/workspace", () => ({ useWorkspace: vi.fn() }));
vi.mock("../../src/pdf/document", () => ({ inspectPdf: vi.fn(), sha256File: vi.fn() }));
vi.mock("../../src/storage/paperFiles", () => ({ savePaperPdf: vi.fn(), deletePaperFiles: vi.fn() }));

let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(workspace.useWorkspace).mockReturnValue({
    projects: [{ id: "project", name: "Project", description: "", paperIds: [], status: "active", createdAt: "2026-10-23" }],
    papers: [], pendingSync: [], addPaper: vi.fn().mockReturnValue("paper"), setPaperFile: vi.fn(), updatePaper: vi.fn(),
  } as unknown as ReturnType<typeof workspace.useWorkspace>);
  vi.mocked(pdf.inspectPdf).mockResolvedValue({ title: "Imported paper", authors: "Author", pageCount: 1, outline: [] });
  vi.mocked(pdf.sha256File).mockResolvedValue("a".repeat(64));
  vi.mocked(storage.savePaperPdf).mockResolvedValue(undefined);
  vi.spyOn(api, "syncProject").mockResolvedValue({ id: "project" });
  vi.spyOn(api, "syncPaper").mockResolvedValue({ paperId: "paper", duplicate: false });
  vi.spyOn(api, "uploadPaperFile").mockResolvedValue({ paperId: "paper", size: 4, cloudStored: false });
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function uploadBatch(file: File) {
  await act(async () => root.render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={["/projects/project/library"]}><Routes><Route path="/projects/:projectId/library" element={<LibraryPage />} /></Routes></MemoryRouter>));
  const input = document.querySelector<HTMLInputElement>('input[type="file"][multiple]')!;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}

it("批量上传写库失败时保留重试入口，不提前标记附件或覆盖缓存", async () => {
  vi.mocked(api.uploadPaperFile).mockRejectedValue(new Error("PDF 写入文献库失败"));
  const state = workspace.useWorkspace();
  await uploadBatch(new File(["%PDF"], "论文.pdf", { type: "application/pdf" }));

  expect(document.querySelector(".upload-queue")?.textContent).toContain("PDF 写入文献库失败");
  expect(document.querySelector(".upload-queue")?.textContent).toContain("重试");
  expect(state.addPaper).toHaveBeenCalledOnce();
  const metadata = vi.mocked(state.addPaper).mock.calls[0][0];
  expect(metadata).not.toHaveProperty("fileName");
  expect(metadata).not.toHaveProperty("fileSize");
  expect(state.setPaperFile).not.toHaveBeenCalled();
  expect(storage.savePaperPdf).not.toHaveBeenCalled();
});

it("批量上传等待数据库成功后才保存缓存和附件状态", async () => {
  let finishUpload!: (result: Awaited<ReturnType<typeof api.uploadPaperFile>>) => void;
  vi.mocked(api.uploadPaperFile).mockImplementation(() => new Promise((resolve) => { finishUpload = resolve; }));
  const state = workspace.useWorkspace();
  const file = new File(["%PDF"], "持久保存.pdf", { type: "application/pdf" });
  await uploadBatch(file);
  expect(api.uploadPaperFile).toHaveBeenCalledWith("paper", file, expect.any(Function));
  expect(state.setPaperFile).not.toHaveBeenCalled();
  expect(storage.savePaperPdf).not.toHaveBeenCalled();

  await act(async () => finishUpload({ paperId: "paper", size: file.size, cloudStored: false }));
  expect(storage.savePaperPdf).toHaveBeenCalledWith("paper", file);
  expect(state.setPaperFile).toHaveBeenCalledWith("paper", { name: file.name, size: file.size });
  expect(document.querySelector(".upload-queue")?.textContent).toContain("已保存到本地文献库");
});

it("数据库已保存时浏览器缓存失败仍报告导入完成", async () => {
  vi.mocked(storage.savePaperPdf).mockRejectedValue(new Error("浏览器缓存已满"));
  const state = workspace.useWorkspace();
  const file = new File(["%PDF"], "持久保存.pdf", { type: "application/pdf" });
  await uploadBatch(file);

  expect(api.uploadPaperFile).toHaveBeenCalled();
  expect(state.setPaperFile).toHaveBeenCalledWith("paper", { name: file.name, size: file.size });
  expect(document.querySelector(".upload-queue")?.textContent).toContain("已保存到本地文献库");
  expect(document.querySelector(".upload-queue")?.textContent).not.toContain("重试");
});
