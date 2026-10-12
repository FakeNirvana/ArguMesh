import type { CompareBlock } from "./translation";

type Translation = { translation: string; model: string; generatedAt: string };

/** Three bounded passage requests; completed passages survive failures and cancellation. */
export async function translatePageBlocks(blocks: CompareBlock[], options: {
  signal: AbortSignal;
  translate: (block: CompareBlock) => Promise<Translation>;
  onBlock?: (index: number, block: CompareBlock) => void;
}) {
  const restored = blocks.map((block) => ({ ...block }));
  const pending = restored.map((block, index) => ({ block, index })).filter(({ block }) => !block.static && block.status !== "done").map(({ index }) => index);
  let cursor = 0;
  let failures = 0;
  let stopped = false;
  let error = "";
  const patch = (index: number, update: Partial<CompareBlock>) => {
    restored[index] = { ...restored[index], ...update };
    options.onBlock?.(index, restored[index]);
  };
  const worker = async () => {
    while (!stopped && !options.signal.aborted && cursor < pending.length) {
      const index = pending[cursor++];
      patch(index, { status: "pending", error: "" });
      try {
        const result = await options.translate(restored[index]);
        if (options.signal.aborted) return;
        patch(index, { status: "done", ...result });
        failures = 0;
      } catch (failure) {
        if (options.signal.aborted) return;
        const message = failure instanceof Error ? failure.message : "翻译失败";
        error ||= message;
        patch(index, { status: "error", error: message });
        if (++failures >= 2) stopped = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, pending.length) }, worker));
  for (const index of pending) {
    if (restored[index].status === "pending") patch(index, { status: "idle" });
  }
  return { blocks: restored, error };
}
