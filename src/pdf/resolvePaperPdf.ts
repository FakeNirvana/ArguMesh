import { downloadPaperFile } from "../api";
import { getPaperPdf, savePaperPdf } from "../storage/paperFiles";

/** 本地数据库为准；浏览器副本仅用于兼容尚未入库的旧附件。 */
export async function resolvePaperPdf(paperId: string, fileName?: string): Promise<Blob | null> {
  const stored = await downloadPaperFile(paperId);
  if (!stored) return getPaperPdf(paperId).catch(() => null);
  // 更换 PDF 后缓存可能仍是旧版本，缓存失败也必须使用数据库中的原件。
  await savePaperPdf(paperId, new File([stored], fileName ?? `${paperId}.pdf`, { type: "application/pdf" })).catch(() => {});
  return stored;
}
