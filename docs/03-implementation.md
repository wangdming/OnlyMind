# 03 · 实现方案

本文说明关键实现细节与设计取舍,便于后续维护。

## 1. 配置(`config.js`)

集中管理环境变量,全部可覆盖:

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `ONLYMIND_TOKEN` | 随机生成 | API 访问令牌;未设置则启动时生成并打印 |
| `ONLYMIND_HOST` | `0.0.0.0` | 监听地址(用 `0.0.0.0` 才能被 LAN IP / cloudflared 访问) |
| `ONLYMIND_PORT` | `8787` | 端口 |
| `ONLYMIND_DB` | `./data/onlymind.db` | SQLite 文件路径 |
| `ONLYMIND_DEFAULT_CWD` | 用户 HOME | 任务未指定目录时的工作目录 |
| `ONLYMIND_TASK_TIMEOUT_MS` | `600000` | 单任务超时(10 分钟) |

## 2. 数据访问(`db.js`)

- 用内置 `node:sqlite` 的 `DatabaseSync`,同步 API。
- 开启 WAL 提升并发读性能。
- 分页用**游标(cursor)** 而非 `OFFSET`:以 `created_at` 为游标,`WHERE created_at < ? ORDER BY created_at DESC LIMIT n+1`,多取一条判断 `hasMore`,避免深翻页的性能问题与插入导致的错位。
- 表结构见 [05-表结构](./05-schema.md)。

## 3. 引擎抽象(`engines.js`)

每个引擎声明 `bin`、`build(task)`(构造参数)、`parse(stdout)`(解析输出):

```js
claude: {
  bin: 'claude',
  build: (t) => ['-p', t.prompt, '--output-format', 'json', '--dangerously-skip-permissions'],
  parse: (stdout) => JSON.parse(stdout).result ?? stdout,  // 取 JSON 信封里的 result
}
codex: {
  bin: 'codex',
  build: (t) => ['exec', '--dangerously-bypass-approvals-and-sandbox', t.prompt],
  parse: (stdout) => stdout,
}
```

新增引擎只需在此加一项,其余代码无需改动。

## 4. 执行器(`runner.js`)

- `run(task, { signal, onData })`,`spawn(bin, args, { cwd })` 启动子进程,分别累积 stdout / stderr。
- **超时**:`setTimeout` 到点 `SIGKILL`,标记为失败。
- **取消**:接收 `AbortSignal`;`abort` 时 `SIGKILL` 子进程,结束时返回 `canceled`。已 abort 则直接返回 `canceled`。
- **流式**:`task.stream` 为真且引擎支持时,用 `engine.stream.build` 调用,并对 stdout 做**行缓冲**:每凑齐一行交 `engine.stream.line()` 解析,得到 `delta`(经 `onData` 回调实时上报)或 `final`(权威最终文本)。关闭时最终输出取 `final ?? 累积delta`。
- **永不 reject**:所有失败(spawn 失败、ENOENT 引擎未安装、非零退出、超时、取消)都通过 resolve 的对象返回,保证队列能把状态落库。
- 友好错误:引擎未安装时返回 `Command 'xxx' not found. Is … installed and on PATH?`。

## 5. 串行队列(`queue.js`)

- 内存 `pending` 数组 + `processing` 布尔量,保证**并发 = 1**。
- `enqueue(id)` 推入并触发 `tick()`;`tick()` 循环取队首,置 `running`(发 `status` 事件)→ 建 `AbortController` → `await run(task, {signal, onData})` → 落库最终状态(发 `status` 事件)。
- `onData(delta)`:`appendOutput` 增量写库 + `emitChunk` 广播给 SSE。
- `cancel(id)`:运行中 → `currentController.abort()`;排队中 → 从 `pending` 移除并落库 `canceled`;已结束 → 返回 `null`(路由转 409)。
- 构造时调用 `failOrphans` 恢复崩溃残留,并把 DB 里仍 `queued` 的重新纳入内存队列。
- 暴露 `drain()`(等待队列清空,供测试)与 `size`。
- `now` 时钟可注入,测试里用自增计数器得到确定性时间戳。

## 5b. 事件总线(`events.js`)

- 一个进程内 `EventEmitter`,`setMaxListeners(0)` 容纳多个并发 SSE 订阅。
- 事件名按任务 id 命名:`chunk:<id>`(增量文本)、`status:<id>`(状态变更)。
- 解耦队列与 HTTP 层:队列只管发事件,SSE 路由订阅/退订。

## 6. HTTP 层(`server.js`)

- `buildServer({ db, queue, token, publicDir, now })` 工厂函数,依赖注入。
- `onRequest` 钩子:凡 `/api/*` 校验令牌,接受 `Authorization: Bearer` **或** `?token=`(后者供 SSE),不匹配返回 401;静态资源不拦截。
- 路由:健康检查、引擎列表、提交(含 `stream`)、单查、分页、**取消**、**重跑**、**SSE 流**。详见 [06-接口](./06-api.md)。
- SSE 路由用 `reply.raw` 直接写 `text/event-stream`,订阅事件总线,结束时发 `done` 并关闭;`req.raw` 的 `close` 事件触发退订,避免泄漏。
- `@fastify/static` 托管 `public/` 下的网页。

## 7. 前端(`public/`)

- 单页:令牌设置、任务提交(prompt / 引擎 / 可选 cwd / **流式开关**)、历史分页列表。
- 令牌存 `localStorage`,所有请求带上;流式开关偏好也持久化(默认关)。
- **分页**:「加载更多」按钮按 `nextCursor` 续取。
- **状态轮询**:存在 `queued`/`running` 任务(且未在 SSE 流中)时,每 2 秒刷新,全部结束后自动停表。
- **卡片**:点击展开查看输出 / 错误;底部「取消」(排队/运行中)与「重跑」(已结束)按钮。
- **流式查看**:展开一个流式且未结束的任务时,打开 `EventSource` 订阅 SSE,实时追加输出(显示 LIVE 标记);结束后拉取最终结果并切换按钮。轮询与 SSE 互斥,避免互相覆盖。
- `manifest.json` 使其可「添加到主屏幕」成为 PWA。

## 8. 测试策略(`test/api.test.js`)

用内置 `node:test`,无额外依赖:

- **DB**:分页正确性(顺序、游标、无重叠)。
- **队列**:串行性(断言 `maxActive === 1`)、顺序、成功/失败落库、孤儿恢复。
- **HTTP**:用 `app.inject()` 免真实端口,覆盖鉴权 401、创建、校验 400、404、默认引擎。
- **引擎**:claude JSON 信封解析 + 回退。

执行真实引擎的部分通过**注入假 `run`** 隔离,CI 无需安装 claude/codex。真实引擎链路通过手动冒烟测试验证(见 [07-进度](./07-progress.md))。

## 9. 启动与运维(`index.js`)

- 组装 `db → runner → queue → server`,监听后打印本机所有 IPv4(LAN 地址)、远程访问提示(Cloudflare 隧道)与令牌。
- 捕获 `SIGINT/SIGTERM` 优雅关闭。
- 开机自启建议:macOS 用 `launchd`,或简单用 `pm2`/`tmux` 常驻(见 [04-说明书](./04-manual.md))。
