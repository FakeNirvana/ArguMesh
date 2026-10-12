import type { PDFPageProxy } from "pdfjs-dist";
import { afterEach, expect, it, vi } from "vitest";
import { currentPageText, recognizePdfPage } from "../../src/pdf/document";
import { recognizeLocalImage } from "../../src/pdf/ocr";
import { getPaperPageTexts, savePaperPageText } from "../../src/storage/paperFiles";

vi.mock("../../src/pdf/ocr", async (original) => ({ ...await original<typeof import("../../src/pdf/ocr")>(), recognizeLocalImage: vi.fn() }));
vi.mock("../../src/storage/paperFiles", () => ({ getPaperPageTexts: vi.fn(), savePaperPageText: vi.fn() }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

it("短 OCR 页面不会因原生文字阈值 40 字符而被误判为空", async () => {
  vi.mocked(getPaperPageTexts).mockResolvedValue({ 1: "Short scanned caption." });
  const page = { pageNumber: 1, getTextContent: async () => ({ items: [] }), getViewport: () => ({ width: 600, height: 800 }) } as unknown as PDFPageProxy;
  expect(await currentPageText(page, "paper")).toMatchObject({ text: "Short scanned caption.", source: "ocr" });
});

it("大型扫描页限制 OCR 画布面积，并将文字保存到它自己的页码", async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
  vi.mocked(recognizeLocalImage).mockResolvedValue({ data: { text: "Recognized current page." } } as never);
  vi.mocked(savePaperPageText).mockResolvedValue(undefined);
  const page = { pageNumber: 3, getViewport: ({ scale }: { scale: number }) => ({ width: 5_000 * scale, height: 7_000 * scale }), render: vi.fn().mockReturnValue({ promise: Promise.resolve(), cancel: vi.fn() }) };
  await recognizePdfPage(page as unknown as PDFPageProxy, "paper");
  const { viewport } = page.render.mock.calls[0][0];
  expect(viewport.width * viewport.height).toBeLessThanOrEqual(10_000_001);
  expect(savePaperPageText).toHaveBeenCalledWith("paper", 3, "Recognized current page.");
});

it("取消 OCR 后迟到的结果不会写入文字缓存", async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({} as never);
  const controller = new AbortController();
  vi.mocked(recognizeLocalImage).mockImplementation(async () => {
    controller.abort(); return { data: { text: "Late OCR result" } } as never;
  });
  const page = { pageNumber: 1, getViewport: () => ({ width: 600, height: 800 }), render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }) } as unknown as PDFPageProxy;
  await expect(recognizePdfPage(page, "paper", undefined, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  expect(savePaperPageText).not.toHaveBeenCalled();
});
