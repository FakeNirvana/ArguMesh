import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "../../src/api";
import * as pdf from "../../src/pdf/document";
import * as storage from "../../src/storage/paperFiles";
import * as workspace from "../../src/state/workspace";
import { ReaderPage } from "../../src/pages/ReaderPage";

const fake = vi.hoisted(() => {
  const page = { pageNumber: 1, getViewport: () => ({ width: 600, height: 800 }) };
  return { page, document: { numPages: 1, getPage: vi.fn().mockResolvedValue(page), destroy: vi.fn().mockResolvedValue(undefined) } };
});
vi.mock("pdfjs-dist", () => ({ getDocument: () => ({ promise: Promise.resolve(fake.document) }) }));
vi.mock("../../src/components/PdfPage", () => ({ PdfPage: ({ page, onSelect }: { page: { pageNumber: number }; onSelect: (payload: unknown) => void }) => <button onClick={() => onSelect({ text: `Selected on page ${page.pageNumber}`, rects: [], clientRect: null })}>Original PDF {page.pageNumber}</button> }));
vi.mock("../../src/state/workspace", () => ({ useWorkspace: vi.fn() }));
vi.mock("../../src/pdf/document", () => ({ currentPageText: vi.fn(), inspectPdf: vi.fn(), recognizePdfPage: vi.fn(), extractPdfText: vi.fn(), sha256File: vi.fn() }));
vi.mock("../../src/storage/paperFiles", () => ({ getPaperPdf: vi.fn(), getPageTranslations: vi.fn(), getPaperPageTexts: vi.fn(), savePageTranslations: vi.fn(), savePaperPdf: vi.fn() }));

let root: ReturnType<typeof createRoot>;
function button(text: string) {
  const found = Array.from(document.querySelectorAll("button")).find((node) => node.textContent === text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}
async function render(query = "") {
  await act(async () => root.render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[`/projects/project/library/paper/read${query}`]}><Routes><Route path="/projects/:projectId/library/:paperId/read" element={<ReaderPage />} /></Routes></MemoryRouter>));
}
const current = { text: "Recognized text from the current page only. ".repeat(5), source: "ocr" as const, layout: null };
beforeEach(() => {
  fake.document.numPages = 1;
  fake.document.getPage.mockImplementation(async (number: number) => ({ ...fake.page, pageNumber: number }));
  fake.document.destroy.mockResolvedValue(undefined);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  vi.mocked(workspace.useWorkspace).mockReturnValue({
    projects: [{ id: "project", name: "Project" }], papers: [{ id: "paper", title: "Scanned paper", projectIds: ["project"], authors: "Author", year: 1958 }], readerAnswers: [], readerExcerpts: [], readerPositions: [], settings: {},
    updatePaper: vi.fn(), setReaderPosition: vi.fn(), setPaperFile: vi.fn(),
  } as unknown as ReturnType<typeof workspace.useWorkspace>);
  vi.mocked(storage.getPaperPdf).mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(4) } as Blob);
  vi.spyOn(api, "downloadPaperFile").mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(4) } as Blob);
  vi.mocked(storage.getPageTranslations).mockResolvedValue(null);
  vi.mocked(storage.savePageTranslations).mockResolvedValue(undefined);
  vi.mocked(storage.savePaperPdf).mockResolvedValue(undefined);
  vi.mocked(pdf.inspectPdf).mockResolvedValue({ title: "", authors: "", pageCount: 1, outline: [] });
  vi.mocked(pdf.sha256File).mockResolvedValue("a".repeat(64));
  vi.mocked(pdf.currentPageText).mockResolvedValue({ text: "", source: "empty", layout: null });
  vi.spyOn(api, "syncProject").mockResolvedValue({ id: "project" });
  vi.spyOn(api, "syncPaper").mockResolvedValue({ paperId: "paper", duplicate: false });
  vi.spyOn(api, "uploadPaperFile").mockResolvedValue({ paperId: "paper", size: 4, cloudStored: false });
  vi.spyOn(api, "parseReaderPage").mockRejectedValue(new Error("本机解析不可用"));
  vi.spyOn(api, "getReaderPageParseStatus").mockResolvedValue({ progress: null });
  vi.spyOn(api, "getAiModels").mockResolvedValue({ model: "step-5-preview", models: ["step-5-preview"], providers: [] });
  vi.spyOn(api, "getAiConfig").mockResolvedValue({ configured: true, model: "step-5-preview", baseUrl: "https://model.example/v1", apiKeyMasked: "masked", envProviders: [] });
  vi.spyOn(api, "translateSelection").mockResolvedValue({ translation: "本页译文", model: "step-5-preview", generatedAt: "2026-10-11T10:00:00Z" });
});

it("矩阵来源链接的页码优先于上次阅读位置", async () => {
  fake.document.numPages = 5;
  vi.mocked(workspace.useWorkspace).mockReturnValue({ ...workspace.useWorkspace(), readerPositions: [{ projectId: "project", paperId: "paper", page: 2, scale: 1.15 }] } as ReturnType<typeof workspace.useWorkspace>);
  await render("?page=3");
  expect((document.querySelector('.reader-toolbar input[type="number"]') as HTMLInputElement).value).toBe("3");
});

it("超出文档的来源页码安全落到最后一页", async () => {
  fake.document.numPages = 5;
  await render("?page=900");
  expect((document.querySelector('.reader-toolbar input[type="number"]') as HTMLInputElement).value).toBe("5");
});

it("PDF 尚未加载时不能用空滚动区把已保存的页码重置为第一页", async () => {
  fake.document.numPages = 5;
  vi.mocked(workspace.useWorkspace).mockReturnValue({ ...vi.mocked(workspace.useWorkspace).getMockImplementation()!(), readerPositions: [{ projectId: "project", paperId: "paper", page: 3, scale: 1.15 }] } as ReturnType<typeof workspace.useWorkspace>);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("pdf-stage") || this.classList.contains("compare-page-stage") ? 200 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const stage = this.closest<HTMLDivElement>(".pdf-stage, .compare-page-stage");
    return { top: this.dataset.readerPage ? (Number(this.dataset.readerPage) - 1) * 1000 - (stage?.scrollTop ?? 0) : 0, height: 976 } as DOMRect;
  });
  await render();
  expect(document.querySelector<HTMLInputElement>('[aria-label="当前页码"]')?.value).toBe("3");
  expect(document.querySelector<HTMLDivElement>(".pdf-stage")?.scrollTop).toBe(2000);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ""; vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

it("OCR 准备阶段不会伪装成 0%，可取消后重试", async () => {
  vi.mocked(pdf.recognizePdfPage).mockImplementation((_page, _id, _progress, options) => new Promise((_resolve, reject) => {
    options?.onStage?.("loading");
    options?.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
  }));
  await render();
  await act(async () => button("OCR 本页").click());
  expect(document.body.textContent).toContain("OCR 加载引擎");
  expect(document.body.textContent).not.toContain("OCR 0%");
  await act(async () => button("取消 OCR").click());
  expect(button("OCR 本页").disabled).toBe(false);
});

it("OCR 后可直接翻译本页，并只发送当前页分段", async () => {
  vi.mocked(pdf.recognizePdfPage).mockImplementation(async () => {
    vi.mocked(pdf.currentPageText).mockResolvedValue(current);
    return current.text;
  });
  await render();
  await act(async () => button("OCR 本页").click());
  await act(async () => button("翻译本页").click());
  expect(api.translateSelection).toHaveBeenCalledWith(expect.objectContaining({ text: current.text.trim(), page: 1, model: "step-5-preview" }), expect.any(AbortSignal));
  expect(document.querySelector(".translation-sheet")?.textContent).toContain("本页译文");
  expect(storage.savePageTranslations).toHaveBeenCalledWith("paper", 1, "中文:layout-v2", expect.objectContaining({ blocks: expect.arrayContaining([expect.objectContaining({ model: "step-5-preview" })]) }));
});

it("全文解析失败且没有文字时提示 OCR，暂停期间页签仍能切换", async () => {
  await render();
  await act(async () => button("精确解析并翻译全文").click());
  expect(document.body.textContent).toContain("请先 OCR 本页");
  expect(document.body.textContent).toContain("已暂停");
  await act(async () => button("批注与问答").click());
  expect(document.querySelector(".reader-page")?.getAttribute("data-reader-mode")).toBe("notes");
  expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("批注与问答");
  await act(async () => button("双语对照").click());
  expect(button("继续翻译全文").disabled).toBe(false);
});

it("精确解析失败时可用已识别 OCR 继续全文翻译，并显著提示版面降级", async () => {
  vi.mocked(pdf.currentPageText).mockResolvedValue(current);
  await render();
  await act(async () => button("精确解析并翻译全文").click());
  expect(document.body.textContent).toContain("全部完成");
  expect(document.body.textContent).toContain("已识别的 OCR");
  expect(document.body.textContent).toContain("近似还原");
  expect(api.translateSelection).toHaveBeenCalledWith(expect.objectContaining({ text: current.text.trim(), page: 1 }), expect.any(AbortSignal));
});

it("本页翻译失败不会使页签或重试入口失效", async () => {
  vi.mocked(pdf.currentPageText).mockResolvedValue(current);
  vi.mocked(api.translateSelection).mockRejectedValue(new Error("翻译暂停（HTTP 429）：额度不足"));
  await render();
  await act(async () => button("翻译本页").click());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("HTTP 429");
  expect(button("翻译本页").disabled).toBe(false);
  await act(async () => button("批注与问答").click());
  expect(document.querySelector(".reader-page")?.getAttribute("data-reader-mode")).toBe("notes");
});

it("连续页面双向关联纵向位置与横向比例，关闭关联后独立滚动且不调用 AI", async () => {
  fake.document.numPages = 3;
  fake.document.getPage.mockImplementation(async (number: number) => ({ ...fake.page, pageNumber: number }));
  vi.mocked(pdf.currentPageText).mockResolvedValue(current);
  await render();
  const original = document.querySelector<HTMLDivElement>(".pdf-stage")!;
  const translated = document.querySelector<HTMLDivElement>(".compare-page-stage")!;
  expect(original.querySelectorAll("[data-reader-page]")).toHaveLength(3);
  expect(translated.querySelectorAll("[data-reader-page]")).toHaveLength(3);
  for (const stage of [original, translated]) {
    Object.defineProperty(stage, "clientHeight", { value: 200 });
    Object.defineProperty(stage, "scrollHeight", { value: 3000 });
    stage.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    for (const node of stage.querySelectorAll<HTMLElement>("[data-reader-page]")) {
      node.getBoundingClientRect = () => ({ top: (Number(node.dataset.readerPage) - 1) * 1000 - stage.scrollTop, height: 976 }) as DOMRect;
    }
  }
  Object.defineProperty(original, "clientWidth", { value: 500 });
  Object.defineProperty(original, "scrollWidth", { value: 1000 });
  Object.defineProperty(translated, "clientWidth", { value: 400 });
  Object.defineProperty(translated, "scrollWidth", { value: 1400 });
  await act(async () => { original.scrollTop = 1050; original.scrollLeft = 250; original.dispatchEvent(new Event("scroll")); });
  expect(document.querySelector<HTMLInputElement>('[aria-label="当前页码"]')?.value).toBe("2");
  expect(translated.scrollTop).toBe(1050);
  expect(translated.scrollLeft).toBe(500);
  expect(original.scrollTop).toBe(1050); // changing active page does not reset the viewport
  expect(original.scrollLeft).toBe(250);
  await act(async () => { translated.scrollTop = 2050; translated.scrollLeft = 750; translated.dispatchEvent(new Event("scroll")); });
  expect(original.scrollTop).toBe(2050);
  expect(original.scrollLeft).toBe(375);
  expect(document.querySelector<HTMLInputElement>('[aria-label="当前页码"]')?.value).toBe("3");
  await act(async () => document.querySelector<HTMLInputElement>(".compare-scroll-toggle input")!.click());
  await act(async () => { translated.scrollTop = 50; translated.scrollLeft = 50; translated.dispatchEvent(new Event("scroll")); });
  expect(original.scrollTop).toBe(2050);
  expect(original.scrollLeft).toBe(375);
  expect(document.querySelector<HTMLInputElement>('[aria-label="当前页码"]')?.value).toBe("3");
  expect(api.translateSelection).not.toHaveBeenCalled();
  expect(vi.mocked(api.parseReaderPage).mock.calls.every((call) => call[2] === true)).toBe(true);
});

it("邻页划词使用文字实际所属页，不移动当前滚动位置", async () => {
  fake.document.numPages = 3;
  fake.document.getPage.mockImplementation(async (number: number) => ({ ...fake.page, pageNumber: number }));
  vi.mocked(pdf.currentPageText).mockResolvedValue(current);
  await render();
  const stage = document.querySelector<HTMLDivElement>(".pdf-stage")!;
  stage.scrollTop = 400;
  await act(async () => button("Original PDF 2").click());
  expect(document.querySelector<HTMLInputElement>('[aria-label="当前页码"]')?.value).toBe("2");
  expect(stage.scrollTop).toBe(400);
  expect(api.translateSelection).not.toHaveBeenCalled();
  Object.defineProperty(stage, "clientHeight", { value: 200 });
  Object.defineProperty(stage, "scrollHeight", { value: 3000 });
  stage.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
  for (const node of stage.querySelectorAll<HTMLElement>("[data-reader-page]")) {
    node.getBoundingClientRect = () => ({ top: (Number(node.dataset.readerPage) - 1) * 1000 - stage.scrollTop, height: 976 }) as DOMRect;
  }
  await act(async () => { stage.scrollTop = 2050; stage.dispatchEvent(new Event("scroll")); });
  expect(document.querySelector<HTMLInputElement>('[aria-label="当前页码"]')?.value).toBe("3");
  await act(async () => button("翻译").click());
  expect(api.translateSelection).toHaveBeenCalledWith(expect.objectContaining({ text: "Selected on page 2", page: 2 }));
});

it("视口上方的纸页变高后，两栏保留同页阅读位置", async () => {
  const observers: Array<{ callback: ResizeObserverCallback; nodes: Element[] }> = [];
  vi.stubGlobal("ResizeObserver", class {
    nodes: Element[] = [];
    constructor(callback: ResizeObserverCallback) { observers.push({ callback, nodes: this.nodes }); }
    observe(node: Element) { this.nodes.push(node); }
    unobserve() {}
    disconnect() {}
  });
  fake.document.numPages = 3;
  vi.mocked(pdf.currentPageText).mockResolvedValue(current);
  await render();
  const original = document.querySelector<HTMLDivElement>(".pdf-stage")!;
  const translated = document.querySelector<HTMLDivElement>(".compare-page-stage")!;
  const growth = new Map([[original, 0], [translated, 0]]);
  for (const stage of [original, translated]) {
    Object.defineProperty(stage, "clientHeight", { value: 200 });
    Object.defineProperty(stage, "scrollHeight", { value: 4000 });
    stage.getBoundingClientRect = () => ({ top: 0 }) as DOMRect;
    for (const node of stage.querySelectorAll<HTMLElement>("[data-reader-page]")) {
      node.getBoundingClientRect = () => ({ top: (Number(node.dataset.readerPage) - 1) * 1000 + (Number(node.dataset.readerPage) > 1 ? growth.get(stage)! : 0) - stage.scrollTop, height: 976 }) as DOMRect;
    }
  }
  await act(async () => { original.scrollTop = 1050; original.dispatchEvent(new Event("scroll")); });
  growth.set(original, 300);
  growth.set(translated, 500);
  const pageObserver = observers.find((observer) => observer.nodes.length === 6 && observer.nodes.every((node) => (node as HTMLElement).dataset.readerPage));
  expect(pageObserver).toBeDefined();
  await act(async () => pageObserver!.callback([], {} as ResizeObserver));
  expect(original.scrollTop).toBe(1350);
  expect(translated.scrollTop).toBe(1550);
  expect(document.querySelector<HTMLInputElement>('[aria-label="当前页码"]')?.value).toBe("2");
  expect(api.translateSelection).not.toHaveBeenCalled();
});


it("Paper Card 对照入口保留 PDF，切换页签不丢草稿，保存仍写入当前论文", async () => {
  const updatePaper = workspace.useWorkspace().updatePaper;
  await render("?panel=card");
  const original = document.querySelector(".pdf-stage");
  expect(original?.textContent).toContain("Original PDF 1");
  expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("Paper Card");
  const problem = document.querySelector<HTMLTextAreaElement>('textarea[name="problem"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(problem, "对照原文填写的研究问题");
    problem.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => button("批注与问答").click());
  expect(document.querySelector<HTMLElement>("#reader-card-panel")?.hidden).toBe(true);
  await act(async () => button("双语对照").click());
  await act(async () => button("Paper Card").click());
  expect(document.querySelector<HTMLElement>("#reader-card-panel")?.hidden).toBe(false);
  expect(problem.value).toBe("对照原文填写的研究问题");
  expect(document.querySelector(".pdf-stage")).toBe(original);
  await act(async () => document.querySelector<HTMLFormElement>(".paper-card-editor")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(updatePaper).toHaveBeenCalledWith("paper", expect.objectContaining({ card: expect.objectContaining({ problem: "对照原文填写的研究问题", confirmed: false }) }));
  expect(api.translateSelection).not.toHaveBeenCalled();
  expect(pdf.extractPdfText).not.toHaveBeenCalled();
});


it("窄 PDF 分区进入卡片模式时按分区宽度适配，而不是裁掉右半页", async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("pdf-stage") ? 320 : 0;
  });
  await render("?panel=card");
  const sheet = document.querySelector<HTMLElement>(".pdf-stage .continuous-reader-page")!;
  expect(Number.parseFloat(sheet.style.width)).toBeLessThanOrEqual(320 - 32);
  expect(Number.parseFloat(sheet.style.width)).toBeGreaterThan(0);
});

it("对照编辑沿用已保存卡片的确认状态与 AI 来源信息", async () => {
  const card = { problem: "已有问题", method: "已有方法", data: "", findings: "", limitations: "", confirmed: true, updatedAt: "2026-10-18T00:00:00Z", generatedBy: "original-model", generatedAt: "2026-10-17T00:00:00Z", generatedSource: "PDF 第 2 页", sources: { problem: "原文证据摘录", method: "", data: "", findings: "", limitations: "" } };
  const state = workspace.useWorkspace();
  vi.mocked(workspace.useWorkspace).mockReturnValue({ ...state, papers: [{ ...state.papers[0], card }] });
  await render("?panel=card");
  expect(document.querySelector<HTMLTextAreaElement>('textarea[name="problem"]')?.value).toBe("已有问题");
  expect(document.querySelector<HTMLInputElement>('input[name="confirmed"]')?.checked).toBe(true);
  expect(document.querySelector(".ai-evidence-panel")?.textContent).toContain("原文证据摘录");
  await act(async () => document.querySelector<HTMLFormElement>(".paper-card-editor")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(state.updatePaper).toHaveBeenCalledWith("paper", expect.objectContaining({ card: expect.objectContaining({ ...card, updatedAt: expect.any(String) }) }));
});

async function uploadPdf(file: File) {
  const input = document.querySelector<HTMLInputElement>('.reader-header input[type="file"]')!;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}

it("PDF 写入文献库失败时显示错误，不将附件标记为已保存", async () => {
  vi.mocked(api.uploadPaperFile).mockRejectedValue(new Error("PDF 写入文献库失败"));
  const setPaperFile = workspace.useWorkspace().setPaperFile;
  await render();
  vi.mocked(storage.savePaperPdf).mockClear();
  await uploadPdf(new File(["%PDF"], "论文.pdf", { type: "application/pdf" }));

  expect(api.uploadPaperFile).toHaveBeenCalledWith("paper", expect.any(File));
  expect(document.body.textContent).toContain("PDF 写入文献库失败");
  expect(storage.savePaperPdf).not.toHaveBeenCalled();
  expect(setPaperFile).not.toHaveBeenCalled();
});

it("PDF 写入文献库成功后才更新附件状态", async () => {
  let finishUpload!: (result: Awaited<ReturnType<typeof api.uploadPaperFile>>) => void;
  vi.mocked(api.uploadPaperFile).mockImplementation(() => new Promise((resolve) => { finishUpload = resolve; }));
  const setPaperFile = workspace.useWorkspace().setPaperFile;
  const file = new File(["%PDF"], "持久保存.pdf", { type: "application/pdf" });
  await render();
  await uploadPdf(file);
  expect(api.uploadPaperFile).toHaveBeenCalledWith("paper", file);
  expect(setPaperFile).not.toHaveBeenCalled();

  await act(async () => finishUpload({ paperId: "paper", size: file.size, cloudStored: false }));
  expect(setPaperFile).toHaveBeenCalledWith("paper", { name: file.name, size: file.size });
  expect(document.body.textContent).not.toContain("PDF 写入文献库失败");
});

it("翻译操作与状态集中在公共工具区，切换右栏不触发 AI", async () => {
  await render();
  const controls = document.querySelector<HTMLElement>(".reader-controls");
  const actions = document.querySelector<HTMLElement>('[role="group"][aria-label="翻译操作"]');
  const status = document.querySelector<HTMLElement>(".reader-translation-status");
  expect(controls).not.toBeNull();
  expect(actions).not.toBeNull();
  expect(controls?.contains(actions)).toBe(true);
  expect(controls?.contains(button("翻译本页"))).toBe(true);
  expect(controls?.contains(button("精确解析并翻译全文"))).toBe(true);
  expect(controls?.contains(document.querySelector(".reader-tabs"))).toBe(true);
  expect(controls?.contains(status)).toBe(true);
  expect(status?.textContent).toContain("当前第 1 / 1 页");
  expect(document.querySelector(".compare-pane .reader-translation-actions, .compare-pane .compare-progress, .compare-pane .compare-scroll-toggle")).toBeNull();
  expect(document.querySelector(".reader-document .reader-toolbar, .reader-ai .reader-tabs")).toBeNull();

  for (const [label, mode] of [["批注与问答", "notes"], ["Paper Card", "card"], ["双语对照", "compare"]]) {
    await act(async () => button(label).click());
    expect(document.querySelector(".reader-page")?.getAttribute("data-reader-mode")).toBe(mode);
    expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(label);
    expect(document.querySelector(".reader-controls")?.contains(button(label))).toBe(true);
  }
  expect(api.translateSelection).not.toHaveBeenCalled();
  expect(vi.mocked(api.parseReaderPage).mock.calls.every((call) => call[2] === true)).toBe(true);
});

it("窄双语分区使用较窄栏的可用宽度，两侧纸页保持同宽", async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("pdf-stage") ? 360 : this.classList.contains("compare-page-stage") ? 320 : 0;
  });
  await render();
  const original = document.querySelector<HTMLElement>(".pdf-stage .continuous-reader-page")!;
  const translated = document.querySelector<HTMLElement>(".compare-page-stage .continuous-reader-page")!;
  const originalWidth = Number.parseFloat(original.style.width);
  const translatedWidth = Number.parseFloat(translated.style.width);
  expect(originalWidth).toBeGreaterThan(0);
  expect(originalWidth).toBeLessThanOrEqual(320 - 32);
  expect(translatedWidth).toBe(originalWidth);
  expect(original.style.minHeight).toBe(translated.style.minHeight);
  expect(api.translateSelection).not.toHaveBeenCalled();
});

it("双语分区变窄后重新适配，两侧不保留导致横向裁切的缩放下限", async () => {
  const observers: Array<{ callback: ResizeObserverCallback; nodes: Element[] }> = [];
  vi.stubGlobal("ResizeObserver", class {
    nodes: Element[] = [];
    constructor(callback: ResizeObserverCallback) { observers.push({ callback, nodes: this.nodes }); }
    observe(node: Element) { this.nodes.push(node); }
    unobserve() {}
    disconnect() {}
  });
  let paneWidth = 600;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("pdf-stage") || this.classList.contains("compare-page-stage") ? paneWidth : 0;
  });
  await render();
  const original = document.querySelector<HTMLElement>(".pdf-stage .continuous-reader-page")!;
  const translated = document.querySelector<HTMLElement>(".compare-page-stage .continuous-reader-page")!;
  const initialWidth = Number.parseFloat(original.style.width);
  const fitObserver = observers.find((observer) => observer.nodes.some((node) => node.classList.contains("pdf-stage")) && observer.nodes.some((node) => node.classList.contains("compare-page-stage")));
  expect(fitObserver).toBeDefined();
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="放大页面"]')!.click());
  const zoomedWidth = Number.parseFloat(original.style.width);
  expect(zoomedWidth).toBeGreaterThan(initialWidth);
  // Status wrapping or a horizontal scrollbar changes height, not the available width.
  await act(async () => fitObserver!.callback([], {} as ResizeObserver));
  expect(Number.parseFloat(original.style.width)).toBe(zoomedWidth);
  paneWidth = 280;
  await act(async () => fitObserver!.callback([], {} as ResizeObserver));
  const fittedWidth = Number.parseFloat(original.style.width);
  expect(fittedWidth).toBeGreaterThan(0);
  expect(fittedWidth).toBeLessThan(initialWidth);
  expect(fittedWidth).toBeLessThanOrEqual(paneWidth - 32);
  expect(Number.parseFloat(translated.style.width)).toBe(fittedWidth);
  expect(api.translateSelection).not.toHaveBeenCalled();
});
