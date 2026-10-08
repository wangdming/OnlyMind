# 不变量:任务不跨会话、会话不跨目录

## 问题
用户要求强制两条不变量:
1. **任务不跨会话**:一个任务只属于一个会话;重跑(rerun)应留在原会话,不得脱离/转移会话。
2. **会话不跨目录**:同一会话的所有任务在**同一工作目录**运行。

这也修复了原生续接的根因:claude 会话按「首轮 cwd」归档,`--resume` 只在该目录生效;若会话跨目录,claude 续接会失效。

## 背景(现状)
- `POST /api/tasks`:已校验「会话引擎 == 任务引擎」(`server.js:165`),但**不校验 cwd**;每个任务 cwd 可不同(手机有 cwd 输入框 `app.js:611`)。
- runner 用 `task.cwd || defaultCwd`(`runner.js:126`);`defaultCwd = ONLYMIND_DEFAULT_CWD || home`。
- **rerun 丢了 session_id/mcp**(`server.js:280`):重跑会话任务会变成游离任务 → 违反「任务不跨会话」。
- `sessions` 无 cwd 列;`listSessions`/`getSession` 用 `SELECT *`(加列后自动带出)。

## 预期
1. 会话首个任务**绑定目录**(存绝对路径 = `cwd || defaultCwd`);此后该会话任务一律用此目录。
2. 若后续任务显式传了**不同**目录 → `400`,明确提示「不允许会话跨目录」;留空 = 继承会话目录。
3. rerun 保留 `session_id` + `mcp` + `cwd`(留在原会话、同目录)。
4. MCP 原生续接提示直接用 `session.cwd`(更准,去掉从任务推导)。
5. 前端:选中已绑定会话时,cwd 字段显示该目录且不可改(继承);未绑定会话/一次性任务才可填。
6. `npm test` 全绿 + 冒烟。

## 实现方案
### DB(`src/db.js`)
- `sessions` 加列 `cwd TEXT`(CREATE TABLE + migrate)。
- `setSessionCwd(db, id, cwd)`;`countSessionTasks(db, id)`。

### server(`src/server.js` + `src/index.js`)
- `buildServer` 增参 `defaultCwd`;`index.js` 传 `config.defaultCwd`。
- `POST /api/tasks`(有 session_id 时):
  - 若该会话无任务(首个):`effectiveCwd = cwd || defaultCwd`,`setSessionCwd`。
  - 否则:若 `cwd != null && cwd !== s.cwd` → `400`;否则 `effectiveCwd = s.cwd`。
  - 用 `effectiveCwd` 入库。
- `rerun`:带上 `session_id: src.session_id, mcp: src.mcp, cwd: src.cwd`;有会话则 `touchSession`。

### MCP(`scripts/mcp-server.mjs`)
- `get_session_transcript`:`cwd = s.cwd || config.defaultCwd`,传入 `buildResumeHint`(删除从 tasks 推导)。

### 前端(`public/app.js`)
- 选中会话时:`cur.cwd` 有值 → `#cwd` 填该值并 `disabled`;否则可编辑。切回无会话 → 清空可编辑。
- 提交会话任务后刷新 `loadSessions()`,使绑定目录及时反映。

## 测试方案
- 单元:首个任务绑定 cwd;第二个任务异目录 → 400;留空 → 继承;rerun 保留 session_id/mcp;MCP 提示用 session.cwd。
- 冒烟:真实 codex 两轮同目录通过;跨目录第二轮被拒。

## 子任务
- [x] 1. DB:`cwd` 列 + `setSessionCwd` + `countSessionTasks`。
- [x] 2. server:`buildServer` 增 `defaultCwd`;POST /api/tasks 目录绑定(首个绑定、异目录 400、留空继承);rerun 保留 `session_id`+`mcp`+`cwd`。
- [x] 3. index.js 传 `defaultCwd: config.defaultCwd`。
- [x] 4. MCP:续接提示改用 `s.cwd || config.defaultCwd`。
- [x] 5. 前端:选中已绑定会话时 cwd 字段显示并只读;未绑定可编辑;提交后刷新会话反映绑定。
- [x] 6. 单测(+3 块,共 60 全绿)+ 集成冒烟;文档收尾。

## 进度日志
- 2026-10-08:方案定稿。
- 2026-10-08(实现):1–6 全部落地。
  - 单测新增:①会话首个任务绑定目录、异目录 400、留空/同目录继承;②无 cwd 时绑定 `defaultCwd`;③rerun 保留 `session_id`+`mcp`+同目录。**共 60 项全绿**。
  - 集成冒烟(真实 server+queue+runner+codex):turn1 无 cwd → 绑定 `defaultCwd` 并捕获 codex id;跨目录任务 → **400「不允许会话跨目录」**;turn2 留空 → 继承同目录且原生续接续上(回忆 Paris)。痕迹已清理。
- **收尾完成**。改动文件:`src/db.js`、`src/server.js`、`src/index.js`、`scripts/mcp-server.mjs`、`public/app.js`、`test/api.test.js`。
- 说明:会话首个任务后目录即锁定;后续任务留空继承、填不同目录被拒。null cwd 在绑定时解析为 `defaultCwd` 绝对路径,故 MCP 续接提示与前端判定都稳定。
