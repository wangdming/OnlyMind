# MCP 同步:原生续接(本地 AI 直接 resume 引擎会话)

## 问题
"会话同步到电脑端"(MCP)目前只给本地 AI **文本转录**让其"基于转录继续"。既然现在已捕获引擎原生会话 id,可让本地 AI 直接续接**引擎自己的会话**,上下文更完整(工具状态、完整推理),实现真正"无缝续接"。

## 背景(已实测)
- codex:`codex exec resume <thread_id>` —— **任意目录**可续接(跨目录 OK)。
- claude:`claude --resume <id>` —— **仅限任务当初运行的同一目录**(claude 按项目目录归档;跨目录报 "No conversation found")。claude 的 resume id = OnlyMind 的会话 id(首轮用 `--session-id <ourId>`)。
- api(openai/anthropic):引擎侧无会话 → 无原生续接,仍用转录。
- 会话 cwd 来源:任务行 `tasks.cwd`(为空则 `config.defaultCwd`)。`sessionSyncRows`/`getSession` 用 `SELECT *`,已含 `engine_session_id`。

## 预期
1. `get_session_transcript` 顶部给出"续接方式":可用时提供**原生续接命令**(claude 带所需目录),否则仅转录;转录本身保留为兜底。
2. `list_sessions` 对可原生续接的会话加标记。
3. `SERVER_INSTRUCTIONS` 指引:引擎匹配时优先原生续接,否则用转录。
4. 纯增量、读库只读;不破坏既有同步语义(读取仍标记已同步)。
5. `npm test` 全绿 + MCP e2e 冒烟。

## 实现方案(`scripts/mcp-server.mjs`)
- 新增纯函数 `buildResumeHint(session, cwd)` → `{engine,id,cwd,command,note}` 或 `null`(api/未捕获)。
- 新增 `formatResumeHint(hint)` → 文本块。
- `buildTranscript(session, tasks, partial, resumeHint)` 第 4 参注入"续接方式"块(向后兼容)。
- `get_session_transcript`:由 tasks 推导 cwd(最后一个有 cwd 的任务,否则 `config.defaultCwd`)→ `buildResumeHint` → 传入 `buildTranscript`。
- `formatSessionList`:对可原生续接(codex 有 `engine_session_id`;claude 且 `total>0`)加 "· 可原生续接"。
- 更新 `SERVER_INSTRUCTIONS`(+可选 sync prompt 文案)。

## 测试方案
- 单元:`buildResumeHint`(claude 带 cwd/codex/api/未捕获)、`formatResumeHint`、`buildTranscript` 含命令、`formatSessionList` 标记。
- e2e:真实 codex 会话 → MCP transcript 含 `codex exec resume <tid>`;claude 会话(造数据)transcript 含 `claude --resume <id>` + 目录提示。

## 子任务
- [x] 1. `buildResumeHint` + `formatResumeHint`(纯函数,导出)。
- [x] 2. `buildTranscript` 注入续接块;`get_session_transcript` 推导 cwd 并传入。
- [x] 3. `formatSessionList` 加标记("· 可原生续接")。
- [x] 4. 更新 `SERVER_INSTRUCTIONS` 与 sync prompt 文案。
- [x] 5. 单测(+2 块,共 57 全绿)+ e2e 冒烟;文档收尾。

## 进度日志
- 2026-10-08:方案定稿(含 claude cwd 限制、codex 跨目录结论,均已实测)。
- 2026-10-08(实现):`scripts/mcp-server.mjs` 全部落地,仅改 MCP 层(只读库,不动引擎/服务)。
  - 单测:新增 `buildResumeHint`(claude cwd 域 / codex 任意目录 / api 与未捕获=null)、`formatResumeHint`+`buildTranscript` 注入命令,并加强 `runTool` 用例(list 含「可原生续接」、transcript 含 `claude --resume S`)。**共 57 项全绿**。
  - e2e(真实 mcp-server + ONLYMIND_DB):真实 codex 会话 transcript 含 `codex exec resume <tid>(任意目录均可)`;claude 会话 transcript 含 `claude --resume <id>` 且目录提示取自任务 cwd;list_sessions 两者均标「可原生续接」。痕迹已清理。
  - 文案微调:续接提示用 `—— ` 连接命令与说明(避免嵌套括号)。
- **收尾完成**。改动文件:`scripts/mcp-server.mjs`、`test/api.test.js`。既有同步语义不变(读取仍标记已同步)。
