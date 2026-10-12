import { describe, expect, it } from "vitest";
import { structuredCompareBlocks, translationBands } from "../../src/pdf/translation";
import type { ParsedPage } from "../../server/services/mineru";

describe("paper translation layout", () => {
  it("translates captions while keeping table data and diagram labels in the source pixels", () => {
    const page: ParsedPage = { parser: "MinerU", columns: 2, blocks: [
      { kind: "table", column: "full", text: "Table 1: Results", image: "data:image/png;base64,table", html: "<table><tr><td>85.3%</td></tr></table>" },
      { kind: "image", column: 1, text: "Figure 1: Framework", image: "data:image/png;base64,figure" },
      { kind: "formula", column: 0, text: "E=mc^2", image: "data:image/png;base64,equation" },
    ] };
    const blocks = structuredCompareBlocks(page);
    expect(blocks.filter((block) => !block.static).map((block) => block.source))
      .toEqual(["Table 1: Results", "Figure 1: Framework"]);
    expect(blocks.filter((block) => block.static).map((block) => block.image))
      .toEqual(page.blocks.map((block) => block.image));
    expect(blocks.filter((block) => block.static).every((block) => block.status === "done")).toBe(true);
    expect(blocks.map((block) => block.kind)).toEqual(["table", "caption", "image", "caption", "formula"]);
  });

  it("retains merged table cells without sending labels or numeric values to AI when pixels are missing", () => {
    const blocks = structuredCompareBlocks({ parser: "MinerU", columns: 1, blocks: [
      { kind: "table", column: "full", text: "Table 1: Comparison", html: '<table><tr><td rowspan="2">Model 1</td><td>85.3%</td></tr><tr><td>1,054.7</td></tr></table>' },
    ] });
    expect(blocks.filter((block) => !block.static).map((block) => block.source)).toEqual(["Table 1: Comparison"]);
    expect(blocks[0]).toMatchObject({ source: "Model 1", rowSpan: 2, static: true });
    expect(blocks.filter((block) => block.kind === "table-cell").map((block) => block.translation)).toEqual(["Model 1", "85.3%", "1,054.7"]);
  });

  it("places a spanning figure between column sections despite column-major extraction order", () => {
    const blocks = structuredCompareBlocks({ parser: "MinerU", columns: 2, blocks: [
      { kind: "paragraph", column: 0, text: "Upper left", bbox: [100, 100, 450, 200] },
      { kind: "paragraph", column: 0, text: "Lower left", bbox: [100, 600, 450, 750] },
      { kind: "image", column: "full", text: "Figure 1: Middle", bbox: [100, 300, 900, 500], image: "pixels" },
      { kind: "paragraph", column: 1, text: "Upper right", bbox: [550, 100, 900, 200] },
      { kind: "paragraph", column: 1, text: "Lower right", bbox: [550, 600, 900, 750] },
    ] });
    const bands = translationBands(blocks.map((block, index) => ({ block, index })), 2);
    expect(bands).toHaveLength(2);
    expect(bands[0].left[0].block.source).toBe("Upper left");
    expect(bands[0].right[0].block.source).toBe("Upper right");
    expect(bands[1].full.map(({ block }) => block.kind)).toEqual(["image", "caption"]);
    expect(bands[1].left[0].block.source).toBe("Lower left");
    expect(bands[1].right[0].block.source).toBe("Lower right");
    expect(bands[1].left[0].index).toBe(1); // UI retries still address the original translation index.
  });

  it("keeps single-column pages in their original reading order", () => {
    const blocks = structuredCompareBlocks({ parser: "MinerU", columns: 1, blocks: [
      { kind: "paragraph", column: 0, text: "Before figure" },
      { kind: "image", column: "full", text: "Figure caption", image: "pixels" },
      { kind: "paragraph", column: 0, text: "After figure" },
    ] });
    expect(translationBands(blocks.map((block, index) => ({ block, index })), 1)[0].full.map(({ index }) => index)).toEqual([0, 1, 2, 3]);
  });
});
