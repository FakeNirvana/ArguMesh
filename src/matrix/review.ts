import type { EvidenceCell, MatrixResponse } from "../api";

/** Batch review leaves incomplete, conflicting, confirmed and locked cells untouched. */
export function canBatchConfirm(cell: Pick<EvidenceCell, "status" | "locked" | "value" | "claim" | "sourcePage" | "sourceExcerpt">): boolean {
  return cell.status === "draft" && !cell.locked && Boolean(cell.claim.trim() && cell.sourceExcerpt.trim())
    && Boolean(cell.value.trim()) && !/^(待提取|待提取证据|未找到|—|-)$/.test(cell.value.trim())
    && Boolean(cell.sourcePage.trim()) && !/^(—|-|待定位|待提取|未找到|未知)$/.test(cell.sourcePage.trim());
}

export function matrixReviewEntries(data: MatrixResponse, paperId?: string) {
  return data.papers.filter((paper) => !paperId || paper.id === paperId).flatMap((paper) =>
    data.groups.flatMap((group) => group.rows.flatMap((row) => {
      const key = `${row.id}:${paper.id}`;
      const cell = data.cells[key];
      return cell ? [{ key, cell }] : [];
    })));
}

/** Source labels are PDF page numbers, not printed journal pagination. */
export function evidencePageNumber(label: string): number | null {
  const match = label.trim().match(/^(?:第\s*|p(?:age)?\.?\s*)?(\d+)(?:\s*(?:页|pages?)|\s*[-–—,，、]\s*\d+)?$/i);
  const value = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
