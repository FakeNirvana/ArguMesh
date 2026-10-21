# ArguMesh 架构

**仓库：[github.com/Fyuan0206/ArguMesh](https://github.com/Fyuan0206/ArguMesh)** · MIT License

> 架构细节的权威来源。协作规范见 [`../AGENTS.md`](../AGENTS.md)，开发命令见 [`DEVELOPMENT.md`](DEVELOPMENT.md)，页面与路由见 [`PAGE-STRUCTURE.md`](PAGE-STRUCTURE.md)。
>
> `../CLAUDE.md` 也包含一份架构摘要（Claude Code 自动加载）。改这里请同步那边，或让那边指向本文件。

## 总览：一个 Hono app，两个宿主

`server/index.ts` 是一个**与宿主无关**的 Hono 应用。它有两个宿主，业务逻辑只应存在于 `index.ts` 与 `routes/` 中：

| 宿主 | 入口 | 运行方式 |
| --- | --- | --- |
| Web | `server/node.ts` | `@hono/node-server`；`/api/*` 交给主 app，其余走 `dist/` 静态资源 + SPA 回退 |
| 桌面 | `server.mjs`（esbuild 单包） | Tauri 壳拉起的裸 `node` sidecar，见 [`DEPLOYMENT.md`](DEPLOYMENT.md) |

**不要把业务逻辑写进任何宿主。** 新增或修改 API 只动 `index.ts` 与 `routes/`。

运行时配置由 `server/env.ts` 的 `loadBindings()` 从 `process.env` 组装成 `AppBindings`（`server/types.ts`）；测试里直接构造。libSQL client 按连接串缓存（`server/db/client.ts`）。

## 后端（`server/`）

```
server/
├── node.ts            # Web 宿主
├── index.ts           # Hono app：无鉴权门，路由模块挂在 /api 下
├── env.ts             # loadBindings() → AppBindings
├── types.ts           # AppBindings / AppEnv
├── ai/                # 无 DB 依赖的能力层
├── db/                # client.ts / schema.ts / projects.ts
├── routes/            # API 处理器
├── services/          # 领域与执行助手
└── skills/            # 随应用编译的内置科研技能
```

### `index.ts`

**没有鉴权门**——单用户本地工作台，每个 `/api/*` 路由在 localhost 上直接可达。`notFound` 返回 404 JSON，`onError` 原样重新抛出 `HTTPException` 为 JSON。

### `db/`

- **`schema.ts` 是 canonical 表清单：30 张表**，所有外键 cascade-delete。
  - **核心 10 张**：`projects`（含 `workspace_path`）、`papers`、`paper_files`（PDF BLOB）、`project_papers`、`matrices`、`matrix_papers`、`dimensions`、`evidence_cells`、`extraction_jobs`、`ai_settings`
  - **研究弧线 19 张**：`knowledge_items`、`knowledge_relations`、`research_questions`、`rq_papers`、`research_question_origins`、`research_question_conclusions`、`research_question_evidence`、`gaps`、`gap_evidence`、`ideas`、`idea_versions`、`idea_evidence`、`idea_reviews`、`experiments`、`experiment_results`、`ai_conversations`、`ai_messages`、`ai_actions`、`evidence_layers`
  - **技能注册表 1 张**：`agent_skills`，保存用户技能包与内置技能的启停设置；`ai_messages.skills_json` / `skill_selection_json` 保存各轮实际加载快照与用户选择。
- **`projects.ts`** — `projectExists(env, id)`，单用户版替代 prototype 的 `findOwnedProject`；路由用它做 404 存在性检查（没有归属层可作用）。
- `client.ts` — `createDatabase(env)`，client 按连接串缓存。

### `routes/`（全部挂在 `/api`）

- **核心** — `ai`（全局配置）、`papers`、`files`（PDF BLOB 写入 `paper_files`，≤25 MB，必须带 `Content-Length`）、`library`（含 `…/library/scan-inbox`，扫工作区 `literature/` 收件箱）、`projects`、`matrix`（+ 带锁定单元格守卫的 evidence PATCH）、`extraction`、`card`、`reader`（`/reader/ask` 划词问答 + `/reader/translate` 划词翻译，进程内内存限流）
- **研究弧线** — `knowledge`（`/extract`、`/analyze`、`/relations`）、`researchThread`（`/research-thread` + 洞见提升）、`researchQuestions`、`gaps`、`ideas`、`reviews`、`experiments`（`/design`、`/design-with-ai`、结果 `import`/`analyze`）、`evidenceLayers`（`/interpret|imply|promote`）
- **Agent 与写作** — `conversations`（`/projects/:projectId/ai/conversations[/:id|/messages|/cancel]`）、`writing`（`/paper/…` initialize、source、outline、patch、`proposals/:actionId`、bibliography、compile + `/compile/cancel` + `/compile-status`、pdf、snapshots + `snapshots/:snapshotId/restore`）、`system`（`/system/pick-directory`、`/system/open-path`）
- **Agent 技能** — `agent-skills`（`/agent/skills` 列表与本地包安装；`/:id` 查看、启停与用户技能卸载），在本机所有项目间共用。

以目录为准，这里不是穷举。

### `services/`

- **AI 管线** — `ai.ts`（provider 注册表 + `resolveAiForRequest`、`LOCAL_AI_ACCOUNT_ID`）、`stepfun.ts`（单 provider 客户端 + `stripThinkBlock` + `inferAiApiFormat`）、`pi-agent.ts`（Pi `AgentSession` 轮次执行器：SSE 事件、工具白名单、`citationsFromActions`、`normalizeAgentTransportError`）、`pi-runtime.ts`（把 app AI 配置桥接到 Pi model 接口）、`research-agent.ts`（白名单领域动作执行器）、`project-context.ts`（有界上下文装配 + `PROJECT_CONTEXT_LIMITS`）、`result-analysis.ts`、`web-search.ts`（SearXNG JSON 客户端）
- **领域** — `latex.ts`（引擎探测/编译/取消/状态/PDF 路径/日志解析）、`paper-files.ts`（LaTeX 工作区读写、快照、大纲解析、缺失引用检测）、`literature-inbox.ts`（`{workspacePath}/literature/` 扫描，50 文件 / 25 MB 上限）、`native-picker.ts`（拉起系统目录选择对话框/路径打开——**全应用唯一的子进程代码**）

### Research Agent 与 skills

**源码新增（2026-10-21，尚未发布安装包）。** Research Agent 的技能发现、安装与使用由应用管理。内置内容在 `server/skills/builtin.ts` 编译进 Web / 桌面服务，用户从对话区导入本地 `SKILL.md` 或技能文件夹，经预览后安装。`server/routes/agent-skills.ts` 处理管理写入，`server/services/agent-skills.ts` 解析包、装配注册表；`shared/agent-skills.ts` 是前后端共享类型。

| 来源 | 保存与管理 |
| --- | --- |
| 内置技能 | `evidence-review`、`experiment-planning`、`manuscript-review` 三个完整 `SKILL.md`；可查看与启停，不可卸载 |
| 用户技能 | `agent_skills` 保存完整文本包、内容哈希、来源与时间；可查看、启停、卸载，同机所有项目共用 |
| 本轮实际使用 | `ai_messages.skills_json` 保存加载时的完整内容快照及版本、来源、时间，消息关联实际模型；`skill_selection_json` 保存本轮选择供历史与重试使用 |

安装包须有唯一根 `SKILL.md`，也可带一个共同的技能文件夹前缀。最多 64 个文本文件，每文件 64 KiB、每包 512 KiB，`SKILL.md` 正文最多 32,000 字符。后端拒绝绝对路径、路径穿越、重复路径及不合规文本包；不读取用户提交的服务器磁盘路径。同名安装返回冲突，不静默替换内置或已安装内容。脚本可作为文本资料保留并提示兼容限制，不执行。

`server/routes/conversations.ts` 在回合开始时确定允许的启用技能及内容版本。对话选择「自动选择」时，模型获得技能目录并通过 `skill_load` 按需加载；指定技能时先加载该技能；「不使用技能」时本轮没有可加载技能。兼容 `/skill:name 参数` 的手动指令也只在应用管理的本轮允许范围内解析，停用或未知技能不会落回隐式文件发现。

`skill_load` / `skill_read` 是只读工具：一轮最多加载三个技能，资源读取只访问已允许技能的包内文本，每段最多 12,000 字符、每轮最多 48,000 字符。它们不消耗领域写入额度。实际加载后立即记录快照，失败和取消也保留已有加载记录；卸载、停用或重新安装不改写旧快照。领域动作仍由 `runDomainAction()` 转交 `executeWhitelistedAgentAction()`，每轮最多一个，输出经 schema 校验并记入 `ai_actions`。

`DefaultResourceLoader` 显式关闭 SDK 的 skills、extensions、prompt templates、themes 与 context files 加载，并使用应用自己的系统提示，不读取隐式 SYSTEM / APPEND_SYSTEM 提示文件。服务 cwd、项目 `workspacePath`、用户或祖先 `.agents/skills` / `.pi/skills` 中已有技能不会隐式加载进会话；第三方技能不能运行 Pi 扩展、任意 Shell、Python 或文件写入。旧轮加载过技能后，下一轮会重建 Pi 会话并恢复有界的已完成对话，避免旧技能指令因会话缓存继续生效；技能目录变化也会触发重建。

**维护定位**：安装管理看 `server/routes/agent-skills.ts` / `server/services/agent-skills.ts`；回合边界与记录看 `server/routes/conversations.ts`；技能加载、资源读取与会话重建看 `server/services/pi-agent.ts`；迁移 `0015_agent_skills` 在 `scripts/migrate-custom.ts`。技能正文与资料始终作为低于系统规则的不可信输入，工具白名单和应用校验继续决定可执行动作。

### `server/ai/`——无 DB 依赖的能力层

路由复用这一层，不要在各路由里手拼 prompt：

- `complete.ts` — `completeJson` / `completeText`
- `json.ts` — `stripThinkBlock`、`parseJsonObject` / `parseJsonArray`
- `prompts.ts` — **所有** system prompt 的唯一来源
- `capabilities.ts` — 每个 AI 输出的 Zod schema。**所有 AI 输出必须过其中一个 schema 才能落库**

## 前端（`src/`）

```
src/
├── App.tsx             # 路由（react-router-dom v6），无登录门
├── api.ts              # fetch 助手
├── main.tsx            # createRoot + StrictMode
├── components/         # 共享 UI（见 COMPONENT-GUIDELINES.md）
├── pages/              # 路由组件
├── pdf/                # 阅读器纯函数助手
├── state/              # workspace / project Context
├── storage/            # IndexedDB
└── styles.css          # 全部样式，token 在 :root
```

- **Provider 层级** — `WorkspaceProvider` → `ProjectProvider` → `Routes`。
- **`state/workspace.tsx`** — 浏览器本地 notes/claims/evidence/ideas + 后台同步队列。注意：JSON 持久化会丢掉 `retry` 闭包，过期条目要**清除**而不是重试。
- **`state/project.tsx`** — 当前项目。
- **`api.ts`** — 401 分支抛 `Error("Unauthorized")` 是遗留物（单用户无 token）。`getAiConversation(id, {healPending:true})` 会加 `?healPending=1`，让丢了 SSE 流的客户端清理卡在 `pending` 的助手消息。
- **`pdf/`** — 刻意保持纯函数并可单测：`blocks.ts`（无损且确定的 ~400 字符分段器，供双语对照）、`selection.ts`（视口 → **PDF 页面单位**几何换算）、`document.ts`（取页文本）、`resolvePaperPdf.ts`（IndexedDB 未命中时回落到云端 BLOB 并回写缓存）。
- **`storage/paperFiles.ts`** — IndexedDB PDF/OCR 缓存；阅读器未命中时回落 `GET /api/papers/:id/file`。
- **`styles.css`** — 全部样式。token 在 `:root`：`--nav` 石墨导航、`--accent` 青色操作、`--draft` 琥珀色 AI 草稿、`--success` 绿色确认。

## 数据组织

- **PDF 存数据库**，不是 R2/文件系统：`paper_files` 表存 BLOB，随论文外键 cascade 清理，≤25 MB。
- **项目可绑定本地工作区文件夹**（`projects.workspace_path`）。该文件夹同时承载两件事：
  - `paper/` — LaTeX 写作源文件（`main.tex`、`references.bib`）
  - `literature/` — PDF 收件箱，放进来的 PDF 可从文献页一键同步导入（按 SHA-256 去重）
  - `.argumesh/` — 内部快照（应用自行管理）
- **IndexedDB**（`storage/paperFiles.ts`）只做本地缓存：PDF 二进制、OCR 结果、按「论文 + 页 + 语言」缓存的双语翻译。服务端 `ai_settings` 才是配置的事实来源。

## 关键不变量

改这些区域前先读懂，它们对应 `AGENTS.md` 里的产品规则：

1. **锁定/确认的内容永不被批量 AI 静默覆盖** —— `routes/matrix.ts` 的 PATCH 守卫。
2. **AI 输出必须过 Zod** —— `routes/card.ts`、`routes/extraction.ts` 与 `server/ai/capabilities.ts` 是范例。
3. **Prompt 注入防御** —— 用户/论文内容是不可信数据；`routes/extraction.ts` 与阅读器翻译 prompt 都显式声明忽略其中指令。
4. **阅读器最小暴露** —— 划词翻译/问答/双语对照只发送选中内容或当前页分段，**绝不发送整篇文档**。详见 [`PAGE-STRUCTURE.md`](PAGE-STRUCTURE.md) 的阅读器一节。
5. **Agent 每轮最多一个白名单动作**，只通过 `routes/` 处理器写入，全部记入 `ai_actions`。
6. **无静默历史覆盖** —— 重新生成、Idea 编辑、评审修订、LaTeX patch 都保留版本/快照历史。
