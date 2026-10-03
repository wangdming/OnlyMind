# OnlyMind

手机给待命在电脑上的 **Claude Code / Codex** 下任务,电脑执行后把结果回传手机,支持分页查看历史任务。

```
手机网页 ──LAN / Cloudflare 隧道──► 电脑常驻服务(Fastify + SQLite)──► claude -p / codex exec
```

> **跨平台**:macOS 与 Windows 均支持(Linux 亦可)。需 Node ≥ 22。Windows 上 `claude`/`codex` 的 `.cmd` 启动已自动适配,prompt 经 stdin 投递(无 shell 注入面)。

## 快速开始

解压后进入**项目根目录**,然后:

```bash
npm install
npm start          # 终端会打印访问地址(含 LAN 地址)和 ACCESS TOKEN
```

手机与电脑在同一 Wi-Fi 时,浏览器打开启动日志里的 `LAN: http://<电脑LAN-IP>:端口`,在 ⚙︎ 里粘贴令牌即可发任务。异地/外网访问用 Cloudflare 隧道(见手册)。

完整步骤请看按平台拆分的手册:
- **macOS**:[安装手册](./docs/install-macos.md) · [使用手册](./docs/usage-macos.md)
- **Windows**:[安装手册](./docs/install-windows.md) · [使用手册](./docs/usage-windows.md)

常用命令(macOS/Windows 通用):`npm test`(测试)· `npm run doctor`(一键诊断)· `npm run check:tunnel`(隧道检测)· `npm run tunnel`(起隧道)· `npm run package`(打包交付 zip)。开机自启:`./scripts/autostart-install.sh`(macOS)/ `.\scripts\autostart-install.ps1`(Windows)。

> 所有文档与脚本均使用**相对路径**:解压到任意目录即可用。
>
> **交付方式**:维护者运行 `npm run package` 生成 `onlymind-<版本>.zip`(自动排除 `node_modules/data/.env/*.db`)→ 把 zip 发给客户 → 客户解压到空文件夹 → 用自己的大模型按「安装手册」自动安装 → 按「使用手册」使用。详见 [说明书 · 打包交付](./docs/04-manual.md)。

## 特性

- 📱 手机网页(PWA,可加到主屏幕),免安装
- 🔀 Claude Code / Codex 两引擎,提交时切换
- 🗂 任务 + 结果持久化到本地 SQLite,游标分页查历史
- 🧵 串行队列(并发=1),崩溃自动恢复
- ⏱ 实时流式输出(SSE,**默认关闭**,可按任务开启)
- ✋ 任务取消 / 重跑
- 🚀 macOS / Windows 开机自启脚本(`scripts/`)
- 🌐 远程访问:Cloudflare Tunnel + Access(手机在外网也能用,且可同时翻墙)
- 🔐 API 令牌 + Cloudflare Access 多重保护

## 文档

完整文档在 [`docs/`](./docs):

1. [项目背景](./docs/01-background.md)
2. [技术架构](./docs/02-architecture.md)
3. [实现方案](./docs/03-implementation.md)
4. [使用说明书(索引)](./docs/04-manual.md) — 按平台拆分的安装/使用手册
5. [表结构](./docs/05-schema.md)
6. [接口文档](./docs/06-api.md)
7. [工作进度](./docs/07-progress.md)
8. [远程访问(Cloudflare Tunnel + Access)](./docs/08-remote-access.md) — 手机同时翻墙 + 用 OnlyMind

## ⚠️ 安全提醒

本项目默认以最大权限执行任意任务(`--dangerously-skip-permissions`)。远程访问**务必走 Cloudflare Tunnel 并启用 Cloudflare Access 鉴权,不要直接把端口暴露到公网**;再设置强令牌、用普通用户(非 root)运行。详见[架构 · 安全](./docs/02-architecture.md#安全security)与 [08-远程访问](./docs/08-remote-access.md)。
