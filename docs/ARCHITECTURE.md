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
├── index.ts           # Hono app：无鉴权门，20 个路由模块挂在 /api 下
├── env.ts             # loadBindings() → AppBindings
├── types.ts           # AppBindings / AppEnv
├── ai/                # 无 DB 依赖的能力层
├── db/                # client.ts / schema.ts / projects.ts
├── routes/            # 20 个文件
└── services/          # 12 个文件
```

### `index.ts`

**没有鉴权门**——单用户本地工作台，每个 `/api/*` 路由在 localhost 上直接可达。`notFound` 返回 404 JSON，`onError` 原样重新抛出 `HTTPException` 为 JSON。

### `db/`

- **`schema.ts` 是 canonical 表清单：29 张表**，所有外键 cascade-delete。
  - **核心 10 张**：`projects`（含 `workspace_path`）、`papers`、`paper_files`（PDF BLOB）、`project_papers`、`matrices`、`matrix_papers`、`dimensions`、`evidence_cells`、`extraction_jobs`、`ai_settings`
  - **研究弧线 19 张**：`knowledge_items`、`knowledge_relations`、`research_questions`、`rq_papers`、`research_question_origins`、`research_question_conclusions`、`research_question_evidence`、`gaps`、`gap_evidence`、`ideas`、`idea_versions`、`idea_evidence`、`idea_reviews`、`experiments`、`experiment_results`、`ai_conversations`、`ai_messages`、`ai_actions`、`evidence_layers`
- **`projects.ts`** — `projectExists(env, id)`，单用户版替代 prototype 的 `findOwnedProject`；路由用它做 404 存在性检查（没有归属层可作用）。
- `client.ts` — `createDatabase(env)`，client 按连接串缓存。

### `routes/`（20 个，全部挂在 `/api`）

- **核心** — `ai`（全局配置）、`papers`、`files`（PDF BLOB 写入 `paper_files`，≤25 MB，必须带 `Content-Length`）、`library`（含 `…/library/scan-inbox`，扫工作区 `literature/` 收件箱）、`projects`、`matrix`（+ 带锁定单元格守卫的 evidence PATCH）、`extraction`、`card`、`reader`（`/reader/ask` 划词问答 + `/reader/translate` 划词翻译，进程内内存限流）
- **研究弧线** — `knowledge`（`/extract`、`/analyze`、`/relations`）、`researchThread`（`/research-thread` + 洞见提升）、`researchQuestions`、`gaps`、`ideas`、`reviews`、`experiments`（`/design`、`/design-with-ai`、结果 `import`/`analyze`）、`evidenceLayers`（`/interpret|imply|promote`）
- **Agent 与写作** — `conversations`（`/projects/:projectId/ai/conversations[/:id|/messages|/cancel]`）、`writing`（`/paper/…` initialize、source、outline、patch、`proposals/:actionId`、bibliography、compile + `/compile/cancel` + `/compile-status`、pdf、snapshots + `snapshots/:snapshotId/restore`）、`system`（`/system/pick-directory`、`/system/open-path`）

以目录为准，这里不是穷举。

### `services/`（12 个）

- **AI 管线** — `ai.ts`（provider 注册表 + `resolveAiForRequest`、`LOCAL_AI_ACCOUNT_ID`）、`stepfun.ts`（单 provider 客户端 + `stripThinkBlock` + `inferAiApiFormat`）、`pi-agent.ts`（Pi `AgentSession` 轮次执行器：SSE 事件、工具白名单、`citationsFromActions`、`normalizeAgentTransportError`）、`pi-runtime.ts`（把 app AI 配置桥接到 Pi model 接口）、`research-agent.ts`（白名单领域动作执行器）、`project-context.ts`（有界上下文装配 + `PROJECT_CONTEXT_LIMITS`）、`result-analysis.ts`、`web-search.ts`（SearXNG JSON 客户端）
- **领域** — `latex.ts`（引擎探测/编译/取消/状态/PDF 路径/日志解析）、`paper-files.ts`（LaTeX 工作区读写、快照、大纲解析、缺失引用检测）、`literature-inbox.ts`（`{workspacePath}/literature/` 扫描，50 文件 / 25 MB 上限）、`native-picker.ts`（拉起系统目录选择对话框/路径打开——**全应用唯一的子进程代码**）

### Research Agent 与 skills

**现状核验：2026-10-21，Pi SDK `@earendil-works/pi-coding-agent` 0.84.3。** 已有技能发现、加载和手动展开的底座，但尚未形成完整的 skills 产品功能；本节只记录实现，不代表新增能力或排期。升级 SDK 后需重新核验其默认行为。

`server/routes/conversations.ts` 将用户消息交给 `server/services/pi-agent.ts` 的 `runPiAgentTurn()`。后者通过 `DefaultResourceLoader.reload()` 加载资源，再把同一 loader 传给 `createAgentSession()`；没有显式设置 `noSkills` / `noExtensions`，因此沿用 SDK 的默认资源发现行为。

资源路径由**服务进程的启动目录** `process.cwd()` 决定，未切换到项目的 `projects.workspace_path`。`server/services/pi-runtime.ts` 的 `createPiModelBridge()` 将 `agentDir` 设置为 `tmpdir()/argumesh-pi-agent`；它不是项目工作区，也不是持久的技能配置目录。当前 SDK 默认可发现以下技能来源：

| 来源 | 发现位置 |
| --- | --- |
| Pi 项目技能 | `{process.cwd()}/.pi/skills/` |
| 项目及祖先目录的共享技能 | 从 `process.cwd()` 向上查找 `.agents/skills/`；找到 Git 仓库时止于仓库根，否则止于文件系统根 |
| 用户共享技能 | `~/.agents/skills/`，独立于应用传入的临时 `agentDir` |
| Pi 用户技能 | `{agentDir}/skills/`；ArguMesh 当前对应临时目录下的 `argumesh-pi-agent/skills/` |

项目来源受 SDK 的 `projectTrusted` 设置控制；当前应用使用的 `SettingsManager.inMemory()` 默认信任项目。仓库没有随源码提供 `.pi/skills/` 或 `.agents/skills/`，也没有 skills 管理 API 或界面；本机已有的用户共享技能仍可能被默认发现。

技能的两种调用路径目前不同：

- **模型自动选择未接通。** 应用自定义了系统提示，且工具白名单没有 `read`。SDK 在这种情况下不会把已加载技能的目录附加到系统提示；Agent 也没有读取技能正文及其相对引用文件的通用工具。
- **手动 `/skill:name 参数` 有 SDK 基础。** 消息进入 `session.prompt()` 后，SDK 会查找已加载的同名技能，直接读取 `SKILL.md` 并把正文与参数展开到本轮输入。这一步不依赖 `read` 工具；技能不存在时，原文继续作为普通消息。应用尚无技能选择器或针对该语法的产品提示。

应用显式启用的是 `pi-agent.ts` 中 `TOOL_NAMES` 列出的 **11 个领域工具**：项目上下文、网页搜索及九个受控领域动作。该白名单未提供通用 shell、任意文件读写或代码执行工具，不能据此宣称第三方技能的脚本和配套工具都可运行。技能正文也不会自动赋予工具权限；领域动作由 `runDomainAction()` 转交 `executeWhitelistedAgentAction()`，每轮最多执行一个，并记入 `ai_actions`。资源发现沿用 SDK 默认行为，不能把领域工具白名单等同于资源加载沙箱。

尚缺技能的导入/启停/选择与来源管理、限定技能目录的资源读取、脚本执行边界，以及技能内容版本/快照与每轮调用关联的追踪。现有对话和动作记录不等于技能版本追踪；这些均是现状缺口，不在本节新增待办。

**维护定位**：应用侧查看 `server/services/pi-agent.ts` 的 `getOrCreateSession()` / `TOOL_NAMES`、`server/services/pi-runtime.ts` 的 `createPiModelBridge()` 与 `server/routes/conversations.ts`。SDK 侧在已安装的 `@earendil-works/pi-coding-agent` 包中查看 `dist/core/resource-loader.js`（加载）、`package-manager.js`（默认目录与信任边界）、`skills.js`（`SKILL.md` 解析）、`system-prompt.js`（`read` 条件）及 `agent-session.js` 的 `_expandSkillCommand()`（手动展开）；不依赖机器绝对路径或易漂移的行号。

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
