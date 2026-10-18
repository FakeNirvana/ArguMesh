import { FloppyDisk, Sparkle, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { generatePaperCard, getAiModels } from "../api";
import { extractPdfText } from "../pdf/document";
import { getPaperPdf } from "../storage/paperFiles";
import { useWorkspace, type PaperCard, type PaperCardSources } from "../state/workspace";

const FIELDS: Array<{ key: keyof Omit<PaperCard, "confirmed" | "updatedAt" | "generatedBy" | "generatedAt" | "generatedSource" | "sources">; label: string; hint: string }> = [
  { key: "problem", label: "研究问题", hint: "论文试图解决什么问题？" },
  { key: "method", label: "方法", hint: "核心方法、架构或理论是什么？" },
  { key: "data", label: "数据与评测", hint: "使用哪些数据集、基线和指标？" },
  { key: "findings", label: "主要发现", hint: "作者报告了哪些关键结果？" },
  { key: "limitations", label: "局限性", hint: "适用边界、失败模式和未解决问题。" },
];

const EMPTY_DRAFT = { problem: "", method: "", data: "", findings: "", limitations: "" };

interface GenMeta {
  model: string;
  generatedAt: string;
  source: string;
  sources: PaperCardSources;
}

export function PaperCardEditor() {
  const { projectId = "", paperId = "" } = useParams<{ projectId: string; paperId: string }>();
  const { papers, updatePaper } = useWorkspace();
  const paper = papers.find((item) => item.id === paperId && item.projectIds.includes(projectId));
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [abstract, setAbstract] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [genMeta, setGenMeta] = useState<GenMeta | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState("");
  const [currentModel, setCurrentModel] = useState("");
  const [generationModel, setGenerationModel] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getAiModels().then(({ model }) => { if (!cancelled) setCurrentModel(model); });
    return () => { cancelled = true; };
  }, []);

  // 切换论文时把草稿/摘要/确认/来源状态重置为该论文本地卡片(如有)。
  useEffect(() => {
    const next = paper?.card;
    setDraft(next ? { problem: next.problem, method: next.method, data: next.data, findings: next.findings, limitations: next.limitations } : EMPTY_DRAFT);
    setAbstract(paper?.abstract ?? "");
    setConfirmed(Boolean(next?.confirmed));
    setGenMeta(next?.generatedBy ? { model: next.generatedBy, generatedAt: next.generatedAt ?? "", source: next.generatedSource ?? "", sources: next.sources ?? { problem: "", method: "", data: "", findings: "", limitations: "" } } : null);
    setGenError("");
    setSaved(false);
  }, [paperId]);

  if (!paper) return null;

  /**
   * 解析 AI 生成的事实来源:优先浏览器本地 PDF 文本,其次当前表单里的摘要(未保存也能用)。没有原文则拒绝生成。
   * 文本上限 15K:真实 PDF 的 30K 全文让 StepFun 推理逼近 55s 超时(生产 502,2026-08-14),
   * 15K(约 20–30 页)已足以支撑五字段提取;省略处由后端 trimTextForLlm 再兜底标注。
   */
  const MAX_LLM_TEXT = 15_000;
  const resolveMaterial = async (): Promise<{ text: string; source: string }> => {
    const blob = await getPaperPdf(paperId);
    if (blob) {
      const pages = await extractPdfText(blob, paperId, { maxPages: 50, maxChars: MAX_LLM_TEXT });
      const text = pages.map((page) => page.text).join("\n").slice(0, MAX_LLM_TEXT);
      return { text, source: `PDF 文本（前 ${text.length} 字）` };
    }
    const abstractText = abstract.trim();
    if (abstractText.length >= 100) return { text: abstractText.slice(0, MAX_LLM_TEXT), source: "论文摘要" };
    throw new Error("AI 生成需要原文依据：请先上传 PDF，或填写论文摘要（≥100 字）。生成只依据上传的文本，不会凭标题臆造。");
  };

  const generate = async () => {
    setGenerating(true);
    setGenerationModel(null);
    setGenError("");
    try {
      const [{ text, source }, { model }] = await Promise.all([resolveMaterial(), getAiModels()]);
      setCurrentModel(model);
      if (text.trim().length < 100) {
        setGenError("可供 AI 依据的原文太短（<100 字），请上传完整 PDF 后重试。");
        return;
      }
      setGenerationModel(model);
      const result = await generatePaperCard(paperId, { text, title: paper.title, authors: paper.authors, source, model: model || undefined });
      setCurrentModel(result.model);
      setDraft(result.card);
      setConfirmed(false);
      setGenMeta({ model: result.model, generatedAt: result.generatedAt, source: result.source, sources: result.sources });
    } catch (error) {
      setGenError(error instanceof Error ? (error.message === "Unauthorized" ? "登录已过期，请重新登录。" : error.message) : "AI 卡片生成失败，请重试。");
    } finally {
      setGenerating(false);
    }
  };

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    updatePaper(paperId, {
      abstract: abstract.trim() || undefined,
      card: {
        ...draft,
        confirmed,
        updatedAt: new Date().toISOString(),
        generatedBy: genMeta?.model,
        generatedAt: genMeta?.generatedAt,
        generatedSource: genMeta?.source,
        sources: genMeta?.sources,
      },
    });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1600);
  }

  return (
      <form className="surface-card paper-card-editor" onSubmit={save}>
        <header><div><span className="eyebrow">Paper Card</span><h2>结构化论文资产</h2></div>
          <button className="secondary-button" type="button" disabled={generating} onClick={() => void generate()} title={`依据浏览器中的 PDF/摘要文本生成草稿，模型：${(generating ? generationModel : currentModel) || "以设置页当前配置为准"}，约 1 次调用 · 3 万字输入上限`}><Sparkle />{generating ? "AI 生成中…（约 30 秒）" : "AI 生成草稿"}</button>
        </header>
        {genError ? <p className="form-error card-gen-error" role="alert"><WarningCircle weight="fill" />{genError}</p> : null}
        {generating ? <p className="form-hint" role="status" aria-live="polite"><Sparkle /> {generationModel === null ? "正在准备原文并读取当前模型配置…" : `正在调用 ${generationModel || "当前配置的模型"} 依据原文生成草稿，完成后请对照原文审阅确认。`}</p> : null}
        <label className="paper-abstract-field"><span>论文摘要{abstract.trim().length >= 100 ? <em className="ai-field-badge">AI 生成可用</em> : <em className="ai-field-badge">摘要过短，AI 生成不可用</em>}</span><textarea name="abstract" value={abstract} onChange={(event) => setAbstract(event.target.value)} placeholder="粘贴论文摘要（≥100 字）。没有 PDF 时，AI 生成会依据摘要进行。" rows={4} /></label>
        {FIELDS.map((field) => <label key={field.key}><span>{field.label}{genMeta ? <em className="ai-field-badge">AI 草稿</em> : null}</span><textarea name={field.key} value={draft[field.key]} onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))} placeholder={field.hint} /></label>)}
        {genMeta ? <details className="ai-evidence-panel" open><summary>AI 草稿依据 · {genMeta.model} · {new Date(genMeta.generatedAt).toLocaleString("zh-CN")} · {genMeta.source}</summary>{FIELDS.map((field) => <p key={field.key}><strong>{field.label}</strong><span>{genMeta.sources[field.key] || "文中未说明"}</span></p>)}</details> : null}
        <footer><label className="check-control"><input name="confirmed" type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我已对照原文确认</label><button className="primary"><FloppyDisk />{saved ? "已保存" : "保存 Paper Card"}</button></footer>
      </form>
  );
}
