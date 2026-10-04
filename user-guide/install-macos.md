# OnlyMind · macOS 安装手册

> 本手册供「自动执行」:可交给 Claude Code / Codex 之类的命令行大模型,让它**按步骤逐条执行并自检**。所有命令都在**项目根目录**(解压本项目压缩包后得到的文件夹)下运行,全部使用相对路径。

## 给大模型的总指令(自动执行本手册)

你是负责安装的智能体。请**从头到尾自动完成本手册**,遵循以下规则:

1. **定位项目根目录**:先确认当前工作目录是本项目根目录(含 `package.json`、`src/`)。若不是,先 `cd` 到解压后的项目文件夹;若找不到,提示用户给出该路径后再继续。
2. **按顺序逐步执行**:从「第 0 步」开始依次执行每步的命令;每步附带的「验证」命令**必须通过**,才进入下一步。
3. **幂等跳过**:若某步目标已满足(如 Node 已 ≥ v22、依赖已装、cloudflared 已在),跳过该步,不要重复安装。
4. **失败处理**:某步失败时,先按该步的提示/「修复建议」处理并**重试一次**;仍失败则**停止**,向用户报告:失败的步骤、执行的命令、完整报错。
5. **人工步骤**:遇到标注「🧑 需人工」的步骤(登录引擎、输入系统密码、注册/登录账号等),**不要尝试代替**;清楚告诉用户需要做什么,**暂停并等待**其完成后再继续。
6. **最小权限**:不做手册之外的改动;不擅自使用 `sudo`;全程用当前普通用户运行。
7. **收尾**:全部完成后运行 `npm run doctor`,确认输出无 `[FAIL]`;然后向用户汇报安装结果,并提示「接下来按《macOS 使用手册》使用」。

> 准备就绪后,直接从下面的「第 0 步」开始执行。

## 约定

- **项目根目录**:解压后包含 `package.json`、`src/`、`scripts/`、`docs/` 的那个文件夹。下文所有命令都假设当前工作目录就是它。
- 每步都给了「验证」命令;**验证不通过不要进入下一步**。
- 标注「🧑 需人工」的步骤涉及登录/密码/账号,自动化无法完成,需提示用户手动做。

## 获取项目(二选一)

- **git 克隆(推荐,方便更新)**:
  ```bash
  git clone https://github.com/wangdming/OnlyMind.git
  cd OnlyMind
  ```
- **下载压缩包**:打开 https://github.com/wangdming/OnlyMind/releases/latest,下载 `onlymind-<版本>.zip`,解压后 `cd` 进入该文件夹。

## 第 0 步:确认在项目根目录

```bash
test -f package.json && test -d src && echo "OK: in project root" || echo "ERROR: 请先 cd 到解压后的项目文件夹"
```
预期输出 `OK: in project root`。

## 第 1 步:Homebrew(包管理器)

检查:
```bash
command -v brew && brew --version || echo "brew missing"
```
若缺失则安装(🧑 需人工:过程可能要求输入系统密码):
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```
安装后按提示把 brew 加入 PATH(Apple Silicon 通常为):
```bash
eval "$(/opt/homebrew/bin/brew shellenv)"
```

## 第 2 步:Node.js ≥ 22

检查当前版本:
```bash
node -v 2>/dev/null || echo "node missing"
```
- 若输出的主版本号 ≥ v22,跳过本步。
- 否则安装:
```bash
brew install node
```
验证(主版本须 ≥ 22):
```bash
node -v
```

## 第 3 步:安装项目依赖

```bash
npm install
```
验证(应列出 fastify 等,无 error):
```bash
npm ls --depth=0
```

## 第 4 步:确认 AI 引擎可用

本项目调用 `claude`(Claude Code)或 `codex`(Codex)。**通常执行本手册的大模型本身就是其中之一,已安装。** 检查:
```bash
command -v claude && claude --version || echo "claude missing"
command -v codex  && codex  --version || echo "codex missing (可选)"
```
- 至少需要 `claude` 或 `codex` 之一在 PATH 上。
- 若 `claude` 缺失,可安装:`npm install -g @anthropic-ai/claude-code`
- 🧑 需人工:首次需登录引擎(如运行 `claude` 后用 `/login`,或配置 API Key);自动化无法代替登录。

## 第 5 步:cloudflared(远程访问用)

检查:
```bash
command -v cloudflared && cloudflared --version || echo "cloudflared missing"
```
若缺失则安装:
```bash
brew install cloudflared
```
> 仅在同一 Wi-Fi(局域网)内使用、不需要手机在外网访问时,本步可跳过。

## 第 6 步:一键诊断(总验证)

```bash
npm run doctor
```
- 关注输出里的 `[FAIL]`:**必须为 0**(退出码 0 或仅有 `[WARN]`)。
- 常见可接受的 `[WARN]`:未设固定令牌、未配置 Cloudflare 命名隧道、未装开机自启——这些属于「使用手册」里按需配置的项,不影响安装完成。
- 若有 `[FAIL]`,按其「修复建议」处理后重跑。

## 第 7 步(推荐):设置固定访问令牌

不设的话每次启动会随机生成令牌。生成一个强令牌并记录给用户:
```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```
把它作为环境变量 `ONLYMIND_TOKEN` 在启动时使用(见「使用手册」)。也可写入项目根目录的 `.env`(参考 `.env.example`)。

## 第 8 步(可选):开机自启

让 OnlyMind 登录后自动运行、崩溃自动拉起(需固定令牌):
```bash
ONLYMIND_TOKEN=第7步生成的令牌 ./scripts/autostart-install.sh
# 卸载:./scripts/autostart-uninstall.sh
```

## 第 9 步(可选):远程访问(手机在外网)

- **临时方案(零配置,适合先用起来)**:无需域名,见「使用手册」里的临时隧道步骤。
- **正式方案(固定网址 + 登录保护)**:需要一个托管在 Cloudflare 的域名,配置命名隧道 + Cloudflare Access,详见 [08-远程访问](../docs/08-remote-access.md)。🧑 需人工(涉及 Cloudflare 账号登录、域名、Access 策略)。

## 安装完成的判定

全部满足即安装完成:
- `node -v` ≥ v22 ✓
- `npm ls --depth=0` 无缺失 ✓
- `claude` 或 `codex` 可用 ✓
- `npm run doctor` 无 `[FAIL]` ✓

接下来请阅读 [macOS 使用手册](./usage-macos.md)。
