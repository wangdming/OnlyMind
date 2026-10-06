# OnlyMind · Windows 使用手册

> 前提:已按 [Windows 安装手册](./install-windows.md) 完成安装(`npm run doctor` 无 `[FAIL]`)。所有命令在 **PowerShell** 中、于**项目根目录**(解压后的文件夹)下执行,使用相对路径。

分「电脑端」和「手机端」。远程访问这里用**临时隧道**(零配置、无需域名;网址每次会变、仅靠令牌保护)。想要固定网址 + 登录保护,见 [08-远程访问](../docs/08-remote-access.md)。

---

## 电脑端(开两个 PowerShell 窗口,都先 cd 到项目根目录)

> 若某窗口报脚本无法运行,先执行:`Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`

### ① 生成一个强访问令牌(首次,记下来)

```powershell
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```
复制输出备用(下面叫它 `你的令牌`)。

### ② 窗口 A —— 启动 OnlyMind

```powershell
$env:ONLYMIND_TOKEN = "你的令牌"
npm run onlymind
```
保持此窗口开着。看到 `OnlyMind is running` 即成功。

### ③ 窗口 B —— 开启临时隧道(让手机在任意网络可访问)

```powershell
npm run onlymind:remote
```
几秒后它会打印一个公网网址:
```
https://xxxx-xxxx-xxxx.trycloudflare.com
```
**记下这个网址**(每次重开都会变)。保持此窗口也开着。

> 仅在同一 Wi-Fi 下使用时,可跳过第 ③ 步,直接用启动横幅里打印的 `LAN: http://<局域网IP>:端口`。

---

## 手机端

1. 手机**照常开着翻墙 VPN**(不冲突:OnlyMind 走普通 HTTPS 公网网址,不占用手机的 VPN 名额)。
2. 浏览器打开窗口 B 给出的 `https://xxxx.trycloudflare.com`。
3. 点右上角 ⚙︎ → 粘贴窗口 A 里那个 `你的令牌` → 保存 → 显示「已连接 ✓」。
4. (可选)浏览器「添加到主屏幕」,像 App 一样用。
5. 发任务:
   - **任务内容**:自然语言,例如「在 C:\code\foo 里把测试跑一遍,把失败的贴出来」。
   - **引擎**:`Claude Code` / `Codex`(CLI,可操作电脑,无需 Key)或 `OpenAI API` / `Anthropic API`(纯问答,需 API Key)。
     - 选 API 引擎时若未设 Key,引擎下方会出现输入框,填入并「验证并保存」后即可使用;也可在右上角 ⚙︎ 设置里统一管理 Key。Key 存在电脑端,验证通过才保存。
   - **会话(多轮续接)**:默认「不使用会话」(一次性任务)。想让多条任务**互相记得上下文**,选「＋ 新建会话」建一个(会话按引擎区分);之后在该会话里发的任务会带上历史。选中会话后下方有**重命名 / 压缩 / 删除**:压缩=把历史总结成摘要以省上下文/token(仅 OpenAI/Anthropic 引擎;Claude 自管上下文)。选择某会话后,历史区只显示该会话的多轮记录。
   - **工作目录**(可选):任务要操作的目录;留空用服务端默认目录。
   - **简洁回答**:默认已勾选 → 只给最终结果;想要完整解释/代码就**取消勾选**。
   - **实时流式输出**(可选):勾选可边跑边看。
   - **启用 MCP**(可选,仅 Claude 引擎):先在右上角 ⚙︎ 设置里「MCP 服务器」中添加(可一键「填充优麦云 / 卖家精灵」,再填你的 key;演示可用优麦云 `demo_aurelia_2026`)。勾选后,Claude 任务即可通过 MCP 查询/操作这些外部服务(如亚马逊经营、广告、关键词数据)。
   - 点「发送任务」。
6. 「历史任务」里自动刷新状态(`queued → running → done/failed`),点卡片看输出;可**取消**(运行中)、**重跑**(已结束)、底部「加载更多」翻页。

---

## 每天循环使用

- **要用**:窗口 A 跑 OnlyMind → 窗口 B 跑隧道 → 手机打开**当次**网址。
- **不用**:窗口 B 按 `Ctrl+C` 关隧道(高危接口即下线);窗口 A 也可 `Ctrl+C`。
- **再用**:重开后网址会变,手机打开新网址即可。
- 若已装开机自启(安装手册第 8 步),窗口 A 可省略(服务已常驻),只需开隧道。

## 更新到新版本

```powershell
npm run check:update   # 看有没有新版本
npm run update         # 更新(git 克隆→git pull;zip 下载→自动拉最新 Release)
```
更新**保留** `data/`(历史任务)与 `.env`(配置)。更新后请重启正在运行的 OnlyMind。

## MCP:连接优麦云 / 卖家精灵(Claude 与 Codex)

MCP 让 AI 引擎调用外部工具/数据:**优麦云**(你的店铺经营 + 广告操作)、**卖家精灵**(市场/关键词研究)。两者用自定义鉴权头(优麦云 `x-api-key`、卖家精灵 `secret-key`)。

- **Claude 引擎**:OnlyMind 已内置、图形化配置 → **推荐**。
- **Codex 引擎**:在 Codex 自己的配置里加(见 B)。
- **API 引擎(OpenAI/Anthropic)**:暂不支持这两个服务,请用 Claude 或 Codex。

### A. Claude(OnlyMind 内置 · 推荐)
1. 右上角 ⚙︎ → 找到「MCP 服务器」。
2. 点「**填充优麦云**」或「**填充卖家精灵**」自动带出 名称 / URL / 鉴权头名;在「鉴权头值」填你的 key(体验可用优麦云演示 key `demo_aurelia_2026`)。
3. 点「**保存 MCP 服务器**」(列表会显示,key 以遮蔽形式展示)。可添加多个。
4. 回主界面:**引擎选 Claude Code**,勾选「**启用 MCP**」。
5. 发任务,例如:「用 sellerspace 查我店铺最近 7 天的广告花费」。Claude 会自动调用对应 MCP 工具。
> 勾选「启用 MCP」后,本次 Claude 任务会接入**所有已配置**的 MCP;key 存电脑端,列表只显示遮蔽值。

### B. Codex(OnlyMind 一键写入 Codex 配置)
OnlyMind 能把已配置的 MCP **自动写入 Codex 配置**,无需手改 TOML:
1. 先按 A 的第 1–3 步,在「MCP 服务器」里添加好优麦云 / 卖家精灵(填好 key)。
2. 在「MCP 服务器」区点「**写入 Codex 配置**」。OnlyMind 会把这些服务器写入 `%USERPROFILE%\.codex\config.toml` 的一个**受管理标记块**(保留你其它配置;可随时点「**从 Codex 移除**」撤销)。
3. 确保电脑已**安装并登录 Codex**(`codex` 命令可用、已完成 OpenAI 登录)。
4. 回主界面,引擎选 **Codex**,发任务即可调用这些 MCP 工具。
> 配置采用 Codex 的 `http_headers` 格式,支持 `x-api-key` / `secret-key` 等自定义鉴权头。

### 获取正式 key 与官方教程
- 优麦云:后台 `/web/mcp/settings` 生成 `x-api-key`;配置页 https://www.sellerspace.com/web/mcp/setup
- 卖家精灵:`open.sellersprite.com` 获取 `secret-key`;MCP 文档 https://open.sellersprite.com/mcp/43

## 让本地 Claude / ChatGPT 续接 OnlyMind 的工作(OnlyMind MCP)

把本机 OnlyMind 处理过的**会话与任务**暴露给你本地的 AI,让它读取并**无缝接着干**。只读本机数据、不联网。

**挂到 Claude(一键):**
```powershell
npm run mcp:claude            # 挂载(user 范围,所有目录可用)
npm run mcp:claude -- remove  # 取消挂载
```
挂好后,在电脑任意目录运行 `claude`,对它说,例如:
> 检查 OnlyMind 有没有需要同步的会话,有就读取并接着继续。

它会**自动检查并只同步"有新内容、未忽略"的会话,已读取过的不重复**。用到的工具:
- `check_sync` —— 检查哪些会话需要同步(续接前先调用)。
- `list_sessions` —— 列出会话(id/名称/引擎/总轮数/待同步轮数/是否忽略)。
- `get_session_transcript` —— 取某会话的**完整转录**(摘要 + 每轮问/答全文);**读取后自动标记已同步**。
- `search_tasks` —— 全文检索;`set_sync_ignore` —— 把某会话标记为不同步。

**标记"不需要同步"的两种方式:**
- 手机端:选中会话后勾选「**不同步到本地 AI**」。
- 或直接让本地 AI:「把 XX 会话标记为不需要同步」。

在 Claude Code 里也可用斜杠命令 `/onlymind:sync` 一键完成"检查 + 同步"。

**Codex / 支持 MCP 的 ChatGPT:** 在其 MCP 配置里加一个 **stdio** 服务,命令为:
```
node <OnlyMind 项目绝对路径>\scripts\mcp-server.mjs
```
(即本项目的 `scripts\mcp-server.mjs`;它会自动读取本机 OnlyMind 的数据库。)

## 安全要点(临时隧道)

- 临时隧道**没有登录保护,唯一防线是令牌**:务必用强令牌,**网址别发到群/截图等公开场合**。
- 不用时关闭隧道。
- 需要固定网址 + 邮箱登录保护 → 升级到 [08-远程访问](../docs/08-remote-access.md) 的正式方案。

## 排障

- 先跑 `npm run doctor`;远程相关再跑 `npm run check:tunnel`。
- 脚本无法运行:`Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`。
- 手机打不开:确认窗口 A/B 都在运行、用的是当次网址、令牌正确。
- 任务报 `Command 'xxx' not found`:对应引擎未安装或未登录。
