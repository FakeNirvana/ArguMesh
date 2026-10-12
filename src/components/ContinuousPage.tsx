import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { PdfPage, type PdfHighlight, type SelectionPayload } from "./PdfPage";

/** Keep page boundaries mounted, but only render costly canvases near the viewport. */
export function ContinuousPage({ page, activePage, width, height, scale, stage, children }: {
  page: number; activePage: number; width: number; height: number; scale: number;
  stage: RefObject<HTMLDivElement | null>; children: (visible: boolean) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(Math.abs(page - activePage) <= 1);
  const [measured, setMeasured] = useState<{ height: number; scale: number } | null>(null);
  const visible = near || page === activePage;
  useEffect(() => {
    const node = ref.current;
    if (!node || !stage.current || typeof IntersectionObserver === "undefined") {
      setNear(Math.abs(page - activePage) <= 1);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { root: stage.current, rootMargin: "900px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [stage, page, activePage]);
  useEffect(() => {
    if (!visible || !contentRef.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.height > 0) setMeasured({ height: entry.contentRect.height, scale });
    });
    observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [visible, scale]);
  const retainedHeight = Math.max(height, measured ? measured.height * scale / measured.scale : height);
  return <div ref={ref} className="continuous-reader-page" data-reader-page={page} style={{ width, minHeight: retainedHeight }}>
    <div ref={contentRef}>{children(visible)}</div>
    {!visible ? <span className="reader-page-placeholder">第 {page} 页</span> : null}
  </div>;
}

export function ContinuousPdfPage({ document, pageNumber, activePage, visible, scale, highlights, onSelect, onHighlightClick }: {
  document: PDFDocumentProxy; pageNumber: number; activePage?: PDFPageProxy | null; visible: boolean; scale: number;
  highlights: PdfHighlight[]; onSelect: (payload: SelectionPayload) => void; onHighlightClick: (id: string) => void;
}) {
  const [page, setPage] = useState<PDFPageProxy | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!visible) return;
    if (activePage?.pageNumber === pageNumber) { setPage(activePage); return; }
    let cancelled = false;
    void document.getPage(pageNumber).then((loaded) => { if (!cancelled) { setPage(loaded); setError(""); } })
      .catch(() => { if (!cancelled) setError("本页加载失败，请重新打开 PDF。"); });
    return () => { cancelled = true; };
  }, [document, pageNumber, visible, activePage]);
  if (!visible) return null;
  return page ? <PdfPage page={page} scale={scale} highlights={highlights} onSelect={onSelect} onHighlightClick={onHighlightClick} />
    : <p role="status">{error || `正在加载第 ${pageNumber} 页…`}</p>;
}
