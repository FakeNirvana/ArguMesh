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
    updatePaper: vi.fn(), setReaderPosition: vi.fn(),
  } as unknown as ReturnType<typeof workspace.useWorkspace>);
  vi.mocked(storage.getPaperPdf).mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(4) } as Blob);
  vi.mocked(storage.getPageTranslations).mockResolvedValue(null);
  vi.mocked(storage.savePageTranslations).mockResolvedValue(undefined);
  vi.mocked(pdf.inspectPdf).mockResolvedValue({ title: "", authors: "", pageCount: 1, outline: [] });
  vi.mocked(pdf.currentPageText).mockResolvedValue({ text: "", source: "empty", layout: null });
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

it("下滑连续页面更新当前页并关联译文，关闭关联后译文滚动独立且不调用 AI", async () => {
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
  await act(async () => { original.scrollTop = 1050; original.dispatchEvent(new Event("scroll")); });
  expect(document.querySelector<HTMLInputElement>('[aria-label="当前页码"]')?.value).toBe("2");
  expect(translated.scrollTop).toBe(1050);
  expect(original.scrollTop).toBe(1050); // changing active page does not reset the viewport
  await act(async () => { translated.scrollTop = 2050; translated.dispatchEvent(new Event("scroll")); });
  expect(original.scrollTop).toBe(2050);
  expect(document.querySelector<HTMLInputElement>('[aria-label="当前页码"]')?.value).toBe("3");
  await act(async () => document.querySelector<HTMLInputElement>(".compare-scroll-toggle input")!.click());
  await act(async () => { translated.scrollTop = 50; translated.dispatchEvent(new Event("scroll")); });
  expect(original.scrollTop).toBe(2050);
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
