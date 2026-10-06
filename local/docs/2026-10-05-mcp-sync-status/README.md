# 任务:MCP 同步状态(自动检查待同步 + 可标记不同步)

> 开始:2026-10-05 · 状态:**已完成**(Claude Code 真实验证通过) · 依赖:2026-10-05-onlymind-mcp-server

## 问题
让本地 Claude/Codex/ChatGPT 通过 OnlyMind MCP:
1. **自动检查**是否有需要同步(续接)的会话;
2. 读取过的会话**不重复**同步;
3. 用户能**标记某些会话"不需要同步"**(排除)。

## 背景
- 已有 `scripts/mcp-server.mjs`(list_sessions / get_session_transcript / search_tasks)。
- 需引入会话的"同步状态":拉取标记(已同步到哪)+ 忽略标记。

## 预期(验收)
- 新工具 `check_sync()`:返回需要同步的会话(有新轮、未忽略),没有则明确告知。
- `get_session_transcript` 读取后**自动推进拉取标记**(即视为已同步);支持 `since_last_pull` 只取增量。
- `list_sessions` 增字段:`pending`(新轮数)、`pulled`、`ignored`;支持 `only_new` / `include_ignored`。
- `set_sync_ignore(session_id, ignored)`:AI 可代用户标记"不同步";`mark_synced(session_id)` 不读取也可标记已同步。
- 手机端:会话可勾选「不同步」(写同一状态)。
- MCP `instructions` 说明以上规则;MCP prompt `sync`(斜杠命令)一键"检查+同步"。
- 单测 + Claude Code 真实验证("取过后 check_sync 不再出现"、"忽略后被排除")。

## 实现方案
- db:sessions 加 `sync_ignored`、`last_pulled_at`(migration)。helper:`sessionSyncRows(db)`(含 pending 计算)、`markSessionPulled(db,id)`(标记到最新任务时间)、`setSyncIgnored(db,id,ignored,now)`、`sessionsNeedingSync(db)`。
- `mcp-server.mjs`:initialize 加 `instructions`;新增/增强工具;`prompts/list`+`prompts/get`(sync)。
- `server.js`:`POST /api/sessions/:id/sync-ignore {ignored}`;session 对象自带 sync 字段(SELECT *)。
- 前端:sessionBar 加「不同步」勾选。
- 文档:使用手册 + 本文档 + 07-progress。

## 定稿决策
- 读取转录 = 自动标记已同步(省心)+ 保留 `mark_synced` 显式。
- "需要同步" = 未忽略 且 存在 `created_at > last_pulled_at` 的任务(新会话从未拉取 = 全部算新)。

## 子任务
- [x] D1 db:`sync_ignored`/`last_pulled_at` 字段 + migration + helper(markSessionPulled/setSyncIgnored/sessionSyncRows/sessionsNeedingSync/sessionTasksSince)
- [x] D2 mcp-server:`instructions` + `check_sync`/`set_sync_ignore`/`mark_synced` + list_sessions(only_new/include_ignored/pending)+ get_session_transcript(since_last_pull + 读取自动推进)+ `prompts`(sync)
- [x] D3 server:`POST /api/sessions/:id/sync-ignore`;session 自带 sync 字段
- [x] D4 前端:sessionBar「不同步到本地 AI」勾选(调 sync-ignore)
- [x] D5 单测(50/50):同步状态流转、runTool、getPrompt、HTTP 接口
- [x] D6 验证:直接协议(instructions/prompts/check_sync 自动推进/ignore)+ **Claude Code 真实 check_sync 工作流通过**;使用手册更新

## 进度日志
- 2026-10-05:建文档、定方案。开始 D1。
- 2026-10-05:**D1–D6 全部完成**。自动检查(check_sync)+ 读取即标记已同步(不重复)+ 用户可标记不同步(手机勾选 / AI 工具 / set_sync_ignore)+ `/onlymind:sync` 斜杠命令。50/50 测试;直接协议 + Claude Code 真实验证均通过。**任务完成。**
