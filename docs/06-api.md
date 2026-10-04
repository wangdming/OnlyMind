# 06 · 接口文档

- Base URL:局域网 `http://<电脑的-LAN-IP>:8787`;远程 `https://onlymind.你的域名.com`(经 Cloudflare Tunnel,见 [08-远程访问](./08-remote-access.md))
- 鉴权:所有 `/api/*` 需令牌。两种方式任选:
  - 请求头 `Authorization: Bearer <token>`(常规请求);
  - 查询参数 `?token=<token>`(供浏览器 `EventSource` 的 SSE 使用,因其无法设置自定义头)。
  - 缺失或错误返回 `401`。
- 请求/响应体:JSON(SSE 端点除外)。

## 任务对象(Task)

```json
{
  "id": "2d4ba5fc-75c9-44f3-bda9-48e0a3801932",
  "prompt": "Reply with exactly the word: pong",
  "engine": "claude",
  "cwd": null,
  "stream": 0,
  "status": "done",
  "output": "pong",
  "error": null,
  "exit_code": 0,
  "created_at": 1790908307044,
  "started_at": 1790908307044,
  "finished_at": 1790908311004
}
```

`stream`:`0`=缓冲(默认),`1`=流式。`status`:`queued`/`running`/`done`/`failed`/`canceled`。

---

## GET /api/health

健康检查。

**响应 200**
```json
{ "ok": true, "queued": 0 }
```

---

## GET /api/engines

列出支持的引擎(供手机端下拉选择)。`kind=cli` 为可操作电脑的 agent(无需 Key);`kind=api` 为纯问答(需 API Key)。`keySet` 表示该 API 引擎的 Key 是否已配置。

**响应 200**
```json
{ "engines": [
  { "id": "claude",    "label": "Claude Code(CLI,可操作电脑)", "kind": "cli", "needsKey": false, "provider": null,        "keySet": true },
  { "id": "codex",     "label": "Codex(CLI,可操作电脑)",       "kind": "cli", "needsKey": false, "provider": null,        "keySet": true },
  { "id": "openai",    "label": "OpenAI API(ChatGPT 问答)",     "kind": "api", "needsKey": true,  "provider": "openai",    "keySet": false },
  { "id": "anthropic", "label": "Anthropic API(Claude 问答)",   "kind": "api", "needsKey": true,  "provider": "anthropic", "keySet": false }
] }
```

---

## GET /api/keys

返回各提供方的 Key 是否已配置(**不返回 Key 本身**)。

**响应 200**:`{ "openai": false, "anthropic": false }`

## POST /api/keys

在线**验证** API Key(对提供方发一次请求),通过才存储到电脑端。

**请求体**:`{ "provider": "openai" | "anthropic", "key": "sk-..." }`
**响应 200**:`{ "ok": true }`
**错误**:`400 { "ok": false, "error": "API Key 无效或无权限" }` / 未知 provider / 空 key。

---

## 会话(Sessions)

把任务组织成会话以支持**多轮续接**(按引擎区分)。

- `GET  /api/sessions?engine=` 列出会话(按 `updated_at` 倒序,可按引擎过滤)。
- `POST /api/sessions {name, engine}` 新建 → 201 返回会话对象。
- `GET  /api/sessions/:id` 单查(含 `summary`)。
- `PATCH /api/sessions/:id {name}` 重命名。
- `DELETE /api/sessions/:id` 删除(**级联删除**其任务)→ `{ ok, removedTasks }`。
- `GET  /api/sessions/:id/tasks?cursor=&limit=` 会话内任务分页。
- `POST /api/sessions/:id/compress` 压缩历史为摘要(**仅 API 引擎**;claude/codex 返回 400)→ `{ ok, summary, turns_before_summary }`。

**续接行为**:给 `POST /api/tasks` 传 `session_id` 即归属会话;执行时——API 引擎带「摘要 + 历史轮次」一起请求;Claude 用同一 `--session-id`(首轮建、后续 `--resume`);其它 CLI 把历史以文字前置到 prompt。

会话对象:`{ id, name, engine, summary, turns_before_summary, created_at, updated_at }`。

---

## POST /api/tasks

提交一个任务,立即入队并返回(异步执行)。

**请求体**
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `prompt` | string | 是 | 任务内容 |
| `engine` | string | 否 | `claude`(默认)/ `codex` / `openai` / `anthropic`。API 引擎需先配置对应 Key,否则返回 400 |
| `cwd` | string | 否 | 工作目录;省略则用服务端默认(仅 CLI 引擎有效) |
| `stream` | boolean | 否 | 是否流式(默认 `false`)。为 `true` 时引擎以 stream-json 运行,可通过 SSE 实时查看 |
| `session_id` | string | 否 | 归属的会话 id;会校验会话存在且引擎一致,并启用多轮续接 |

```json
{ "prompt": "总结该目录下的 README", "engine": "claude", "cwd": "~/code/foo", "stream": false }
```

**响应 201**:新建的 Task 对象,`status = "queued"`。

**错误**
- `400` `{ "error": "prompt is required" }`
- `400` `{ "error": "unknown engine: xxx" }`
- `401` `{ "error": "Unauthorized" }`

---

## POST /api/tasks/:id/cancel

取消一个 `queued` 或 `running` 的任务(运行中会向子进程发 SIGKILL)。

**响应 200**:更新后的 Task 对象,`status = "canceled"`。
**错误**
- `404` 任务不存在。
- `409` `{ "error": "cannot cancel task in status 'done'" }`(已结束,不可取消)。

---

## POST /api/tasks/:id/rerun

以源任务的 `prompt` / `engine` / `cwd` / `stream` 新建一个任务并入队。

**响应 201**:新建的 Task 对象(新 `id`,`status = "queued"`)。
**错误**:`404` 源任务不存在。

---

## GET /api/tasks/:id/stream  (SSE)

Server-Sent Events,用于实时查看任务输出。令牌经 `?token=` 传入。

**事件序列**
| event | data | 说明 |
|-------|------|------|
| `snapshot` | Task 对象 | 连接时的当前快照(含已累积 output) |
| `chunk` | `{ "text": "…" }` | 增量输出(可能多次) |
| `status` | Task 对象 | 状态变更 |
| `done` | `{ "status": "done\|failed\|canceled" }` | 结束,随后服务端关闭连接 |

若连接时任务已结束,则只发 `snapshot` + `done` 后立即关闭。

```js
const es = new EventSource(`/api/tasks/${id}/stream?token=${token}`);
es.addEventListener('chunk', (e) => append(JSON.parse(e.data).text));
es.addEventListener('done', () => es.close());
```

---

## GET /api/tasks

分页查询历史任务,按创建时间倒序。

**查询参数**
| 参数 | 默认 | 说明 |
|------|------|------|
| `limit` | 20 | 每页数量,1–100 |
| `cursor` | 无 | 上一页返回的 `nextCursor`;首页不传 |

**响应 200**
```json
{
  "items": [ { /* Task */ }, { /* Task */ } ],
  "nextCursor": 1790908290760
}
```
`nextCursor` 为 `null` 表示没有更多。

---

## GET /api/tasks/:id

查询单个任务(手机端据此轮询状态与结果)。

**响应 200**:Task 对象。
**错误**:`404` `{ "error": "not found" }`。

---

## 典型调用流程(curl)

```bash
TOKEN=你的令牌
BASE=http://100.x.y.z:8787

# 提交
ID=$(curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"prompt":"say pong","engine":"claude"}' $BASE/api/tasks | jq -r .id)

# 轮询
curl -s -H "Authorization: Bearer $TOKEN" $BASE/api/tasks/$ID | jq

# 翻历史
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/tasks?limit=20" | jq
```
