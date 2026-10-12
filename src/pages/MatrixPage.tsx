import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams } from "react-router-dom";
import {
  ArrowsOutSimple,
  ArrowsClockwise,
  CaretDown,
  CaretRight,
  CheckCircle,
  FilePdf,
  GridFour,
  LockSimple,
  MagnifyingGlass,
  PencilSimple,
  Question,
  Sparkle,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { Topbar } from "../components/Topbar";
import { EmptyState, ErrorState, LoadingState } from "../components/states";
import {
  extractMatrix,
  confirmMatrixEvidence,
  getMatrixById,
  updateEvidence,
  type EvidenceCell,
  type EvidenceStatus,
  type MatrixResponse,
} from "../api";
import { useProject } from "../state/project";
import { useWorkspace, type LocalMatrix } from "../state/workspace";
import { extractPdfText } from "../pdf/document";
import { resolvePaperPdf } from "../pdf/resolvePaperPdf";
import { canBatchConfirm, evidencePageNumber, matrixReviewEntries } from "../matrix/review";
import { useDialogKeyboard } from "../components/useDialogKeyboard";

interface Selection {
  rowId: string;
  rowLabel: string;
  groupLabel: string;
  paperId: string;
}

interface BatchReview {
  matrixId: string;
  paperId?: string;
  title: string;
  paperCount: number;
  entries: ReturnType<typeof matrixReviewEntries>;
}

function BatchReviewDialog({ review, saving, error, onClose, onConfirm }: {
  review: BatchReview; saving: boolean; error: string; onClose: () => void; onConfirm: () => void;
}) {
  const ref = useDialogKeyboard<HTMLDivElement>(onClose);
  const count = review.entries.filter(({ cell }) => canBatchConfirm(cell)).length;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => previous?.focus();
  }, [ref]);
  return createPortal(<div className="crud-modal-backdrop" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={ref} className="crud-modal matrix-review-dialog" role="dialog" aria-modal="true" aria-labelledby="matrix-review-title" aria-describedby="matrix-review-description">
      <header><div><strong id="matrix-review-title">批量确认并锁定</strong><span>{review.title}</span></div>
        <button type="button" className="icon-button" disabled={saving} aria-label="关闭批量确认" onClick={onClose}><X /></button></header>
      <div className="matrix-review-description" id="matrix-review-description">
        <p>范围：{review.paperCount} 篇文献，{review.entries.length} 个证据单元格。</p>
        <p>将确认并锁定 <strong>{count}</strong> 个有原文摘录与来源位置的草稿，跳过 <strong>{review.entries.length - count}</strong> 个已确认、锁定、缺失、冲突或尚未提取的单元格。</p>
        {!review.paperId ? <p>此操作包含当前矩阵的所有文献，包括搜索框隐藏的文献。</p> : null}
        <p>请在核对原文后确认。批量确认记录的是你的判断，不会自动核验证据；锁定后的内容不会被 AI 批量覆盖。</p>
        {error ? <p role="alert">{error}</p> : null}
      </div>
      <footer><button type="button" className="secondary-button" disabled={saving} onClick={onClose}>取消</button>
        <button type="button" className="primary" disabled={saving || !count} onClick={onConfirm}><LockSimple />{saving ? "正在确认…" : `确认并锁定 ${count} 项`}</button></footer>
    </div>
  </div>, document.body);
}

function StatusMark({ type }: { type: EvidenceStatus }) {
  if (type === "confirmed") return <span className="cell-status confirmed"><CheckCircle weight="fill" /> 已确认</span>;
  if (type === "missing") return <span className="cell-status missing"><Question /> 未找到</span>;
  if (type === "conflict") return <span className="cell-status conflict"><WarningCircle weight="fill" /> 有冲突</span>;
  return <span className="cell-status draft"><Sparkle weight="fill" /> AI 草稿</span>;
}

function firstSelection(data: MatrixResponse): Selection | null {
  const group = data.groups[0];
  const row = group?.rows[0];
  const paper = data.papers[0];
  return group && row && paper
    ? { rowId: row.id, rowLabel: row.label, groupLabel: group.label, paperId: paper.id }
    : null;
}

function localMatrixResponse(matrix: LocalMatrix, papers: ReturnType<typeof useWorkspace>["papers"]): MatrixResponse {
  const matrixPapers = matrix.paperIds.flatMap((paperId) => {
    const paper = papers.find((item) => item.id === paperId);
    return paper ? [{ id: paper.id, name: paper.title.replace(/:.+$/, ""), title: paper.title, venue: paper.venue, year: paper.year, hasFile: Boolean(paper.fileName) }] : [];
  });
  return {
    project: { id: matrix.projectId, name: matrix.name, description: matrix.description, extractionProgress: 0 },
    papers: matrixPapers,
    groups: [{ id: "custom", label: "自定义研究维度", rows: matrix.dimensions }],
    cells: Object.fromEntries(Object.entries(matrix.cells).map(([key, cell]) => [key, { id: `${matrix.id}:${key}`, ...cell }])),
  };
}

/**
 * The Evidence Matrix — the canonical page that the original App.tsx
 * rendered inline. Visual + behavioral parity is required by TODO-01.
 *
 * 新路由是 `/projects/:projectId/matrices/:matrixId`;旧路由
 * `/knowledge/matrices/:projectId` 的参数名仍是 projectId(实为矩阵 id),
 * 兼容两种参数名。项目 id 会喂给 `useProject()` 供子组件读取。
 */
export function MatrixPage() {
  const params = useParams<{ projectId?: string; matrixId?: string }>();
  const navigate = useNavigate();
  const { setProjectId } = useProject();
  const workspace = useWorkspace();

  const fallbackMatrixId = workspace.matrices[0]?.id ?? "";
  const matrixId = params.matrixId ?? params.projectId ?? fallbackMatrixId;
  const workspaceMatrix = workspace.matrices.find((matrix) => matrix.id === matrixId);
  const localMatrix = workspaceMatrix?.source === "local" ? workspaceMatrix : undefined;
  const projectId = localMatrix?.projectId ?? matrixId;

  const [data, setData] = useState<MatrixResponse | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<Selection | null>(null);
  const [query, setQuery] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [aiMessage, setAiMessage] = useState("");
  const [progress, setProgress] = useState(0);
  const [batchReview, setBatchReview] = useState<BatchReview | null>(null);
  const [reviewError, setReviewError] = useState("");
  const [reviewMessage, setReviewMessage] = useState("");

  const loadMatrix = useCallback(async () => {
    if (!matrixId) { setLoading(false); return; }
    setLoading(true);
    setLoadError("");
    try {
      const response = localMatrix ? localMatrixResponse(localMatrix, workspace.papers) : await getMatrixById(matrixId);
      setData(response);
      setProjectId(response.project.id);
      setProgress(response.project.extractionProgress);
      setSelected((current) => current ?? firstSelection(response));
    } catch (error) {
      const message = error instanceof Error ? error.message : "加载矩阵失败";
      setLoadError(message);
    } finally {
      setLoading(false);
    }
  }, [localMatrix, matrixId, projectId, setProjectId, workspace.papers]);

  useEffect(() => {
    void loadMatrix();
  }, [loadMatrix]);

  const visiblePapers = useMemo(() => {
    const value = query.trim().toLowerCase();
    if (!data || !value) return data?.papers ?? [];
    return data.papers.filter((paper) =>
      `${paper.name} ${paper.title} ${paper.venue}`.toLowerCase().includes(value),
    );
  }, [data, query]);

  const selectedCell = selected && data ? data.cells[`${selected.rowId}:${selected.paperId}`] : undefined;
  const selectedPaper = selected && data ? data.papers.find((paper) => paper.id === selected.paperId) : undefined;
  const verified = selectedCell?.status === "confirmed" && selectedCell.locked;
  const confirmableCount = data ? matrixReviewEntries(data).filter(({ cell }) => canBatchConfirm(cell)).length : 0;
  const paperConfirmableCount = data && selected ? matrixReviewEntries(data, selected.paperId).filter(({ cell }) => canBatchConfirm(cell)).length : 0;

  function toggleGroup(id: string) {
    setCollapsed((current) => ({ ...current, [id]: !current[id] }));
  }

  /**
   * 「继续 AI 提取」— 本地与云端矩阵统一走 POST /api/matrices/:matrixId/extract。
   * 旧实现云端矩阵误把矩阵 id 当项目 id 调核验计划接口 → 「项目不存在」,已修复。
   * 论文与维度:本地矩阵取 workspace,云端矩阵取已加载的 data。
   */
  async function runExtraction() {
    if (extracting || saving || batchReview) return;
    const taskId = workspace.addTask({ projectId: data?.project.id ?? projectId, title: `提取矩阵：${workspaceMatrix?.name ?? data?.project.name ?? matrixId}`, detail: `${data?.papers.length ?? 0} 篇论文 · ${data?.groups.flatMap((group) => group.rows).length ?? 0} 个研究维度` });
    workspace.updateTask(taskId, { status: "running", progress: 10 });
    setExtracting(true);
    setLoadError("");
    setAiMessage("正在从本地或数据库读取 PDF…");
    const extractionBatchSize = 3;
    try {
      const papers = localMatrix
        ? localMatrix.paperIds.flatMap((paperId) => {
            const paper = workspace.papers.find((item) => item.id === paperId);
            return paper ? [paper] : [];
          })
        : (data?.papers ?? []);
      const dimensions = localMatrix ? localMatrix.dimensions : (data?.groups.flatMap((group) => group.rows) ?? []);
      const pdfPapers = [];
      const missingPdf: string[] = [];
      for (const paper of papers) {
        const workspacePaper = workspace.papers.find((item) => item.id === paper.id);
        const blob = await resolvePaperPdf(paper.id, workspacePaper?.fileName);
        if (!blob) {
          missingPdf.push(paper.title);
          continue;
        }
        // 文本上限 15K/篇:60 页×6000 字会让 StepFun 推理逼近 55s 超时(生产 502,2026-08-14);
        // 15K(约 20–30 页)已足以覆盖各维度证据来源。
        pdfPapers.push({ id: paper.id, title: paper.title, pages: (await extractPdfText(blob, paper.id, { maxPages: 60, maxChars: 15_000 })).map(({ page, text }) => ({ page, text })) });
      }
      if (!pdfPapers.length) {
        throw new Error("所选论文尚未上传可读取的 PDF（文献库同步的 PDF 在数据库中，请确认 API 已启动并重试）");
      }
      if (missingPdf.length) {
        setAiMessage(`已读取 ${pdfPapers.length} 篇 PDF，跳过 ${missingPdf.length} 篇无文件文献…`);
      } else {
        setAiMessage("正在提取逐格证据…");
      }
      let totalUpdated = 0;
      let totalSkipped = 0;
      let lastProgress = 0;
      const batchFailures: string[] = [];
      for (let offset = 0; offset < pdfPapers.length; offset += extractionBatchSize) {
        const batch = pdfPapers.slice(offset, offset + extractionBatchSize);
        const batchEnd = Math.min(offset + extractionBatchSize, pdfPapers.length);
        setAiMessage(`正在提取第 ${offset + 1}–${batchEnd} / ${pdfPapers.length} 篇论文…`);
        try {
          const result = await extractMatrix(matrixId, { papers: batch, dimensions });
          totalUpdated += result.updated ?? 0;
          totalSkipped += result.skipped ?? 0;
          lastProgress = result.progress ?? lastProgress;
          setProgress(lastProgress);
        } catch (batchError) {
          batchFailures.push(batchError instanceof Error ? batchError.message : "批次失败");
        }
      }
      if (!totalUpdated && batchFailures.length) {
        throw new Error(batchFailures[0]);
      }
      const skipNote = totalSkipped || missingPdf.length || batchFailures.length
        ? `（跳过 ${totalSkipped + missingPdf.length + batchFailures.length * extractionBatchSize} 篇异常/无 PDF）`
        : "";
      setAiMessage(`已提取 ${totalUpdated} 个证据单元格${skipNote}`);
      workspace.updateTask(taskId, { status: "completed", progress: 100, detail: `完成 ${totalUpdated} 个证据单元格` });
      await loadMatrix();
    } catch (error) {
      workspace.updateTask(taskId, { status: "failed", progress: 0, detail: error instanceof Error ? error.message : "AI 证据提取失败" });
      setLoadError(error instanceof Error ? error.message : "AI 证据提取失败");
      setAiMessage("");
    } finally {
      setExtracting(false);
    }
  }

  async function persistStatus(status: EvidenceStatus, locked: boolean) {
    if (!selectedCell || saving || extracting || batchReview) return;
    setSaving(true);
    setLoadError("");
    try {
      const result = localMatrix && selected
        ? (workspace.updateMatrixCell(localMatrix.id, `${selected.rowId}:${selected.paperId}`, status, locked), { status, locked })
        : await updateEvidence(selectedCell.id, status, locked);
      setData((current) => {
        if (!current || !selected) return current;
        const key = `${selected.rowId}:${selected.paperId}`;
        return {
          ...current,
          cells: {
            ...current.cells,
            [key]: { ...current.cells[key], status: result.status, locked: result.locked },
          },
        };
      });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "保存证据状态失败");
    } finally {
      setSaving(false);
    }
  }

  function openSource() {
    if (!selectedPaper?.hasFile || !data) return;
    const page = evidencePageNumber(selectedCell?.sourcePage ?? "");
    navigate(`/projects/${encodeURIComponent(data.project.id)}/library/${encodeURIComponent(selectedPaper.id)}/read${page ? `?page=${page}` : ""}`);
  }

  function startBatchReview(paperId?: string) {
    if (!data || extracting || saving || batchReview) return;
    setReviewError(""); setReviewMessage("");
    setBatchReview({ matrixId, paperId, title: paperId ? `本篇：${data.papers.find((paper) => paper.id === paperId)?.title ?? ""}` : `整个矩阵：${data.project.name}`,
      paperCount: paperId ? 1 : data.papers.length, entries: matrixReviewEntries(data, paperId) });
  }

  async function persistBatchReview() {
    if (!batchReview || saving) return;
    const review = batchReview;
    const eligible = review.entries.filter(({ cell }) => canBatchConfirm(cell));
    if (!eligible.length) return;
    setSaving(true); setReviewError("");
    try {
      const updatedIds = localMatrix
        ? (workspace.confirmMatrixCells(localMatrix.id, eligible.map(({ key }) => key)), eligible.map(({ cell }) => cell.id))
        : (await confirmMatrixEvidence(review.matrixId, eligible.map(({ cell }) => cell.id), review.paperId)).updatedIds;
      const updated = new Set(updatedIds);
      setData((current) => current ? { ...current, cells: Object.fromEntries(Object.entries(current.cells).map(([key, cell]) =>
        [key, updated.has(cell.id) ? { ...cell, status: "confirmed" as const, locked: true } : cell])) } : current);
      setReviewMessage(`已确认并锁定 ${updatedIds.length} 项，跳过 ${review.entries.length - updatedIds.length} 项。`);
      setBatchReview(null);
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : "批量确认失败，请重试。");
    } finally { setSaving(false); }
  }

  function onToggleSidebar() {
    // delegated to AppShell via custom event
    window.dispatchEvent(new CustomEvent("paperidea:toggle-sidebar"));
  }

  const paperColWidth = visiblePapers.length > 30 ? 120 : visiblePapers.length > 15 ? 140 : 160;
  const paperCountStyle = {
    "--paper-count": visiblePapers.length,
    "--paper-col-width": `${paperColWidth}px`,
  } as CSSProperties;

  return (
    <>
      <Topbar
        breadcrumb="矩阵列表"
        breadcrumbHref="/matrices"
        title={data?.project.name ?? workspaceMatrix?.name ?? "证据矩阵"}
        paperCount={visiblePapers.length}
        query={query}
        onQueryChange={setQuery}
        progress={progress}
        aiMessage={aiMessage}
        extracting={extracting}
        extractionDisabled={saving || Boolean(batchReview)}
        onRunExtraction={() => void runExtraction()}
        loadError={loadError && !loading ? loadError : null}
        onRetry={() => void loadMatrix()}
        onToggleSidebar={onToggleSidebar}
      />
      <div className="content">
        <section className="matrix-panel" aria-label="证据矩阵">
          {!loading && data ? <div className="matrix-review-bar">
            <span>{confirmableCount} 项可批量确认</span>
            <button type="button" className="secondary-button" disabled={!selectedPaper || !paperConfirmableCount || saving || extracting} onClick={() => startBatchReview(selectedPaper?.id)} title={selectedPaper?.title}><CheckCircle />确认本篇（{paperConfirmableCount}）</button>
            <button type="button" className="secondary-button" disabled={!confirmableCount || saving || extracting} onClick={() => startBatchReview()}><CheckCircle />确认整个矩阵（{confirmableCount}）</button>
            {reviewMessage ? <span className="matrix-review-result" role="status">{reviewMessage}</span> : null}
          </div> : null}
          <div className="matrix-scroll">
            {!matrixId ? (
              <EmptyState
                icon={<GridFour weight="duotone" />}
                title="还没有证据矩阵"
                description="先在项目中添加论文,然后新建一个证据矩阵。"
                action={<a className="primary" href="/matrices">前往矩阵列表</a>}
              />
            ) : null}
            {loadError && !loading ? (
              <ErrorState
                title={loadError}
                onRetry={() => void loadMatrix()}
              />
            ) : null}
            {loading ? (
              <LoadingState
                title="正在加载证据矩阵"
                description="正在读取项目、论文和证据"
              />
            ) : null}
            {!loading && data ? (
              <div className="matrix-table" style={paperCountStyle}>
                <div className="matrix-grid matrix-header">
                  <div className="dimension-head">研究维度</div>
                  {visiblePapers.map((paper) => (
                    <div className="paper-head" key={paper.id} title={paper.title}>
                      <strong>{paper.name}</strong>
                      <span>{paper.venue} {paper.year}</span>
                    </div>
                  ))}
                </div>
                {visiblePapers.length === 0 ? (
                  <EmptyState
                    icon={<MagnifyingGlass />}
                    title="没有匹配的论文"
                    description="换一个关键词试试"
                  />
                ) : (
                  data.groups.map((group) => (
                    <div className="matrix-group" key={group.id}>
                      <button className="group-title" onClick={() => toggleGroup(group.id)}>
                        {collapsed[group.id] ? <CaretRight /> : <CaretDown />}
                        <span>{group.label}</span>
                      </button>
                      {!collapsed[group.id] &&
                        group.rows.map((row) => (
                          <div className="matrix-grid matrix-row" key={row.id}>
                            <div className="row-label">{row.label}</div>
                            {visiblePapers.map((paper) => {
                              const cell = data.cells[`${row.id}:${paper.id}`];
                              const isSelected =
                                selected?.rowId === row.id && selected.paperId === paper.id;
                              return (
                                <button
                                  className={`matrix-cell ${isSelected ? "selected" : ""}`}
                                  key={paper.id}
                                  disabled={!cell}
                                  onClick={() =>
                                    setSelected({
                                      rowId: row.id,
                                      rowLabel: row.label,
                                      groupLabel: group.label,
                                      paperId: paper.id,
                                    })
                                  }
                                >
                                  <span className="cell-value">{cell?.value ?? "—"}</span>
                                  <StatusMark type={cell?.status ?? "missing"} />
                                </button>
                              );
                            })}
                          </div>
                        ))}
                    </div>
                  ))
                )}
              </div>
            ) : null}
          </div>
        </section>

        <section className="evidence-panel">
          <div className="evidence-summary">
            <div className="evidence-heading">
              <div>
                <span className="eyebrow">选中证据</span>
                <h2>
                  {selected
                    ? `${selected.rowLabel} — ${selectedCell?.value ?? "—"}`
                    : "请选择一个证据单元格"}
                </h2>
              </div>
              {selectedCell ? (
                <span
                  className={`review-state ${
                    verified ? "verified" : selectedCell.status === "conflict" ? "conflict" : ""
                  }`}
                >
                  {verified ? (
                    <CheckCircle weight="fill" />
                  ) : selectedCell.status === "conflict" ? (
                    <WarningCircle weight="fill" />
                  ) : (
                    <Sparkle weight="fill" />
                  )}
                  {verified ? "已确认并锁定" : selectedCell.status === "conflict" ? "待处理冲突" : "AI 草稿"}
                </span>
              ) : null}
            </div>
            {selectedCell && selected ? (
              <>
                <dl>
                  <div>
                    <dt>维度</dt>
                    <dd>{selected.groupLabel}</dd>
                  </div>
                  <div>
                    <dt>论文</dt>
                    <dd>{selectedPaper?.title ?? selectedPaper?.name}</dd>
                  </div>
                  <div>
                    <dt>提取结论</dt>
                    <dd>{selectedCell.claim}</dd>
                  </div>
                  <div>
                    <dt>置信度</dt>
                    <dd>{selectedCell.confidence.toFixed(2)}</dd>
                  </div>
                </dl>
              </>
            ) : (
              <div className="empty-evidence">从上方矩阵中选择一项证据。</div>
            )}
          </div>

          <article className="source-preview">
            <header>
              <div>
                <FilePdf weight="duotone" />
                <span>
                  <strong>来源文档（PDF）</strong>
                  <small>{selectedPaper?.title ?? "尚未选择论文"}</small>
                </span>
              </div>
              <button
                className="text-button"
                onClick={openSource}
                disabled={!selectedPaper?.hasFile}
              >
                <ArrowsOutSimple /> {selectedPaper?.hasFile ? "打开原文" : "尚未上传"}
              </button>
            </header>
            <div className="paper-preview">
              <div className="paper-meta">
                <span>{selectedCell?.sourcePage ?? "—"}</span>
                <span>{selectedCell?.sourceSection ?? "—"}</span>
              </div>
              <h3>{selected ? `${selected.rowLabel} · ${selectedPaper?.title ?? "未命名论文"}` : "尚未选择证据"}</h3>
              {!selectedCell ? (
                <p className="source-empty">从上方矩阵中选择一个证据单元格，即可查看它的原文摘录。</p>
              ) : selectedCell.sourceExcerpt.trim() ? (
                <p>
                  <mark>{selectedCell.sourceExcerpt}</mark>
                </p>
              ) : (
                <p className="source-empty">该单元格还没有原文摘录。运行「AI 证据提取」后，会在这里显示对应页码的论文原文。</p>
              )}
            </div>
            <footer>
              <div className="verification-options">
                <span>证据核验</span>
                <button
                  className={selectedCell?.status === "confirmed" && !selectedCell.locked ? "chosen" : ""}
                  disabled={!selectedCell || saving || extracting}
                  onClick={() => void persistStatus("confirmed", false)}
                >
                  <CheckCircle /> 原文一致
                </button>
                <button
                  disabled={!selectedCell || saving || extracting}
                  onClick={() => void persistStatus("draft", false)}
                >
                  <PencilSimple /> 需要修订
                </button>
                <button
                  className={selectedCell?.status === "conflict" ? "chosen conflict" : ""}
                  disabled={!selectedCell || saving || extracting}
                  onClick={() => void persistStatus("conflict", false)}
                >
                  <WarningCircle /> 标记冲突
                </button>
              </div>
              <button
                className="confirm"
                disabled={!selectedCell || saving || extracting}
                onClick={() => void persistStatus("confirmed", true)}
              >
                <LockSimple />
                {saving ? "正在保存" : verified ? "已确认并锁定" : "确认并锁定"}
              </button>
            </footer>
          </article>
        </section>
      </div>
      {batchReview ? <BatchReviewDialog review={batchReview} saving={saving} error={reviewError} onClose={() => { if (!saving) setBatchReview(null); }} onConfirm={() => void persistBatchReview()} /> : null}
      <noscript>
        <p style={{ padding: 24 }}>
          ArguMesh requires JavaScript to render the Evidence Matrix.
        </p>
      </noscript>
    </>
  );
}
