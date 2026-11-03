# VPS 监控 · Surge 面板版

把你那份 Egern（`VPS监控.yaml` + `VPS_SSH.js`）的 VPS 监控，搬到 **Surge 的信息面板（Information Panel）** 里。

## 为什么不直接转成模块

Egern 的小组件跑在自己的 JS 环境里，能 `ctx.ssh.connect()` 开 SSH 会话。
Surge 的脚本环境**只有 `$httpClient`**，没有任何原始 TCP/SSH 能力 —— 也就是说模块里那段
SSH 采集代码在 Surge 里根本发不出去。

所以拆成两半：

```
VPS ──[vps_agent.py 采集 /proc、vnstat]── HTTP(S)+token ──> Surge 面板脚本 ──> [Panel] 卡片
```

- **VPS 端**：`vps_agent.py`，零依赖（只用 Python 标准库），监听一个端口，`GET /status?token=xxx` 返回 JSON。
- **Surge 端**：模块里一个 generic 脚本，每次刷新拉一次 JSON，渲染成 5 行文字面板，失败时显示上次缓存。

## 安装

### 1. VPS 上装采集端

```bash
curl -fsSL https://raw.githubusercontent.com/Konoha-Naruto/surge-vps-panel/main/install.sh | bash
```

脚本会：装 python3（没有的话）→ 装 `/usr/local/bin/vps-agent` → 生成随机口令 → 写 systemd/OpenRC 服务 →
放行防火墙 → 打印 `host / port / token`。

想指定口令和端口：

```bash
TOKEN=你的口令 PORT=8787 bash install.sh
```

手动跑也行（前台调试）：

```bash
python3 vps_agent.py --port 8787 --token 你的口令
curl -s "http://127.0.0.1:8787/status?token=你的口令" | python3 -m json.tool
```

### 2. Surge 装模块

用 Surge 打开（或模块 → 从 URL 安装）：

```
https://raw.githubusercontent.com/Konoha-Naruto/surge-vps-panel/main/vps_monitor.sgmodule
```

装完点模块 → **VPS 服务器监控** → 改参数表：

| 参数 | 说明 | 默认 |
|---|---|---|
| `host` | 服务器 IP / 域名 | 必填 |
| `port` | 采集端口 | 8787 |
| `token` | 上面打印的口令 | changeme |
| `name` | 面板标题，留空用主机名 | 空 |
| `scheme` | `http` / `https` | http |
| `limit` | 月流量限额 GB | 2000 |
| `interval` | 刷新间隔（秒） | 300 |
| `mask` | IP 打码 | true |
| `reset` | 流量重置日（1–31） | 1 |

### 3. 看效果

Surge → 首页 → 策略选择页顶部就是面板；Mac 上是菜单栏 → Panels。

面板长这样：

```
CPU ████░░░░░░  42%  4核
RAM ██████░░░░  61%  5.0G/8.0G
DSK ██░░░░░░░░  23%  21G/93G
NET █░░░░░░░░░   6%  124G/2000G
UP 42天13时 · 12:31
```

超过 78% 变黄（alert），90% 变红（error），连不上显示上次缓存并标「缓存」。

## 数据来源

| 字段 | 来源 |
|---|---|
| CPU | `/proc/stat` 两次采样（0.25s 间隔） |
| 内存/交换 | `/proc/meminfo`（用 `MemAvailable` 算真实占用） |
| 磁盘 | `statvfs("/")`，可用 `--mount` 换挂载点 |
| 网卡累计 | `/proc/net/dev`（跳过 lo/docker/veth） |
| 月流量 | 有 `vnstat` 就用 `vnstat --json m` 的本月值；没有就用网卡累计值做月差值，Surge 端持久化基线 |
| 运行时长 | `/proc/uptime` |

想装 vnstat（流量统计更准，和 VPS 商家一致）：

```bash
apt install vnstat -y && vnstat --monthrotate 1 && systemctl enable --now vnstat
```

## 安全

- 默认 `http`，靠 token 校验（`hmac.compare_digest`，比较安全）。**公网暴露建议套 TLS**：
  ```bash
  # caddy 一行搞定，自动签证书
  caddy reverse-proxy --from vps.example.com --to 127.0.0.1:8787
  # 然后把模块参数改成 scheme=https, port=443, host=vps.example.com
  ```
- 更狠的做法：`--bind 127.0.0.1` + Surge 的 SSH 策略转发到本机端口，端口完全不开公网。
- `token` 只放在 Surge 模块参数里，别写进公开仓库。

## 文件

| 文件 | 用途 |
|---|---|
| `vps_monitor.sgmodule` | Surge 模块（`[Script]` + `[Panel]` + 参数表） |
| `vps_panel.js` | 面板渲染脚本 |
| `vps_agent.py` | VPS 采集端（零依赖） |
| `install.sh` | 一键部署 |

## 常见问题

**面板一直显示失败？** 先在服务器上 `curl "http://127.0.0.1:8787/health"`，再在本机浏览器开
`http://IP:8787/status?token=xxx`。多半是防火墙/安全组没放行。

**CPU 一直 0%？** 容器（LXC/OpenVZ）里 `/proc/stat` 可能不更新，属宿主限制。

**流量一直是 0？** 没装 vnstat 时，第一次请求只建立基线，第二次刷新才有数值；重启后也会重算。
