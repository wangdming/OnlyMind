# 更新日志

本文件记录每个版本的主要变化(面向用户)。打包时会自动抽取当前版本那一节生成 `更新说明.md` 放进交付包。

## v0.6.0 — 会话同步状态
- 本地 Claude / Codex / ChatGPT 可**自动检查**有哪些 OnlyMind 会话需要同步。
- 读取过的会话**不再重复**同步;会话有新内容时会重新提示。
- 可把某会话标记为**不需要同步**(手机端勾选「不同步到本地 AI」,或让 AI 代标记)。
- Claude Code 新增斜杠命令 `/onlymind:sync` 一键「检查 + 同步」。

## v0.5.0 — OnlyMind MCP 服务
- 把 OnlyMind 的会话/任务暴露给本地 AI,可读取并**无缝续接**之前的工作。
- 工具:`list_sessions` / `get_session_transcript`(完整转录) / `search_tasks`。
- 一键挂载到 Claude:`npm run mcp:claude`。

## v0.4.0 — 接入优麦云 / 卖家精灵(MCP)
- Claude 引擎可按需连接优麦云、卖家精灵等 MCP 服务查数据。
- Codex 一键写入其配置(`写入 Codex 配置`)。
- 手机端「MCP 服务器」管理:添加 / 删除 / 快捷填充 / 启用开关。

## v0.3.0 — API 引擎 + 会话管理
- 新增 **OpenAI / Anthropic API** 两个引擎(纯问答),API Key 在手机端在线验证后保存。
- **会话管理**:按引擎分组、多轮续接、重命名 / 删除 / 压缩(总结省 token)。
- 历史任务**打开更快**(列表轻量化 + 点开按需加载 + loading 蒙层)。

## v0.2.0 — 远程访问与分发
- **跨平台**:macOS 与 Windows 均可用。
- 远程访问:Cloudflare Tunnel + Access(手机在外网也能用)。
- 一键诊断 `npm run doctor`;实时流式输出、任务取消 / 重跑、简洁回答。
- GitHub 分发与一键更新 `npm run update`;手机底部显示版本并提示新版。

## v0.1.0 — 基础版
- 手机发任务 → 电脑上的 Claude Code / Codex 执行 → 结果回传手机,支持历史分页。
