# ArguMesh 开发指南

**仓库：[github.com/Fyuan0206/ArguMesh](https://github.com/Fyuan0206/ArguMesh)** · MIT License

命令、环境、迁移、测试与交付门禁。架构见 [`ARCHITECTURE.md`](ARCHITECTURE.md)，部署见 [`DEPLOYMENT.md`](DEPLOYMENT.md)。

## 环境要求

Node.js ≥ 20，包管理器用 **pnpm**（仓库统一；npm 在部分运行时里不可用）。

## 常用命令

所有命令在仓库根 `ArguMesh/` 下执行。

```bash
# 依赖
pnpm install                       # 嘈杂环境加 --reporter=append

# 开发
pnpm run dev                       # API（node --watch --import tsx）+ Vite :5173，concurrently
pnpm run dev:api                   # 仅 API（:8787）
pnpm run dev:web                   # 仅 Vite

# 构建与运行
pnpm run build                     # tsc --noEmit + vite build → dist/
pnpm start                         # 单端口 8787：同时提供 dist/ 与 API（需先 build）
pnpm run preview                   # vite preview 构建产物

# 类型检查与测试
pnpm run typecheck                 # tsc --noEmit
pnpm run test                      # Vitest（单一 config）：tests/unit + tests/api
pnpm run test:watch                # watch 模式
pnpm exec vitest run tests/api/<file>.test.ts   # 只跑单个 API 测试文件

# 数据库
pnpm run db:seed                   # 幂等：建全部表 + 演示项目（全新安装路径；无账号）
pnpm run db:migrate                # 应用未应用的 drizzle/ 迁移（0000–0007）
pnpm run db:generate               # 改完 server/db/schema.ts 后生成迁移
pnpm run db:backup                 # 全表 JSON 快照 → backups/
pnpm run db:studio                 # drizzle-kit studio

# 桌面打包（另一条链路，见 DEPLOYMENT.md）
pnpm run build:mineru              # Windows x64，需要构建机安装 uv；下载已锁定 CPU 依赖
pnpm run build:sidecar -- --node-exe "$(node -p process.execPath)"
pnpm tauri build
```

### ⚠ 两个不要改

- **别把 `pnpm run test` 改回裸 `vitest`。** 脚本实际是 `node ./node_modules/vitest/vitest.mjs run --config vitest.config.ts`，这是 Windows 下绕过 `vitest.cmd` shim 的写法。改回裸命令会在 Windows 上挂掉。
- **别删 `pnpm-workspace.yaml` 的 `allowBuilds`**（`esbuild` / `protobufjs` / `sharp` / `tesseract.js`）。pnpm 默认跳过 postinstall，这些是 `pnpm install` 之后原生依赖能用的前提。

## 环境变量

### 可选：本机 MinerU 精确解析

桌面安装包内置 Python **3.13.16** 与 MinerU **3.4.2** 的 CPU `pipeline` 环境，无需用户安装解析工具。构建机需有 `uv`，先执行 `pnpm run build:mineru`：下载并校验官方 Python 嵌入包，按 `scripts/mineru/requirements-win-x64.lock` 哈希安装 wheel 到 `build/mineru-runtime/`。微软官方 Visual C++ **14.44.35211** x64 包同样固定 SHA-256，仅提取应用私有 DLL 和许可文本，不运行其安装器、不写 System32。完整推理导入检查还会验证 C++ DLL 从私有目录加载，防止开发机已有运行库掩盖缺失依赖。移除 torch 中仅供 C++ 编译使用的 `.lib` 静态库，保留运行所需 DLL / PYD 和第三方许可文件。不包含模型、用户配置或 PDF。`build:sidecar` 会验证并拷贝完整解析环境。

源码运行优先使用 `build/mineru-runtime/`，缺失时仍可使用 PATH 中的 MinerU 3.4.2 CLI；桌面版环境不完整时明确提示重新安装，不回退到用户 PATH。宿主设置 `ARGUMESH_MINERU_RUNTIME` 与 `ARGUMESH_DATA_DIR`（用户数据根目录）；缓存位于该根目录的 `data/mineru-cache/`，模型位于 `data/mineru-models/`。未设置宿主变量时使用仓库的 `data/`。首次通过 MinerU 官方支持的 ModelScope 仓库下载模型（无需账号或 API key），模型配置损坏时会自动重建并复用缓存。首次下载有独立 30 分钟超时，CPU 单页解析有 10 分钟超时；模型组下载完成才进入解析。下载可取消，重试通过下载器检查并复用已有文件；模型配置不使用用户的全局 `mineru.json`。CLI 只在本机处理指定页，不调用 mineru.net 的文档上传 API。MinerU 4.x CLI 尚未接入。

`.env` 是可选的（dotenv）。模板在 `.env.example`，全部可选——不配任何 AI 也能跑，AI 功能会返回明确的「未配置」提示。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | `file:./data/argumesh.db` | 本地 SQLite；也支持远程 `libsql://` |
| `DATABASE_AUTH_TOKEN` | — | 仅远程 `libsql://` 需要 |
| `PORT` | `8787` | **不在 `AppBindings` 里**——`server/node.ts` 直接读 `process.env.PORT` |
| `STEPFUN_BASE_URL` / `STEPFUN_API_KEY` / `STEPFUN_MODEL` | — | 单 provider 回退 |
| `AI_PROVIDERS` | — | JSON 数组 `[{id,label,baseUrl,apiKey,models}]`，多家 provider |
| `AI_MODELS` | — | 逗号分隔，覆盖可选模型列表 |
| `LATEX_ENGINE_PATH` | — | tectonic / latexmk 可执行文件路径 |
| `SEARXNG_BASE_URL` | — | 自托管 SearXNG 根地址；不设则 `web_search` 关闭 |
| `SEARXNG_TIMEOUT_MS` | `20000` | 夹在 3000–60000 之间 |

**优先级**：设置页的全局 AI 配置（`ai_settings` 表，一行 `account_id='local'`）**完全覆盖** `AI_PROVIDERS` / `STEPFUN_*` 环境回退，并忽略客户端传来的 provider/model。Base URL 以 `/anthropic` 结尾时自动改用 Anthropic Messages API。

**无鉴权 token**——不要把 API 端口暴露到不可信网络。

> 已知欠账：`.env.example` 缺 `LATEX_ENGINE_PATH`，而 `server/env.ts` 会读它。`.env.example` 随安装包发布，补上它有实际意义。

**gitignore**：`data/`、`backups/`、`dist/`、`build/`、`src-tauri/target/`、`src-tauri/gen/`、`node_modules/`、`design-qa-artifacts/`、`docs/tasks/` 以及根目录的 `IMPACT_ANALYSIS*.md` / `TASK_SUMMARY*.md`（后两者是本机 agent 草稿，全新 clone 里没有）。

## Research Agent 与 Skills 接入现状

**本节对应 2026-10-21 新增源码功能，尚未发布新安装包。** Research Agent 内置证据梳理、实验规划和论文审查技能，并提供本地技能安装管理。对话可自动选择、指定技能或不使用技能；运行边界与记录方式见 [`ARCHITECTURE.md` 的「Research Agent 与 skills」](ARCHITECTURE.md#research-agent-与-skills)。

- **管理入口**：点击左侧栏「管理技能」打开现有管理弹窗，安装与启停设置由所有项目共用；Research Agent 输入区只保留自动选择、不使用技能和指定技能。此次入口移动不新增数据库迁移，也未发布新安装包。
- **安装格式**：选择单个 `SKILL.md` 或包含它的技能文件夹，预览后安装。根文件须有 YAML frontmatter，`name` 使用小写字母、数字和连字符，`description` 非空；允许附带包内文本资料。最多 64 个文本文件，每文件 64 KiB、每包 512 KiB，`SKILL.md` 正文最多 32,000 字符。同名包不能静默覆盖；内置技能仅可启停，用户技能还可卸载。二进制资料不作为可读取文本导入；脚本即使保存，也只作为文本资料，不执行。
- **本地保存**：安装内容和启停设置保存在应用数据库，由所有项目共用，不依赖 `process.cwd()` 或项目 `workspacePath`。SDK 的全局/项目技能、扩展、提示词和上下文文件自动发现已关闭；已有 `.agents/skills` 或 `.pi/skills` 不会自动出现在列表，需要通过安装入口导入。
- **运行限制**：`skill_load` / `skill_read` 只读取本轮允许的技能及其包内文本；每轮最多加载三个技能，资源每段最多 12,000 字符、每轮最多 48,000 字符。领域工具继续保留每轮一个草稿写入和 `ai_actions` 审计，不因技能正文获得额外工具权限。
- **历史与调试**：消息保留实际加载技能的完整内容快照、来源、内容哈希及加载时间；停用、卸载或重装不改写旧记录。使用模拟模型与临时数据库检查启停/选择、路径与大小校验、自动加载和历史保留；不以执行未知脚本或扩展证明技能可用。入口是 `server/routes/agent-skills.ts`、`server/services/agent-skills.ts`、`server/services/pi-agent.ts` 和 `server/routes/conversations.ts`。

一个最小的 `SKILL.md` 示例：

```markdown
---
name: research-checklist
description: 用项目已有证据检查研究问题是否清楚、可验证。
---

先读取当前项目上下文，区分已有事实与待验证假设。
按“研究问题、支持证据、缺失条件、下一步核验”给出检查结果。
只引用实际提供的项目对象；资料不足时明确说明，不编造文献或结果。
```

若需要额外清单，可把它保存为技能文件夹中的 `references/checklist.md` 并在正文引用；Agent 按需通过 `skill_read` 读取该包内文本。安装来源限本地文件与文件夹，当前没有 GitHub URL 安装或第三方脚本执行入口。

## 迁移是双轨的

- **`drizzle/` + journal（`drizzle/meta/_journal.json`）覆盖 0000–0007**，由 `scripts/migrate.ts` 应用（`pnpm run db:migrate`）。
- **0007 之后全部由 `scripts/migrate-custom.ts` 逐条手写执行**：`0008_drop_accounts`、`0009_workspace_path`、`0010_research_question_origins`、`0011_experiment_result_analysis`、`0012_research_agent_conversations`、`0013_research_question_conclusions`、`0014_research_question_evidence`、`0015_agent_skills`。原因是 drizzle migrator 的 libsql 批处理路径会在多语句迁移上抛 `SQLITE_UNKNOWN_0`。每个 hash 会登记进 `__drizzle_migrations`。
- `tests/api/helpers.ts` 用同一个脚本构建全新临时库。
- `0015_agent_skills` 新增 `agent_skills` 表，并为 `ai_messages` 增加 `skills_json`（默认 `[]`，实际加载快照）与 `skill_selection_json`（默认 `null`，自动选择；`[]` 表示不使用技能）列，保留已有消息与研究数据。源码旧库升级先确认 `DATABASE_URL` 指向需要升级的库，再运行 `pnpm exec tsx scripts/migrate-custom.ts`；`pnpm run db:migrate` 只处理上面的 drizzle 轨道，不能替代本迁移。
- schema 旧注释还把 0015/0016 用于 `evidence_layers.promotedTo`，那部分没有独立 journal / SQL，属于历史说明；不要与实际的 `0015_agent_skills` 混淆。

**改 schema 之后**：0000–0007 形状的改动走 `pnpm run db:generate`；其他情况扩展 `migrate-custom.ts`。

## 测试

- **`tests/unit/**`** — 默认 happy-dom，服务端单测用文件头切换 Node 环境。覆盖浏览器状态、阅读器、API 助手和 Agent 生命周期；skills 用例检查安装预览、选择/重试、历史预览、受限资源读取和写入校验。
- **`tests/api/**` + `helpers.ts`** — 每个文件顶部有 `// @vitest-environment node` docblock。`helpers.ts` 给每个文件一个临时 SQLite 库（全新、经 `migrate-custom.ts` 迁移、无账号种子）加 `app.request(url, init, bindings)`；skills 用例还覆盖安装管理、旧库迁移、fresh seed 幂等及消息快照保留。**新 binding 必须加进 `helpers.ts`**（`LATEX_ENGINE_PATH`、`SEARXNG_BASE_URL`、`SEARXNG_TIMEOUT_MS` 已在）。临时目录尽力清理（Windows 文件句柄可能残留，无害）。
- **`tests/fixtures/`** — 小样本 PDF、假 tectonic 的 `main.tex`、阅读器划词样本。
- **本 checkout 没有 CI 配置**——typecheck / test / build 都是交付前的手动门禁。

## 文档规则（强制）

以 [`../AGENTS.md`](../AGENTS.md) 的现行规则为准：

任何**用户可见**的功能变更，必须在**同一个任务内**更新 **`README.md`**（中文，主），同一轮同步英文版 **`README.en.md`**，并在 [`../CHANGELOG.md`](../CHANGELOG.md) 追加条目。版本历史集中在该文件，README 只保留指向它的入口。

README 编辑属于实现的一部分，不是收尾抛光。仅纯重构、以及对用户不可见的内部改动（测试、CI、开发工具）可以跳过。

## 交付前门禁

```bash
pnpm run typecheck
pnpm run test
pnpm run build
```

汇报时说明：改了哪些文件、迁移影响、测试结果、已知缺口——不要只说「做完了」。
