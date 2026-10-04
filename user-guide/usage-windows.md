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
   - **工作目录**(可选):任务要操作的目录;留空用服务端默认目录。
   - **简洁回答**:默认已勾选 → 只给最终结果;想要完整解释/代码就**取消勾选**。
   - **实时流式输出**(可选):勾选可边跑边看。
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

## 安全要点(临时隧道)

- 临时隧道**没有登录保护,唯一防线是令牌**:务必用强令牌,**网址别发到群/截图等公开场合**。
- 不用时关闭隧道。
- 需要固定网址 + 邮箱登录保护 → 升级到 [08-远程访问](../docs/08-remote-access.md) 的正式方案。

## 排障

- 先跑 `npm run doctor`;远程相关再跑 `npm run check:tunnel`。
- 脚本无法运行:`Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`。
- 手机打不开:确认窗口 A/B 都在运行、用的是当次网址、令牌正确。
- 任务报 `Command 'xxx' not found`:对应引擎未安装或未登录。
