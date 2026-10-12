import type { PDFPageProxy } from "pdfjs-dist";
import { parseReaderPage } from "../api";
import { getPageTranslations } from "../storage/paperFiles";
import { currentPageText } from "./document";
import { structuredCompareBlocks, textCompareBlocks, type CompareBlock } from "./translation";

export interface TranslationPageData {
  blocks: CompareBlock[];
  columns: 1 | 2;
  language: "中文" | "English";
  parser: "layout" | "mineru";
  source: "native" | "ocr" | "empty";
}

export const compareCacheLanguage = (language: "中文" | "English", parser: "layout" | "mineru") => `${language}:${parser === "mineru" ? "mineru-paper-v2" : "layout-v2"}`;
export function validCachedTranslation(translation: string): boolean {
  return !(/"targetLanguage"\s*:/.test(translation) && /"paperTitle"\s*:/.test(translation));
}
export function targetLanguageFor(text: string): "中文" | "English" {
  return /[\u4e00-\u9fff]/.test(text) ? "English" : "中文";
}

/** Cache-only layout lookup; no document upload, parsing job or AI request on scroll. */
export async function readTranslationPage(page: PDFPageProxy, paperId: string): Promise<TranslationPageData> {
  const current = await currentPageText(page, paperId);
  const parsed = await parseReaderPage(paperId, page.pageNumber, true).catch(() => null);
  const parser = parsed ? "mineru" : "layout";
  const content = parsed ? structuredCompareBlocks(parsed) : current.text ? textCompareBlocks(current).blocks : [];
  const language = targetLanguageFor(parsed ? parsed.blocks.filter((block) => block.kind === "paragraph" || block.kind === "heading").map((block) => block.text).join(" ") : current.text);
  const saved = await getPageTranslations(paperId, page.pageNumber, compareCacheLanguage(language, parser));
  const blocks = content.map((block, index) => {
    if (block.static) return block;
    const hit = saved?.blocks.find((entry) => entry.index === index && entry.source === block.source);
    return hit && validCachedTranslation(hit.translation) ? { ...block, status: "done" as const, translation: hit.translation, model: hit.model, generatedAt: hit.generatedAt } : block;
  });
  return { blocks, columns: parsed?.columns ?? current.layout?.columns ?? 1, language, parser, source: current.source };
}
