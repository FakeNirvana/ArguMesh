import { describe, expect, it } from "vitest";
import { pageScrollTop, readPageScroll } from "../../src/pdf/scroll";

function stage(heights: number[]) {
  const root = document.createElement("div");
  root.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
  let top = 18;
  for (const [index, height] of heights.entries()) {
    const page = document.createElement("div");
    page.dataset.readerPage = String(index + 1);
    const offset = top;
    page.getBoundingClientRect = () => ({ top: 100 + offset - root.scrollTop, height }) as DOMRect;
    root.append(page);
    top += height + 24;
  }
  return root;
}

describe("continuous reader page alignment", () => {
  it("links the same page and progress even when translated pages have different heights", () => {
    const original = stage([800, 800, 800]);
    const translated = stage([1200, 1000, 1800]);
    original.scrollTop = 18 + 824 + 412;
    const position = readPageScroll(original);
    expect(position).toEqual({ page: 2, progress: .5 });
    translated.scrollTop = pageScrollTop(translated, position);
    expect(translated.scrollTop).toBe(18 + 1224 + 512);
    expect(readPageScroll(translated)).toEqual(position);
  });

  it("handles page gaps, first/last boundaries and the active-page viewport offset", () => {
    const root = stage([800, 800, 800]);
    expect(readPageScroll(root)).toEqual({ page: 1, progress: 0 });
    root.scrollTop = 830;
    expect(readPageScroll(root).page).toBe(1);
    expect(readPageScroll(root, 40).page).toBe(2);
    root.scrollTop = 4000;
    expect(readPageScroll(root)).toEqual({ page: 3, progress: 1 });
    expect(pageScrollTop(root, { page: 2, progress: 0 })).toBe(842);
  });
});
