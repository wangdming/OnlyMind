# 09 · 会话管理(设计草案 · 规划中,尚未实现)

> 状态:**已评估可行,暂不实现**,先存档。当前版本每个任务都是**独立、无记忆**的一次性执行;本功能用于把任务组织成「会话」,并支持在历史会话中**继续工作**(多轮续接)。

## 目标

- 把相关任务归入同一「会话」,支持**选择一个历史会话并在其中继续工作**(多轮上下文)。
- 会话**按引擎区分**:一个会话绑定一个引擎,不能跨引擎共享(各家上下文格式不通用)。
- 会话操作:**重命名**、**删除**、**压缩**。
- **压缩 = 用模型把历史总结成摘要以节省上下文/token**(类似 Claude Code 的 `/compact`),不是单纯折叠/归档。

## 各引擎可行性

| 引擎 | 多轮续接 | 说明 |
|---|---|---|
| OpenAI / Anthropic API | ✅ 完全可控 | 服务端存会话历史消息,下次把「历史 + 新问题」一起发;续接、压缩都由我们掌控 |
| Claude Code | ✅ 原生支持 | `--session-id <uuid>` / `--resume`,Claude 自己维护上下文;复用同一 session id 即续接 |
| Codex | ⚠️ 待验证 | 需安装后确认其 `resume/session` 能力,预计可行,先按「尽力而为」 |

## 数据模型

```sql
CREATE TABLE sessions (
  id                  TEXT PRIMARY KEY,   -- 也用作 claude 的 --session-id
  name                TEXT NOT NULL,
  engine              TEXT NOT NULL,      -- claude | codex | openai | anthropic
  provider_session_id TEXT,              -- CLI 引擎侧的会话标识(如需)
  summary             TEXT,              -- 压缩后的历史摘要(API 引擎用)
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
-- tasks 增加:session_id TEXT(可空;无会话的任务即「一次性任务」,兼容现状)
ALTER TABLE tasks ADD COLUMN session_id TEXT;
```

## 续接执行设计

- **API 引擎**:提交任务时,服务端按 `session_id` 取出该会话的历史(或 `summary` + 近期若干轮),拼成 `messages` 一起发送;把本轮 user/assistant 追加存储。
- **Claude Code**:对该会话固定用 `--session-id <sessions.id>`(首轮创建、后续 `--resume` 复用),Claude 自行保留上下文;注意需保持会话持久化开启(勿用 `--no-session-persistence`)。
- **Codex**:装好后验证 resume 语义,映射到同一会话。

## 操作语义

- **重命名**:改 `sessions.name`。
- **删除**:删会话及其任务(或可选「仅解绑任务」)。
- **压缩(总结省 token)**:
  - **API**:调用该引擎把历史总结成简短摘要,写入 `sessions.summary`;之后续接只带「摘要 + 最近几轮」,显著减少 token。
  - **CLI(claude)**:`-p` 模式无直接 `/compact`;近似做法——发一轮「请总结到目前为止的要点」任务,用其输出作为新的续接基底(或 `--fork-session` 开新分支带摘要)。

## 分阶段实施(建议)

1. **组织层**:`sessions` 表 + `tasks.session_id` + 按引擎分组展示 + 新建/重命名/删除(先不续接)。
2. **续接层**:API 拼历史;Claude `--session-id` 续接。← 「选择历史会话并继续工作」在此阶段达成。
3. **压缩层**:先做 API 摘要压缩,CLI 近似。

## 注意 / 权衡

- 不能跨引擎续接同一会话。
- CLI 续接依赖引擎自身的会话持久化;Codex 能力待验证。
- 历史存储会随会话增长——「压缩」正好缓解。
- 手机端 UI 需新增:会话列表(按引擎分组)、会话选择器(发任务时「新会话 / 选已有」)、重命名/删除/压缩入口。

## 前端影响(预留)

- 发任务区增加「会话」选择(新建 / 选择已有,按当前引擎过滤)。
- 新增「会话」视图:分组列出、支持重命名/删除/压缩、点击进入可见该会话的多轮记录并继续提问。
