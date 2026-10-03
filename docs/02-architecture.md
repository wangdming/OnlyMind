# 02 · 技术架构

## 总览

全本地单体服务,无云端。一个 Node 进程同时负责:托管网页、提供 API、持久化、驱动引擎 CLI。

```
┌─────────────┐  LAN 或 Cloudflare 隧道  ┌──────────────────────────────────┐
│  手机浏览器  │ ───────────────────────► │        电脑 (OnlyMind 进程)        │
│ (PWA 网页)  │ ◄─────────────────────── │                                   │
└─────────────┘        JSON API          │  Fastify ── 静态页 + /api/*        │
                                          │     │                             │
                                          │     ├─ SQLite (node:sqlite)        │
                                          │     │     tasks 表                 │
                                          │     │                             │
                                          │     └─ 串行队列 (并发=1)            │
                                          │           │ spawn                  │
                                          │           ▼                        │
                                          │     claude -p / codex exec         │
                                          └──────────────────────────────────┘
```

## 技术选型

| 层 | 选型 | 理由 |
|----|------|------|
| 运行时 | Node.js ≥ 22 | 子进程 + 流式输出是 Node 的母语,契合「围着 CLI 转的调度器」 |
| Web 框架 | Fastify 5 | 轻量、快、`inject()` 便于测试 |
| 数据库 | `node:sqlite`(内置) | 零原生依赖、免编译;同步 API 契合串行队列 |
| 前端 | 原生 HTML/CSS/JS + manifest | 免构建、免框架,手机直接打开 |
| 远程连通 | Cloudflare Tunnel + Access | 公网 HTTPS,免端口转发/穿 NAT,邮箱鉴权;局域网内直接用 LAN 地址 |

> 选用 `node:sqlite` 而非 `better-sqlite3`,避免原生模块在 Node 26 上的编译问题;API 风格一致(同步)。

## 跨平台支持(macOS / Windows)

本项目必须在 macOS 与 Windows 上运行,关键点:

| 事项 | 处理 |
|------|------|
| **调用 CLI shim** | Windows 上 `claude`/`codex` 多为 `.cmd` 脚本,Node ≥18.20 只能用 `shell:true` 启动。`runner.js` 据 `process.platform` 决定:win32 用 `shell:true`,其余直接 spawn。 |
| **任意 prompt 的注入风险** | prompt 一律经 **stdin** 传入,绝不进 argv/shell。即便开了 `shell:true`,进入 shell 的只有固定可信的 flag。已用含 `" & $(…)` 的 prompt 验证:原样传递,不被执行。 |
| **取消/超时杀进程** | win32 下 `shell:true` 有中间 `cmd.exe`,用 `taskkill /T /F` 杀整棵进程树;其余 `SIGKILL`。见 `runner.js` 的 `killChild`。 |
| **路径/目录** | 统一用 `node:path` / `os.homedir()`,不手拼分隔符。 |
| **开机自启** | macOS 用 `scripts/autostart-install.sh`(launchd);Windows 用 `scripts/autostart-install.ps1`(计划任务)。 |
| **运行时要求** | 两平台均需 Node ≥ 22(内置 `node:sqlite`)。 |

> prompt 走 stdin 是刻意设计:既解决 Windows 的 `.cmd` 启动问题,又彻底消除任意文本的 shell 注入面——一举两得。

## 模块划分(`src/`)

| 文件 | 职责 |
|------|------|
| `config.js` | 读取环境变量,生成/读取令牌,集中配置 |
| `db.js` | 打开 SQLite、建表、任务的增查改、分页、孤儿恢复 |
| `engines.js` | 各引擎的命令构造 + 输出解析;含流式(stream-json)构造与逐行解析 |
| `runner.js` | 默认执行器:spawn 子进程、捕获输出、超时、**流式 onData 回调**、**AbortSignal 取消**。永不 reject |
| `queue.js` | 串行队列(并发=1),状态机推进,启动恢复,**取消**,流式增量落库 + 发事件 |
| `events.js` | 任务事件总线(EventEmitter):`chunk:<id>` / `status:<id>`,供 SSE 消费 |
| `server.js` | Fastify 应用工厂:鉴权钩子 + 路由(含取消/重跑/SSE)+ 静态托管。依赖注入便于测试 |
| `index.js` | 组装依赖、启动监听、打印访问信息、优雅退出 |

依赖注入是刻意的:`buildServer` / `createQueue` 都接收 `db`、`queue`/`run`、`now` 等参数,测试可注入内存库和假执行器,无需真跑引擎。

## 任务状态机

```
          enqueue            run() 开始           run() 结束(成功)
 (提交) ──────────► queued ──────────► running ──────────────────► done
                      │                   │
                      │                   └──────────────────────► failed
                      │                      run() 失败 / 超时 / 引擎缺失
                      │                   │
          cancel ─────┴───────────────────┴──────────────────────► canceled

 启动恢复:上次崩溃残留的 running ──► failed ("Interrupted by server restart")
```

- **串行**:`queue.js` 用一个 `processing` 标志 + `pending` 数组保证同一时刻只有一个任务在跑,避免多个引擎实例互相干扰。
- **崩溃恢复**:进程重启时,`failOrphans` 把残留的 `running` 标为 `failed`,`queued` 的重新入队。
- **取消**:队列记录当前运行任务的 `AbortController`。取消运行中任务 → `abort()` → runner 向子进程发 `SIGKILL` → 落库 `canceled`;取消排队中任务 → 从 `pending` 移除并直接落库 `canceled`。
- **重跑**:复制源任务的 `prompt/engine/cwd/stream` 新建任务入队,不改动原任务。

## 流式输出(默认关闭)

流式是**提交时的属性**(`stream` 字段),因为它决定引擎的调用方式,而非仅查看方式:

- **默认(`stream=0`)**:`claude -p --output-format json`,结束时一次性拿到最终结果,手机端用 2 秒轮询。
- **流式(`stream=1`)**:`claude -p --output-format stream-json --verbose`,引擎边跑边输出 JSONL。
  - `runner.js` 按行解析:`type:assistant` 的文本作为增量 `delta`,`type:result` 作为权威最终文本。
  - 每个 `delta` 经 `onData` → 增量写入 DB(`appendOutput`)+ 通过事件总线 `emitChunk` 广播。
  - 手机端对流式任务打开 `EventSource` 订阅 `GET /api/tasks/:id/stream`,实时追加显示。

```
runner(onData) ──delta──► queue ──appendOutput──► SQLite
                              └──emitChunk──► events bus ──► SSE ──► 手机 EventSource
```

SSE 鉴权:`EventSource` 无法设自定义头,故令牌经 `?token=` 查询参数传入(鉴权钩子同时接受 Bearer 头与查询参数)。

## 连通方案

分两种场景:

- **局域网(同一 Wi-Fi)**:电脑运行 OnlyMind(监听 `0.0.0.0:8787`),手机直接访问 `http://<电脑的-LAN-IP>:8787`。无需任何额外组件。
- **远程 / 外网(推荐 Cloudflare Tunnel)**:电脑跑 `cloudflared`,主动外连 Cloudflare,把 OnlyMind 映射成公网 HTTPS 域名(`https://onlymind.你的域名.com`),前面叠加 **Cloudflare Access** 做身份鉴权。**无需公网 IP、无需端口转发、能穿 NAT**;手机在任何网络下都能访问,且不占用手机的 VPN 名额(可同时翻墙)。详见 [08-远程访问](./08-remote-access.md)。

```
手机 ──► Cloudflare 边缘(Access 鉴权)──隧道──► 电脑 cloudflared ──► OnlyMind:8787
```

## 安全(Security)

执行权限放到最大,安全必须多层兜底:

1. **远程访问只走 Cloudflare Tunnel + Access**:Access(Zero Trust,邮箱验证码)确保只有你本人能触达域名;**不要直接把端口映射到公网**。
2. **API 令牌**:所有 `/api/*` 请求必须带 `Authorization: Bearer <token>`(或 SSE 的 `?token=`)。令牌默认启动时随机生成并打印,也可用 `ONLYMIND_TOKEN` 固定。
3. **不要用 root 运行**,用你的普通用户,把爆炸半径限制在该用户权限内。
4. **任务超时**(默认 10 分钟)防止卡死队列。
5. 所有任务与结果落库,留痕可审计。

> ⚠️ 风险自知:`--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox` 意味着引擎可无确认执行任意操作。这是需求明确要求的「权限最大化」,务必配合上述多层防护(尤其 Cloudflare Access)。

## 已知权衡 / 后续可演进

- **流式**:已支持(SSE,默认关闭)。非流式任务仍用 2 秒轮询。
- **单机 → 多机**:当前一服务一机;多机需引入设备注册与路由。
- **HTTPS**:远程经 Cloudflare 自动是 HTTPS;局域网内为 HTTP(私有网络内,风险可控)。
