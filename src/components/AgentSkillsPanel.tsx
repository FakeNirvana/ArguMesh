import { BookOpenText, DownloadSimple, FolderOpen, PuzzlePiece, Trash, UploadSimple, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState, type InputHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { getAgentSkill, getAgentSkillSnapshot, installAgentSkill, setAgentSkillEnabled, uninstallAgentSkill, type AgentSkill, type AgentSkillFile, type AgentSkillSnapshot, type AgentSkillSummary, type AgentSkillUsage } from "../api";
import { EmptyState, ErrorState, LoadingState } from "./states";
import { useDialogKeyboard } from "./useDialogKeyboard";

const TEXT_EXTENSION = /\.(?:md|txt|jsonl?|ya?ml|csv|tsv|rst|bib|tex|toml|ini|py|sh|bash|ps1|[cm]?js|tsx?|r|ipynb)$/i;
const DIRECTORY_INPUT = { webkitdirectory: "", directory: "" } as InputHTMLAttributes<HTMLInputElement>;

export interface SkillImportPreview {
  files: AgentSkillFile[];
  skipped: string[];
  name: string;
  instructions: string;
  hasScripts: boolean;
}

/** Read only explicitly selected text files; the server validates package metadata and paths again. */
export async function prepareSkillImport(selected: File[]): Promise<SkillImportPreview> {
  const skipped: string[] = [];
  const accepted = selected.filter((file) => {
    if (TEXT_EXTENSION.test(file.name)) return true;
    skipped.push(file.webkitRelativePath || file.name);
    return false;
  });
  if (!accepted.length) throw new Error("请选择 SKILL.md，或包含 SKILL.md 的技能文件夹。");
  if (accepted.length > 64) throw new Error("每个技能最多导入 64 个文本文件。");
  if (accepted.some((file) => file.size > 64 * 1024)) throw new Error("每个文本文件不能超过 64 KB。");
  if (accepted.reduce((size, file) => size + file.size, 0) > 512 * 1024) throw new Error("技能包的文本文件总大小不能超过 512 KB。");
  const files = await Promise.all(accepted.map(async (file) => {
    const content = await file.text();
    if (content.includes("\0") || content.includes("\uFFFD")) throw new Error(`${file.name} 不是有效的 UTF-8 文本，请转换编码后再导入。`);
    return { path: file.webkitRelativePath || file.name, content };
  }));
  const instructions = files.filter((file) => /(?:^|\/)SKILL\.md$/.test(file.path));
  if (instructions.length !== 1) throw new Error("每次只能安装一个技能，文件夹内须有唯一的 SKILL.md。");
  const name = instructions[0].content.match(/^name:\s*["']?([^\r\n"']+)["']?\s*$/m)?.[1]?.trim() || "待校验的技能";
  return { files, skipped, name, instructions: instructions[0].content, hasScripts: files.some((file) => /\.(?:py|sh|bash|ps1|[cm]?js|tsx?|r|ipynb)$/i.test(file.path)) };
}

function messageOf(cause: unknown) { return cause instanceof Error ? cause.message : "操作失败，请重试。"; }

interface AgentSkillsPanelProps {
  skills: AgentSkillSummary[];
  loading: boolean;
  error: string;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}

export function AgentSkillsPanel({ skills, loading, error: listError, onRefresh, onClose }: AgentSkillsPanelProps) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<SkillImportPreview | null>(null);
  const [detail, setDetail] = useState<AgentSkill | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [filePath, setFilePath] = useState("SKILL.md");
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const operationRef = useRef(false);
  const requestRef = useRef(0);
  const close = useCallback(() => { if (!operationRef.current) onClose(); }, [onClose]);
  const dialogRef = useDialogKeyboard<HTMLDivElement>(close);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { requestRef.current += 1; if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [dialogRef]);

  async function readFiles(selected: File[]) {
    if (operationRef.current || !selected.length) return;
    requestRef.current += 1; setDetailLoading(false);
    operationRef.current = true; setBusy(true); setError(""); setNotice("");
    try { setPreview(await prepareSkillImport(selected)); setDetail(null); }
    catch (cause) { setError(messageOf(cause)); setPreview(null); }
    finally { operationRef.current = false; setBusy(false); }
  }
  async function perform(operation: () => Promise<unknown>, success: string) {
    if (operationRef.current) return;
    operationRef.current = true; setBusy(true); setError(""); setNotice("");
    try { await operation(); await onRefresh(); setNotice(success); }
    catch (cause) { setError(messageOf(cause)); }
    finally { operationRef.current = false; setBusy(false); }
  }
  async function viewSkill(id: string) {
    const request = ++requestRef.current;
    setDetailLoading(true); setPreview(null); setDetail(null); setError("");
    try {
      const result = await getAgentSkill(id);
      if (request === requestRef.current) { setDetail(result.skill); setFilePath(result.skill.files.find((file) => file.path === "SKILL.md")?.path ?? result.skill.files[0]?.path ?? ""); }
    } catch (cause) { if (request === requestRef.current) setError(messageOf(cause)); }
    finally { if (request === requestRef.current) setDetailLoading(false); }
  }
  function install() {
    if (!preview) return;
    void perform(async () => { const result = await installAgentSkill(preview.files); setPreview(null); setDetail(result.skill); setFilePath("SKILL.md"); }, "技能已安装，可在对话中选择使用。");
  }
  function remove(skill: AgentSkillSummary) {
    if (!window.confirm(`卸载「${skill.name}」？已有会话中的技能使用记录仍会保留。`)) return;
    requestRef.current += 1; setDetailLoading(false);
    void perform(async () => { await uninstallAgentSkill(skill.id); if (detail?.id === skill.id) setDetail(null); }, "技能已卸载，已有会话记录保留。");
  }
  function downloadExample() {
    const blob = new Blob(["---\nname: my-research-skill\ndescription: 在需要梳理研究问题和证据时使用，输出待核验的建议。\n---\n\n# 我的研究技能\n\n先读取当前项目上下文，区分事实与假设，为每项判断引用项目对象。\n仅使用提供的领域工具；需要写入时只创建一个草稿，不能执行脚本或修改任意文件。\n"], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob); const link = document.createElement("a");
    link.href = url; link.download = "SKILL.md"; link.click(); URL.revokeObjectURL(url);
  }

  const activeFile = detail?.files.find((file) => file.path === filePath);
  return createPortal(<div className="crud-modal-backdrop agent-skills-backdrop" onClick={close}>
    <div className="agent-skills-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-skills-title" ref={dialogRef} onClick={(event) => event.stopPropagation()} aria-busy={busy}>
      <header className="agent-skills-header">
        <span className="agent-skills-heading-icon"><PuzzlePiece /></span>
        <div><span className="agent-skills-eyebrow">RESEARCH AGENT</span><h2 id="agent-skills-title">研究技能</h2><p>选择内置工作流，或安装你自己的技能。已启用的技能可供所有项目使用。</p></div>
        <button type="button" disabled={busy} onClick={close} aria-label="关闭技能管理"><X /></button>
      </header>
      <div className="agent-skills-import-bar">
        <div><strong>安装自己的技能</strong><span>支持 SKILL.md 和技能文件夹；只导入文本，脚本不会执行。</span></div>
        <button type="button" disabled={busy} onClick={() => fileInput.current?.click()}><UploadSimple />选择文件</button>
        <button type="button" disabled={busy} onClick={() => folderInput.current?.click()}><FolderOpen />选择文件夹</button>
        <input ref={fileInput} className="visually-hidden" type="file" accept=".md" aria-label="选择技能说明文件" disabled={busy} onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; void readFiles(files); }} />
        <input ref={folderInput} className="visually-hidden" type="file" multiple {...DIRECTORY_INPUT} aria-label="选择技能文件夹" disabled={busy} onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; void readFiles(files); }} />
      </div>
      <div className="agent-skills-body">
        {(error || listError) ? <ErrorState title="技能操作未完成" description={error || listError} onRetry={() => { setError(""); void onRefresh(); }} /> : null}
        {notice ? <p className="agent-skills-notice" role="status">{notice}</p> : null}
        {preview ? <section className="agent-skill-install-preview" aria-label="安装预览">
          <header><div><span className="agent-skills-eyebrow">安装预览</span><h3>{preview.name}</h3><p>{preview.files.length} 个文本文件 · 安装时校验名称、内容和路径</p></div><button type="button" disabled={busy} onClick={() => setPreview(null)}>取消</button></header>
          {preview.skipped.length ? <div className="agent-skill-warning" role="status">已跳过 {preview.skipped.length} 个非文本文件；它们不会安装。<details><summary>查看跳过的文件</summary><ul>{preview.skipped.map((path, index) => <li key={`${index}-${path}`}>{path}</li>)}</ul></details></div> : null}
          {preview.hasScripts ? <p className="agent-skill-warning">包含脚本文本：可以查看内容，但 Research Agent 不会执行这些脚本。需要外部工具的步骤可能无法完成。</p> : null}
          <details><summary>查看将安装的文件</summary><ul>{preview.files.map((file) => <li key={file.path}>{file.path}</li>)}</ul></details>
          <pre className="agent-skill-source">{preview.instructions}</pre>
          <footer><span>同名技能不会被覆盖。安装后可预览、停用或卸载。</span><button className="primary" type="button" disabled={busy} onClick={install}>{busy ? "正在安装…" : `确认安装 · ${preview.files.length} 个文件`}</button></footer>
        </section> : null}
        {detailLoading ? <LoadingState title="正在读取技能内容…" /> : null}
        {detail ? <section className="agent-skill-detail" aria-label={`技能内容：${detail.name}`}>
          <header><div><span className="agent-skills-eyebrow">{detail.source === "builtin" ? "内置技能" : "用户安装"} · {detail.version.slice(0, 8)}</span><h3>{detail.name}</h3><p>{detail.description}</p></div><button type="button" disabled={busy} onClick={() => { requestRef.current += 1; setDetail(null); }}>收起</button></header>
          <label>预览文件<select value={filePath} onChange={(event) => setFilePath(event.target.value)}>{detail.files.map((file) => <option key={file.path} value={file.path}>{file.path}</option>)}</select></label>
          <div className="agent-skill-detail-content"><pre className="agent-skill-source">{activeFile?.content ?? "文件内容不可用"}</pre></div>
          {detail.warnings.map((warning) => <p className="agent-skill-warning" key={warning}>{warning}</p>)}
        </section> : null}
        {loading && !skills.length ? <LoadingState title="正在加载研究技能…" /> : null}
        {!loading && !skills.length && !listError ? <EmptyState icon={<PuzzlePiece />} title="尚无可用技能" description="可选择本地 SKILL.md 或技能文件夹安装。" /> : null}
        {(["builtin", "user"] as const).map((source) => {
          const group = skills.filter((skill) => skill.source === source);
          if (!group.length) return null;
          return <section className="agent-skill-group" key={source}><header><h3>{source === "builtin" ? "内置技能" : "已安装的技能"}</h3><span>{group.length} 项</span></header><div className="agent-skill-list">{group.map((skill) => <article className={`agent-skill-card${skill.enabled ? "" : " is-disabled"}`} key={skill.id}>
            <div className="agent-skill-card-title"><BookOpenText /><h4>{skill.name}</h4><span>{skill.enabled ? "已启用" : "已停用"}</span></div><p>{skill.description}</p>
            <div className="agent-skill-card-meta"><span>{skill.fileCount} 个文件</span><span title={`内容版本 ${skill.version}`}>版本 {skill.version.slice(0, 8)}</span></div>
            {skill.warnings.length ? <p className="agent-skill-warning">{skill.warnings[0]}</p> : null}
            <footer><button type="button" disabled={busy} onClick={() => void viewSkill(skill.id)}>查看内容</button><label className="agent-skill-switch"><input type="checkbox" checked={skill.enabled} disabled={busy} aria-label={`${skill.enabled ? "停用" : "启用"}技能：${skill.name}`} onChange={() => void perform(async () => { await setAgentSkillEnabled(skill.id, !skill.enabled); setDetail((current) => current?.id === skill.id ? { ...current, enabled: !skill.enabled } : current); }, skill.enabled ? "技能已停用，不会用于新的回合。" : "技能已启用。")} /><span>{skill.enabled ? "启用中" : "已停用"}</span></label>{source === "user" ? <button className="agent-skill-uninstall" type="button" disabled={busy} onClick={() => remove(skill)} aria-label={`卸载技能：${skill.name}`}><Trash />卸载</button> : null}</footer>
          </article>)}</div></section>;
        })}
      </div>
      <footer className="agent-skills-footer"><button type="button" disabled={busy} onClick={downloadExample}><DownloadSimple />下载技能示例</button><span>已使用的技能会随消息记录来源与版本。</span></footer>
    </div>
  </div>, document.body);
}

/** Read the immutable package used by a past turn, including after uninstall or reinstall. */
export function AgentSkillHistoryPreview({ projectId, conversationId, messageId, usage, onClose }: {
  projectId: string; conversationId: string; messageId: string; usage: AgentSkillUsage; onClose: () => void;
}) {
  const [skill, setSkill] = useState<AgentSkillSnapshot | null>(null);
  const [error, setError] = useState("");
  const [filePath, setFilePath] = useState("SKILL.md");
  const dialogRef = useDialogKeyboard<HTMLDivElement>(onClose);
  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [dialogRef]);
  useEffect(() => {
    let cancelled = false;
    setSkill(null); setError("");
    getAgentSkillSnapshot(projectId, conversationId, messageId, usage.id).then((result) => {
      if (cancelled) return;
      setSkill(result.skill); setFilePath(result.skill.files.find((file) => file.path === "SKILL.md")?.path ?? result.skill.files[0]?.path ?? "");
    }).catch((cause) => { if (!cancelled) setError(messageOf(cause)); });
    return () => { cancelled = true; };
  }, [projectId, conversationId, messageId, usage.id]);
  const activeFile = skill?.files.find((file) => file.path === filePath);
  return createPortal(<div className="crud-modal-backdrop agent-skills-backdrop" onClick={onClose}>
    <div className="agent-skills-dialog" role="dialog" aria-modal="true" aria-labelledby="agent-skill-history-title" ref={dialogRef} onClick={(event) => event.stopPropagation()}>
      <header className="agent-skills-header"><span className="agent-skills-heading-icon"><BookOpenText /></span><div><span className="agent-skills-eyebrow">本回合使用的版本</span><h2 id="agent-skill-history-title">{usage.name}</h2><p>{usage.source === "builtin" ? "内置技能" : "用户安装"} · 版本 {usage.version.slice(0, 8)} · {new Date(usage.loadedAt).toLocaleString()}</p></div><button type="button" onClick={onClose} aria-label="关闭技能历史预览"><X /></button></header>
      <div className="agent-skills-body">
        {error ? <ErrorState title="无法读取技能快照" description={error} /> : null}
        {!skill && !error ? <LoadingState title="正在读取本回合的技能快照…" /> : null}
        {skill ? <section className="agent-skill-detail"><p>{skill.description}</p><label>预览原版本文件<select value={filePath} onChange={(event) => setFilePath(event.target.value)}>{skill.files.map((file) => <option key={file.path} value={file.path}>{file.path}</option>)}</select></label><div className="agent-skill-detail-content"><pre className="agent-skill-source">{activeFile?.content ?? "文件内容不可用"}</pre></div></section> : null}
      </div>
      <footer className="agent-skills-footer"><span>保存的是本回合实际使用的内容；卸载或重新安装不会改写该记录。</span></footer>
    </div>
  </div>, document.body);
}
