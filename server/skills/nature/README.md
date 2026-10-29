# Nature 技能资源

来源为用户下载并提供的 11 个 `nature-*` 技能包，经用户明确授权适配后随 ArguMesh 源码保存和提交。`catalog.json` 只记录名称、说明和包内资源路径；技能正文及全部研究参考资料各自保存为独立文件。

## 适配与运行边界

- 沿用已验证的本地文本适配：根 `SKILL.md` 加入 ArguMesh 可用工具说明，大脚本以文本分块保留，文件数量和大小满足应用安装边界。原下载文件未被修改。文件换行统一为 LF。
- `SKILL.md`、`manifest.yaml`（原包提供时）、`static/`、`references/`、研究案例与脚本文本保留。根说明只要求读取资源列表中实际存在的 manifest，不补造原包没有的文件。
- 原包引用的 `_shared/` 资料未随用户提供的下载包出现；本目录不编造或自动下载它们。相关步骤须说明资料缺失，并使用已提供的包内参考资料或请用户补充。
- `skill_load` / `skill_read` 仅将目录内已登记的文本作为工作流说明。脚本、MCP 服务和安装器不执行，不获得通用文件访问、Python/R/Shell、MCP 调用或创建 PPTX/DOCX/图片的权限。
- 发布前剔除不参与该只读工作流的代理元数据、评测、主机配置、原始 README、安装脚本及 MCP 实现测试；其中评测配置含作者本机论文样例路径，不进入发布资源。保留资料中的联系邮箱统一换成明确的示例地址 `researcher@example.org`。

## 第三方内容与许可

未在用户提供的包中发现独立的上游 `LICENSE` 文件。本目录的第三方正文、示例和参考资料保留其原有权利状态，不因仓库根目录的 MIT License 自动获得 MIT 再许可；本说明不虚构上游许可或期刊官方授权。

## 剔除的非运行资料

- `nature-academic-search`：`README.md`、`config/mcp-snippet.json`、`config/settings-snippet.json`、`config/triggers-academic-search.toml`、`install.sh`、`mcp-server/README.md`、`mcp-server/config.toml`、`mcp-server/tests/__init__.py`、`mcp-server/tests/test_elsevier_live.py`、`mcp-server/tests/test_mcp_tools.py`、`mcp-server/tests/test_sources.py`。
- `nature-citation`：`README.md`、`evals/evals.json`。
- `nature-data`：`README.md`、`agents/openai.yaml`。
- `nature-figure`：`README.md`、`evals/evals.json`。
- `nature-paper-to-patent`：`README.md`、`evals/evals.json`。
- `nature-paper2ppt`：`README.md`。
- `nature-polishing`：`README.md`。
- `nature-reader`：`README.md`、`evals/evals.json`。
- `nature-response`：`README.md`。
- `nature-reviewer`：`README.md`。
