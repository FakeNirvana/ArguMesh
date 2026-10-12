import type { RecognizeResult, Worker } from "tesseract.js";

export interface OcrOptions {
  signal?: AbortSignal;
  onStage?: (stage: "loading" | "recognizing") => void;
  onProgress?: (progress: number) => void;
}

export function waitForOcr<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** All engine and English language files are served by this app, including offline desktop builds. */
export async function recognizeLocalImage(image: HTMLCanvasElement | string, options: OcrOptions = {}): Promise<RecognizeResult> {
  const timeout = AbortSignal.timeout(120_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let worker: Worker | null = null;
  let disposed = false;
  let rejectEngine: (error: Error) => void = () => {};
  const engineFailure = new Promise<never>((_resolve, reject) => { rejectEngine = reject; });
  const assetUrl = (path: string) => new URL(`/ocr/${path}`, window.location.href).href;
  options.onStage?.("loading");
  try {
    const { createWorker } = await waitForOcr(import("tesseract.js"), signal);
    const pending = createWorker("eng", 1, {
      workerPath: assetUrl("worker.min.js"), workerBlobURL: false,
      corePath: assetUrl("tesseract-core-lstm.wasm.js"), langPath: assetUrl(""),
      cacheMethod: "none",
      errorHandler: () => rejectEngine(new Error("OCR 引擎或识别资源加载失败，请重试；桌面版请检查安装文件是否完整。")),
      logger: (message) => {
        if (!disposed && !signal.aborted && message.status === "recognizing text" && typeof message.progress === "number") {
          options.onStage?.("recognizing");
          options.onProgress?.(message.progress);
        }
      },
    }).then((created) => {
      // Initialization can finish after cancellation; such a worker must never be reused.
      if (disposed || signal.aborted) void created.terminate();
      return created;
    });
    worker = await waitForOcr(Promise.race([pending, engineFailure]), signal);
    signal.throwIfAborted();
    options.onStage?.("recognizing");
    return await waitForOcr(Promise.race([worker.recognize(image, {}, { tsv: true }), engineFailure]), signal);
  } catch (error) {
    if (timeout.aborted && !options.signal?.aborted) throw new Error("OCR 超时（2 分钟）：请重试，或改用本机精确解析；识别质量也可能受扫描分辨率影响。");
    if (options.signal?.aborted) throw new DOMException("OCR 已取消", "AbortError");
    throw error;
  } finally {
    disposed = true;
    if (worker) await worker.terminate();
  }
}
