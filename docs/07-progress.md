# 07 · 工作进度

> 更新时间:2026-10-02

## 状态总览

| 模块 | 状态 | 备注 |
|------|------|------|
| 项目脚手架 / 依赖 | ✅ 完成 | Node + Fastify + `node:sqlite` |
| 配置(config.js) | ✅ 完成 | 环境变量 + 令牌生成 |
| 数据层(db.js) | ✅ 完成 | 建表、增查改、游标分页、孤儿恢复、**stream 列迁移、增量追加输出** |
| 引擎抽象(engines.js) | ✅ 完成 | claude / codex,**含流式 stream-json 构造与逐行解析** |
| 执行器(runner.js) | ✅ 完成 | spawn + 超时 + 友好错误 + **流式 onData + AbortSignal 取消** |
| 串行队列(queue.js) | ✅ 完成 | 并发=1,崩溃恢复,**取消,流式落库 + 发事件** |
| 事件总线(events.js) | ✅ 完成 | SSE 用的 chunk/status 事件 |
| HTTP 层(server.js) | ✅ 完成 | 令牌鉴权(头/查询)+ 路由 + **取消/重跑/SSE** + 静态托管 |
| 启动入口(index.js) | ✅ 完成 | 打印访问信息 + 优雅退出 |
| 手机端网页(public/) | ✅ 完成 | 提交 / 分页 / 轮询 / PWA / **流式开关 + SSE 实时 + 取消/重跑** |
| 开机自启脚本(scripts/) | ✅ 完成 | **macOS launchd + Windows 计划任务**(含卸载) |
| 一键诊断脚本(scripts/) | ✅ 完成 | **doctor.mjs + macOS/Windows 入口**,内存实启自检 |
| Cloudflare 隧道检测(scripts/) | ✅ 完成 | **check-tunnel.mjs**,已并入 doctor「C.」节;装/配/本地/公网+Access 逐段检查 + 改配置建议 + `--json` |
| 脚本统一命名 + 打包 | ✅ 完成 | 跨平台 node 工具(doctor/check-tunnel/tunnel/package.mjs,经 `npm run` 两系统通用)+ 系统专属 autostart-*.{sh,ps1};`npm run package` 产出交付 zip |
| 公网远程访问(docs/08 + scripts/) | ✅ 完成 | **Cloudflare Tunnel + Access**;隧道脚本 + 配置模板 + doctor 识别 |
| 单元 + 集成测试 | ✅ 完成 | 17 项全部通过 |
| 文档 | ✅ 完成 | 01–08 全套,已随功能更新 |

## 版本记录

- **v0.1**:基础功能 —— 提交 / 执行 / 分页历史 / 串行队列 / 令牌鉴权 / 网页。
- **v0.2**:实时流式输出(SSE,默认关闭)、任务取消、任务重跑、macOS/Windows 开机自启脚本。
- **v0.3**:强化**跨平台(macOS + Windows)**——prompt 改走 stdin(解决 Windows `.cmd` 启动 + 消除 shell 注入面),win32 用 `shell:true` + `taskkill /T /F` 杀进程树。
- **v0.4**:一键诊断脚本 `scripts/doctor.mjs`(+ macOS/Windows 一键入口),检查运行时/依赖/引擎/配置/网络/自启,并内存实启服务验证安装。`npm run doctor`。
- **v0.5 / v0.5.1**:(已废弃)早期做过一套连通诊断脚本并带 `--json`;v0.7 起连通层从 Tailscale 整体切换到 Cloudflare,相关旧脚本已移除。
- **v0.6**:公网远程访问方案(满足「手机同时翻墙 + 用 OnlyMind」)—— Cloudflare Tunnel + Access,新增 [docs/08-remote-access.md]、隧道脚本(`tunnel-macos.sh`/`tunnel-windows.ps1`、`npm run tunnel`)、`cloudflared-config.example.yml`,doctor 识别 cloudflared。含中国大陆坑的处理(http2 + 走本地代理)。
- **v0.8**:每任务「简洁回答」开关(默认开启)——简洁指令经 **stdin** 注入(claude/codex 一致),命令行参数全为纯 ASCII,Windows `shell:true` 下无编码/转义风险;新增 `concise` 列 + 手机端复选框(持久化)。
- **v0.14(进行中)**:① `user-guide/` 顶层目录,打包前自动从 docs/ 同步 4 份说明书(`npm run guide:sync`,已接入 `npm run package`);② CLAUDE.md 新增「复杂任务处理流程」(任务文档存 `local/docs/{日期}-{任务名}/`,`local/` 不进交付包);③ **会话管理 P1–P3 后端完成**(sessions 表 + CRUD + 任务归属 + **多轮续接**[API 拼历史 / claude `--session-id`·`--resume` / 其它 CLI 历史前置] + **压缩**[API 总结省 token]),35/35 测试通过,**claude 续接真实冒烟通过**;见 `local/docs/2026-10-04-session-management/`。剩:前端会话 UI(F-1/F-2)、API 续接/压缩的真实 Key 冒烟。
- **v0.13**:历史任务**打开性能优化** —— 列表接口 `/api/tasks` 改为**轻量返回**(排除 `output`/`error` 两个大字段),历史页加载更快、流量更小;**点开某任务时才 `GET /api/tasks/:id` 取完整结果**,并配 **loading 蒙层**提供即时反馈;运行中/流式任务走 SSE。另:会话管理写入设计文档 [docs/09-sessions.md](待实现)。
- **v0.12**:**新增 OpenAI / Anthropic API 引擎**(纯问答)。`src/providers.js`(Key 验证 + 补全含 SSE 流式);引擎分 `kind` cli/api;API Key 存电脑端(`settings` 表,env 兜底),`POST /api/keys` 在线验证后才存、`GET /api/keys` 查状态、`/api/engines` 带 `kind/needsKey/keySet`;提交 API 引擎任务无 Key 返回 400。手机端:选引擎→若 API 且无 Key 则就地要求输入并验证,齿轮设置里统一管理 Key。启动/隧道命令品牌化为 `npm run onlymind` / `npm run onlymind:remote`。本机验证:四引擎元数据、无 Key 400、真实无效 Key 验证报错、CLI 回归、测试 22→27 全过。
- **v0.11**:**GitHub 分发 + 一键更新**。仓库 https://github.com/wangdming/OnlyMind(public)。新增 `scripts/update.mjs`(`npm run update` / `check:update`:git 检出→`git pull`;zip 下载→拉最新 Release tarball 覆盖,保留 `data/`、`.env`)、`.github/workflows/release.yml`(打 tag `v*` 自动打包发 Release)、`/api/version` 接口(含 GitHub 最新版对比,缓存 6h)、手机网页底部**显示当前版本并在有新版时提示**、`package.json` 的 `repository` 字段。公开仓库客户下载/克隆/更新**无需 GitHub 账号**。发版流程:改 version → `git tag vX.Y.Z && git push --tags`。本机已验证:仓库创建推送、Release Action 成功产出 zip、git/下载两种更新模式检测均正常。
- **v0.10**:脚本统一命名 + 跨平台收敛 —— 可跨平台的工具全部改为 Node 核心、经 `npm run` 调用(`doctor` / `check:tunnel` / `tunnel` / `package`,macOS/Windows 通用,`tunnel` 不再依赖 bash);开机自启按用途命名为 `autostart-install/uninstall.{sh,ps1}`;删除冗余的 per-OS 一键包装;新增 `scripts/package.mjs` 打包交付 zip(排除 node_modules/data/.env/*.db)。安装手册顶部加「给大模型的总指令」。
- **v0.9**:**可移植交付**——说明书拆成 4 份(macOS/Windows × 安装/使用手册);安装手册写成可被大模型自动执行的 runbook(逐步 + 自检 + 标注人工步骤);**全部文档与脚本改用相对路径**,解压到任意目录即可用;`04-manual` 改为索引页。
- **v0.7**:**连通层统一为 Cloudflare,彻底移除 Tailscale**。新增 Cloudflare 隧道检测 `scripts/check-cloudflare.mjs`(`npm run check:tunnel`,+ macOS/Windows 一键入口,含 `--json`),并入 doctor 作为「C.」专节;逐段检查 cloudflared 安装 / 命名隧道配置 / 本地 OnlyMind / 公网可达性 + 是否启用 Access(未启用 Access 则红色告警)。说明书与各文档同步去除 Tailscale 内容。

## 测试结果

### 自动化测试(`npm test`)—— 17/17 通过

v0.1 的 10 项,外加 v0.2 新增:
- claude 流式逐行解析(assistant delta / result final / 非 JSON 透传)✅
- POST 接受 stream 标志(true→1,缺省→0)✅
- 取消排队中任务 → canceled 且移出队列 ✅
- 取消运行中任务 → 经 AbortSignal 中止 → canceled ✅
- 取消已结束任务 → HTTP 409 ✅
- 重跑 → 复制 prompt/engine/cwd/stream 为新 queued 任务 ✅
- 流式任务经 onData 增量落库 ✅

### 手动冒烟测试(真实服务 + 真实 Claude Code)

- **流式 SSE**:提交 stream 任务 → SSE 依次收到 `snapshot → chunk("1 2 3 4 5") → status(done) → done`,服务端随后关闭连接 ✅
- **取消运行中**:提交长任务 → running → 取消 → canceled ✅
- **重跑**:从源任务新建成功 ✅
- **取消已结束** → HTTP 409 ✅
- **stdin 投递**:prompt 经 stdin → 正常执行,结果 `pong` ✅
- **注入安全**:prompt 含 `A"B&C$(whoami)D` → 原样返回,`$(whoami)` 未执行 ✅
- **macOS 自启**:`macos-install.sh` 装载 launchd → 服务响应 → `launchctl list` 可见 → 卸载后连接拒绝 ✅

## 环境备注

- 本机 `claude` 已安装可用;`codex` 未安装(代码已对缺失引擎优雅降级)。
- Node v26.3.0,`node:sqlite` 可用。

## 待办 / 后续可演进

- [ ] 局域网实机联调(手机同 Wi-Fi 打开 LAN 地址验证)—— 代码就绪,待你验证。
- [ ] 开机自启脚本在目标机器上实跑验证(macOS 已本机验证;**Windows 计划任务需在 Windows 上验证**)。
- [ ] 在 **Windows** 上实跑一次完整链路(`.cmd` 启动 + stdin + 取消 taskkill),本机为 macOS 无法验证。
- [ ] 安装 codex 后补一次真实链路(含流式)验证;codex 经 stdin 的 `-` 约定待确认。
- [ ] 公网方案实跑验证:需你的 Cloudflare 域名 + 账号(cloudflared login / Access 策略),本机无法代跑;脚本与文档已就绪。
- [ ] 验证电脑在墙内连 Cloudflare 的稳定性(http2 + 本地代理两招已写入 docs/08)。
- [ ] **会话管理**(多轮续接 / 按引擎分组 / 重命名·删除·压缩)——已评估可行并写入设计文档 [docs/09-sessions.md],**暂不实现**。压缩 = 总结历史省 token。
- [ ] 历史任务打开性能:已优化为「点开即时从列表缓存渲染 + loading 蒙层」(见下方版本记录)。
- [ ] 输出超长时的截断与「查看完整」。
- [ ] 任务搜索 / 按状态过滤。
