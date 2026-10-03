# 04 · 使用说明书(索引)

说明书按平台拆成了 4 份,分别是**安装手册**(可交给大模型自动执行)和**使用手册**(电脑端 + 手机端操作流程)。请按你的系统选择:

## macOS
- [macOS 安装手册](./install-macos.md) —— 环境、依赖、引擎、cloudflared 的全部安装与配置细节,可由 Claude Code / Codex 自动执行。
- [macOS 使用手册](./usage-macos.md) —— 电脑端 + 手机端 日常使用流程。

## Windows
- [Windows 安装手册](./install-windows.md) —— 同上(PowerShell / winget)。
- [Windows 使用手册](./usage-windows.md) —— 电脑端 + 手机端 日常使用流程。

## 打包交付(给维护者 / 交付方)

把本项目打成压缩包交给客户,用内置脚本即可(macOS / Windows 通用):

```bash
npm run package
```

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
