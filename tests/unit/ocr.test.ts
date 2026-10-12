import { afterEach, expect, it, vi } from "vitest";
import { createWorker } from "tesseract.js";
import { recognizeLocalImage } from "../../src/pdf/ocr";

vi.mock("tesseract.js", () => ({ createWorker: vi.fn() }));
afterEach(() => vi.resetAllMocks());

const result = { data: { text: "Scanned paper text", tsv: "" } };
const worker = () => ({ recognize: vi.fn().mockResolvedValue(result), terminate: vi.fn().mockResolvedValue(undefined) });

it("OCR 使用本机资源并显示引擎准备和识别阶段，完成后释放 worker", async () => {
  const instance = worker();
  vi.mocked(createWorker).mockResolvedValue(instance as never);
  const onStage = vi.fn();
  expect(await recognizeLocalImage("data:image/png;base64,fixture", { onStage })).toEqual(result);
  expect(createWorker).toHaveBeenCalledWith("eng", 1, expect.objectContaining({
    workerBlobURL: false, cacheMethod: "none",
    workerPath: expect.stringMatching(/\/ocr\/worker\.min\.js$/),
    corePath: expect.stringMatching(/\/ocr\/tesseract-core-lstm\.wasm\.js$/),
    langPath: expect.stringMatching(/\/ocr\/$/),
  }));
  expect(onStage.mock.calls.map(([stage]) => stage)).toEqual(["loading", "recognizing"]);
  expect(instance.terminate).toHaveBeenCalledTimes(1);
});

it("初始化一直不返回时也可以取消，迟到的 worker 被释放", async () => {
  let ready: (instance: unknown) => void = () => {};
  vi.mocked(createWorker).mockImplementation(() => new Promise((resolve) => { ready = resolve as never; }));
  const controller = new AbortController();
  const operation = recognizeLocalImage("image", { signal: controller.signal });
  const rejected = expect(operation).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(createWorker).toHaveBeenCalled());
  controller.abort();
  await rejected;
  const instance = worker(); ready(instance);
  await vi.waitFor(() => expect(instance.terminate).toHaveBeenCalledTimes(1));
  expect(instance.recognize).not.toHaveBeenCalled();
});

it("识别卡住时取消能释放 worker，重试仍可成功", async () => {
  const instance = worker(); instance.recognize.mockImplementationOnce(() => new Promise(() => {}));
  vi.mocked(createWorker).mockResolvedValue(instance as never);
  const controller = new AbortController();
  const operation = recognizeLocalImage("image", { signal: controller.signal });
  const rejected = expect(operation).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(instance.recognize).toHaveBeenCalled());
  controller.abort(); await rejected;
  expect(instance.terminate).toHaveBeenCalledTimes(1);
  expect(await recognizeLocalImage("image")).toEqual(result);
});

it("语言资源初始化失败时返回可操作错误，不无限等待", async () => {
  vi.mocked(createWorker).mockImplementation((_language, _mode, options) => {
    queueMicrotask(() => options?.errorHandler?.("language failed"));
    return new Promise(() => {});
  });
  await expect(recognizeLocalImage("image")).rejects.toThrow("识别资源加载失败");
});

it("识别超时会释放 worker 并提示重试", async () => {
  const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(AbortSignal.abort(new DOMException("timeout", "TimeoutError")));
  try { await expect(recognizeLocalImage("image")).rejects.toThrow("2 分钟"); }
  finally { spy.mockRestore(); }
});
