# 会话名同步到引擎(Claude 原生改名 + Codex 原生会话 & 官方改名)

## 问题
OnlyMind 已有完整的会话管理(新建/删除/选择/重命名,见 `app.js` Sessions、`server.js /api/sessions`、`db.js sessions`)。但"重命名"**只改 OnlyMind 本地 DB 的标签**,不会反映到引擎。用户要求:改名要"在引擎中也修改成功",并要能确认成功。

## 背景(已实测核实,2026-10-08)
两个 CLI 引擎都有会话名,且都能非交互地改名——此前"只用 UUID、不能改名"的说法是错的。

### Claude Code
- 会话按 UUID 续接(`--session-id`/`--resume <uuid>`),这点不变。
- 标题存在转录 JSONL:`ai-title`(自动)/ `custom-title`(用户设的)。
- **`claude -n/--name <name>` 可设/改名**:实测 `claude -p --resume <uuid> -n "新名"` 会追加 `custom-title`,UUID 不变、续接不受影响;`-p` 非交互模式下成立。
- ⚠️ 约束:`-n` 的值走 argv。仓库有"所有静态 CLI 参数保持纯 ASCII(Windows `shell:true` 防乱码)"的约定与测试(`test/api.test.js:596`,仅校验 `build()`/`stream.build()` 静态参数,**不含** `claudeSessionArgs`)。中文名作为 `-n` 值在 **Windows+shell:true** 下可能乱码(仅标题,续接不受影响)。macOS/Linux 无此问题。

### Codex(codex-cli 0.161.0,已实测)
- **OnlyMind 目前没用 codex 原生会话**:`codex exec … -`(`engines.js:88`)每个任务都新建线程,续接靠把转录拼进 stdin(`runner.js:135`)。
- codex 原生续接可用:`codex exec resume <id|name> … --json -` 实测能回忆上一轮、`thread_id` 不变。
- `codex exec … --json -` 首轮输出 `{"type":"thread.started","thread_id":"…"}`;产出为 `{"type":"item.completed","item":{"type":"agent_message","text":…}}`。
- 线程元数据在 `~/.codex/state_5.sqlite` 的 `threads` 表:`title`(首条消息自动)/`name`(用户设,resume/archive/delete by-name 用它)。
- **官方改名**:app-server JSON-RPC 方法 `thread/name/set`,参数 `{threadId, name}`,返回 `{}`。实测:spawn `codex app-server` → `initialize{clientInfo}` → `thread/name/set` → `name` 从空变为中文 `我的库存会话OM`。**走 stdin JSON,无 argv/ASCII 问题**。
- 无 `codex exec --name` 命令行开关;写 sqlite 可行但不受支持,**不采用**。

## 预期(验收点)
1. 选中某会话发任务时,引擎侧会话标题 = OnlyMind 的会话名。
2. Claude:会话每轮带 `-n <名>`,改名后"下次该会话执行任务"时自动同步到 Claude 标题。
3. Codex:改用原生会话(首轮捕获并保存 `thread_id`,后续 `exec resume`),不再注入转录;会话名通过官方 `thread/name/set` 同步。
4. 重命名接口返回引擎同步结果,手机端能看到确认("已在引擎改名 ✓" / "将在下次任务同步" / 失败原因)。
5. `npm test` 全绿;codex 做一次真实冒烟(建会话→发两条任务验证续接→改名→`codex resume` 列表可见新名)。

## 实现方案

### 数据模型(`src/db.js`)
- `sessions` 新增列 `engine_session_id TEXT`(迁移:在现有 ALTER 块里加),保存 codex 的 `thread_id`(claude 的引擎 id 即我们自己的 uuid,无需单独存)。
- 新增 `setSessionEngineId(db, id, engineSessionId, now)`。
- `getSessionContext`(`src/index.js`)返回值加 `name`、`engineSessionId`,供 runner 使用。

### 引擎参数(`src/engines.js` + `src/runner.js`)
- **Claude**:`claudeSessionArgs(sessionId, ctx, name)` 追加 `['-n', name]`(name 存在时)。保持纯函数、可测试。Windows+非 ASCII 的乱码风险记为已知限制(仅标题)。
- **Codex**:改用 `--json`,并按是否已有 `engine_session_id` 选择:
  - 首轮:`exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --json -`
  - 续接:`exec resume <threadId> --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --json -`
  - 新增 JSONL 解析:`parse()` 取最后一条 `item.completed` 的 `agent_message.text` 作为 final;`stream.line()` 解析增量(**待核实 exec --json 的增量事件名**,如 `item.*/delta`;核实前以 `item.completed` 作为单块兜底)。
  - 解析需向 runner 回传捕获到的 `threadId`(扩展 line 返回 `{delta?, final?, threadId?}`,或由 runner 扫描 stdout)。
  - 不再为 codex 注入 `cliTranscript(ctx)`(原生 resume 已带上下文)。⚠️ 影响:codex 会话的"压缩/摘要"将失效(codex 自管上下文),压缩按钮对 codex 变为无效——先记录,后续可在 UI 对 codex 隐藏。

### runner 产出 & 落库
- runner 结果增加 `engineSessionId`(codex 首轮捕获);`queue`/`db` 在任务完成后把它写回会话(仅当会话此前无 engine_session_id)。
- 首轮捕获到 codex `thread_id` 后,立即调用 `thread/name/set` 设置会话名。

### 新模块 `src/codex-appserver.mjs`
- `setCodexThreadName(threadId, name, { timeoutMs })`:spawn `codex app-server`,发 `initialize{clientInfo:{name:'onlymind',version}}` → `thread/name/set{threadId,name}`,收到响应即关闭。best-effort,超时/错误返回 `{ok:false,reason}`。

### 重命名接口(`src/server.js` PATCH `/api/sessions/:id`)
- 改名写库后做引擎同步并把结果并入响应 `{ ...session, engineSync:{attempted, ok, reason} }`:
  - codex 且有 `engine_session_id`:调用 `setCodexThreadName`,返回真实成功/失败。
  - claude:不立即调用(`-n` 需随一次任务);返回"将于下次任务同步"。
  - 无引擎会话(还没跑过任务):返回"尚无引擎会话,首个任务创建时同步"。

### 前端(`public/app.js`)
- `renameSession` 根据 PATCH 返回的 `engineSync` 显示:已在引擎改名 ✓ / 将在下次任务同步 / 失败原因。

## 测试方案
- 单元:`claudeSessionArgs` 带 name 产出 `-n`;codex 首轮 vs resume 参数;codex `--json` 解析(final + threadId 捕获);PATCH 返回 engineSync(mock `setCodexThreadName`)。
- 回归:现有 50 项保持绿;注意 codex stream.line 改造会影响"streaming task appends…"等用例,需同步更新。
- 冒烟(真实 codex/claude):见"预期#5"。

## 关键实现修正(实测后)
- **codex 不走 `--json`**:`codex exec --json` 不吐增量,只在 `item.completed` 一次性给全文——会毁掉流式。改为**保留 plain 模式**(流式不变),从 **stderr** 的头部 `session id: <uuid>` 捕获引擎会话 id(codex 的 stdout 恰好是干净答案)。因此无需重写解析器,改动大幅缩小。
- 续接:`codex exec resume <id> …`;首轮 plain `exec …`。两者都加 `--skip-git-repo-check`。
- claude `-n` 值在 Windows+非 ASCII 时跳过(runner 内 gate),保纯 ASCII argv;mac/Linux 照常。

## 子任务拆分
- [x] 1. DB:加 `engine_session_id` 列 + `setSessionEngineId`;`getSessionContext` 暴露 name/engineSessionId。
- [x] 2. Claude:`claudeSessionArgs` 加 `-n <name>`;runner 传入 name(Windows 非 ASCII gate)。单测。
- [x] 3. 核实 codex 流式事件格式 → 结论:`--json` 无增量,改用 plain + stderr 捕获 session id。
- [x] 4. Codex:engines.js `build(task,{resumeId})`(first/resume,含 `--skip-git-repo-check`);runner 选 first/resume、去掉 codex 转录注入(仅首轮为迁移兜底保留)、从 stderr 捕获 id。单测。
- [x] 5. runner/queue/db:runner 回传 `engineSessionId`;queue `onFinished` 钩子;index.js 落库 `engine_session_id`。
- [x] 6. `src/codex-appserver.mjs`:`setCodexThreadName`(initialize + thread/name/set)。
- [x] 7. 首轮捕获 id 后经 app-server 置名;PATCH 改名接口做引擎同步并返回 `engineSync`。
- [x] 8. 前端 renameSession 显示引擎同步结果。
- [x] 9. `npm test` 全绿(55);codex/claude 真实冒烟通过;文档收尾。

## 进度日志
- 2026-10-08(方案):完成 claude/codex 全部实测核实;app-server `thread/name/set` spike 成功(含中文名);方案定稿。
- 2026-10-08(实现):按 1–9 全部落地。关键修正:codex 保留 plain 模式、从 **stderr** 捕获 `session id`(避免 `--json` 毁流式)。
  - 单测:新增 5 项(claudeSessionArgs 带 `-n`、parseCodexSessionId、codex first/resume 参数、setSessionEngineId 仅首捕获、PATCH engineSync),共 **55 项全绿**。
  - codex 冒烟:建会话→turn1 捕获 `engine_session_id` 且官方置名「OM库存会话甲」ok→turn2 **原生 resume 续接**(正确回忆 42)→app-server 改名为「OM库存会话乙改名」确认生效。
  - claude 冒烟:跑一条任务后转录 JSONL 出现 `"customTitle":"OM我的Claude会话"`,证明 `-n` 经真实 runner 生效。
  - 测试痕迹(临时 codex/claude 线程与目录)已清理。
- **收尾完成**。改动文件:`src/db.js`、`src/index.js`、`src/engines.js`、`src/runner.js`、`src/queue.js`、`src/server.js`、`src/codex-appserver.mjs`(新)、`public/app.js`、`test/api.test.js`。
- 后续处理(2026-10-08):前端"压缩"按钮改为**仅 API 引擎显示**(`renderSessionBar` 按 `engineById[engine].kind==='api'` 控制)。这同时覆盖 codex 与 claude——因为压缩后端本就只支持 API 引擎(`kind==='api'`),CLI 引擎自管上下文、原会返回 400。
- 遗留:Windows+非 ASCII 的 claude 标题暂不同步(仅标题,续接不受影响)。
