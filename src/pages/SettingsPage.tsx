import { ArrowCounterClockwise, Check, Cpu, DownloadSimple, Eye, EyeSlash, Info, MagnifyingGlass, ShieldCheck, Trash, UploadSimple, UserCircle } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { PageHeader } from "../components/PageHeader";
import { UpdateSettings } from "../components/UpdateNotice";
import { deleteAiConfig, getAiConfig, saveAiConfig, testAiConnection, type AiConfig } from "../api";
import { useWorkspace } from "../state/workspace";

export function SettingsPage() {
  const { settings, trash, updateSettings, resetLocalData, exportWorkspace, importWorkspace, restoreTrashItem, permanentlyDeleteTrashItem } = useWorkspace();
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState("");
  const [displayName, setDisplayName] = useState(settings.displayName);
  const [autoSave, setAutoSave] = useState(settings.autoSave);
  const [evidenceFirst, setEvidenceFirst] = useState(settings.evidenceFirst);
  const [searchProvider, setSearchProvider] = useState(settings.provider || "semantic-scholar");
  const [showApiKey, setShowApiKey] = useState(false);
  const [expandedInfo, setExpandedInfo] = useState<string | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [aiConfig, setAiConfig] = useState<AiConfig | null>(null);
  const [aiBaseUrl, setAiBaseUrl] = useState("https://api.openai.com/v1");
  const [aiApiKey, setAiApiKey] = useState("");
  const [aiModel, setAiModel] = useState("");
  const [aiMessage, setAiMessage] = useState("");
  const [aiError, setAiError] = useState(false);
  const [aiSaving, setAiSaving] = useState(false);
  const [aiLoading, setAiLoading] = useState(true);
  const [aiTesting, setAiTesting] = useState(false);
  const [aiCheck, setAiCheck] = useState<{ message: string; error: boolean } | null>(null);
  const aiCheckController = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getAiConfig()
      .then((config) => {
        if (cancelled) return;
        setAiConfig(config);
        if (config.baseUrl) setAiBaseUrl(config.baseUrl);
        setAiModel(config.model);
      })
      .catch(() => {
        if (cancelled) return;
        setAiError(true);
        setAiMessage("无法读取 AI 配置，请刷新后重试；也可重新填写并保存配置。");
      })
      .finally(() => { if (!cancelled) setAiLoading(false); });
    return () => { cancelled = true; aiCheckController.current?.abort(); };
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    updateSettings({ displayName: displayName.trim() || "Researcher", autoSave, evidenceFirst, provider: searchProvider });
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  }

  async function saveAi() {
    const baseUrl = aiBaseUrl.trim();
    const apiKey = aiApiKey.trim();
    const model = aiModel.trim();
    if (!/^https?:\/\//i.test(baseUrl)) { setAiError(true); setAiMessage("Base URL 需以 http(s):// 开头"); return; }
    if (!model) { setAiError(true); setAiMessage("请填写模型名称"); return; }
    if (!apiKey && !aiConfig?.configured) { setAiError(true); setAiMessage("请填写 API Key"); return; }
    setAiSaving(true);
    setAiCheck(null);
    setAiError(false);
    setAiMessage("");
    try {
      const next = await saveAiConfig({ baseUrl, apiKey, model });
      setAiConfig(next);
      setAiApiKey("");
      setAiBaseUrl(next.baseUrl);
      setAiModel(next.model);
      setAiMessage("AI 配置已保存");
    } catch (error) {
      setAiError(true);
      setAiMessage(error instanceof Error ? (error.message === "Unauthorized" ? "登录已过期，请重新登录" : error.message) : "保存失败");
    } finally {
      setAiSaving(false);
    }
  }

  async function clearAi() {
    if (!window.confirm("确定清除已保存的 AI 配置？清除后 AI 功能将回落到服务器环境配置（若有）。")) return;
    setAiError(false);
    setAiSaving(true);
    setAiCheck(null);
    try {
      await deleteAiConfig();
      setAiConfig(await getAiConfig());
      setAiApiKey("");
      setAiModel("");
      setAiBaseUrl("https://api.openai.com/v1");
      setAiMessage("AI 配置已清除");
    } catch (error) {
      setAiError(true);
      setAiMessage(error instanceof Error ? (error.message === "Unauthorized" ? "登录已过期，请重新登录" : error.message) : "清除失败");
    } finally {
      setAiSaving(false);
    }
  }

  async function checkAi() {
    const controller = new AbortController();
    aiCheckController.current = controller;
    setAiTesting(true);
    setAiCheck(null);
    try {
      const result = await testAiConnection(controller.signal);
      if (controller.signal.aborted) return;
      setAiCheck({ error: false, message: `连接成功 · ${result.provider} · ${result.model} · ${result.apiFormat === "anthropic" ? "Anthropic Messages" : "OpenAI 兼容接口"} · ${(result.latencyMs / 1000).toFixed(2)} 秒 · ${new Date(result.checkedAt).toLocaleString()}` });
    } catch (error) {
      setAiCheck({ error: !controller.signal.aborted, message: controller.signal.aborted ? "连接自检已取消。" : error instanceof Error ? error.message : "连接自检失败，请稍后重试。" });
    } finally {
      aiCheckController.current = null;
      setAiTesting(false);
    }
  }

  function downloadBackup() {
    const blob = new Blob([exportWorkspace()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `argumesh-backup-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setMessage("备份已导出");
  }

  async function importBackup(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const result = importWorkspace(await file.text());
    setMessage(result.ok ? "备份已恢复" : result.error);
    event.target.value = "";
  }

  const environmentLabel = aiLoading ? "读取中…" : !aiConfig ? "状态读取失败"
    : aiConfig.configured ? `自定义配置 · ${aiConfig.model || "模型未填写"}`
    : aiConfig.envProviders.length ? `环境配置 · ${aiConfig.envProviders[0].label} · ${aiConfig.envProviders[0].models[0] || "模型未填写"}` : "未配置";
  const aiDirty = Boolean(aiApiKey.trim()) || aiBaseUrl.trim().replace(/\/+$/, "") !== (aiConfig?.baseUrl || "https://api.openai.com/v1") || aiModel.trim() !== (aiConfig?.model || "");
  const aiBusy = aiLoading || aiSaving || aiTesting;
  const toggleInfo = (id: string) => setExpandedInfo((current) => current === id ? null : id);

  return (
    <div className="route-page settings-page">
      <PageHeader eyebrow="设置" title="工作台设置" description="管理个人偏好、AI 接入与本地数据，让研究流程保持清晰可控。" />
      <form className="settings-stack" onSubmit={submit}>
        <UpdateSettings />
        <section className="settings-section settings-personal" aria-labelledby="personal-settings-title">
          <header className="settings-section-header"><span><UserCircle /></span><div><h2 id="personal-settings-title">个人设置</h2><p>管理你的个人信息与编辑偏好。</p></div><button className="primary settings-header-action" type="submit">{saved ? <><Check />已保存</> : "保存设置"}</button></header>
          <div className="settings-section-body">
            <label className="settings-row settings-input-row" htmlFor="display-name"><span><strong>显示名称</strong><small>该名称将显示在工作台与评论记录中。</small></span><input id="display-name" type="text" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></label>
            <label className="settings-row settings-toggle-row" htmlFor="auto-save"><span><strong>自动保存</strong><small>自动保存工作进度，防止意外丢失。</small></span><input id="auto-save" type="checkbox" checked={autoSave} onChange={(event) => setAutoSave(event.target.checked)} /><span className="settings-toggle-control" aria-hidden /></label>
            <label className="settings-row settings-toggle-row" htmlFor="evidence-first"><span><strong>证据优先模式</strong><small>优先显示来源、定位与人工确认状态。</small></span><input id="evidence-first" type="checkbox" checked={evidenceFirst} onChange={(event) => setEvidenceFirst(event.target.checked)} /><span className="settings-toggle-control" aria-hidden /></label>
          </div>
        </section>

        <section className="settings-section settings-model" aria-labelledby="model-settings-title">
          <header className="settings-section-header"><span><Cpu /></span><div><h2 id="model-settings-title">模型接入</h2><p>配置大模型服务以启用 AI 研究能力。</p></div><em className="environment-badge"><i aria-hidden />当前配置：{environmentLabel}</em></header>
          <div className="model-config-surface">
            <label className="settings-field" htmlFor="ai-base-url"><span>Base URL</span><input id="ai-base-url" value={aiBaseUrl} disabled={aiBusy} onChange={(event) => { setAiBaseUrl(event.target.value); setAiCheck(null); }} placeholder="https://api.openai.com/v1" /><small>支持 OpenAI 兼容接口；以 /anthropic 结尾时自动使用 Anthropic Messages API。</small></label>
            <label className="settings-field" htmlFor="ai-api-key"><span>API Key</span><span className="settings-secret-control"><input id="ai-api-key" type={showApiKey ? "text" : "password"} value={aiApiKey} disabled={aiBusy} onChange={(event) => { setAiApiKey(event.target.value); setAiCheck(null); }} placeholder={aiConfig?.apiKeyMasked ? `已保存 ${aiConfig.apiKeyMasked}（留空保持不变）` : "sk-..."} autoComplete="off" /><button type="button" onClick={() => setShowApiKey((visible) => !visible)} aria-label={showApiKey ? "隐藏 API Key" : "显示 API Key"}>{showApiKey ? <EyeSlash /> : <Eye />}</button></span><small>密钥仅保存在本机服务端数据库中。</small></label>
            <label className="settings-field" htmlFor="ai-model"><span>模型名称</span><input id="ai-model" value={aiModel} disabled={aiBusy} onChange={(event) => { setAiModel(event.target.value); setAiCheck(null); }} placeholder="如 gpt-4o-mini" /><small>Paper Card、证据提取与阅读问答将使用此模型。</small></label>
            <div className="model-config-actions"><button className="primary" type="button" disabled={aiBusy} onClick={() => void saveAi()}>{aiSaving ? "保存中…" : "保存 AI 配置"}</button><button className="secondary-button" type="button" disabled={aiBusy || aiDirty || !aiConfig} onClick={() => void checkAi()}>{aiTesting ? "自检中…" : "连接自检"}</button>{aiTesting ? <button className="secondary-button" type="button" onClick={() => aiCheckController.current?.abort()}>取消自检</button> : null}{aiConfig?.configured ? <button className="secondary-button" type="button" disabled={aiBusy} onClick={() => void clearAi()}>清除配置</button> : null}</div>
            <p className="model-check-hint">{aiDirty ? "配置有未保存的修改，请先保存再自检。" : "自检向当前配置的模型发送一条固定短消息，会产生少量调用费用；不发送论文内容，最长等待 30 秒。"}</p>
            {aiMessage ? <p className={aiError ? "settings-message ai-error" : "settings-message"} role={aiError ? "alert" : "status"}>{aiMessage}</p> : null}
            {aiTesting ? <p className="model-check-hint" role="status" aria-live="polite" aria-busy="true">正在等待模型回复…</p> : null}
            {aiCheck ? <p className={aiCheck.error ? "settings-message ai-error" : "settings-message"} role={aiCheck.error ? "alert" : "status"}>{aiCheck.message}</p> : null}
          </div>
        </section>

        <section className="settings-section settings-search" aria-labelledby="search-settings-title">
          <header className="settings-section-header"><span><MagnifyingGlass /></span><div><h2 id="search-settings-title">搜索设置</h2><p>选择学术元数据的默认检索服务。</p></div></header>
          <label className="settings-row settings-input-row" htmlFor="search-provider"><span><strong>默认搜索服务</strong></span><select id="search-provider" value={searchProvider} onChange={(event) => setSearchProvider(event.target.value)}><option value="semantic-scholar">Semantic Scholar</option><option value="crossref">Crossref</option><option value="openalex">OpenAlex</option></select></label>
        </section>

        <section className="settings-section settings-security" aria-labelledby="security-settings-title">
          <header className="settings-section-header"><span><ShieldCheck /></span><div><h2 id="security-settings-title">安全与数据</h2><p>管理账户会话与本地研究数据。</p></div></header>
          <div className="settings-security-list">
            <div className="settings-security-row"><span><strong>备份与导入</strong></span><span className="settings-row-actions"><button className="secondary-button" type="button" onClick={downloadBackup}><DownloadSimple />导出</button><button className="secondary-button" type="button" onClick={() => inputRef.current?.click()}><UploadSimple />导入</button><button className="settings-info-button" type="button" onClick={() => toggleInfo("backup")} aria-label="查看备份说明" aria-expanded={expandedInfo === "backup"}><Info /></button></span></div>
            {expandedInfo === "backup" ? <p className="settings-inline-info">JSON 备份包含项目、文献元数据、知识与 Idea；不包含浏览器中的 PDF 文件和 OCR 缓存。</p> : null}
            <div className="settings-security-row"><span><strong>回收站</strong><small>{trash.length} 个对象</small></span><span className="settings-row-actions"><button className="secondary-button" type="button" onClick={() => setTrashOpen((open) => !open)}>{trashOpen ? "收起" : "打开回收站"}</button><button className="settings-info-button" type="button" onClick={() => toggleInfo("trash")} aria-label="查看回收站说明" aria-expanded={expandedInfo === "trash"}><Info /></button></span></div>
            {expandedInfo === "trash" ? <p className="settings-inline-info">回收站中的 Idea 与知识对象可恢复；永久删除后不可撤销。</p> : null}
            {trashOpen ? <div className="settings-trash-items">{trash.length ? trash.map((item) => <article key={item.id}><span><strong>{item.label}</strong><small>{item.kind === "idea" ? "Idea" : "知识对象"} · {new Date(item.deletedAt).toLocaleString("zh-CN")}</small></span><span><button className="secondary-button" type="button" onClick={() => restoreTrashItem(item.id)}><ArrowCounterClockwise />恢复</button><button className="danger-button" type="button" onClick={() => permanentlyDeleteTrashItem(item.id)}><Trash />永久删除</button></span></article>) : <p>回收站为空。</p>}</div> : null}
            <div className="settings-security-row"><span><strong>恢复本地示例数据</strong></span><span className="settings-row-actions"><button className="danger-button" type="button" onClick={() => { if (window.confirm("确定恢复本地示例数据？你的本地页面修改将被清除。")) resetLocalData(); }}><Trash />恢复</button><button className="settings-info-button" type="button" onClick={() => toggleInfo("reset")} aria-label="查看数据恢复说明" aria-expanded={expandedInfo === "reset"}><Info /></button></span></div>
            {expandedInfo === "reset" ? <p className="settings-inline-info">此操作会清除当前浏览器中的本地修改，并恢复示例工作区。</p> : null}
          </div>
          <input ref={inputRef} hidden type="file" accept="application/json,.json" onChange={(event) => void importBackup(event)} />
          {message ? <p className="settings-message">{message}</p> : null}
        </section>
      </form>
    </div>
  );
}
