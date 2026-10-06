# 任务:OnlyMind MCP 服务(让本地 Claude/ChatGPT 续接 OnlyMind 的工作)

> 开始:2026-10-05 · 状态:**已完成**(Claude Code 真实接入验证通过)

## 问题
用户希望本地的 Claude / ChatGPT 能"学习"OnlyMind 会话里处理过的问题与任务,从而无缝衔接继续。选定**路径 3:把 OnlyMind 做成 MCP 服务**,输出**完整转录**。

## 背景
- OnlyMind 本地 SQLite 已存:`sessions`(name/engine/summary)、`tasks`(prompt/output/error/status/session_id/created_at)。
- 本地 AI 接入 MCP 后即可调用工具读取这些数据:Claude Code/Desktop、Codex、支持连接器的 ChatGPT。
- 复用既有 db 函数;只读访问。

## 预期(验收)
- 一个**本地 stdio MCP 服务** `scripts/mcp-server.mjs`,暴露工具:
  - `list_sessions(engine?)`:列出会话(id/name/engine/轮数/时间)。
  - `get_session_transcript(session_id)`:返回该会话**完整转录**(摘要 + 每轮 问/答全文 + 状态/时间),不截断。
  - `search_tasks(query, limit?)`:在所有任务的 prompt/output 里全文检索。
- 一键挂到 Claude:`npm run mcp:claude`(或文档命令)。
- **真实验证**:Claude Code 接入该 MCP 后能 list / 读取完整转录 / 搜索。
- 无新 npm 依赖(手写 JSON-RPC over stdio)。

## 实现方案
- `db.js` 增:`sessionTasksFull(db,id)`(全字段、oldest→newest)、`searchTasks(db,q,limit)`。
- `scripts/mcp-server.mjs`:读 `config.dbPath`(含 ONLYMIND_DB 覆盖),实现 MCP stdio:
  - 处理 `initialize` / `notifications/initialized` / `tools/list` / `tools/call` / `ping`。
  - newline-delimited JSON-RPC 2.0。
  - 工具返回 `content:[{type:'text',text}]`。
- `scripts/install-mcp-claude.mjs` + npm `mcp:claude`:`claude mcp add --scope user onlymind -- node <绝对路径>/scripts/mcp-server.mjs`。
- 文档:使用手册加"让本地 Claude 接入 OnlyMind 会话"一节。

## 测试方案
- 单元:sessionTasksFull / searchTasks(db);transcript 文本组装纯函数。
- 真实:用 `claude -p --mcp-config <stdio 指向 mcp-server> --strict-mcp-config` + 预置测试库,验证三个工具。
- 回归:npm test。

## 子任务
- [x] S1 db 函数:`sessionTasksFull` / `searchTasks`
- [x] S2 `scripts/mcp-server.mjs`:手写 JSON-RPC/stdio(initialize/tools/list/tools/call/ping/通知)+ 三工具 + 可导出纯函数(buildTranscript/formatSessionList/formatSearch/runTool)
- [x] S3 单测:db 函数 + 转录/列表/搜索组装 + runTool(含错误)(46/46)
- [x] S4 真实验证:Claude Code 经 `--mcp-config` stdio 接入 → list_sessions → get_session_transcript 返回**完整转录**,is_error=false
- [x] S5 一键挂载 `scripts/install-mcp-claude.mjs`(`npm run mcp:claude` / `-- remove`,实测 ✔ Connected)+ 使用手册新增一节

## 进度日志
- 2026-10-05:建文档,定方案(stdio、无依赖、完整转录)。开始 S1。
- 2026-10-05:**S1–S5 全部完成**。无新依赖的 stdio MCP 服务上线,暴露 list_sessions/get_session_transcript(完整转录)/search_tasks;Claude Code 真实接入通过;`npm run mcp:claude` 一键挂载(实测挂载→Connected→移除)。46/46 测试。**任务完成。**
