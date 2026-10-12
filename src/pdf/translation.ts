import type { ParsedPage, ParsedPageBlock } from "../../server/services/mineru";
import { splitPageIntoBlocks } from "./blocks";
import { parseStructuredTable } from "./structured";
import type { CurrentPageText } from "./document";

export interface CompareBlock {
  source: string;
  kind: "heading" | "paragraph" | "caption" | "table-caption" | "table-cell" | "image" | "table" | "formula";
  column: "full" | 0 | 1;
  bbox?: ParsedPageBlock["bbox"];
  continuation: boolean;
  leadIn: boolean;
  status: "idle" | "pending" | "done" | "error";
  translation: string;
  model?: string;
  generatedAt?: string;
  error?: string;
  tableId?: number;
  row?: number;
  col?: number;
  rowSpan?: number;
  colSpan?: number;
  image?: string;
  static?: boolean;
}

/** Native text and saved OCR remain translatable when precise layout parsing is unavailable. */
export function textCompareBlocks(current: CurrentPageText): { blocks: CompareBlock[]; columns: 1 | 2 } {
  const paragraphs = current.layout?.blocks ?? [{ text: current.text, kind: "paragraph" as const, column: 0 as const, leadIn: false }];
  return { columns: current.layout?.columns ?? 1, blocks: paragraphs.flatMap((paragraph) => splitPageIntoBlocks(paragraph.text, 1_400)
    .map((source, index) => ({ source, kind: paragraph.kind, column: paragraph.column, continuation: index > 0, leadIn: paragraph.leadIn && index === 0, status: "idle" as const, translation: "" }))) };
}

/** Translate prose and captions; figures, tables and equations keep their source appearance. */
export function structuredCompareBlocks(parsed: ParsedPage): CompareBlock[] {
  const blocks: CompareBlock[] = [];
  parsed.blocks.forEach((block, id) => {
    const add = (source: string, kind: CompareBlock["kind"], extra: Partial<CompareBlock> = {}) => {
      blocks.push({ source, kind, column: block.column, bbox: block.bbox, continuation: false,
        leadIn: false, status: "idle", translation: "", ...extra });
    };
    if (block.kind === "table" || block.kind === "image" || block.kind === "formula") {
      if (block.kind === "table" && !block.image && block.html) {
        // Legacy/partial parser results: preserve original cells without trusting PDF HTML.
        parseStructuredTable(block.html).forEach((row, rowIndex) => row.forEach((cell, col) =>
          add(cell.text, "table-cell", { tableId: id, row: rowIndex, col, rowSpan: cell.rowSpan,
            colSpan: cell.colSpan, status: "done", translation: cell.text, static: true, model: "原文表格" })));
      } else {
        add(`${block.kind}:${block.imageHash ?? id}`, block.kind, { image: block.image,
          status: "done", translation: block.kind === "formula" ? block.text : "",
          model: "原文", static: true });
      }
      if (block.kind !== "formula" && block.text) {
        splitPageIntoBlocks(block.text, 1_400).forEach((source, index) =>
          add(source, "caption", { continuation: index > 0 }));
      }
      return;
    }
    splitPageIntoBlocks(block.text, 1_400).forEach((source, index) =>
      add(source, block.kind, { continuation: index > 0 }));
  });
  return blocks;
}

export interface TranslationEntry { block: CompareBlock; index: number }
export interface TranslationBand { full: TranslationEntry[]; left: TranslationEntry[]; right: TranslationEntry[] }

/** Full-width blocks divide the page into vertical bands, rather than all moving to the top. */
export function translationBands(entries: TranslationEntry[], columns: 1 | 2): TranslationBand[] {
  if (columns === 1) return [{ full: entries, left: [], right: [] }];
  const bands: TranslationBand[] = [];
  let band: TranslationBand = { full: [], left: [], right: [] };
  // Geometry sorts column-major parser output around spanning tables/figures.
  const positioned = entries.every(({ block }) => block.bbox);
  const ordered = positioned ? [...entries].sort((a, b) => a.block.bbox![1] - b.block.bbox![1] || a.index - b.index) : entries;
  for (const entry of ordered) {
    if (entry.block.column === "full") {
      if (band.left.length || band.right.length) {
        bands.push(band);
        band = { full: [], left: [], right: [] };
      }
      band.full.push(entry);
    } else {
      (entry.block.column === 0 ? band.left : band.right).push(entry);
    }
  }
  if (band.full.length || band.left.length || band.right.length) bands.push(band);
  return bands;
}
