export interface PageScrollPosition { page: number; progress: number }

function pageTop(stage: HTMLElement, page: HTMLElement): number {
  return page.getBoundingClientRect().top - stage.getBoundingClientRect().top + stage.scrollTop;
}

/** Use page boundaries, not total document height: translated pages can be taller. */
export function readPageScroll(stage: HTMLElement, offset = 0): PageScrollPosition {
  const pages = Array.from(stage.querySelectorAll<HTMLElement>("[data-reader-page]"));
  const point = stage.scrollTop + offset;
  let index = pages.findIndex((page, i) => point < (pages[i + 1] ? pageTop(stage, pages[i + 1]) : Infinity));
  if (index < 0) index = 0;
  const page = pages[index];
  if (!page) return { page: 1, progress: 0 };
  const top = pageTop(stage, page);
  const end = pages[index + 1] ? pageTop(stage, pages[index + 1]) : top + page.getBoundingClientRect().height;
  return { page: Number(page.dataset.readerPage), progress: Math.max(0, Math.min(1, (point - top) / Math.max(1, end - top))) };
}

export function pageScrollTop(stage: HTMLElement, position: PageScrollPosition): number {
  const page = stage.querySelector<HTMLElement>(`[data-reader-page="${position.page}"]`);
  if (!page) return stage.scrollTop;
  const next = stage.querySelector<HTMLElement>(`[data-reader-page="${position.page + 1}"]`);
  const top = pageTop(stage, page);
  const end = next ? pageTop(stage, next) : top + page.getBoundingClientRect().height;
  return Math.max(0, top + (end - top) * position.progress);
}
