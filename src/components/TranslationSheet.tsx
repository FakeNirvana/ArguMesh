import { useEffect, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { LoadingState } from "./states";
import { readTranslationPage, type TranslationPageData } from "../pdf/translationPage";
import { translationBands, type CompareBlock } from "../pdf/translation";

export function TranslationSheet({ data, pageNumber, width, height, scale, onAnnotate, onRetry }: {
  data: TranslationPageData; pageNumber: number; width: number; height: number; scale: number;
  onAnnotate: (source: string, page: number) => void; onRetry?: (index: number) => void;
}) {
  const compareEntries = data.blocks.map((block, index) => ({ block, index }));
  const renderTranslation = (block: CompareBlock) => {
    const visible = block.translation.replace(/<\/?(?:sup|sub|em|strong|i|b)>/gi, "");
    const lead = block.leadIn ? /^(.+?[。.!?])([\s\S]*)$/.exec(visible) : null;
    return lead ? <><strong>{lead[1]}</strong>{lead[2]}</> : visible;
  };
  const renderBlockContent = (block: CompareBlock, index: number) => <>
    {block.status === "done" ? block.static ? renderTranslation(block) : <button type="button" title={`来源：第 ${pageNumber} 页 · ${block.model ?? "AI"}${block.generatedAt ? ` · ${new Date(block.generatedAt).toLocaleString()}` : ""}\n${block.source}\n点击查看原文并记笔记`} onClick={() => onAnnotate(block.source, pageNumber)}>{renderTranslation(block)}</button> : null}
    {block.status === "pending" || block.status === "idle" ? <p title={block.status === "pending" ? "正在翻译此段" : "此段尚未翻译"}>{block.source}</p> : null}
    {block.status === "error" ? <p>{block.error || "翻译失败"}{onRetry ? <button type="button" onClick={() => onRetry(index)}>重试</button> : null}</p> : null}
  </>;
  const renderCompareEntry = ({ block, index }: typeof compareEntries[number]) => <div
    className={block.static && block.kind !== "table-cell" ? "translation-visual" : "translation-paragraph"}
    data-status={block.status}
    data-kind={block.kind}
    data-continuation={block.continuation}
    data-title={index === 0 && block.kind === "heading" && pageNumber === 1}
    data-frontmatter={pageNumber === 1 && block.column === "full" && (block.bbox?.[1] ?? 1000) < 260}
    key={index}
  >
    {block.static && block.kind !== "table-cell" ? <>
      {block.image ? <img src={block.image} alt={block.kind === "formula" ? "原文公式" : block.kind === "table" ? "原文表格（数据与标签保留原貌）" : "原文图片"} />
        : block.kind === "formula" ? <span className="translation-formula-source">{block.translation}</span>
          : <small>原图无法提取，请查看左侧 PDF。</small>}
    </> : renderBlockContent(block, index)}
  </div>;
  const renderCompareList = (entries: typeof compareEntries) => {
    const shownTables = new Set<number>();
    return entries.map((entry) => {
      const id = entry.block.tableId;
      if (id === undefined) return renderCompareEntry(entry);
      if (shownTables.has(id)) return null;
      shownTables.add(id);
      const tableEntries = entries.filter(({ block }) => block.tableId === id);
      const caption = tableEntries.find(({ block }) => block.kind === "table-caption");
      const cells = tableEntries.filter(({ block }) => block.kind === "table-cell");
      const rowNumbers = [...new Set(cells.map(({ block }) => block.row ?? 0))].sort((a, b) => a - b);
      return <figure className="translation-table" key={`table-${id}`}>
        {caption ? <figcaption>{renderBlockContent(caption.block, caption.index)}</figcaption> : null}
        {cells.length ? <div className="translation-table-scroll"><table><tbody>{rowNumbers.map((row) => <tr key={row}>
          {cells.filter(({ block }) => block.row === row).map(({ block, index }) => {
            const Cell = row === 0 ? "th" : "td";
            return <Cell key={index} rowSpan={block.rowSpan} colSpan={block.colSpan}>
              {renderBlockContent(block, index)}
            </Cell>;
          })}
        </tr>)}</tbody></table></div> : <p>表格结构无法识别，请查看左侧原文。</p>}
      </figure>;
    });
  };

  return <div className="translation-sheet" lang={data.language === "中文" ? "zh-CN" : "en"} style={{ width, minHeight: height, fontSize: 10.5 * scale }}>
              <div className="translation-flow" data-columns={data.columns}>
                {translationBands(compareEntries, data.columns).map((band, index) => <div className="translation-band" key={index}>
                  {renderCompareList(band.full)}
                  {band.left.length || band.right.length ? <div className="translation-columns">
                    <div>{renderCompareList(band.left)}</div>
                    <div>{renderCompareList(band.right)}</div>
                  </div> : null}
                </div>)}
              </div>
              <footer className="translation-sheet-footer"><span className="translation-draft-label">AI 译文草稿</span><span>原文第 {pageNumber} 页 · {data.parser === "mineru" ? "本机版面解析" : data.source === "ocr" ? "OCR 近似版面" : "文字预览"} · {data.blocks.find((block) => !block.static && block.model)?.model ?? data.language}</span></footer>
            </div>;

}

/** Scrolling only reads local text and existing caches; it never starts AI translation. */
export function ContinuousTranslationPage({ document, paperId, pageNumber, visible, active, revision, width, height, scale, onAnnotate, onRetry, empty }: {
  document: PDFDocumentProxy; paperId: string; pageNumber: number; visible: boolean;
  active?: TranslationPageData; revision: string; width: number; height: number; scale: number;
  onAnnotate: (source: string, page: number) => void; onRetry?: (index: number) => void; empty?: React.ReactNode;
}) {
  const [cached, setCached] = useState<TranslationPageData>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (active) setCached(active);
  }, [active]);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    void document.getPage(pageNumber).then((page) => readTranslationPage(page, paperId))
      .then((data) => { if (!cancelled) { setCached(data); setError(""); } })
      .catch(() => { if (!cancelled) setError("本页文字读取失败，请重新打开 PDF 或 OCR 本页。"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [document, paperId, pageNumber, visible, revision]);
  if (!visible) return null;
  const data = active ?? cached;
  if (data?.blocks.length) return <TranslationSheet data={data} pageNumber={pageNumber} width={width} height={height} scale={scale} onAnnotate={onAnnotate} onRetry={onRetry} />;
  return <div className="translation-sheet translation-page-empty" style={{ width, minHeight: height }}>
    {loading ? <LoadingState title={`正在读取第 ${pageNumber} 页`} /> : error ? <p role="status">{error}</p> : empty ?? <p>第 {pageNumber} 页没有可翻译的文字，扫描页请先 OCR 本页。</p>}
    <span>原文第 {pageNumber} 页</span>
  </div>;
}
