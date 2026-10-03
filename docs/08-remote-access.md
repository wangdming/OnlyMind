# 08 · 远程访问:Cloudflare Tunnel + Access

目标:**手机同时「连电脑用 OnlyMind」+「翻墙看外网」**。办法不是在手机上并存两个 VPN(iOS 只允许一个),而是把 OnlyMind 变成一个公网 HTTPS 网址,这样手机**不占用 VPN 名额**即可访问它,那唯一的 VPN 名额就留给翻墙。

```
手机(只开翻墙 VPN)
   ├─► 翻墙出口 ─► 正常访问 Google 等外网
   └─► 翻墙出口 ─► Cloudflare 边缘 ─(隧道)─► 你电脑的 cloudflared ─► OnlyMind(localhost:8787)
```

- `cloudflared` 在电脑上**主动外连** Cloudflare,无需公网 IP、无需端口转发、能穿 NAT。
- 手机访问 `https://onlymind.你的域名`,由于翻墙是全局隧道,这个请求经翻墙出口到 Cloudflare 再回到你电脑——**即使该域名在国内被墙也没关系**(流量从墙外出口走)。

## ⚠️ 安全红线(必读)

OnlyMind 是「能在你电脑上执行任意命令」的接口,权限又放到了最大。**一旦上公网,只靠一个 token 远远不够。** 因此本方案**强制要求**在前面加 **Cloudflare Access(Zero Trust,免费)**:只有通过你本人邮箱验证码登录的人,才能触达这个网址。再叠加 OnlyMind 自己的 token,双层防护。并务必**用普通用户(非 root)运行**。

> 不加 Access 的「临时隧道」只可用于本机测试,**绝不要**用于日常。

---

## 第一步:安装 cloudflared(电脑端)

```bash
# macOS
brew install cloudflared
# Windows
winget install Cloudflare.cloudflared
# 其他:https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
```

## 第二步:快速测试(临时隧道,仅本机验证用)

先确认 OnlyMind 已在跑(`npm start`),然后:

```bash
npm run tunnel        # macOS 与 Windows 通用
# 等价于:cloudflared tunnel --url http://localhost:8787
```

它会打印一个 `https://xxxx.trycloudflare.com` 网址,手机(开着翻墙)能打开即说明链路通。
**注意**:临时隧道每次网址都变、且无法加 Access,**只用于测试**,别长期用。

## 第三步:正式部署(命名隧道 + 你的域名 + Access)

前提:有一个**托管在 Cloudflare 的域名**(免费套餐即可)。

```bash
# 1) 登录(浏览器授权,选择你的域名)
cloudflared tunnel login

# 2) 创建命名隧道(记下生成的 Tunnel ID 和凭证文件路径)
cloudflared tunnel create onlymind

# 3) 写配置文件(模板见 scripts/cloudflared-config.example.yml)
#    放到 ~/.cloudflared/config.yml,把 <TUNNEL_ID> / 域名 / 端口填好

# 4) 把域名解析到隧道
cloudflared tunnel route dns onlymind onlymind.你的域名.com

# 5) 运行(或装成开机服务)
npm run tunnel -- onlymind                  # 前台运行命名隧道(mac/win 通用)
#   开机自启:
#   macOS/Linux:  sudo cloudflared service install
#   Windows(管理员 PowerShell):  cloudflared service install
```

### 配置 Cloudflare Access(鉴权,必做)

1. 打开 Cloudflare **Zero Trust** 控制台 → **Access → Applications → Add an application → Self-hosted**。
2. Application domain 填 `onlymind.你的域名.com`。
3. 加一条 **Policy**:Action = Allow,Include = **Emails** = 你的邮箱(登录方式选 **One-time PIN**,收邮箱验证码,无需 Google)。
4. 保存。之后任何人访问该网址都会先被要求邮箱验证码登录,只有你能进。

> Access 登录后用 Cookie 维持会话,OnlyMind 网页的 `fetch` 和 SSE(同源)会自动带上,**不影响使用**。

## 第四步:手机使用

1. 手机开**翻墙 VPN**(日常那个)。
2. 浏览器打开 `https://onlymind.你的域名.com` → Cloudflare Access 邮箱验证码登录 → 进入 OnlyMind。
3. ⚙︎ 里粘贴 OnlyMind 的 **ACCESS TOKEN**,正常发任务。
4. 同时你照常用翻墙查外网资料——**一个 VPN 名额,两件事都成立**。

---

## 中国大陆关键坑:电脑在墙内连不上 Cloudflare?

电脑本身在国内,`cloudflared` 外连 Cloudflare 边缘可能被墙/限速(尤其 QUIC/UDP)。两招:

1. **强制走 http2(关掉 QUIC)**,在 `~/.cloudflared/config.yml` 加:
   ```yaml
   protocol: http2
   ```
2. **让 cloudflared 走你电脑的翻墙代理**(电脑本来就有翻墙),设置环境变量后再启动:
   ```bash
   # 例:本地代理在 127.0.0.1:7890
   export HTTPS_PROXY=http://127.0.0.1:7890
   export ALL_PROXY=http://127.0.0.1:7890
   cloudflared tunnel run onlymind
   ```
   (Windows PowerShell:`$env:HTTPS_PROXY="http://127.0.0.1:7890"` 后再运行)

若仍不稳,可改用**自建 VPS + frp**(见 [02-架构](./02-architecture.md) 的穿透讨论)。

## 常见问题

| 现象 | 排查 |
|------|------|
| 手机打不开网址 | 翻墙 VPN 是否开着;域名是否已 `route dns`;电脑 `cloudflared` 是否在跑 |
| 一直转圈/502 | OnlyMind 没启动,或 config.yml 的 `service` 端口与 `ONLYMIND_PORT` 不一致 |
| 电脑端隧道连不上 Cloudflare | 加 `protocol: http2`;给 cloudflared 设 `HTTPS_PROXY` 走本地翻墙代理 |
| 没被要求邮箱登录 | Access Application 的 domain 没匹配上;确认拼写与策略已保存 |
| 担心安全 | 必须启用 Access;OnlyMind 用非 root 跑;token 另设强口令 |
