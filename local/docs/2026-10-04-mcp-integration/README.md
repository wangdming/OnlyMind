# 任务:MCP 接入(优麦云 / 卖家精灵)

> 开始:2026-10-04 · 状态:**已完成**(claude 引擎 + 优麦云/卖家精灵;演示 key 实测通过)

## 问题
让 OnlyMind 的引擎在执行任务时能通过 **MCP** 连接外部服务(优麦云 SellerSpace、卖家精灵 SellerSprite),从而用自然语言查询/操作亚马逊数据。

## 背景
- 两服务均提供**官方远程 HTTP MCP**:
  - 优麦云:`https://www.sellerspace.com/mcp/`,头 `x-api-key: sk-ss-…`(演示 key `demo_aurelia_2026`)。
  - 卖家精灵:`https://mcp.sellersprite.com/mcp`,头 `secret-key: …`。
- **POC 已验证**:Claude Code `claude -p --mcp-config <file> --strict-mcp-config` + 演示 key 成功连接优麦云,列出 19 个工具(is_error=false)。
- 引擎适配性:
  - claude/codex(CLI):MCP 支持任意自定义头 → 适配两服务。
  - API 引擎:Anthropic connector 仅 Bearer(不支持自定义头)→ 不适配;OpenAI 需 Responses API(无额度验证)。暂不做,文档记录。

## 预期(本轮验收)
- OnlyMind 可**管理 MCP 服务器**(增/查/删:name、url、header 名、header 值),存电脑端。
- 任务可选「启用 MCP」;启用且引擎为 **claude** 时,自动按任务注入 `--mcp-config`(临时文件、`--strict-mcp-config`、用后删除),使任务能调用这些 MCP 工具。
- codex:尽力而为(经临时 `CODEX_HOME` 注入),未安装故不实测。
- **真实验证(claude + 优麦云演示 key)**:通过 OnlyMind 发任务,让 claude 经 MCP 列出/调用优麦云工具成功。
- 单测:MCP CRUD、claude mcp-config 组装、任务 mcp 标志。

## 实现方案
- 数据层:`mcp_servers(name PK, url, header_name, header_value, created_at)`;`tasks` 加 `mcp` 列。
- 接口:`GET/POST /api/mcp`、`DELETE /api/mcp/:name`(列表遮蔽 header 值);`POST /api/tasks` 接受 `mcp` 布尔。
- 执行:runner 注入——
  - claude:写临时 mcp-config JSON → `--mcp-config <f> --strict-mcp-config`,close 后删文件。
  - codex:临时 `CODEX_HOME` + config.toml(best-effort)。
  - API 引擎:暂不注入(文档说明限制)。
- 注入源:index.js 提供 `getMcpServers()`(读 db)。
- 前端:设置里管理 MCP 服务器(预置优麦云/卖家精灵快捷填充)+ 发任务区「启用 MCP」开关(持久化)。

## 测试方案
- 单元:mcp CRUD(含遮蔽)、`buildClaudeMcpConfig()` 纯函数、task mcp 标志存取。
- 真实:claude + 优麦云演示 key 端到端(列工具 / 只读查询)。
- 回归:全量 npm test。

## 子任务
- [x] M1 数据层:mcp_servers 表 + tasks.mcp + db 函数(list/set/delete)
- [x] M2 接口:/api/mcp CRUD(GET 遮蔽 header 值)+ task mcp 标志
- [x] M3 执行:claude 注入(临时 mcp-config + --strict-mcp-config,close 后删)+ index `getMcpServers`。codex 本轮不自动注入(避免写错配置破坏;文档说明手动)。
- [x] M4 单测:buildClaudeMcpConfig、/api/mcp CRUD+遮蔽、task mcp 标志(38/38)
- [x] M5 前端:设置里 MCP 管理(列表/删除/新增 + 优麦云·卖家精灵快捷填充)+ 发任务区「启用 MCP」开关(持久化)
- [x] M6 真实验证:OnlyMind → claude(mcp:true)→ 优麦云演示 key → 成功列出 19 个工具;文档更新

- [x] M7 Codex 自动配置:`src/codexmcp.js`(`buildCodexMcpToml`/`syncCodexConfig`,用 `http_headers` + 标记块、保留其它配置)+ `/api/mcp/codex-apply`·`/codex-clear` + 前端「写入 Codex 配置 / 从 Codex 移除」按钮。单测(生成/合并/替换/移除/端点)+ 真实写文件验证(CODEX_HOME 临时目录)通过。**Codex 实际连接未在本机验证(无 codex)**。

## 结论(API 引擎)
- claude:✅ 完整支持并实测。
- codex:✅ OnlyMind 一键写入其 `config.toml`(`http_headers`,官方格式);写文件已验证,Codex 实际连接无本机环境未实测。
- openai(API):需 Responses API 的 mcp 工具(支持自定义头),无额度未做,后续可加。
- anthropic(API):MCP connector 仅 Bearer,不支持 x-api-key/secret-key 自定义头 → **不适配这两个服务**。

## 进度日志
- 2026-10-04:POC 成功(claude 连优麦云演示 key 列 19 工具)。确定方案:本轮聚焦 CLI 引擎。开始 M1。
- 2026-10-04:**M1–M6 完成**。数据层/接口/claude 注入/前端 全部就绪,38/38 测试;**端到端实测(claude + 优麦云演示 key)成功列出 19 工具**。API 引擎限制已记录。**任务完成。**
