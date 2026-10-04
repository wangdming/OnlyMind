# 04 · 使用说明书(索引)

说明书按平台拆成了 4 份,分别是**安装手册**(可交给大模型自动执行)和**使用手册**(电脑端 + 手机端操作流程)。请按你的系统选择:

## macOS
- [macOS 安装手册](./install-macos.md) —— 环境、依赖、引擎、cloudflared 的全部安装与配置细节,可由 Claude Code / Codex 自动执行。
- [macOS 使用手册](./usage-macos.md) —— 电脑端 + 手机端 日常使用流程。

## Windows
- [Windows 安装手册](./install-windows.md) —— 同上(PowerShell / winget)。
- [Windows 使用手册](./usage-windows.md) —— 电脑端 + 手机端 日常使用流程。

## 发布与交付(给维护者 / 交付方)

**推荐:GitHub 自动发布**(仓库 https://github.com/wangdming/OnlyMind)。有新功能/修复后:
```bash
# 1) 修改 package.json 的 version(如 0.2.0),提交并推送
# 2) 打同名 tag 并推送:
git tag v0.2.0 && git push origin v0.2.0
```
GitHub Actions(`.github/workflows/release.yml`)会自动打包并发布带 `onlymind-<版本>.zip` 的 Release。客户用 `npm run update` 即可拿到,**无需你手动打包发送**。

**客户更新**:`npm run check:update`(查)/ `npm run update`(更新;保留 `data/` 与 `.env`)。

---

### 离线打包(备选:无网络 / 不用 GitHub 时)

把本项目打成压缩包交给客户,用内置脚本即可(macOS / Windows 通用):

```bash
npm run package
```

- 打包前会**自动把 4 份说明书同步到 `user-guide/`**(`scripts/sync-user-guide.mjs`),客户解压后可在顶层 `user-guide/` 直接找到说明书。
- 产物:项目根目录下的 **`onlymind-<版本号>.zip`**(版本号取自 `package.json`,如 `onlymind-0.1.0.zip`)。
- **自动排除**:`node_modules`、`data`、`.git`、`.env`、`*.db` 及旧的 zip —— 不含依赖、不含你本机的数据与密钥,体积小、可安全外发。
- 跨平台:macOS/Linux 用 `zip`,Windows 用 `Compress-Archive`,命令一致。
- 客户无需联网下载依赖的源,但安装时会执行 `npm install` 拉取依赖(需联网)。

**完整交付闭环:**
1. 维护者:`npm run package` → 得到 `onlymind-<版本>.zip`。
2. 把 zip 发给客户。
3. 客户:解压到**一个新建的空文件夹**。
4. 客户:在该文件夹里用自己的大模型(Claude Code / Codex)按对应「安装手册」自动安装 —— 手册顶部已有「给大模型的总指令」。
5. 客户:按对应「使用手册」使用。

## 其它参考
- [05 · 表结构](./05-schema.md) · [06 · 接口文档](./06-api.md)
- [08 · 远程访问(固定网址 + 登录保护的正式方案)](./08-remote-access.md)

> 所有文档与脚本均使用相对路径,不依赖任何固定安装位置;解压到任意目录即可用。
