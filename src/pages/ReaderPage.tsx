import type { ParserProgress } from "../../server/services/mineru-runtime";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, ArrowsClockwise, BookOpenText, BookmarkSimple, Check, FilePdf, ListBullets, MagnifyingGlass, Minus, NotePencil, Plus, Quotes, Scan, Sparkle, Trash, Translate, UploadSimple, WarningCircle, X } from "@phosphor-icons/react";
import { getDocument, type PDFDocumentProxy, type PDFPageProxy } from "pdfjs-dist";
import { askReader, cancelReaderPageParse, getAiConfig, getAiModels, getReaderPageParseStatus, parseReaderPage, syncPaper, syncProject, translateSelection, uploadPaperFile } from "../api";
import type { ParsedPage } from "../../server/services/mineru";
import type { SelectionPayload } from "../components/PdfPage";
import { ContinuousPage, ContinuousPdfPage } from "../components/ContinuousPage";
import { ContinuousTranslationPage } from "../components/TranslationSheet";
import { pageScrollTop, readPageScroll, type PageScrollPosition } from "../pdf/scroll";
import { compareCacheLanguage, readTranslationPage, targetLanguageFor, validCachedTranslation } from "../pdf/translationPage";
import { PaperCardEditor } from "../components/PaperCardEditor";
import { EmptyState, LoadingState } from "../components/states";
import { pickBubbleAnchor, type PageRect } from "../pdf/selection";
import { getPageTranslations, getPaperPageTexts, getPaperPdf, savePageTranslations, savePaperPdf } from "../storage/paperFiles";
import { useWorkspace } from "../state/workspace";
import { currentPageText, extractPdfText, inspectPdf, recognizePdfPage, sha256File } from "../pdf/document";
import { resolvePaperPdf } from "../pdf/resolvePaperPdf";
import { structuredCompareBlocks, textCompareBlocks, type CompareBlock } from "../pdf/translation";
import { translatePageBlocks } from "../pdf/translatePage";

const MAX_FILE_SIZE = 25 * 1024 * 1024;
// 与 server/routes/reader.ts translateSchema 的 max(8_000) 对齐:超长选区(整页/整段)
// 在前端就给明确提示,不消耗一次 AI 请求,也不让服务端返回文不对题的报错。
const TRANSLATE_MAX_CHARS = 8_000;
// 双语对照:一页同时最多几个段落在飞。固定值,不随页大小变 —— 段已经切到 ~400 字符,
// 单个请求的输出远低于服务端 maxTokens(2000),不会出现静默截断。
const COMPARE_CONCURRENCY = 3;
// 连续失败这么多段就停掉整页:第一段可能是偶发,第二段基本是配置/网络问题。
const COMPARE_MAX_CONSECUTIVE_FAILURES = 2;

interface DocumentTranslationJob {
  stage: "parsing" | "translating" | "cancelling" | "done" | "cancelled" | "error";
  page: number;
  completedPages: number;
  totalPages: number;
  completedBlocks: number;
  totalBlocks: number;
  model: string;
  error?: string;
  notice?: string;
}


async function parseDocumentPageWithRetry(paperId: string, page: number, signal: AbortSignal): Promise<ParsedPage> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await parseReaderPage(paperId, page, false, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const transient = /服务器未返回内容|Failed to fetch|fetch failed/i.test(message);
      if (signal.aborted || !transient || attempt >= 2) throw error;
      await new Promise((resolve) => window.setTimeout(resolve, 800 * (attempt + 1)));
      if (signal.aborted) throw error;
    }
  }
}

export function ReaderPage() {
  const { projectId = "", paperId = "" } = useParams<{ projectId: string; paperId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { projects, papers, readerAnswers, readerExcerpts, readerPositions, settings, setPaperFile, updatePaper, addReaderAnswer, addReaderExcerpt, addKnowledge, updateReaderExcerpt, deleteReaderExcerpt, setReaderPosition } = useWorkspace();
  const project = projects.find((item) => item.id === projectId);
  const paper = papers.find((item) => item.id === paperId && item.projectIds.includes(projectId));
  const libraryPath = project ? `/projects/${encodeURIComponent(project.id)}/library` : "/library";
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [pageSize, setPageSize] = useState({ width: 595, height: 842 });
  const restoredDocumentRef = useRef<PDFDocumentProxy | null>(null);
  const [pdfPage, setPdfPage] = useState<PDFPageProxy | null>(null);
  const savedPosition = readerPositions.find((item) => item.projectId === projectId && item.paperId === paperId);
  const requestedPage = Number(searchParams.get("page"));
  const [pageNumber, setPageNumber] = useState(Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : savedPosition?.page ?? 1);
  const [scale, setScale] = useState(savedPosition?.scale ?? 1.15);
  const [selection, setSelection] = useState("");
  // 划词气泡:rects 是与缩放无关的 PDF 页面单位矩形(用于在原文上重绘高亮),
  // selectionPage 记下这批矩形属于哪一页,翻页后存量的矩形不再复用。
  const [selectionRects, setSelectionRects] = useState<PageRect[]>([]);
  const [selectionPage, setSelectionPage] = useState(0);
  const selectedPage = selectionPage || pageNumber;
  const [bubbleAnchor, setBubbleAnchor] = useState<{ top: number; left: number; placement: "above" | "below" } | null>(null);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [model, setModel] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<Array<{ page: number; excerpt: string }>>([]);
  const [excerptNote, setExcerptNote] = useState("");
  const [savedMessage, setSavedMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [asking, setAsking] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [translation, setTranslation] = useState("");
  // 同一句译过一次就不再打 AI:划词连点/反复选中同一句时零成本。
  const translationCache = useRef(new Map<string, { translation: string; model: string; generatedAt: string }>());
  const [ocrProgress, setOcrProgress] = useState<number | null>(null);
  const [ocrStage, setOcrStage] = useState<"rendering" | "loading" | "recognizing">("rendering");
  const ocrRunRef = useRef<AbortController | null>(null);
  const pageRunRef = useRef<AbortController | null>(null);
  const [pageTranslationActive, setPageTranslationActive] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [editingExcerptId, setEditingExcerptId] = useState("");
  const [error, setError] = useState("");
  // 进入阅读器即展示原文 PDF 与同页译文，批注问答仍可从右栏切回。
  const [readerTab, setReaderTab] = useState<"notes" | "compare" | "card">(searchParams.get("panel") === "card" ? "card" : "compare");
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareSource, setCompareSource] = useState<"native" | "ocr" | "empty">("empty");
  const [compareLanguage, setCompareLanguage] = useState<"中文" | "English">("中文");
  const [compareBlocks, setCompareBlocks] = useState<CompareBlock[]>([]);
  const [compareColumns, setCompareColumns] = useState<1 | 2>(1);
  const [compareParser, setCompareParser] = useState<"layout" | "mineru">("layout");
  const [linkedScroll, setLinkedScroll] = useState(true);
  const [documentJob, setDocumentJob] = useState<DocumentTranslationJob | null>(null);
  const [parserProgress, setParserProgress] = useState<ParserProgress | null>(null);
  const parsingPage = documentJob?.stage === "parsing" ? documentJob.page : null;
  useEffect(() => {
    setParserProgress(null);
    if (parsingPage === null) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const status = await getReaderPageParseStatus(paperId, parsingPage, controller.signal);
        if (!controller.signal.aborted) setParserProgress(status.progress);
      } catch { /* A failed status poll must not interrupt the running parse. */ }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 1500);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [paperId, parsingPage]);

  const documentRunRef = useRef<AbortController | null>(null);
  const documentParsingPageRef = useRef<number | null>(null);
  const pageNumberRef = useRef(pageNumber);
  pageNumberRef.current = pageNumber;
  const [documentRefreshNonce, setDocumentRefreshNonce] = useState(0);
  const [comparePhase, setComparePhase] = useState<"idle" | "working" | "done" | "error">("idle");
  const [compareError, setCompareError] = useState("");
  // OCR 完成后对照面板要重新读一次本页文本 → 用 nonce 触发上面那个 effect 重跑。
  const [ocrNonce, setOcrNonce] = useState(0);
  // 轮次令牌:翻页 / 取消 / 重译都换一个新值,回填前比对,不一致就丢弃在途结果。
  // 比布尔标志稳 —— "翻走又翻回来"叠加在途请求时不会把上一页的译文写进这一页。
  const compareRunId = useRef(0);
  // 并发的唯一真相源:三个 worker 同时回填,若从渲染闭包里的 compareBlocks 推导会互相覆盖。
  const compareBlocksRef = useRef<CompareBlock[]>([]);
  // 这些块属于哪一页 / 哪种目标语言。落盘必须按"块所属的那一页"写 ——
  // 翻页后 effect 里的 pageNumber 已经是新页,直接用会把上一页的译文写进新页的键。
  const compareContextRef = useRef<{ page: number; language: "中文" | "English"; parser: "layout" | "mineru" } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const compareStageRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const scrollPositionsRef = useRef(new WeakMap<HTMLDivElement, PageScrollPosition>());
  const pendingZoomRef = useRef<{ original?: PageScrollPosition; translated?: PageScrollPosition } | null>(null);
  function resizePages(nextScale: number) {
    const original = stageRef.current ? readPageScroll(stageRef.current) : undefined;
    pendingZoomRef.current = {
      original,
      translated: readerTab === "compare" && linkedScroll ? original : compareStageRef.current ? readPageScroll(compareStageRef.current) : undefined,
    };
    setScale(nextScale);
  }
  useLayoutEffect(() => {
    const positions = pendingZoomRef.current;
    if (!positions) return;
    pendingZoomRef.current = null;
    if (stageRef.current && positions.original) {
      scrollPositionsRef.current.set(stageRef.current, positions.original);
      stageRef.current.scrollTop = pageScrollTop(stageRef.current, positions.original);
    }
    if (compareStageRef.current && positions.translated) {
      scrollPositionsRef.current.set(compareStageRef.current, positions.translated);
      compareStageRef.current.scrollTop = pageScrollTop(compareStageRef.current, positions.translated);
    }
  }, [scale]);
  const legacyEntryBelongsHere = paper?.projectIds.length === 1 && paper.projectIds[0] === projectId;
  const history = useMemo(() => readerAnswers.filter((item) => item.paperId === paperId && (item.projectId === projectId || (!item.projectId && legacyEntryBelongsHere))), [legacyEntryBelongsHere, paperId, projectId, readerAnswers]);
  const excerpts = useMemo(() => readerExcerpts.filter((item) => item.paperId === paperId && (item.projectId === projectId || (!item.projectId && legacyEntryBelongsHere))), [legacyEntryBelongsHere, paperId, projectId, readerExcerpts]);
  // workspace 方法(updatePaper 等)每次工作区数据变化都会换新 identity,
  // 绝不能进 useCallback/useEffect 依赖:否则 updatePaper → setData → 新方法 →
  // loadBlob 重建 → effect 重跑 → 再 updatePaper → 无限重载 PDF 死循环。
  // 用 ref 桥接,effect 只依赖 paperId。见 ERR-20260814-002。
  const updatePaperRef = useRef(updatePaper);
  updatePaperRef.current = updatePaper;
  const paperRef = useRef(paper);
  paperRef.current = paper;
  const setReaderPositionRef = useRef(setReaderPosition);
  setReaderPositionRef.current = setReaderPosition;

  // 气泡只认"选中时"的视口位置:.pdf-stage 一滚动就失锚,所以滚动/尺寸变化即收起。
  function dismissBubble() { setBubbleAnchor(null); }

  useEffect(() => {
    if (!bubbleAnchor) return;
    const stage = stageRef.current;
    stage?.addEventListener("scroll", dismissBubble, { passive: true });
    window.addEventListener("resize", dismissBubble);
    return () => {
      stage?.removeEventListener("scroll", dismissBubble);
      window.removeEventListener("resize", dismissBubble);
    };
  }, [bubbleAnchor]);

  useEffect(() => {
    if (!bubbleAnchor) return;
    // 点气泡以外任意处 / Esc → 收起。capture 阶段拦截,避免先触发别处的 pointerup。
    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof Node && bubbleRef.current?.contains(event.target)) return;
      setBubbleAnchor(null);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setBubbleAnchor(null);
    }
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [bubbleAnchor]);

  const loadBlob = useCallback(async (blob: Blob) => {
    setLoading(true);
    setError("");
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const loaded = await getDocument({ data: bytes }).promise;
      setDocument(loaded);
      const metadata = await inspectPdf(blob);
      updatePaperRef.current(paperId, { pageCount: metadata.pageCount, outline: metadata.outline, authors: metadata.authors || paperRef.current?.authors });
      setPageNumber((current) => Math.min(Math.max(1, current), loaded.numPages));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "无法解析该 PDF");
    } finally {
      setLoading(false);
    }
  }, [paperId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    async function resolvePdf() {
      try {
        const blob = await resolvePaperPdf(paperId);
        if (cancelled) return;
        if (blob) await loadBlob(blob);
        else setLoading(false);
      } catch (error) {
        if (!cancelled) {
          setError(error instanceof Error ? error.message : "无法读取 PDF");
          setLoading(false);
        }
      }
    }
    void resolvePdf();
    return () => { cancelled = true; };
  }, [loadBlob, paperId]);

  useEffect(() => {
    if (!document) { setPdfPage(null); return; }
    let cancelled = false;
    setLoading(true);
    void document.getPage(pageNumber).then((loadedPage) => {
      if (!cancelled) setPdfPage(loadedPage);
    }).catch((loadError: unknown) => {
      if (!cancelled) setError(loadError instanceof Error ? loadError.message : "页面加载失败");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [document, pageNumber]);

  useEffect(() => () => { if (document) void document.destroy(); }, [document]);

  useEffect(() => () => {
    documentRunRef.current?.abort();
    pageRunRef.current?.abort();
    ocrRunRef.current?.abort();
    const parsingPage = documentParsingPageRef.current;
    if (parsingPage !== null) void cancelReaderPageParse(paperId, parsingPage).catch(() => {});
  }, [paperId]);

  useEffect(() => () => { ocrRunRef.current?.abort(); }, [paperId, pageNumber]);

  useEffect(() => {
    if (!document) return;
    let cancelled = false;
    void document.getPage(1).then((page) => {
      if (!cancelled) { const { width, height } = page.getViewport({ scale: 1 }); setPageSize({ width, height }); }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [document]);

  useEffect(() => {
    if (readerTab === "notes" || !document) return;
    const original = stageRef.current;
    const translated = readerTab === "compare" ? compareStageRef.current : null;
    if (!original || (readerTab === "compare" && !translated)) return;
    let fittedWidth = 0;
    const fit = () => {
      const available = translated ? Math.min(original.clientWidth, translated.clientWidth) - 36 : original.clientWidth - 32;
      // Status wrapping and horizontal scrollbars must not undo the user's zoom.
      if (available > 0 && available !== fittedWidth) {
        fittedWidth = available;
        resizePages(Math.max(.2, Math.min(2.2, available / pageSize.width)));
      }
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(original);
    if (translated) observer.observe(translated);
    return () => observer.disconnect();
  }, [document, pageSize.width, readerTab]);

  function jumpToPage(requested: number) {
    const page = Math.min(document?.numPages ?? 1, Math.max(1, requested));
    setPageNumber(page);
    for (const stage of [stageRef.current, compareStageRef.current]) {
      if (stage) { scrollPositionsRef.current.set(stage, { page, progress: 0 }); stage.scrollTop = pageScrollTop(stage, { page, progress: 0 }); }
    }
    dismissBubble();
  }

  useLayoutEffect(() => {
    if (!document || !pdfPage || restoredDocumentRef.current === document) return;
    restoredDocumentRef.current = document;
    for (const stage of [stageRef.current, compareStageRef.current]) {
      if (stage) { const position = { page: pageNumberRef.current, progress: 0 }; scrollPositionsRef.current.set(stage, position); stage.scrollTop = pageScrollTop(stage, position); }
    }
  }, [document, pdfPage]);

  useEffect(() => {
    if (!document) return;
    const original = stageRef.current;
    const translated = compareStageRef.current;
    if (!original) return;
    const expected = new WeakMap<HTMLElement, { top: number; left: number }>();
    const scroll = (source: HTMLDivElement, target: HTMLDivElement | null) => {
      if (restoredDocumentRef.current !== document) return;
      const pending = expected.get(source);
      if (pending !== undefined) {
        expected.delete(source);
        if (Math.abs(source.scrollTop - pending.top) < 2 && Math.abs(source.scrollLeft - pending.left) < 2) return;
      }
      const position = readPageScroll(source);
      scrollPositionsRef.current.set(source, position);
      // Independent translation scrolling must not change the original's current-page actions.
      if (restoredDocumentRef.current === document && source.clientHeight > 0 && (source === original || linkedScroll)) setPageNumber(readPageScroll(source, source.clientHeight * .2).page);
      if (readerTab !== "compare" || !linkedScroll || !target) return;
      scrollPositionsRef.current.set(target, position);
      const top = Math.min(pageScrollTop(target, position), Math.max(0, target.scrollHeight - target.clientHeight));
      const sourceRange = Math.max(0, source.scrollWidth - source.clientWidth);
      const targetRange = Math.max(0, target.scrollWidth - target.clientWidth);
      const left = sourceRange ? Math.max(0, Math.min(1, source.scrollLeft / sourceRange)) * targetRange : 0;
      expected.set(target, { top, left });
      target.scrollTop = top;
      target.scrollLeft = left;
    };
    const fromOriginal = () => scroll(original, translated);
    const fromTranslated = () => { if (translated) scroll(translated, original); };
    original.addEventListener("scroll", fromOriginal, { passive: true });
    translated?.addEventListener("scroll", fromTranslated, { passive: true });
    if (readerTab === "compare" && linkedScroll && translated) scroll(original, translated);
    // Loading a cached translation may change the height of pages above the viewport.
    // Keep the last page-relative anchor, rather than allowing the browser to drift into a previous page.
    const observer = new ResizeObserver(() => {
      if (restoredDocumentRef.current !== document) return;
      for (const stage of [original, translated]) {
        if (!stage) continue;
        const anchor = scrollPositionsRef.current.get(stage);
        if (!anchor) continue;
        const top = Math.min(pageScrollTop(stage, anchor), Math.max(0, stage.scrollHeight - stage.clientHeight));
        if (Math.abs(stage.scrollTop - top) > 1) { expected.set(stage, { top, left: stage.scrollLeft }); stage.scrollTop = top; }
      }
    });
    for (const stage of [original, translated]) stage?.querySelectorAll("[data-reader-page]").forEach((page) => observer.observe(page));
    return () => {
      observer.disconnect();
      original.removeEventListener("scroll", fromOriginal);
      translated?.removeEventListener("scroll", fromTranslated);
    };
  }, [document, readerTab, linkedScroll]);

  // 双语对照:进入对照 / 翻页 / OCR 后重跑时,取当前页文本 → 切块 → 填缓存。
  // 依赖里刻意不放 workspace 方法(ERR-20260814-002),只放页面身份。
  useEffect(() => {
    // 全文任务与单段重试完成时已立即保存。刷新只读取缓存；旧视图不能回写，
    // 否则原图或部分译文会覆盖全文任务刚保存的完整页。
    // 任何一次新的上下文都作废在途翻译,否则上一页的译文会被回填进这一页。
    compareRunId.current += 1;
    compareBlocksRef.current = [];
    compareContextRef.current = null;
    setCompareBlocks([]);
    setCompareParser("layout");
    setComparePhase("idle");
    setCompareError("");
    if (readerTab !== "compare" || !pdfPage || pdfPage.pageNumber !== pageNumber) return;
    let cancelled = false;
    setCompareLoading(true);
    void (async () => {
      const data = await readTranslationPage(pdfPage, paperId);
      if (cancelled) return;
      compareBlocksRef.current = data.blocks;
      compareContextRef.current = { page: pageNumber, language: data.language, parser: data.parser };
      setCompareBlocks(data.blocks);
      setCompareColumns(data.columns);
      setCompareLanguage(data.language);
      setCompareParser(data.parser);
      setCompareSource(data.source);
      setCompareLoading(false);
    })().catch((failure) => {
      if (cancelled) return;
      setCompareLoading(false);
      setCompareSource("empty");
      setCompareError(failure instanceof Error ? failure.message : "本页文字读取失败，请重试。");
    });
    return () => { cancelled = true; };
  }, [readerTab, pdfPage, pageNumber, ocrNonce, documentRefreshNonce, paperId]);

  useEffect(() => {
    if (!document) return;
    const timer = window.setTimeout(() => setReaderPositionRef.current({ projectId, paperId, page: pageNumber, scale }), 350);
    return () => window.clearTimeout(timer);
  }, [document, pageNumber, paperId, projectId, scale]);

  async function upload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) { setError("请选择 PDF 文件"); return; }
    if (file.size > MAX_FILE_SIZE) { setError("PDF 不能超过 25 MB"); return; }
    cancelDocumentTranslation();
    try {
      const metadata = await inspectPdf(file);
      const hash = await sha256File(file);
      if (project && paper) {
        await syncProject(project);
        await syncPaper(project.id, { ...paper, fileHash: hash });
        await uploadPaperFile(paperId, file);
      }
      // PDF 已入库；浏览器缓存不可用不影响持久化结果。
      await savePaperPdf(paperId, file).catch(() => {});
      setPaperFile(paperId, { name: file.name, size: file.size });
      updatePaper(paperId, { fileHash: hash, pageCount: metadata.pageCount, outline: metadata.outline, authors: metadata.authors || paper?.authors });
      await loadBlob(file);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "PDF 保存失败");
    }
  }

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!paper || question.trim().length < 2 || asking) return;
    setAsking(true); setError(""); setAnswer("");
    try {
      // 无选区时对全文提问:提取论文全文文本(≤15K)随请求发送,后端按全文上下文回答。
      let fullText = "";
      if (selection.trim().length < 10) {
        const blob = await getPaperPdf(paperId);
        if (blob) {
          const pages = await extractPdfText(blob, paperId, { maxPages: 80, maxChars: 15_000 });
          fullText = pages.map((page) => `[第 ${page.page} 页] ${page.text}`).join("\n").slice(0, 15_000);
        }
        if (!fullText) {
          setError("无法读取论文文本，请先上传 PDF 或选择一段原文。");
          return;
        }
      }
      const result = await askReader({
        paper: { id: paper.id, title: paper.title, authors: paper.authors, year: paper.year },
        page: selection.trim().length >= 10 ? selectedPage : pageNumber,
        selection: selection.trim().length >= 10 ? selection : "",
        ...(fullText ? { fullText } : {}),
        question: question.trim(),
      });
      setAnswer(result.answer); setModel(result.model);
      addReaderAnswer({ projectId, paperId: paper.id, page: selection.trim().length >= 10 ? selectedPage : pageNumber, selection, question: question.trim(), answer: result.answer, model: result.model, createdAt: result.generatedAt });
      setQuestion("");
    } catch (askError) {
      setError(askError instanceof Error ? askError.message : "AI 回答失败");
    } finally { setAsking(false); }
  }

  async function searchDocument(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = searchQuery.trim().toLowerCase();
    if (!document || query.length < 2 || searching) return;
    setSearching(true); setSearchResults([]); setError("");
    try {
      const matches: Array<{ page: number; excerpt: string }> = [];
      const ocrPages = await getPaperPageTexts(paperId);
      for (let number = 1; number <= document.numPages && matches.length < 30; number += 1) {
        const sourcePage = await document.getPage(number);
        const content = await sourcePage.getTextContent();
        const nativeText = content.items.map((item) => "str" in item ? item.str : "").join(" ").replace(/\s+/g, " ");
        const text = nativeText.trim().length >= 40 ? nativeText : ocrPages[number] ?? nativeText;
        const index = text.toLowerCase().indexOf(query);
        if (index >= 0) matches.push({ page: number, excerpt: text.slice(Math.max(0, index - 70), index + query.length + 100) });
      }
      setSearchResults(matches);
      if (matches.length === 0) setError("未找到匹配文字；如果这是扫描 PDF，需要先进行 OCR。");
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : "全文搜索失败");
    } finally { setSearching(false); }
  }

  // PDF 选区变化 → 同步侧栏文本框 + 气泡锚点。空选区(在原文区单击)即收起气泡。
  function handleSelect(payload: SelectionPayload, sourcePage = pageNumber) {
    if (payload.text) setPageNumber(sourcePage);
    setSelection(payload.text);
    setSelectionRects(payload.rects);
    setSelectionPage(payload.text ? sourcePage : 0);
    // 换了选区就收掉上一段的译文:气泡和侧栏卡片共用同一个 translation,
    // 不清就会让新选区顶着一句"别人的翻译",违反 AI 推断须与来源可区分的规则。
    // 同句重译不花钱——translationCache 命中即返回。
    setTranslation("");
    if (!payload.text || !payload.clientRect) {
      setBubbleAnchor(null);
      return;
    }
    setBubbleAnchor(pickBubbleAnchor(payload.clientRect, { width: window.innerWidth, height: window.innerHeight }));
  }

  function clearSelection() {
    setSelection("");
    setSelectionRects([]);
    setSelectionPage(0);
    setBubbleAnchor(null);
    window.getSelection()?.removeAllRanges();
  }

  // 只有"当前页选中"的矩形才能贴到这一页的摘录上;翻页后的旧矩形直接丢弃。
  function currentSelectionRects(): PageRect[] | undefined {
    return selectionPage > 0 && selectionRects.length ? selectionRects : undefined;
  }

  // 点 PDF 原文上的高亮块 → 跳到对应页、回填选区、打开该摘录的侧栏编辑框。
  function openAnchoredExcerpt(id: string) {
    const item = excerpts.find((entry) => entry.id === id);
    if (!item) return;
    if (item.page !== pageNumber) jumpToPage(item.page);
    setSelection(item.text);
    setSelectionRects(item.rects ?? []);
    setSelectionPage(item.page);
    setBubbleAnchor(null);
    setEditingExcerptId(id);
  }

  function saveExcerpt(kind: "note" | "evidence") {
    if (selection.length < 2) return;
    addReaderExcerpt({ projectId, paperId, page: selectedPage, text: selection, note: excerptNote.trim(), kind, rects: currentSelectionRects() });
    addKnowledge({ projectId, paperId, page: selectedPage, kind, title: excerptNote.trim() || `${kind === "evidence" ? "证据" : "笔记"} · 第 ${selectedPage} 页`, content: selection, note: excerptNote.trim(), source: "human", status: "draft" });
    setExcerptNote("");
    setSavedMessage(kind === "evidence" ? "已保存为证据摘录" : "已保存为阅读笔记");
    clearSelection();
    window.setTimeout(() => setSavedMessage(""), 1800);
  }

  function saveHighlight() {
    if (selection.length < 2) return;
    addReaderExcerpt({ projectId, paperId, page: selectedPage, text: selection, note: excerptNote.trim(), kind: "highlight", color: "yellow", rects: currentSelectionRects() });
    setExcerptNote(""); setSavedMessage("已保存高亮"); clearSelection();
    window.setTimeout(() => setSavedMessage(""), 1800);
  }

  async function translate() {
    if (!paper || selection.length < 2 || translating) return;
    // 选区过长先在前端挡掉:服务端上限 8000 字符,整页/整段选中是常见误操作,
    // 不能让用户等到一次网络往返再拿到一句文不对题的报错。
    if (selection.trim().length > TRANSLATE_MAX_CHARS) {
      setError(`一次最多翻译 ${TRANSLATE_MAX_CHARS} 个字符,请缩小选区后重试。`);
      return;
    }
    // 同一句译过一次就不再打 AI:划词连点/反复选中同一句时零成本。
    const targetLanguage = targetLanguageFor(selection);
    const cacheKey = `${targetLanguage}:${selection}`;
    const cached = translationCache.current.get(cacheKey);
    if (cached !== undefined) { setTranslation(cached.translation); return; }
    setTranslating(true); setTranslation(""); setError("");
    try {
      const result = await translateSelection({ text: selection, targetLanguage, paperTitle: paper.title, page: selectedPage });
      translationCache.current.set(cacheKey, result);
      setTranslation(result.translation);
    } catch (translateError) { setError(translateError instanceof Error ? translateError.message : "翻译失败"); }
    finally { setTranslating(false); }
  }

  async function runOcr() {
    if (!pdfPage || pdfPage.pageNumber !== pageNumber || ocrRunRef.current) return;
    const controller = new AbortController();
    ocrRunRef.current = controller;
    const sourcePage = pageNumber;
    setOcrStage("rendering");
    setOcrProgress(0); setError("");
    try {
      const text = await recognizePdfPage(pdfPage, paperId, (progress) => { if (!controller.signal.aborted) setOcrProgress(progress); }, {
        signal: controller.signal, onStage: (stage) => { if (!controller.signal.aborted) setOcrStage(stage); },
      });
      if (controller.signal.aborted || pageNumberRef.current !== sourcePage) return;
      setSelection(text); setSelectionPage(sourcePage); setSelectionRects([]); setSavedMessage(`第 ${sourcePage} 页 OCR 完成，可点击“翻译本页”`);
      // 对照面板可能正显示"这一页没有文字":OCR 出了文本就让它重新切块。
      setOcrNonce((value) => value + 1);
    } catch (ocrError) {
      if (controller.signal.aborted) setSavedMessage("OCR 已取消，可重新识别本页");
      else setError(ocrError instanceof Error ? ocrError.message : "OCR 失败");
    } finally { ocrRunRef.current = null; setOcrProgress(null); }
  }

  const ocrLabel = ocrProgress === null ? "OCR 本页" : ocrStage === "rendering" ? "OCR 准备页面…" : ocrStage === "loading" ? "OCR 加载引擎…" : `OCR ${Math.round(ocrProgress * 100)}%`;

  // ── 双语对照 ────────────────────────────────────────────────────────────
  // 进度从"已完成段数"现算,不累加:三个 worker 并发回填时累加会重复计数。
  const compareDone = compareBlocks.filter((block) => !block.static && block.status === "done").length;
  const compareTotal = compareBlocks.filter((block) => !block.static).length;

  function patchCompareBlock(index: number, patch: Partial<CompareBlock>, runId: number) {
    if (compareRunId.current !== runId) return;
    const next = compareBlocksRef.current.map((block, position) => (position === index ? { ...block, ...patch } : block));
    compareBlocksRef.current = next;
    setCompareBlocks(next);
  }

  async function translateCompareBlock(block: CompareBlock, language: "中文" | "English", sourcePage = pageNumber, model?: string, signal?: AbortSignal): Promise<{ translation: string; model: string; generatedAt: string }> {
    // 划词气泡译过的段落直接命中:同一段文字不重复花钱。
    const cacheKey = `${language}:${block.source}`;
    const cached = translationCache.current.get(cacheKey);
    if (cached !== undefined && validCachedTranslation(cached.translation)) return cached;
    const result = await translateSelection({ text: block.source, targetLanguage: language, paperTitle: paper?.title ?? "", page: sourcePage, model }, signal);
    translationCache.current.set(cacheKey, result);
    return result;
  }

  /** 译一段。返回 false 表示失败(已把该段标成 error)。 */
  async function runCompareBlock(index: number, runId: number, language: "中文" | "English"): Promise<boolean> {
    const block = compareBlocksRef.current[index];
    if (!block || block.static) return true;
    patchCompareBlock(index, { status: "pending", error: "" }, runId);
    try {
      const result = await translateCompareBlock(block, language);
      patchCompareBlock(index, { status: "done", ...result }, runId);
      return true;
    } catch (translateError) {
      patchCompareBlock(index, { status: "error", error: translateError instanceof Error ? translateError.message : "翻译失败" }, runId);
      return false;
    }
  }

  /** 把已完成的段落写进 IndexedDB。整页一次写入,避免每段写造成的 read-modify-write 竞态。 */
  async function flushCompareTranslations() {
    const context = compareContextRef.current;
    if (!context) return;
    const done = compareBlocksRef.current
      .map((block, index) => ({ block, index }))
      .filter((entry) => !entry.block.static && entry.block.status === "done");
    if (!done.length) return;
    await savePageTranslations(paperId, context.page, compareCacheLanguage(context.language, context.parser), {
      source: compareBlocksRef.current.map((block) => block.source).join(" "),
      blocks: done.map((entry) => ({ index: entry.index, source: entry.block.source, translation: entry.block.translation, model: entry.block.model ?? "", generatedAt: entry.block.generatedAt })),
    });
  }

  async function translateCurrentPage() {
    const context = compareContextRef.current;
    if (!context || context.page !== pageNumber || pageRunRef.current || documentRunRef.current || compareLoading || comparePhase === "working") return;
    const controller = new AbortController();
    pageRunRef.current = controller;
    const runId = ++compareRunId.current;
    const original = compareBlocksRef.current;
    setPageTranslationActive(true); setComparePhase("working"); setCompareError("");
    try {
      const { model } = await getAiModels();
      const result = await translatePageBlocks(original, {
        signal: controller.signal,
        translate: (block) => translateCompareBlock(block, context.language, context.page, model || undefined, controller.signal),
        onBlock: (index, block) => patchCompareBlock(index, block, runId),
      });
      const done = result.blocks.map((block, index) => ({ block, index })).filter(({ block }) => !block.static && block.status === "done");
      if (done.length) await savePageTranslations(paperId, context.page, compareCacheLanguage(context.language, context.parser), {
        source: result.blocks.map((block) => block.source).join(" "),
        blocks: done.map(({ block, index }) => ({ index, source: block.source, translation: block.translation, model: block.model ?? "", generatedAt: block.generatedAt })),
      });
      if (compareRunId.current === runId) {
        setCompareError(controller.signal.aborted ? "本页翻译已取消，完成的译文已保存。" : result.error);
      }
    } catch (failure) {
      if (compareRunId.current === runId) setCompareError(failure instanceof Error ? failure.message : "本页翻译失败，请重试。");
    } finally {
      pageRunRef.current = null; setPageTranslationActive(false);
      if (compareRunId.current === runId) setComparePhase("idle");
      else setDocumentRefreshNonce((value) => value + 1);
    }
  }

  async function translateWholeDocument() {
    if (!document || !paper || documentRunRef.current || pageRunRef.current || comparePhase === "working") return;
    const controller = new AbortController();
    documentRunRef.current = controller;
    const requestedPaperId = paperId;
    const totalPages = document.numPages;
    const firstPage = pageNumberRef.current;
    const pages = [firstPage, ...Array.from({ length: totalPages }, (_, index) => index + 1).filter((page) => page !== firstPage)];
    let completedPages = 0;
    let selectedModel: string | undefined;
    setDocumentJob({ stage: "parsing", page: firstPage, completedPages: 0, totalPages, completedBlocks: 0, totalBlocks: 0, model: "读取模型配置…" });
    try {
      const config = await getAiConfig().catch(() => null);
      selectedModel = config?.configured ? config.model : (await getAiModels()).model || undefined;
      if (controller.signal.aborted) throw new Error("全文翻译已取消");
      if (!selectedModel) throw new Error("未读取到可用模型，请在设置页保存 AI 配置并进行连接自检。");
      setDocumentJob((current) => current ? { ...current, model: selectedModel || "默认模型" } : current);
      for (const page of pages) {
        if (controller.signal.aborted) throw new Error("全文翻译已取消");
        setDocumentJob((current) => current ? { ...current, stage: "parsing", page, completedPages, completedBlocks: 0, totalBlocks: 0 } : current);
        documentParsingPageRef.current = page;
        let blocks: CompareBlock[];
        let language: "中文" | "English";
        let parser: "mineru" | "layout" = "mineru";
        try {
          const parsed = await parseDocumentPageWithRetry(requestedPaperId, page, controller.signal);
          blocks = structuredCompareBlocks(parsed);
          if (!blocks.some((block) => !block.static && block.source.trim().length >= 2)) throw new Error("精确解析未返回可翻译文字");
          language = targetLanguageFor(parsed.blocks.filter((block) => block.kind === "paragraph" || block.kind === "heading").map((block) => block.text).join(" "));
        } catch (parseError) {
          if (controller.signal.aborted) throw parseError;
          const current = await currentPageText(await document.getPage(page), requestedPaperId);
          if (!current.text) throw new Error(`第 ${page} 页精确解析失败：${parseError instanceof Error ? parseError.message : "无法识别版面"}。本页也没有可读文字，请先 OCR 本页，再翻译本页或继续全文翻译。`);
          blocks = textCompareBlocks(current).blocks;
          language = targetLanguageFor(current.text);
          parser = "layout";
          setDocumentJob((job) => job ? { ...job, notice: `第 ${page} 页精确解析失败，改用${current.source === "ocr" ? "已识别的 OCR" : "PDF 文字"}继续翻译；版面为近似还原。` } : job);
        } finally {
          documentParsingPageRef.current = null;
        }
        if (controller.signal.aborted) throw new Error("全文翻译已取消");
        const stored = await getPageTranslations(requestedPaperId, page, compareCacheLanguage(language, parser));
        const restored = blocks.map((block, index) => {
          if (block.static) return block;
          const hit = stored?.blocks.find((entry) => entry.index === index && entry.source === block.source);
          return hit && validCachedTranslation(hit.translation) ? { ...block, status: "done" as const, translation: hit.translation, model: hit.model, generatedAt: hit.generatedAt } : block;
        });
        const pending = restored.map((block, index) => ({ block, index })).filter(({ block }) => !block.static && block.status !== "done").map(({ index }) => index);
        const totalBlocks = restored.filter((block) => !block.static).length;
        let completedBlocks = totalBlocks - pending.length;
        setDocumentJob((current) => current ? { ...current, stage: "translating", page, completedPages, completedBlocks, totalBlocks } : current);
        let cursor = 0;
        let consecutiveFailures = 0;
        let stopped = false;
        let firstError = "";
        const worker = async () => {
          while (!stopped && !controller.signal.aborted && cursor < pending.length) {
            const index = pending[cursor++];
            try {
              const result = await translateCompareBlock(restored[index], language, page, selectedModel, controller.signal);
              if (controller.signal.aborted) return;
              restored[index] = { ...restored[index], status: "done", ...result };
              completedBlocks += 1;
              consecutiveFailures = 0;
              setDocumentJob((current) => current ? { ...current, completedBlocks, model: selectedModel || result.model } : current);
            } catch (translateError) {
              if (controller.signal.aborted) return;
              firstError ||= translateError instanceof Error ? translateError.message : "翻译失败";
              restored[index] = { ...restored[index], status: "error", error: firstError };
              consecutiveFailures += 1;
              if (consecutiveFailures >= COMPARE_MAX_CONSECUTIVE_FAILURES) stopped = true;
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(COMPARE_CONCURRENCY, pending.length) }, () => worker()));
        if (restored.some((block) => block.status === "done" && !block.static)) {
          await savePageTranslations(requestedPaperId, page, compareCacheLanguage(language, parser), {
            source: restored.map((block) => block.source).join(" "),
            blocks: restored.map((block, index) => ({ block, index })).filter(({ block }) => block.status === "done")
              .map(({ block, index }) => ({ index, source: block.source, translation: block.translation, model: block.model ?? "", generatedAt: block.generatedAt })),
          });
        }
        setDocumentRefreshNonce((value) => value + 1);
        if (controller.signal.aborted) throw new Error("全文翻译已取消");
        if (restored.some((block) => !block.static && block.status !== "done")) throw new Error(`第 ${page} 页翻译未完成：${firstError || "请重试"}`);
        completedPages += 1;
        setDocumentJob((current) => current ? { ...current, completedPages } : current);
      }
      setDocumentJob((current) => current ? { ...current, stage: "done", completedPages: totalPages } : current);
    } catch (jobError) {
      setDocumentJob((current) => current ? {
        ...current,
        stage: controller.signal.aborted ? "cancelled" : "error",
        error: controller.signal.aborted ? "已停止后续页面，完成的译文已保存" : jobError instanceof Error ? jobError.message : "全文翻译失败",
      } : current);
    } finally {
      documentRunRef.current = null;
      documentParsingPageRef.current = null;
    }
  }

  function cancelDocumentTranslation() {
    const controller = documentRunRef.current;
    if (!controller || controller.signal.aborted) return;
    controller.abort();
    setDocumentJob((current) => current ? { ...current, stage: "cancelling" } : current);
    const parsingPage = documentParsingPageRef.current;
    if (parsingPage !== null) void cancelReaderPageParse(paperId, parsingPage).catch(() => {});
  }

  async function retryCompareBlock(index: number) {
    if (comparePhase === "working" || pageRunRef.current || documentRunRef.current) return;
    compareContextRef.current = { page: pageNumber, language: compareLanguage, parser: compareParser };
    const runId = ++compareRunId.current;
    setComparePhase("working"); setCompareError("");
    if (await runCompareBlock(index, runId, compareLanguage)) {
      if (compareRunId.current === runId) await flushCompareTranslations();
    } else if (compareRunId.current === runId) {
      setCompareError(compareBlocksRef.current[index].error ?? "翻译失败");
    }
    if (compareRunId.current === runId) setComparePhase("idle");
  }

  /** 点对照里的英文段 → 回填选区并切回批注标签,高亮/笔记/证据按钮立即可用。 */
  function annotateCompareBlock(source: string, sourcePage: number) {
    jumpToPage(sourcePage);
    setSelection(source);
    setSelectionRects([]);
    setSelectionPage(sourcePage);
    setBubbleAnchor(null);
    setReaderTab("notes");
  }


  if (!paper) return <div className="reader-missing"><EmptyState icon={<BookOpenText />} title="当前项目中没有这篇文献" description="阅读器只允许打开当前项目关联的论文。" action={<button className="primary" onClick={() => navigate(libraryPath)}>返回项目文献库</button>} /></div>;

  return <div className="reader-page" data-reader-mode={readerTab}>
    <header className="reader-header"><div className="reader-title"><button className="icon-button" onClick={() => navigate(libraryPath)} aria-label="返回项目文献库"><ArrowLeft /></button><FilePdf weight="duotone" /><div><span className="eyebrow">{project?.name}</span><h1>{paper.title}</h1><small>{paper.authors} · {paper.venue} {paper.year}</small></div></div><label className="secondary-button upload-button"><UploadSimple />{document ? "更换 PDF" : "上传 PDF"}<input type="file" accept="application/pdf,.pdf" onChange={(event) => void upload(event)} /></label></header>
    <div className="reader-controls">
      <div className="reader-toolbar"><div className="outline-control"><button className="icon-button" disabled={!paper.outline?.length} onClick={() => setOutlineOpen((value) => !value)} aria-label="文档目录"><ListBullets /></button>{outlineOpen && paper.outline?.length ? <nav className="reader-outline" aria-label="PDF 目录">{paper.outline.map((item, index) => <button key={`${item.page}-${index}`} onClick={() => { jumpToPage(item.page); setOutlineOpen(false); }}><span>{item.title}</span><small>{item.page}</small></button>)}</nav> : null}<label title="向下滚动连续阅读，也可输入页码跳转"><input aria-label="当前页码" type="number" min={1} max={document?.numPages ?? 1} value={pageNumber} onChange={(event) => jumpToPage(Number(event.target.value) || 1)} /> / {document?.numPages ?? 0}</label></div><form className="reader-search" onSubmit={(event) => void searchDocument(event)}><MagnifyingGlass /><input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="全文搜索" /><button disabled={!document || searchQuery.trim().length < 2 || searching}>{searching ? "搜索中" : "搜索"}</button>{searchResults.length ? <div className="search-results">{searchResults.map((result) => <button type="button" key={`${result.page}-${result.excerpt}`} onClick={() => { jumpToPage(result.page); setSearchResults([]); }}><strong>第 {result.page} 页</strong><span>{result.excerpt}</span></button>)}</div> : null}</form><button className="secondary-button ocr-button" disabled={!pdfPage || pdfPage.pageNumber !== pageNumber || ocrProgress !== null} onClick={() => void runOcr()}><Scan />{ocrLabel}</button>{ocrProgress !== null ? <button type="button" className="secondary-button" onClick={() => ocrRunRef.current?.abort()}>取消 OCR</button> : null}<div><button className="icon-button" aria-label="缩小页面" onClick={() => resizePages(Math.max(.2, scale - .15))}><Minus /></button><span>{Math.round(scale * 100)}%</span><button className="icon-button" aria-label="放大页面" onClick={() => resizePages(Math.min(2.2, scale + .15))}><Plus /></button></div>
          {readerTab === "compare" ? <div className="reader-translation-actions" role="group" aria-label="翻译操作">
            {pageTranslationActive ? <button type="button" className="secondary-button" onClick={() => pageRunRef.current?.abort()}><X />取消本页翻译</button>
              : <button type="button" className="secondary-button" disabled={compareContextRef.current?.page !== pageNumber || compareLoading || !compareTotal || comparePhase === "working" || Boolean(documentRunRef.current) || ocrProgress !== null} onClick={() => void translateCurrentPage()}><Translate />{compareDone === compareTotal && compareTotal ? "本页已翻译" : "翻译本页"}</button>}
            {documentJob?.stage === "parsing" || documentJob?.stage === "translating"
              ? <button type="button" className="secondary-button" onClick={cancelDocumentTranslation}><X />取消全文翻译</button>
              : documentJob?.stage === "cancelling"
                ? <button type="button" className="secondary-button" disabled><X />正在取消…</button>
                : <button type="button" className="primary" disabled={!document || pageTranslationActive || comparePhase === "working" || documentJob?.stage === "done"} onClick={() => void translateWholeDocument()}><Translate />{documentJob?.stage === "done" ? "全文已翻译" : documentJob?.stage === "error" || documentJob?.stage === "cancelled" ? "继续翻译全文" : "精确解析并翻译全文"}</button>}
            <label className="compare-scroll-toggle"><input type="checkbox" checked={linkedScroll} onChange={(event) => setLinkedScroll(event.target.checked)} />双屏关联</label>
          </div> : null}
          <div className="reader-tabs" role="tablist" aria-label="右栏视图">
          <button id="reader-notes-tab" type="button" role="tab" className="reader-tab" aria-controls="reader-notes-panel" aria-selected={readerTab === "notes"} onClick={() => setReaderTab("notes")}><NotePencil />批注与问答</button>
          <button id="reader-compare-tab" type="button" role="tab" className="reader-tab" aria-controls="reader-compare-panel" aria-selected={readerTab === "compare"} onClick={() => setReaderTab("compare")}><Translate />双语对照</button>
          <button id="reader-card-tab" type="button" role="tab" className="reader-tab" aria-controls="reader-card-panel" aria-selected={readerTab === "card"} onClick={() => setReaderTab("card")}><BookOpenText />Paper Card</button>
        </div>
        </div>
      {readerTab === "compare" ? <div className="reader-translation-status">
            <span className="compare-progress" role="status" aria-live="polite">{documentJob
              ? `全文 ${documentJob.totalPages} 页 · 已完成 ${documentJob.completedPages} 页 · ${documentJob.stage === "parsing" ? `${parserProgress?.stage === "downloading" ? `首次准备：下载解析模型 ${parserProgress.completed}/${parserProgress.total} 组` : parserProgress?.stage === "starting" ? "正在检查本机解析模型…" : parserProgress?.stage === "queued" ? "等待本机解析任务…" : `正在解析第 ${documentJob.page} 页`}` : documentJob.stage === "translating" ? `正在翻译第 ${documentJob.page} 页 ${documentJob.completedBlocks}/${documentJob.totalBlocks} 项` : documentJob.stage === "done" ? "全部完成" : documentJob.stage === "cancelling" ? "正在取消" : documentJob.stage === "cancelled" ? "已取消" : "已暂停"} · 模型 ${documentJob.model}`
              : `当前第 ${pageNumber} / ${document?.numPages ?? 0} 页 · 已完成 ${compareDone} / ${compareTotal} 项`}</span>
            {!documentJob ? <small className="compare-progress">首次使用需联网下载解析模型，之后在本机复用。</small> : null}
            {documentJob?.notice ? <span className="compare-notice-text" role="status">{documentJob.notice}</span> : null}
            {documentJob?.error || compareError || error ? <span className="compare-error-text" role="alert">{compareError || error || documentJob?.error}</span> : null}
      </div> : null}
    </div>
    <div className="reader-layout" data-reader-mode={readerTab}>
      <section className="reader-document">
        <div className="pdf-stage" ref={stageRef}>{loading && !document ? <LoadingState title="正在加载 PDF" /> : null}{!loading && error && !document ? <EmptyState icon={<WarningCircle />} title="无法打开 PDF" description={error} action={<label className="primary upload-button"><UploadSimple />重新选择<input type="file" accept="application/pdf,.pdf" onChange={(event) => void upload(event)} /></label>} /> : null}{!loading && !document ? <EmptyState icon={<FilePdf />} title="上传 PDF 开始阅读" action={<label className="primary upload-button"><UploadSimple />选择 PDF<input type="file" accept="application/pdf,.pdf" onChange={(event) => void upload(event)} /></label>} /> : null}{document ? Array.from({ length: document.numPages }, (_, index) => index + 1).map((page) => <ContinuousPage key={page} page={page} activePage={pageNumber} width={pageSize.width * scale} height={pageSize.height * scale} scale={scale} stage={stageRef}>
          {(visible) => <ContinuousPdfPage document={document} pageNumber={page} activePage={pdfPage?.pageNumber === page ? pdfPage : undefined} visible={visible} scale={scale} onSelect={(payload) => handleSelect(payload, page)} highlights={excerpts.filter((item) => item.page === page && item.rects?.length).map((item) => ({ id: item.id, rects: item.rects!, note: item.note, kind: item.kind }))} onHighlightClick={openAnchoredExcerpt} />}
        </ContinuousPage>) : null}</div>
      </section>
      <aside className="reader-ai">
        {/* 用 CSS 隐藏而不是卸载:切走再切回时,写了一半的问题和摘录备注不该丢。 */}
        <div id="reader-notes-panel" role="tabpanel" aria-labelledby="reader-notes-tab" className="reader-notes" data-active={readerTab === "notes"}>
        <div className="reader-ai-intro"><Sparkle weight="duotone" /><div><strong>问 AI</strong><span>选中文字则基于选区回答；不选中则基于全文回答</span></div></div>
        <form onSubmit={(event) => void ask(event)}><label className="selection-box"><span><Quotes /> 当前选区 · 第 {selectedPage} 页</span><textarea value={selection} onChange={(event) => { setSelection(event.target.value); setSelectionPage(pageNumber); setSelectionRects([]); }} placeholder="在左侧 PDF 中拖动选择一段文字；留空则对全文提问…" maxLength={8000} /><small className={selection.length > TRANSLATE_MAX_CHARS ? "selection-count over" : "selection-count"}>{selection.length} / {TRANSLATE_MAX_CHARS}{selection.length > TRANSLATE_MAX_CHARS ? " · 超出翻译上限" : ""}</small></label><label className="excerpt-note"><span>摘录备注（可选）</span><input value={excerptNote} onChange={(event) => setExcerptNote(event.target.value)} placeholder="记录你的判断或用途" /></label><div className="excerpt-actions"><button type="button" disabled={selection.length < 2} onClick={saveHighlight}><BookmarkSimple />高亮</button><button type="button" disabled={selection.length < 2} onClick={() => saveExcerpt("note")}><NotePencil />笔记</button><button type="button" disabled={selection.length < 2} onClick={() => saveExcerpt("evidence")}><BookmarkSimple />证据</button><button type="button" disabled={selection.length < 2 || translating} onClick={() => void translate()}><Translate />{translating ? "翻译中" : "翻译"}</button><span>{savedMessage}</span></div>{translation ? <div className="translation-card"><strong>选区翻译</strong><p>{translation}</p></div> : null}<label className="question-box"><span>你想问什么？</span><textarea value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：作者为什么采用这个设计？未选中文字时将基于全文回答" maxLength={800} /></label><button className="primary ask-button" disabled={question.trim().length < 2 || asking}>{asking ? <><ArrowsClockwise className="spin" />正在回答</> : <><Sparkle />{selection.trim().length >= 10 ? "基于选区回答" : "基于全文回答"}</>}</button></form>
        {error && document ? <div className="reader-error"><WarningCircle />{error}</div> : null}
        {answer ? <article className="answer-card"><header><span><Check /> AI 回答</span><small>{model} · 第 {pageNumber} 页</small></header><p>{answer}</p>{selection.trim() ? <blockquote>{selection}</blockquote> : null}</article> : null}
        <section className="reader-history"><div className="section-heading"><div><span className="eyebrow">摘录与问答</span><h2>{excerpts.length} 条摘录 · {history.length} 次问答</h2></div></div>{excerpts.map((item) => <article className={`excerpt-card kind-${item.kind}`} key={item.id}><header><button onClick={() => jumpToPage(item.page)}>{item.kind === "evidence" || item.kind === "highlight" ? <BookmarkSimple /> : <NotePencil />}第 {item.page} 页</button><span><button className="icon-button subtle" onClick={() => setEditingExcerptId(item.id)} aria-label="编辑摘录"><NotePencil /></button><button className="icon-button subtle danger" onClick={() => deleteReaderExcerpt(item.id)} aria-label="删除摘录"><Trash /></button></span></header>{editingExcerptId === item.id ? <input defaultValue={item.note} autoFocus onBlur={(event) => { updateReaderExcerpt(item.id, { note: event.target.value, color: item.color }); setEditingExcerptId(""); }} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /> : <strong>{item.note || (item.kind === "evidence" ? "证据摘录" : item.kind === "highlight" ? "文本高亮" : "阅读笔记")}</strong>}<p>{item.text}</p></article>)}{history.map((item) => <article key={item.id}><button onClick={() => { jumpToPage(item.page); setSelection(item.selection); setSelectionPage(item.page); setSelectionRects([]); }}><Quotes />第 {item.page} 页</button><strong>{item.question}</strong><p>{item.answer}</p><footer><span>{item.model}</span><time>{new Date(item.createdAt).toLocaleString("zh-CN")}</time></footer></article>)}</section>
        </div>
        <div id="reader-card-panel" role="tabpanel" aria-labelledby="reader-card-tab" className="reader-card-panel" hidden={readerTab !== "card"}>
          <PaperCardEditor key={paperId} />
        </div>
        {readerTab === "compare" ? <section id="reader-compare-panel" role="tabpanel" aria-labelledby="reader-compare-tab" className="compare-pane" aria-label="双语对照">
          <div className="compare-page-stage" ref={compareStageRef}>
            {document ? Array.from({ length: document.numPages }, (_, index) => index + 1).map((page) => <ContinuousPage key={page} page={page} activePage={pageNumber} width={pageSize.width * scale} height={pageSize.height * scale} scale={scale} stage={compareStageRef}>
              {(visible) => <ContinuousTranslationPage document={document} paperId={paperId} pageNumber={page} visible={visible} width={pageSize.width * scale} height={pageSize.height * scale} scale={scale} revision={`${ocrNonce}:${documentRefreshNonce}`} active={page === pageNumber && !compareLoading && compareContextRef.current?.page === page ? { blocks: compareBlocks, columns: compareColumns, language: compareLanguage, parser: compareParser, source: compareSource } : undefined} onAnnotate={annotateCompareBlock} onRetry={page === pageNumber ? (index) => void retryCompareBlock(index) : undefined} empty={page === pageNumber ? <EmptyState icon={<Scan />} title="这一页没有可翻译的文字" description="扫描版 PDF 请先 OCR 本页，再点击“翻译本页”。英文识别资源已内置，识别在本机完成。" action={<button type="button" className="primary" disabled={!pdfPage || pdfPage.pageNumber !== pageNumber || ocrProgress !== null} onClick={() => void runOcr()}><Scan />{ocrLabel}</button>} /> : undefined} />}
            </ContinuousPage>) : <EmptyState icon={<FilePdf />} title="等待 PDF 加载" description="左侧 PDF 加载完成后，即可按段对照阅读。" />}

          </div>
        </section> : null}
      </aside>
    </div>
    {/* 划词气泡:紧贴选区,翻译/高亮/笔记/证据一步到位。滚动即失锚 → 自动收起。 */}
    {bubbleAnchor && selection.length >= 2 ? <div ref={bubbleRef} className="selection-bubble" data-placement={bubbleAnchor.placement} role="group" aria-label="选区操作" style={{ top: bubbleAnchor.top, left: bubbleAnchor.left }}><div className="bubble-actions"><button type="button" disabled={translating} onClick={() => void translate()}><Translate />{translating ? "翻译中" : "翻译"}</button><button type="button" onClick={saveHighlight}><BookmarkSimple />高亮</button><button type="button" onClick={() => saveExcerpt("note")}><NotePencil />笔记</button><button type="button" onClick={() => saveExcerpt("evidence")}><BookmarkSimple />证据</button></div>{translation ? <div className="bubble-translation"><strong>译文</strong><p>{translation}</p></div> : null}</div> : null}
  </div>;
}
