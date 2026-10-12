import { expect, it, vi } from "vitest";
import { translatePageBlocks } from "../../src/pdf/translatePage";
import { textCompareBlocks, type CompareBlock } from "../../src/pdf/translation";

const blocks = (count: number) => Array.from({ length: count }, (_, index): CompareBlock => ({ source: `Passage ${index}`, kind: "paragraph", column: 0, continuation: false, leadIn: false, status: "idle", translation: "" }));
const output = { translation: "译文", model: "step-5-preview", generatedAt: "2026-10-11T10:00:00Z" };

it("已保存 OCR 文本可以直接分段翻译，不要求 MinerU", () => {
  const result = textCompareBlocks({ source: "ocr", text: "Scanned paper. ".repeat(200), layout: null });
  expect(result.columns).toBe(1);
  expect(result.blocks.length).toBeGreaterThan(1);
  expect(result.blocks.every((block) => block.source.length <= 1_460 && block.status === "idle")).toBe(true);
  expect(result.blocks.map((block) => block.source).join(" ")).toBe("Scanned paper. ".repeat(200).trim());
});

it("请求最多三项并行，跳过已完成内容和原图，保留模型与时间", async () => {
  let active = 0; let maximum = 0;
  const translate = vi.fn(async () => {
    active++; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 1)); active--; return output;
  });
  const input = blocks(8); input[0] = { ...input[0], static: true, status: "done" }; input[1] = { ...input[1], status: "done", ...output };
  const result = await translatePageBlocks(input, { signal: new AbortController().signal, translate });
  expect(maximum).toBe(3);
  expect(translate).toHaveBeenCalledTimes(6);
  expect(result.blocks[2]).toMatchObject({ status: "done", ...output });
  expect(input[2].status).toBe("idle");
});

it("连续失败时停止后续请求，保留已完成译文及明确的错误", async () => {
  const translate = vi.fn().mockResolvedValueOnce(output).mockRejectedValue(new Error("HTTP 429：额度不足"));
  const result = await translatePageBlocks(blocks(20), { signal: new AbortController().signal, translate });
  expect(result.error).toContain("额度不足");
  expect(result.blocks[0].status).toBe("done");
  expect(translate.mock.calls.length).toBeLessThan(20);
});

it("取消后保留已完成译文，不留下永久 pending 状态", async () => {
  const controller = new AbortController();
  const result = await translatePageBlocks(blocks(5), { signal: controller.signal, translate: async () => output, onBlock: (index, block) => {
    if (index === 0 && block.status === "done") controller.abort();
  } });
  expect(result.blocks[0].status).toBe("done");
  expect(result.blocks.some((block) => block.status === "pending")).toBe(false);
});
