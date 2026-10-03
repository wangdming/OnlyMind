# OnlyMind · Windows 安装手册

> 本手册供「自动执行」:可交给 Claude Code / Codex 之类的命令行大模型,让它**按步骤逐条执行并自检**。所有命令在 **PowerShell** 中、于**项目根目录**(解压本项目压缩包后得到的文件夹)下运行,全部使用相对路径。

## 给大模型的总指令(自动执行本手册)

你是负责安装的智能体,运行在 **Windows PowerShell** 中。请**从头到尾自动完成本手册**,遵循以下规则:

1. **定位项目根目录**:先确认当前工作目录是本项目根目录(含 `package.json`、`src\`)。若不是,先 `cd` 到解压后的项目文件夹;找不到则请用户给出路径。
2. **按顺序逐步执行**:从「第 0 步」开始依次执行;每步「验证」命令**必须通过**才进入下一步。
3. **幂等跳过**:目标已满足的步骤(Node 已 ≥ v22、依赖已装、cloudflared 已在等)直接跳过。
4. **PATH 生效**:用 winget 装完 Node / cloudflared 后,**新开一个 PowerShell 窗口**(或重载环境)再验证,否则可能仍找不到命令。
5. **失败处理**:先按该步「修复建议」处理并**重试一次**;仍失败则**停止**并报告:步骤、命令、完整报错。
6. **人工步骤**:遇到「🧑 需人工」(登录引擎、UAC 提权、注册/登录账号等),**不要代替**;告诉用户要做什么,**暂停等待**完成后再继续。
7. **最小权限**:不做手册之外的改动;仅在手册明确要求时才提权。
8. **收尾**:全部完成后运行 `npm run doctor`,确认无 `[FAIL]`;向用户汇报结果,并提示「接下来按《Windows 使用手册》使用」。

> 准备就绪后,直接从下面的「第 0 步」开始执行。

## 约定

- **项目根目录**:解压后包含 `package.json`、`src\`、`scripts\`、`docs\` 的文件夹。下文命令都假设当前工作目录是它。
- 用 **PowerShell**(非 CMD)。每步都给了「验证」命令;**验证不通过不要进入下一步**。
- 标注「🧑 需人工」的步骤涉及登录/账号/UAC 提权,自动化无法完成,需提示用户手动做。
- 适用 Windows 10 / 11(64 位);ARM 版选对应架构包即可。

## 获取项目(二选一)

- **git 克隆(推荐,方便更新)**:
  ```powershell
  git clone https://github.com/wangdming/OnlyMind.git
  cd OnlyMind
  ```
- **下载压缩包**:打开 https://github.com/wangdming/OnlyMind/releases/latest,下载 `onlymind-<版本>.zip`,解压后 `cd` 进入该文件夹。

## 第 0 步:确认在项目根目录 + 允许运行脚本

```powershell
Test-Path package.json -PathType Leaf   # 应为 True
# 允许本会话运行项目自带的 .ps1 脚本:
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

## 第 1 步:确认 winget(包管理器)

```powershell
winget --version
```
若提示找不到 `winget`:🧑 需人工——从 Microsoft Store 安装「应用安装程序 / App Installer」后重开 PowerShell。

## 第 2 步:Node.js ≥ 22

检查:
```powershell
node -v   # 若无输出或主版本 < v22 则安装
```
安装(🧑 可能弹 UAC 提权):
```powershell
winget install --id OpenJS.NodeJS.LTS -e --source winget
```
**安装后重开一个 PowerShell 窗口**(让 PATH 生效),再验证(主版本须 ≥ 22):
```powershell
node -v
```

## 第 3 步:安装项目依赖

```powershell
npm install
npm ls --depth=0    # 验证:应列出 fastify 等,无 error
```

## 第 4 步:确认 AI 引擎可用

本项目调用 `claude`(Claude Code)或 `codex`(Codex)。**通常执行本手册的大模型本身就是其中之一,已安装。** 检查:
```powershell
Get-Command claude -ErrorAction SilentlyContinue; claude --version
Get-Command codex  -ErrorAction SilentlyContinue; codex  --version   # 可选
```
- 至少需要 `claude` 或 `codex` 之一在 PATH 上。
- 若 `claude` 缺失可安装:`npm install -g @anthropic-ai/claude-code`(装完重开 PowerShell)。
- 🧑 需人工:首次需登录引擎(运行 `claude` 后 `/login`,或配置 API Key)。

## 第 5 步:cloudflared(远程访问用)

```powershell
Get-Command cloudflared -ErrorAction SilentlyContinue; cloudflared --version
# 缺失则安装:
winget install --id Cloudflare.cloudflared -e --source winget
```
装完**重开 PowerShell**让 PATH 生效。
> 仅在同一 Wi-Fi 内使用、不需要手机外网访问时,本步可跳过。

## 第 6 步:一键诊断(总验证)

```powershell
npm run doctor
```
- `[FAIL]` **必须为 0**。
- 可接受的 `[WARN]`:未设固定令牌、未配 Cloudflare 命名隧道、未装开机自启(属使用阶段按需配置)。
- 有 `[FAIL]` 按其「修复建议」处理后重跑。

## 第 7 步(推荐):设置固定访问令牌

```powershell
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```
记录该令牌,启动时作为环境变量 `ONLYMIND_TOKEN` 使用(见使用手册)。也可写入项目根目录 `.env`(参考 `.env.example`)。

## 第 8 步(可选):开机自启(计划任务)

需固定令牌:
```powershell
$env:ONLYMIND_TOKEN = "第7步生成的令牌"
.\scripts\autostart-install.ps1
# 卸载:.\scripts\autostart-uninstall.ps1
```
脚本会创建名为 `OnlyMind` 的计划任务(登录即启动)。

## 第 9 步(可选):远程访问(手机在外网)

- **临时方案(零配置)**:无需域名,见使用手册的临时隧道步骤。
- **正式方案(固定网址 + 登录保护)**:需 Cloudflare 域名 + 命名隧道 + Access,详见 [08-远程访问](./08-remote-access.md)。🧑 需人工。

## 安装完成的判定

- `node -v` ≥ v22 ✓
- `npm ls --depth=0` 无缺失 ✓
- `claude` 或 `codex` 可用 ✓
- `npm run doctor` 无 `[FAIL]` ✓

接下来请阅读 [Windows 使用手册](./usage-windows.md)。

## Windows 注意事项

- 项目已针对 Windows 适配:`claude`/`codex` 多为 `.cmd`,代码用 `shell:true` 启动并通过 **stdin** 传任务内容(避免命令行转义/编码问题),取消任务用 `taskkill /T /F` 结束整棵进程树。
- 所有工具命令跨平台统一:`npm run doctor` / `npm run check:tunnel` / `npm run tunnel` / `npm run package` 在 macOS 与 Windows 上通用(底层是 Node 脚本)。开机自启因系统机制不同,分别用 `.\scripts\autostart-install.ps1`(Windows)或 `./scripts/autostart-install.sh`(macOS)。
