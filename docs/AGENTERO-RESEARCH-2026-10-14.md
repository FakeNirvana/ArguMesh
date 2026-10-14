# Agentero 竞品分析（2026-10-14）

Agentero 与 ArguMesh 在本地文献库、PDF 阅读、笔记和 Agent 协作上直接竞争，值得作为重点竞品持续对照。其优势集中在文献发现、Zotero 迁移、阅读上下文和外部 Agent 互操作；ArguMesh 的差异集中在证据矩阵、人工核验、研究问题、实验结果分析与写作快照形成的结构化研究链路。

## 核验范围与计数口径

- 仓库：[poco-ai/Agentero](https://github.com/poco-ai/Agentero)，官网：[agentero.app](https://agentero.app)，MIT。
- 2026-10-14 GitHub API 查询快照：**942 stars / 73 forks**，数字会变化。
- 最新正式发布：**[v0.11.7](https://github.com/poco-ai/Agentero/releases/tag/v0.11.7)**，发布于 2026-10-08。源码盘点固定在 **[d20787f](https://github.com/poco-ai/Agentero/commit/d20787f0680084c758c290e923b790f6110865b3)**（2026-10-14）；以下不是仅针对 v0.11.7 安装包的验收清单。
- 方法：读取官方 README、使用/架构/前后端文档，抽查对应源码入口；**没有安装运行 Agentero，也没有实测模型、同步或移动端**。文档存在实现说明不等于质量或稳定性已验证。
- 官方 README 按 **4 大功能方向**介绍；本次把可辨识的用户能力归为 **10 个模块、40 项能力**。这是分析口径，非官方公布数字，亦非穷尽所有功能。组合操作算一项，同一能力通过 UI、CLI、MCP 暴露不重复计数；快捷键、主题、修复条目、平台适配不单独计数。
- 下表使用编号 01–40，便于复核。iOS 远程客户端、播客占位与其他规划项另列，不计入这 40 项。

## 功能盘点：10 个模块、40 项能力

| 模块 | 数量 | 能力（编号） | 官方依据 |
| --- | ---: | --- | --- |
| 文献入库与管理 | 5 | **01** 标识符/URL 批量入库及元数据/资源获取（DOI、arXiv、PMID、ISBN 等）；**02** 本地 PDF 选择/拖拽导入；**03** Zotero 全库迁移（分类、标签、笔记、高亮与附件）；**04** 文件夹作用域、表格排序筛选、标签与元数据编辑；**05** 删除进回收站、恢复与永久删除 | [导入与管理][import]、[Catalog][catalog] |
| PDF 阅读与结构化上下文 | 6 | **06** 大纲、页码、缩放、全文查找与沉浸阅读；**07** 文字高亮及页边评论；**08** 图/表/算法/公式区域框选、裁剪与批注；**09** 版面分析及 Figures 索引、位置跳转；**10** 参考文献解析、关联论文导入与引用近邻图；**11** 基于阅读/标注活动的阅读热力条 | [阅读与整理][reader]、[Library][library] |
| 翻译 | 3 | **12** 划词翻译；**13** 本页翻译与对照展示；**14** 按版面分批的全文翻译、覆盖层与缓存 | [阅读与整理][reader]、[翻译配置][translate] |
| 笔记与知识链接 | 4 | **15** 所见即所得 Markdown、数学公式与属性编辑；**16** 文档/标题/文本块/批注双链及反链；**17** Markdown 区段、图片、PDF 与批注嵌入；**18** 文件移动/重命名时修复已解析链接 | [阅读与整理][reader]、[Wiki UI][wiki]、[改链源码][rename] |
| Agent 协作 | 5 | **19** ACP BYOA 接入本地兼容 Agent；**20** 会话历史恢复、切换与重命名（受各 Agent 能力限制）；**21** 当前论文、路径提及、划词行号、批注及图片上下文；**22** paper-reader 手动/可选自动精读并写笔记；**23** 选择安装与运行 Vault 内科研 Skill | [Agent 使用][agents]、[Agent UI][agent-ui]、[v0.11.7][release] |
| 文献发现与学术雷达 | 5 | **24** Cool Papers / ModelScope 浏览与一键入库；**25** 学术 RSS 订阅；**26** 根据本地库内容做 arXiv Daily 推荐；**27** 查询式 arXiv 发现、可解释词法排序、可选语义排序、在库去重及短名单导出；**28** CCF 截稿面板、评级筛选与明确标注的预计日期 | [广场][plaza]、[CLI 发现][cli]、[v0.11.7][release]、[截稿面板源码][deadlines] |
| 生态互通 | 3 | **29** Zotero Connector 浏览器采集兼容服务；**30** BibTeX / BibLaTeX 导出；**31** MCP Server 暴露论文、笔记、版面与发现工具供外部客户端调用 | [Connector][zotero]、[README][readme]、[MCP][mcp] |
| 桌面工作区与写作 | 3 | **32** Dockview 标签、多向分屏、文档独立窗口与布局恢复；**33** CodeMirror 文本/TeX 编辑、LaTeX root 解析与本地引擎编译/PDF 更新；**34** 后台任务进度与取消 | [工作区][workspace]、[阅读与整理][reader]、[编译 root 源码][compile] |
| 数据与跨设备使用 | 3 | **35** 透明 Vault 文件、SQLite Catalog 与 metadata sidecar；**36** S3 / WebDAV 手动及自动同步；**37** SSH 远程 Vault、SFTP 文件访问与远端 Agent | [数据模型][data]、[同步实现][sync]、[远程 Vault][remote] |
| 自动化与维护 | 3 | **38** 无头 CLI、机器可读 JSON 与桌面工作区控制；**39** Doctor 结构/坏链/别名/视觉批注/重复记录诊断与部分修复；**40** Vault Markdown 关键词搜索，返回行号及可确定的论文页码，支持 MCP 元数据过滤 | [CLI][cli]、[MCP 工具][mcp] |
| **合计** | **40** | **5 + 6 + 3 + 4 + 5 + 5 + 3 + 3 + 3 + 3** | 以上为当前源码/文档能力盘点，未作运行验收 |

## 需要明确的边界

1. **本地优先不等于所有处理都离线。** 笔记/PDF/TeX/marks 是本地文件，论文集合与元数据由 Catalog SQLite 管理；模型调用、发现、翻译、可选云端正文解析可能使用外部服务。ACP 启动在本机，也不能据此断言模型推理不出网。[数据模型][data]、[Agent 使用][agents]。
2. **AI 精读有条件。** 需 PDF 和 TeX 或 `PAPER.md` 等可读正文；自动精读默认关闭，批量导入/批量 Download 不会自动连跑精读。不能据此算出无人值守科研全流程。[Agent 使用][agents]。
3. **权限与 Diff 已有产品设计。** 其文档提供受限/每次询问/自动批准模式，以及 Agent 修改笔记后的 Keep/Revert。不能笼统写成“没有 Agent 写入控制”；但也不能等同 ArguMesh 的领域白名单、结构化校验、动作审计和确认内容守卫。[Agent 使用][agents]。
4. **远程能力有平台和并发限制。** 官方使用文档明确 Windows 客户端暂不能打开远程 Vault；远程 MVP 按单写者设计。远程 Vault 不支持本地 MCP 服务与 Skill 导入，部分元数据编辑亦受限。[远程 Vault][remote]、[MCP 使用][mcp-usage]、[导入与管理][import]。
5. **同步并非实时协同。** 已实现 S3/WebDAV 手动与自动同步；文档注明状态栏指示、GC、multipart 尚未全部落地。Markdown 冲突可另存副本，其他类型存在按修改时间择一的规则，不能承诺所有类型都保留版本。[同步实现][sync]。
6. **移动端另算实验性观察项。** 当前主干有 iOS 远程客户端文档：手机配对桌面 Bridge，远程读 PDF、改 NOTES、与桌面 Agent 对话；不是手机独立 Vault 或独立 Agent。本次未核验公开上架/安装分发，未计入桌面 40 项。[移动端][mobile]。
7. **占位不算交付。** 广场文档把播客写为占位，后续托管同步也属于设计方向；均未计入本次清单。[广场][plaza]、[同步设计][sync-plan]。
8. **搜索、图谱与编译的含义要区分。** `vault_search` 是 Markdown 关键词搜索，不是全库语义 RAG；arXiv 推荐/发现的可选 embedding 是另一项能力。文献引用图也不是人工核验的证据矩阵。当前源码确有 TeX 编辑与编译，旧名单“只有 BibTeX 导出”的描述需修正。[MCP][mcp]、[工作区][workspace]。

## 与 ArguMesh 的对照

ArguMesh 列以本仓库当前 [产品规范](PROJECT-SPEC.md)、[AGENTS.md](../AGENTS.md) 和 README 为依据；Agentero 列以以上固定源码快照为依据。“未发现”表示本次材料中没有看到相应一等对象或产品流程，不断言其他 Skill 做不到。

| 维度 | Agentero | ArguMesh | 竞争含义 |
| --- | --- | --- | --- |
| 数据中心 | Vault 文件 + Catalog SQLite + sidecar | SQLite 中结构化研究对象；本地工作区文件 | 双方都本地优先；Agentero 更方便与外部文件工具互用 |
| 阅读与上下文 | PDF/NOTES 分屏、文字/视觉批注、Figures、引用关系、双链 | OCR、划词问答、批注、双语对照、带出处 Paper Card | 阅读体验直接竞争，不能只以“本地优先”区分 |
| 文献发现/存量迁移 | Cool Papers、RSS、arXiv 推荐、CCF、Zotero/Connector | 标识符/PDF/文件夹入库，项目文献管理 | Agentero 的入口覆盖是明显优势 |
| Agent 接入 | ACP 多 Agent + Skill + MCP + CLI | Pi AgentSession + 项目上下文 + 领域工具 | Agentero 强在开放互操作；ArguMesh 强在对象和动作约束 |
| 证据核验 | 有引用位置、批注、图谱；未发现证据格确认/锁定流程 | Evidence Matrix、draft/confirmed/conflict/missing、人工锁定 | ArguMesh 应明确展示该差异，避免把普通引用当核验 |
| 研究问题与实验 | 可在自由笔记/Agent 中表达；未发现同等 RQ/实验结果对象流程 | 洞见 → RQ → 证据 → 实验设计/结果分析 | ArguMesh 的研究链路是可验证的差异点 |
| 写作 | 当前主干有 TeX 编辑和编译；Agent 可协作文本 | LaTeX workspace、快照、需接受的 AI Diff、编译 | 编译本身已非独占优势；保留历史和研究证据关联更重要 |
| 隐私与外发范围 | 有全文翻译/正文解析/Agent 文件上下文；实际外发依所选服务 | 阅读器问答/翻译仅选中或当前页分段，记录来源/模型/时间 | ArguMesh 应保留最小暴露原则，不能照搬整篇上下文 |
| 跨设备 | S3/WebDAV、SSH；主干另有 iOS 远程客户端 | 无强制云依赖、单用户本地运行 | 是功能覆盖差异，不据此引入云存储、账号或鉴权 |

## 借鉴建议（产品判断，尚未实施或排期）

| 优先级 | 建议方向 | 原因与约束 |
| --- | --- | --- |
| 高 | Zotero 存量导入与 BibTeX 互通 | 降低科研用户迁移门槛；可保持本地单用户，不要求 Zotero 账号 |
| 高 | 图表/公式区域 → 原页位置 → 笔记/证据的可跳转引用 | 让图表解读回到证据链；发送选中区域或当前页有界内容 |
| 高 | 当前论文/选段/证据的上下文清单与出处展示 | 提高 AI 输入透明度；继续执行模型/时间溯源与确认内容守卫 |
| 中 | 参考文献关联及 RSS/轻量文献发现 | 减少浏览器到工作台的搬运，优先明确来源和去重规则 |
| 中 | ACP / MCP / CLI 的可选互操作 | 值得研究；写入仍只走现有 routes 白名单和审计，不能放开通用文件/命令写入 |

保持 ArguMesh 的证据矩阵、RQ、实验结果与写作版本主线；本分析不调整 TODO、不实施竞品功能、不引入云同步/账号/产品级键盘快捷键，也不宣称 Agentero 有无完整实验执行能力（本次未发现独立的实验编排产品流程）。

## 固定来源与源码入口

以下仓库文件全部固定到 `d20787f0680084c758c290e923b790f6110865b3`，避免后续主干变化改变本次证据。发布说明使用独立版本链接。

[readme]: https://github.com/poco-ai/Agentero/blob/d20787f0680084c758c290e923b790f6110865b3/README.md
[import]: https://github.com/poco-ai/Agentero/blob/d20787f0680084c758c290e923b790f6110865b3/docs/usage/import-papers.md
[catalog]: https://github.com/poco-ai/Agentero/blob/d20787f0680084c758c290e923b790f6110865b3/docs/backend/catalog.md
[reader]: https://github.com/poco-ai/Agentero/blob/d20787f0680084c758c290e923b790f6110865b3/docs/usage/read-and-organize.md
[library]: https://github.com/poco-ai/Agentero/blob/d20787f0680084c758c290e923b790f6110865b3/docs/frontend/library.md
[translate]: https://github.com/poco-ai/Agentero/blob/d20787f0680084c758c290e923b790f6110865b3/docs/usage/translate-openai-compatible.md
[wiki]: https://github.com/poco-ai/Agentero/blob/d20787f0680084c758c290e923b790f6110865b3/docs/frontend/wiki.md
[rename]: https://github.com/poco-ai/Agentero/blob/d20787f0680084c758c290e923b790f6110865b3/crates/agentero-core/src/features/markdown/wiki/rename.rs
[agents]: https://github.com/poco-ai/Agentero/blob/d20787f0680084c758c290e923b790f6110865b3/docs/usage/agents.md
[agent-ui]: https://github.com/poco-ai/Agentero/blob/d20787f0680084c758c290e923b790f6110865b3/docs/frontend/agent.md
[plaza]: https://github.com/poco-ai/Agentero/blob/d20787f0680084c758c290e923b790f6110865b3/docs/development/plaza.md
[deadlines]: https://github.com/poco-ai/Agentero/blob/d20787f0680084c758c290e923b790f6110865b3/src/components/plaza/plaza-ccf-deadlines-view.tsx
[zotero]: https://github.com/poco-ai/Agentero/blob/d20787f0680084c758c290e923b790f6110865b3/docs/usage/zotero.md
[mcp]: https://github.com/poco-ai/Agentero/blob/d20787f0680084c758c290e923b790f6110865b3/docs/backend/mcp.md
[mcp-usage]: https://github.com/poco-ai/Agentero/blob/d20787f0680084c758c290e923b790f6110865b3/docs/usage/mcp.md
[workspace]: https://github.com/poco-ai/Agentero/blob/d20787f0680084c758c290e923b790f6110865b3/docs/frontend/workspace.md
[compile]: https://github.com/poco-ai/Agentero/blob/d20787f0680084c758c290e923b790f6110865b3/src-tauri/src/features/compile/root.rs
[data]: https://github.com/poco-ai/Agentero/blob/d20787f0680084c758c290e923b790f6110865b3/docs/backend/data-model.md
[sync]: https://github.com/poco-ai/Agentero/blob/d20787f0680084c758c290e923b790f6110865b3/docs/backend/sync.md
[sync-plan]: https://github.com/poco-ai/Agentero/blob/d20787f0680084c758c290e923b790f6110865b3/docs/development/cloud-sync-s3.md
[remote]: https://github.com/poco-ai/Agentero/blob/d20787f0680084c758c290e923b790f6110865b3/docs/usage/remote-vault.md
[mobile]: https://github.com/poco-ai/Agentero/blob/d20787f0680084c758c290e923b790f6110865b3/docs/usage/mobile.md
[cli]: https://github.com/poco-ai/Agentero/blob/d20787f0680084c758c290e923b790f6110865b3/docs/backend/cli.md
[release]: https://github.com/poco-ai/Agentero/releases/tag/v0.11.7
