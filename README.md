# OnlyMind

手机给待命在电脑上的 **Claude Code / Codex** 下任务,电脑执行后把结果回传手机,支持分页查看历史任务。

```
手机网页 ──LAN / Cloudflare 隧道──► 电脑常驻服务(Fastify + SQLite)──► claude -p / codex exec
```

> **跨平台**:macOS 与 Windows 均支持(Linux 亦可)。需 Node ≥ 22。Windows 上 `claude`/`codex` 的 `.cmd` 启动已自动适配,prompt 经 stdin 投递(无 shell 注入面)。

仓库地址:**https://github.com/wangdming/OnlyMind**

## 下载 · 安装 · 更新

**获取(客户,二选一):**
```bash
# 方式一:git 克隆(之后 npm run update 走 git pull)
git clone https://github.com/wangdming/OnlyMind.git

# 方式二:下载最新 Release 压缩包(无需 git)
# 打开 https://github.com/wangdming/OnlyMind/releases/latest 下载 onlymind-<版本>.zip 并解压
```
然后按平台安装手册操作(见下)。

**更新(客户):**
```bash
npm run check:update   # 只检查有没有新版本
npm run update         # 更新到最新(git 克隆→git pull;zip 下载→自动拉取最新 Release)
```
更新会**保留** `data/`(历史任务)与 `.env`(你的配置),完成后重启 OnlyMind 生效。

**发布新版本(维护者,替代手动打包发送):**
```bash
# 1) 修改 package.json 的 version(如 0.2.0)并提交推送
# 2) 打同名 tag 并推送:
git tag v0.2.0 && git push origin v0.2.0
# GitHub Actions 自动打包并发布带 zip 的 Release;客户 npm run update 即可拿到。
```

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
> **交付方式(推荐:GitHub)**:维护者打 tag(`git tag vX.Y.Z && git push --tags`)→ GitHub Actions 自动发布带 zip 的 Release;客户从 Releases 下载或 `git clone`,日后用 `npm run update` 一键更新,无需你每次手动打包发送。
> **离线交付(备选)**:无网络/不便用 GitHub 时,维护者 `npm run package` 生成 zip 直接发给客户。详见 [说明书 · 打包交付](./docs/04-manual.md)。

## 特性

- 📱 手机网页(PWA,可加到主屏幕),免安装
- 🔀 四种引擎:Claude Code / Codex(CLI,可操作电脑)+ OpenAI API / Anthropic API(纯问答);手机端切换,API 引擎在线验证 Key
- 🗂 任务 + 结果持久化到本地 SQLite,游标分页查历史
- 🧵 串行队列(并发=1),崩溃自动恢复
- ⏱ 实时流式输出(SSE,**默认关闭**,可按任务开启)
- ✋ 任务取消 / 重跑
- 🚀 macOS / Windows 开机自启脚本(`scripts/`)
- 🔌 MCP 接入:Claude 引擎可连外部 MCP 服务(如优麦云 / 卖家精灵),用自然语言查数据
- 🔁 OnlyMind MCP 服务:把会话/任务暴露给本地 Claude/Codex/ChatGPT,无缝续接(`npm run mcp:claude`)
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
9. [会话管理](./docs/09-sessions.md) — 多轮续接 / 按引擎分组 / 重命名·删除·压缩(已实现)

## ⚠️ 安全提醒

本项目默认以最大权限执行任意任务(`--dangerously-skip-permissions`)。远程访问**务必走 Cloudflare Tunnel 并启用 Cloudflare Access 鉴权,不要直接把端口暴露到公网**;再设置强令牌、用普通用户(非 root)运行。详见[架构 · 安全](./docs/02-architecture.md#安全security)与 [08-远程访问](./docs/08-remote-access.md)。
