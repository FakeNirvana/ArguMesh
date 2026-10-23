import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../src/api";
import * as storage from "../../src/storage/paperFiles";
import { resolvePaperPdf } from "../../src/pdf/resolvePaperPdf";

vi.mock("../../src/storage/paperFiles", () => ({ getPaperPdf: vi.fn(), savePaperPdf: vi.fn() }));

let pdf: Blob;
beforeEach(() => {
  pdf = new Blob(["%PDF"], { type: "application/pdf" });
  vi.mocked(storage.getPaperPdf).mockResolvedValue(null);
  vi.mocked(storage.savePaperPdf).mockResolvedValue(undefined);
  vi.spyOn(api, "downloadPaperFile").mockResolvedValue(pdf);
});

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("persistent PDF fallback", () => {
  it("uses a legacy cached PDF only when the database has no PDF", async () => {
    vi.mocked(api.downloadPaperFile).mockResolvedValue(null);
    vi.mocked(storage.getPaperPdf).mockResolvedValue(pdf);
    expect(await resolvePaperPdf("paper")).toBe(pdf);
    expect(storage.savePaperPdf).not.toHaveBeenCalled();
  });

  it("opens the updated database PDF even when a stale browser copy cannot be replaced", async () => {
    const oldPdf = new Blob(["old PDF"]);
    vi.mocked(storage.getPaperPdf).mockResolvedValue(oldPdf);
    vi.mocked(storage.savePaperPdf).mockRejectedValue(new Error("cache full"));
    expect(await resolvePaperPdf("paper")).toBe(pdf);
    expect(await resolvePaperPdf("paper")).toBe(pdf);
    expect(storage.getPaperPdf).not.toHaveBeenCalled();
  });

  it("loads the database PDF when the browser cache cannot be read", async () => {
    vi.mocked(storage.getPaperPdf).mockRejectedValue(new Error("缓存不可用"));
    expect(await resolvePaperPdf("paper")).toBe(pdf);
    expect(api.downloadPaperFile).toHaveBeenCalledWith("paper");
  });

  it("returns downloaded PDF bytes even when the browser cache is full", async () => {
    vi.mocked(storage.savePaperPdf).mockRejectedValue(new Error("缓存已满"));
    expect(await resolvePaperPdf("paper")).toBe(pdf);
    expect(storage.savePaperPdf).toHaveBeenCalledWith("paper", expect.any(File));
  });

  it("downloads and caches a missing PDF with its original filename", async () => {
    expect(await resolvePaperPdf("paper", "原始论文.pdf")).toBe(pdf);
    expect(api.downloadPaperFile).toHaveBeenCalledWith("paper");
    expect(storage.savePaperPdf).toHaveBeenCalledWith("paper", expect.objectContaining({ name: "原始论文.pdf", type: "application/pdf", size: pdf.size }));
  });

  it("returns null when neither browser cache nor database has a PDF", async () => {
    vi.mocked(api.downloadPaperFile).mockResolvedValue(null);
    expect(await resolvePaperPdf("paper")).toBeNull();
    expect(storage.savePaperPdf).not.toHaveBeenCalled();
  });

  it("reports database download failures instead of treating them as a missing PDF", async () => {
    vi.mocked(api.downloadPaperFile).mockRejectedValue(new Error("文献库读取失败"));
    await expect(resolvePaperPdf("paper")).rejects.toThrow("文献库读取失败");
    expect(storage.savePaperPdf).not.toHaveBeenCalled();
  });
});
