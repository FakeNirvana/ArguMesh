import { BookOpenText, CheckCircle, FileText, Quotes } from "@phosphor-icons/react";
import { Link, useParams } from "react-router-dom";
import { EmptyState } from "../components/states";
import { PageHeader } from "../components/PageHeader";
import { PaperCardEditor } from "../components/PaperCardEditor";
import { useWorkspace } from "../state/workspace";

export function PaperPage() {
  const { projectId = "", paperId = "" } = useParams<{ projectId: string; paperId: string }>();
  const { papers, projects, readerAnswers, readerExcerpts, knowledge } = useWorkspace();
  const paper = papers.find((item) => item.id === paperId && item.projectIds.includes(projectId));
  const project = projects.find((item) => item.id === projectId);
  if (!paper) return <div className="route-page"><EmptyState icon={<BookOpenText />} title="当前项目中没有这篇文献" description="请返回项目文献库重新选择。" /></div>;
  const card = paper.card;
  const excerpts = readerExcerpts.filter((item) => item.paperId === paperId && item.projectId === projectId);
  const answers = readerAnswers.filter((item) => item.paperId === paperId && item.projectId === projectId);
  const items = knowledge.filter((item) => item.paperId === paperId && item.projectId === projectId);
  const confidenceLabel = card?.confirmed ? "已人工确认" : card?.generatedBy ? "AI 草稿（待人工确认）" : "草稿";

  return <div className="route-page paper-page">
    <PageHeader eyebrow={`${project?.name ?? "项目"} · Paper`} title={paper.title} description={`${paper.authors} · ${paper.venue} ${paper.year}`} actions={<><Link className="secondary-button" to={`/projects/${encodeURIComponent(projectId)}/library/${encodeURIComponent(paperId)}/read?panel=card`}><FileText />对照 PDF 填写</Link><Link className="secondary-button" to={`/projects/${encodeURIComponent(projectId)}/library/${encodeURIComponent(paperId)}/read`}><BookOpenText />阅读 PDF</Link><Link className="secondary-button" to={`/projects/${encodeURIComponent(projectId)}/research?view=insights`}><Quotes />项目研究脉络</Link></>} />
    <div className="paper-workspace-grid">
      <PaperCardEditor key={paperId} />
      <aside className="paper-activity-stack">
        <section className="surface-card summary-card"><span className="eyebrow">可信度</span><strong>{confidenceLabel}</strong><p>{card?.updatedAt ? `最近更新 ${new Date(card?.updatedAt).toLocaleString("zh-CN")}` : "尚未填写 Paper Card"}</p>{card?.confirmed ? <CheckCircle weight="fill" /> : <FileText />}</section>
        <section className="surface-card activity-card"><h2>阅读产物</h2><dl><div><dt>摘录</dt><dd>{excerpts.length}</dd></div><div><dt>问答</dt><dd>{answers.length}</dd></div><div><dt>知识对象</dt><dd>{items.length}</dd></div></dl></section>
      </aside>
    </div>
  </div>;
}
