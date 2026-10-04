# 任务:会话管理(Session Management)

> 开始日期:2026-10-04 · 状态:开发中

## 问题

当前每个任务都是独立、无记忆的一次性执行。需要「会话」把任务组织起来,支持**选择历史会话并在其中继续工作**(多轮上下文),会话**按引擎区分**,并支持**重命名 / 删除 / 压缩**(压缩 = 用模型总结历史以节省上下文/token)。

## 背景 / 现状

- 引擎:`claude`/`codex`(CLI,kind=cli)、`openai`/`anthropic`(API,kind=api)。
- 任务表 `tasks`;执行在 `src/runner.js`(CLI spawn;API 走 `src/providers.js`)。
- Claude Code 支持 `--session-id <uuid>` / `--resume` 续接;API 引擎可自行拼历史;Codex 待验证(本机未装)。
- 设计总纲见 `docs/09-sessions.md`。

## 预期(验收)

- 可创建/列出(按引擎分组)/重命名/删除会话。
- 任务可归属会话;在会话内发任务时带上该会话的历史(多轮续接)。
  - API:服务端把历史消息 + 新问题一起发。
  - claude:复用同一 `--session-id`。
- 压缩:把会话历史总结成摘要,之后续接只带「摘要 + 最近若干轮」。
- 手机端:会话列表(按引擎分组)、发任务时选择会话、重命名/删除/压缩入口、进入会话查看多轮并继续提问。
- 单测覆盖;真实冒烟验证 API 续接与 claude 续接。

## 实现方案

### 数据模型
```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,            -- uuid;同时用作 claude --session-id
  name TEXT NOT NULL,
  engine TEXT NOT NULL,
  summary TEXT,                   -- 压缩后的历史摘要
  turns_before_summary INTEGER DEFAULT 0, -- 已并入摘要的轮数(压缩用)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- tasks 增加 session_id TEXT(可空;空=一次性任务,兼容旧数据)
```

### 接口
- `GET  /api/sessions?engine=` 列表(按 updated_at 倒序,可按引擎过滤)
- `POST /api/sessions {name, engine}` 新建
- `PATCH /api/sessions/:id {name}` 重命名
- `DELETE /api/sessions/:id` 删除(含其任务)
- `GET  /api/sessions/:id/tasks?cursor=` 会话内任务分页
- `POST /api/sessions/:id/compress` 压缩(总结历史)
- `POST /api/tasks` 增加可选 `session_id`(校验会话存在且引擎一致)

### 续接执行
- `runner` 对带 `session_id` 的任务:
  - API:注入该会话历史(summary + 最近 N 轮的 user/assistant)到 provider。
  - claude:加 `--session-id <sessionId>`(首轮建、后续 `--resume`)。
- `index.js` 注入 `getHistory(sessionId)`。

### 压缩
- API:调用对应引擎总结「summary + 历史」成新 summary,写回;记录 turns_before_summary。
- claude:近似——发一轮「总结要点」任务,输出作为 summary。

## 测试方案
- 单元:sessions CRUD;task 带 session_id 校验;删除级联;getHistory 组装;压缩写回。
- 集成(inject):/api/sessions 全套、/api/tasks 带 session_id、引擎不一致拒绝。
- 真实冒烟:API 多轮(记住上一轮内容)、claude `--session-id` 续接、压缩后仍能续接。

## 子任务拆分

- [x] P1-1 数据层:sessions 表 + migration(tasks.session_id)+ db 函数(create/get/list/rename/delete/touch/summary/sessionHistory)
- [x] P1-2 服务端:/api/sessions CRUD(含 GET 单查)+ /api/sessions/:id/tasks + /api/tasks 接受并校验 session_id(引擎一致、会话存在)
- [x] P1-3 单测:CRUD、过滤、重命名、校验(引擎不一致 400 / 不存在 404)、级联删除(30/30 通过)
- [x] P2-1 续接(API):runner 注入历史;`providers.complete` 支持 history/summary;`assembleContext` 纯函数
- [x] P2-2 续接(claude):`claudeSessionArgs` → 首轮 `--session-id`、后续 `--resume`;其它 CLI 用 `cliTranscript` 前置历史
- [x] P2-3 测试:assembleContext / claudeSessionArgs / cliTranscript 单测;**claude 2 轮续接真实冒烟通过**(记名字→答对,对照组不知道)。API 续接真实冒烟待 Key。
- [x] P3-1 压缩接口 `/api/sessions/:id/compress` + 逻辑(API:总结历史写入 summary;CLI 返回 400)
- [x] P3-2 压缩测试:404 / CLI 400 / 无 Key 400(成功路径待真实 Key)
- [ ] F-1 前端:会话列表(按引擎分组)+ 选择器 + 新建/重命名/删除/压缩 + 会话内多轮视图
- [ ] F-2 前端联调
- [ ] 文档:更新 06-api / 09-sessions(落地)/ 使用手册(前端完成后)

## 进度日志

- 2026-10-04:创建任务文档,确定方案与拆分。开始 P1。
- 2026-10-04:**P1 完成**(数据层 + 服务端 CRUD + 任务归属校验 + 级联删除),新增 3 组单测,全量 30/30 通过。下一步 P2 续接(API 拼历史 + claude --session-id)。
- 2026-10-04:**P2+P3 后端完成**。API 续接(assembleContext 拼 system/摘要/历史)、claude 续接(--session-id/--resume)、其它 CLI 历史前置;压缩接口(API 总结、CLI 400)。新增单测,全量 **35/35** 通过。**claude 2 轮续接真实冒烟通过**。剩:前端会话 UI(F-1/F-2)、API 续接/压缩的真实 Key 冒烟。本批将提交 + 打包。
