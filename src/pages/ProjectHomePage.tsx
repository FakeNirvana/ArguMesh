import { ArrowRight, BookOpenText, Brain, CaretDown, ChatCircleDots, ClockCounterClockwise, Flask, FolderSimple, GitBranch, GridFour, PaperPlaneTilt, PuzzlePiece, Stop, Trash, Wrench } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  AgentTurnBusyError,
  cancelAiConversation,
  createAiConversation,
  deleteAiConversation,
  getAiConversation,
  getResearchThread,
  listAiConversations,
  listExperiments,
  listAgentSkills,
  sendAiMessage,
  type AiAction,
  type AiConversation,
  type AiMessage,
  type AgentSkillSummary,
  type AgentSkillUsage,
  type ResearchThread,
} from "../api";
import { AgentMarkdown } from "../components/AgentMarkdown";
import { AgentSkillHistoryPreview, AgentSkillsPanel } from "../components/AgentSkillsPanel";
import { EmptyState } from "../components/states";
import { useWorkspace } from "../state/workspace";

const TOOL_LABELS: Record<string, string> = {
  skill_load: "加载研究技能",
  skill_read: "读取技能资料",
  web_search: "网页搜索",
  project_context: "读取项目上下文",
  insight_create_draft: "已创建研究洞见草稿",
  research_question_create_draft: "已创建研究问题草稿",
  experiment_design_create_draft: "已创建实验设计草稿",
  result_analysis_create_draft: "已保存实验结果分析草稿",
  paper_patch_propose: "已生成论文 Diff 提案",
  research_question_link_evidence: "已关联研究问题证据",
  ablation_design_add: "已追加消融实验草稿",
  bibliography_entry_propose: "已生成 BibTeX 条目提案",
  latex_compile: "已完成 LaTeX 编译检查",
};

export function ProjectHomePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { projects, papers, matrices } = useWorkspace();
  const project = projects.find((item) => item.id === projectId);
  const [conversations, setConversations] = useState<AiConversation[]>([]);
  const [activeId, setActiveId] = useState("");
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [actions, setActions] = useState<AiAction[]>([]);
  const [thread, setThread] = useState<ResearchThread | null>(null);
  const [experimentCount, setExperimentCount] = useState(0);
  const [sending, setSending] = useState(false);
  const [streamHint, setStreamHint] = useState("");
  const [error, setError] = useState("");
  const [skills, setSkills] = useState<AgentSkillSummary[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [skillsError, setSkillsError] = useState("");
  const [selectedSkill, setSelectedSkill] = useState("auto");
  const [showSkills, setShowSkills] = useState(false);
  const [historicalSkill, setHistoricalSkill] = useState<{ messageId: string; conversationId: string; usage: AgentSkillUsage } | null>(null);
  const skillsRequestRef = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);
  const sendingRef = useRef<AbortController | null>(null);
  const refreshSkills = useCallback(async () => {
    const request = ++skillsRequestRef.current;
    setSkillsLoading(true); setSkillsError("");
    try {
      const response = await listAgentSkills();
      if (request !== skillsRequestRef.current) return;
      setSkills(response.skills);
      setSelectedSkill((current) => current === "auto" || current === "none" || response.skills.some((skill) => skill.id === current && skill.enabled) ? current : "auto");
    } catch (cause) {
      if (request === skillsRequestRef.current) setSkillsError(cause instanceof Error ? cause.message : "无法加载技能，请重试。");
    } finally { if (request === skillsRequestRef.current) setSkillsLoading(false); }
  }, []);
  useEffect(() => {
    setSelectedSkill("auto"); setShowSkills(false); setHistoricalSkill(null); setSkills([]);
    void refreshSkills();
    return () => { skillsRequestRef.current += 1; };
  }, [projectId, refreshSkills]);
  useEffect(() => {
    setSending(false); setStreamHint(""); setError("");
    return () => { sendingRef.current?.abort(); sendingRef.current = null; };
  }, [projectId]);

  const loadConversation = useCallback(async (pid: string, conversationId: string, isCurrent: () => boolean = () => true) => {
    const detail = await getAiConversation(pid, conversationId);
    if (!isCurrent()) return;
    setMessages(detail.messages); setActions(detail.actions); setActiveId(conversationId);
  }, []);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    Promise.all([listAiConversations(projectId), getResearchThread(projectId), listExperiments(projectId)])
      .then(async ([conversationRes, threadRes, experimentRes]) => {
        if (cancelled) return;
        setThread(threadRes); setExperimentCount(experimentRes.experiments.length);
        let list = conversationRes.conversations;
        if (!list.length) {
          const created = await createAiConversation(projectId);
          list = [created.conversation];
        }
        if (cancelled) return;
        setConversations(list);
        await loadConversation(projectId, list[0].id, () => !cancelled);
      }).catch(() => { if (!cancelled) setError("无法加载项目研究助手。"); });
    return () => { cancelled = true; };
  }, [projectId, loadConversation]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, sending]);

  const actionsByMessage = useMemo(() => new Map(actions.map((action) => [action.messageId, action])), [actions]);
  const active = conversations.find((conversation) => conversation.id === activeId);
  if (!project) return <div className="route-page"><EmptyState icon={<FolderSimple />} title="项目不存在" description="该项目可能已被删除，或链接不正确。" action={<Link className="primary" to="/projects">返回项目列表</Link>} /></div>;

  const encodedId = encodeURIComponent(project.id);
  const projectPapers = papers.filter((paper) => paper.projectIds.includes(project.id));
  const projectMatrices = matrices.filter((matrix) => matrix.projectId === project.id);

  async function newConversation() {
    if (!projectId) return;
    const created = await createAiConversation(projectId);
    setConversations((items) => [created.conversation, ...items]);
    setActiveId(created.conversation.id); setMessages([]); setActions([]); setError(""); setStreamHint("");
  }
  async function stopConversation() {
    if (!projectId || !activeId) return;
    try {
      await cancelAiConversation(projectId, activeId);
      sendingRef.current?.abort();
      setError("");
      setConversations((items) => items.map((item) => item.id === activeId ? { ...item, status: "cancelled" } : item));
    } catch { setError("无法结束会话，请重试。"); }
  }
  async function removeConversation(conversationId: string) {
    if (!projectId || !window.confirm("确定删除该会话？消息与动作记录将一并清除。")) return;
    await deleteAiConversation(projectId, conversationId);
    const remaining = conversations.filter((item) => item.id !== conversationId);
    if (!remaining.length) {
      const created = await createAiConversation(projectId);
      setConversations([created.conversation]);
      setActiveId(created.conversation.id);
      setMessages([]);
      setActions([]);
      return;
    }
    setConversations(remaining);
    if (activeId === conversationId) {
      await loadConversation(projectId, remaining[0].id);
    }
  }
  async function submitContent(content: string, skillSelection: string[] | null = selectedSkill === "auto" ? null : selectedSkill === "none" ? [] : [selectedSkill]) {
    if (!projectId || !activeId || !content.trim() || sendingRef.current || active?.status === "cancelled") return;
    const controller = new AbortController();
    sendingRef.current = controller;
    const optimistic: AiMessage = {
      id: `local-${Date.now()}`, conversationId: activeId, projectId, role: "user", content: content.trim(), citations: [],
      model: null, status: "completed", error: "", createdAt: new Date().toISOString(), skillSelection,
    };
    setMessages((items) => [...items, optimistic]); setSending(true); setError(""); setStreamHint("Research Agent 推理中…");
    try {
      await sendAiMessage(projectId, activeId, content.trim(), (event) => {
        if (sendingRef.current !== controller) return;
        if (event.type === "tool_start") {
          const name = String(event.toolName ?? "");
          setStreamHint(`工具：${TOOL_LABELS[name] ?? name}`);
        }
        else if (event.type === "text_delta") setStreamHint("生成回复中…");
        else if (event.type === "agent_end" || event.type === "done") setStreamHint("");
      }, controller.signal, { skillIds: skillSelection ?? undefined });
      if (sendingRef.current !== controller) return;
      await loadConversation(projectId, activeId, () => sendingRef.current === controller);
      if (sendingRef.current !== controller) return;
      const refreshed = await listAiConversations(projectId);
      if (sendingRef.current === controller) setConversations(refreshed.conversations);
    } catch (cause) {
      if (sendingRef.current !== controller) return;
      const detail = cause instanceof Error && cause.message.trim() ? cause.message.trim() : "";
      if (!controller.signal.aborted) setError(
        detail
          ? `本回合失败：${detail}`
          : "本回合失败。消息已保留，可以在下方重试；请检查 AI 配置或网络。",
      );
      await getAiConversation(projectId, activeId, { healPending: !(cause instanceof AgentTurnBusyError) })
        .then((detail) => { if (sendingRef.current === controller) { setMessages(detail.messages); setActions(detail.actions); } })
        .catch(() => undefined);
    } finally { if (sendingRef.current === controller) { sendingRef.current = null; setSending(false); setStreamHint(""); } }
  }
  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const fd = new FormData(form); const content = String(fd.get("message") ?? "");
    form.reset(); void submitContent(content);
  }

  return <div className="project-agent-page">
    <section className="agent-conversation-pane" aria-label="Research Agent 对话">
      <header className="agent-pane-header">
        <div className="agent-project-heading">
          <div className="agent-breadcrumb"><span>项目</span><ArrowRight /><strong>Research Agent</strong><span>会话 · {active?.title ?? "新研究对话"}</span></div>
          <div className="agent-title-row"><h1>{project.name}</h1><span className="agent-project-state">研究中</span></div>
        </div>
        <div className="agent-session-controls" role="group" aria-label="会话操作">
          <button type="button" className="agent-new-conversation" disabled={sending} onClick={newConversation}><ChatCircleDots weight="bold" />新对话</button>
          <details className="agent-history-menu">
            <summary aria-label={`历史记录，共 ${conversations.length} 条`}>
              <ClockCounterClockwise weight="bold" />历史记录
              <span className="agent-history-count" aria-hidden="true">{conversations.length}</span>
              <CaretDown />
            </summary>
            <div className="agent-history-popover" role="menu">
              <header><strong>项目会话</strong><span>{conversations.length} 条</span></header>
              {conversations.length === 0 ? <p className="agent-history-empty">暂无会话</p> : null}
              {conversations.map((conversation) => (
                <div className={`agent-history-row${conversation.id === activeId ? " active" : ""}`} role="menuitem" key={conversation.id}>
                  <button type="button" className="agent-history-open" disabled={sending} onClick={(event) => {
                    if (projectId) void loadConversation(projectId, conversation.id);
                    event.currentTarget.closest("details")?.removeAttribute("open");
                  }}><span>{conversation.title}</span><small>{conversation.status === "cancelled" ? "已结束" : new Date(conversation.updatedAt).toLocaleDateString()}</small></button>
                  <button type="button" className="agent-history-delete" disabled={sending} aria-label={`删除会话：${conversation.title}`} title="删除会话" onClick={(event) => {
                    event.stopPropagation();
                    void removeConversation(conversation.id);
                  }}><Trash weight="bold" /></button>
                </div>
              ))}
            </div>
          </details>
        </div>
      </header>

      <div className="agent-message-scroll">
        {!messages.length ? <div className="agent-welcome">
          <span><Brain /></span><h2>从项目证据开始，而不是从空白提示词开始</h2>
          <p>我会读取当前项目的文献、洞见、研究问题、实验设计和真实结果。所有创建动作都是草稿，引用可以回到原对象。</p>
          <div className="agent-suggestions">
            <button onClick={() => submitContent("梳理当前项目最重要的研究洞见，并指出证据不足的地方。")}>梳理研究洞见</button>
            <button onClick={() => submitContent("基于现有证据，提出一个可验证的研究问题，但先不要创建。")}>形成研究问题</button>
            <button onClick={() => submitContent("检查当前实验设计是否缺少必要的基线或消融。")}>检查实验设计</button>
          </div>
        </div> : null}
        {messages.map((message) => {
          const action = actionsByMessage.get(message.id);
          return <article className={`agent-message agent-message-${message.role} status-${message.status}`} key={message.id}>
            <div className="agent-message-avatar">{message.role === "assistant" ? <Brain /> : "你"}</div>
            <div className="agent-message-body">
              <header><strong>{message.role === "assistant" ? "Research Agent" : "你"}</strong>{message.model ? <small>{message.model}</small> : null}</header>
              {message.content ? (
                message.role === "assistant" ? <AgentMarkdown content={message.content} /> : <p>{message.content}</p>
              ) : null}
              {message.status === "failed" ? <div className="agent-failure"><span>{message.error || "本回合失败"}</span><button disabled={sending || active?.status === "cancelled"} onClick={() => {
                const index = messages.findIndex((item) => item.id === message.id); const previous = [...messages.slice(0, index)].reverse().find((item) => item.role === "user");
                if (previous) void submitContent(previous.content, previous.skillSelection ?? null);
              }}>重试</button></div> : null}
              {message.citations.length ? <div className="agent-citations">{message.citations.map((citation) => <Link to={citation.href} key={`${citation.kind}-${citation.id}`}><BookOpenText />{citation.label}</Link>)}</div> : null}
              {message.role === "assistant" && message.skills?.length ? <div className="agent-used-skills" aria-label="本回合使用的技能">{message.skills.map((skill) => <button type="button" key={`${skill.id}-${skill.version}`} onClick={() => setHistoricalSkill({ messageId: message.id, conversationId: message.conversationId, usage: skill })} title={`查看本回合的原版本\n技能来源：${skill.source === "builtin" ? "内置" : "用户安装"}\n内容版本：${skill.version}`}><PuzzlePiece /><strong>{skill.name}</strong><small>{skill.source === "builtin" ? "内置" : "用户安装"} · {skill.version.slice(0, 8)}</small></button>)}</div> : null}
              {action ? <div className={`agent-action agent-action-${action.status}`}><Wrench /><span><strong>{TOOL_LABELS[action.toolName] ?? action.toolName}</strong>{action.error || "已记录到项目，并保留动作历史。"}</span>{action.output.href ? <Link to={action.output.href}>查看 <ArrowRight /></Link> : null}</div> : null}
            </div>
          </article>;
        })}
        {sending ? <article className="agent-message agent-message-assistant"><div className="agent-message-avatar"><Brain /></div><div className="agent-message-body"><header><strong>Research Agent</strong><small>{streamHint || "多步工具循环"}</small></header><div className="agent-thinking"><i /><i /><i /> {streamHint || "正在核对项目证据…"}</div></div></article> : null}
        <div ref={endRef} />
      </div>

      <form className="agent-composer" onSubmit={submit}>
        {error ? <div className="agent-composer-error" role="status">{error}</div> : null}
        <div className="agent-skill-composer-controls">
          <label><PuzzlePiece /><span className="visually-hidden">本回合研究技能</span><select aria-label="本回合研究技能" value={selectedSkill} disabled={sending || skillsLoading || active?.status === "cancelled"} onChange={(event) => setSelectedSkill(event.target.value)}><option value="auto">自动选择技能</option><option value="none">不使用技能</option>{(["builtin", "user"] as const).map((source) => <optgroup key={source} label={source === "builtin" ? "内置技能" : "已安装的技能"}>{skills.filter((skill) => skill.source === source && skill.enabled).map((skill) => <option key={skill.id} value={skill.id}>{skill.name}</option>)}</optgroup>)}</select></label>
          <button type="button" disabled={sending} onClick={() => setShowSkills(true)}>管理技能{skillsLoading ? "…" : ` · ${skills.filter((skill) => skill.enabled).length}`}</button>
          {skillsError ? <button type="button" className="agent-skill-retry" disabled={sending || skillsLoading} onClick={() => void refreshSkills()} title={skillsError}>技能加载失败，重试</button> : null}
        </div>
        <div className="agent-composer-box"><textarea name="message" required disabled={sending || active?.status === "cancelled"} placeholder={active?.status === "cancelled" ? "该会话已结束，请新建对话" : "询问项目证据、形成研究问题、设计实验或分析真实结果…"} onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); }
        }} /><button className="primary" disabled={sending || active?.status === "cancelled"} aria-label="发送"><PaperPlaneTilt /></button></div>
        <div className="agent-composer-meta">
          <span>Pi AgentSession · 多步领域白名单 · 仅草稿写入</span>
          {active?.status === "active" ? <button type="button" className="agent-end-session" onClick={stopConversation}><Stop weight="bold" />结束会话</button> : null}
        </div>
      </form>
    </section>

    <aside className="research-mission-pane" aria-label="当前研究任务">
      <header><span>CURRENT MISSION</span><h2>研究上下文</h2><p>{project.description || "围绕项目证据推进研究问题、实验和论文。"}</p></header>
      <section className="mission-progress">
        <div><span>研究资产完整度</span><strong>{projectPapers.length ? Math.min(100, 20 + (thread?.stats.insights ?? 0) * 8 + (thread?.stats.questions ?? 0) * 12 + experimentCount * 10) : 0}%</strong></div>
        <progress max="100" value={projectPapers.length ? Math.min(100, 20 + (thread?.stats.insights ?? 0) * 8 + (thread?.stats.questions ?? 0) * 12 + experimentCount * 10) : 0} />
      </section>
      <nav className="mission-stages">
        <Link to={`/projects/${encodedId}/library`}><span><BookOpenText /></span><div><strong>文献</strong><small>{projectPapers.length} 篇项目论文</small></div><ArrowRight /></Link>
        <Link to={projectMatrices[0] ? `/projects/${encodedId}/matrices/${encodeURIComponent(projectMatrices[0].id)}` : `/projects/${encodedId}/matrices`}><span><GridFour /></span><div><strong>证据矩阵</strong><small>{projectMatrices.length} 个矩阵</small></div><ArrowRight /></Link>
        <Link to={`/projects/${encodedId}/research`}><span><GitBranch /></span><div><strong>研究脉络</strong><small>{thread?.stats.insights ?? 0} 条洞见 · {thread?.stats.questions ?? 0} 个问题</small></div><ArrowRight /></Link>
        <Link to={`/projects/${encodedId}/experiments`}><span><Flask /></span><div><strong>实验</strong><small>{experimentCount} 份设计</small></div><ArrowRight /></Link>
      </nav>
      <section className="mission-agent-state"><ChatCircleDots /><div><strong>Research Agent</strong><small>以 Pi SDK AgentSession 为底座的多步工具循环；写入只产生草稿。</small></div></section>
      <section className="mission-guardrails"><strong>可信研究护栏</strong><ul><li>不编造文献或实验结果</li><li>具体判断回链项目对象</li><li>写入只创建草稿</li><li>不提供 Shell 或任意文件访问</li><li>默认关闭 bash / write / edit</li></ul></section>
    </aside>
    {showSkills ? <AgentSkillsPanel skills={skills} loading={skillsLoading} error={skillsError} onRefresh={refreshSkills} onClose={() => setShowSkills(false)} /> : null}
    {historicalSkill && projectId ? <AgentSkillHistoryPreview projectId={projectId} conversationId={historicalSkill.conversationId} messageId={historicalSkill.messageId} usage={historicalSkill.usage} onClose={() => setHistoricalSkill(null)} /> : null}
  </div>;
}
