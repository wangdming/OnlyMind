# 05 · 表结构

数据库:SQLite(`node:sqlite`),默认文件 `./data/onlymind.db`,开启 WAL 模式。

## 表 `tasks`

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| `id` | TEXT | PRIMARY KEY | 任务 ID,UUID v4 |
| `prompt` | TEXT | NOT NULL | 任务内容(已 trim) |
| `engine` | TEXT | NOT NULL, default `'claude'` | 引擎:`claude` / `codex` |
| `cwd` | TEXT | 可空 | 工作目录;空则用服务端默认目录 |
| `stream` | INTEGER | NOT NULL, default `0` | 是否流式:`0` 缓冲(默认)/ `1` 流式(stream-json) |
| `status` | TEXT | NOT NULL | 状态:`queued` / `running` / `done` / `failed` / `canceled` |
| `output` | TEXT | 可空 | 执行输出(claude 为解析后的 result 文本) |
| `error` | TEXT | 可空 | 错误信息 / stderr |
| `exit_code` | INTEGER | 可空 | 子进程退出码 |
| `created_at` | INTEGER | NOT NULL | 创建时间(epoch ms) |
| `started_at` | INTEGER | 可空 | 开始执行时间(epoch ms) |
| `finished_at` | INTEGER | 可空 | 结束时间(epoch ms) |

### 索引

```sql
CREATE INDEX idx_tasks_created ON tasks(created_at DESC);
```

用于历史列表的游标分页(按 `created_at` 倒序)。

### 建表 DDL(实际代码在 `src/db.js`)

```sql
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  prompt      TEXT NOT NULL,
  engine      TEXT NOT NULL DEFAULT 'claude',
  cwd         TEXT,
  stream      INTEGER NOT NULL DEFAULT 0, -- 0 = buffered (default), 1 = stream-json
  status      TEXT NOT NULL,              -- queued | running | done | failed | canceled
  output      TEXT,
  error       TEXT,
  exit_code   INTEGER,
  created_at  INTEGER NOT NULL,
  started_at  INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);
```

> **迁移**:`openDb` 在建表后会检查 `tasks` 是否有 `stream` 列,旧库自动 `ALTER TABLE … ADD COLUMN stream`。

## 状态流转

```
queued ──► running ──► done
   │             └────► failed
   │             └────► canceled   (运行中被取消)
   └────────────────► canceled     (排队中被取消)
```

详见 [02-架构 · 任务状态机](./02-architecture.md#任务状态机)。

## 分页约定

- 游标 = 上一页最后一条的 `created_at`(不含)。
- 查询:`WHERE created_at < :cursor ORDER BY created_at DESC LIMIT :limit`。
- `limit` 范围 1–100,默认 20。
- 响应含 `nextCursor`(无更多时为 `null`)。
