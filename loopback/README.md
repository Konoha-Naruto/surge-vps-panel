# Local Device Loopback → Egern

把这份 Surge 模块：

```ini
#!name=Local Device Loopback
#!desc=Reflect 10.7.0.1 back to this device for on-device developer tools.
[General]
ipv6-vif = auto
tun-included-routes = %INSERT% 10.7.0.1/32
tun-excluded-routes = %INSERT% 203.0.113.1/32

[IP Rewrite]
10.7.0.1 = reflect
```

转成 Egern 原生模块。

---

## 1. 对照表（逐行翻译）

| Surge 原文 | Egern 写法 | 能不能放模块里 |
|---|---|---|
| `[General] ipv6-vif = auto` | `ipv6: true` | ❌ 只能写 Profile.yaml |
| `tun-included-routes = %INSERT% 10.7.0.1/32` | `vif_included_routes: [10.7.0.1/32]` | ❌ 只能写 Profile.yaml |
| `tun-excluded-routes = %INSERT% 203.0.113.1/32` | `vif_excluded_routes: [203.0.113.1/32]` | ❌ 只能写 Profile.yaml |
| `[IP Rewrite] 10.7.0.1 = reflect` | `dns.hosts: {"10.7.0.1": 127.0.0.1}` + `ip_cidr → DIRECT` | ✅ 模块里就有 |

**为什么前三条进不了模块**：Egern 的模块文件只解析
`dns / rules / url_rewrites / header_rewrites / body_rewrites / map_locals / scriptings / mitm / http_captures / widgets / bypass_tunnel_proxy / real_ip_domains`
——没有 `general`、没有 `ip_rewrite`、没有 `vif_*`。这是官方模块文档写死的字段表，不是写法问题。

**为什么 hosts 能当 reflect 用**：Surge 的 `reflect` 是「TUN 抓到发往 10.7.0.1 的包 → 直接在本机网络栈里回送一份」。Egern 没有这个动作，但它支持把 **IP 字面量** 作为 hosts 的 key 做改写（官方文档 Hosts 一节的示例就是 `"192.168.1.100": internal.example.com` 的 IP 反向映射）。把目标改成 `127.0.0.1` 后，端口不变，数据落到本机回环——效果和 reflect 一模一样：谁连 `10.7.0.1:49152`，谁就连到本机 `49152`。

改写之后必须补 `DIRECT` 规则，否则你 profile 里最后那条兜底代理规则会把「去 127.0.0.1 的连接」塞给远端节点，表现就是永远连不上。

---

## 2. 文件

- `LocalDeviceLoopback.egern.yaml` —— 原生模块本体（hosts 改写 + DIRECT 规则）
- `Profile-补充片段.yaml` —— 模块改不到的三行，复制进主配置
- `check_loopback.py` —— 10 秒验证反射是否真的生效

---

## 3. 安装

### 3.1 模块

点链接（Egern 会弹确认框）：

```
egern:/modules/new?url=https://raw.githubusercontent.com/Konoha-Naruto/surge-vps-panel/main/loopback/LocalDeviceLoopback.egern.yaml
```

或手动：Egern → 工具 → 模块 → + → 填上面这个 raw 地址。

> 装了原生模块后，把之前那个 Surge 版 `.sgmodule` **停用**，两套同时开会重复改写。

### 3.2 Profile 必须补的三行

模块写不进去，得手动加进 Profile.yaml（Egern → 配置 → 编辑当前配置）：

```yaml
ipv6: true                 # 对应 ipv6-vif = auto
vif_included_routes:
  - 10.7.0.1/32            # 强行把 10.7.0.1 塞进 TUN，必须
vif_excluded_routes:
  - 203.0.113.1/32         # 可选：原模块的对照路由，就是个探针
```

⚠️ **Egern 的 `vif_included_routes` 没有 `%INSERT%` 这种追加语义**，你写了什么就是全部。原来已经有条目（比如 `192.168.0.1/32`）的，必须一起保留，别把整段替换掉。

`203.0.113.1/32` 是 TEST-NET-3 的假地址，原模块拿它当「排除路由」的对照组，不加也不影响 10.7.0.1 回环。

---

## 4. 验证

```bash
python3 check_loopback.py
```

判定标准（本机实测的指纹）：

| 现象 | 含义 |
|---|---|
| `10.7.0.1:49152` 连上后立刻被 RST | ✅ 打到本机了（remoted 是 TLS-PSK 服务，收到垃圾字节就断） |
| `10.7.0.1:22` 立刻 `Connection refused` | ✅ 本机栈在应答（没有服务监听 → RST → refused） |
| 两者都 `timed out` | ❌ 没进 TUN，或 hosts 改写没生效 |

`10.7.0.1` 不是任何真实网卡上的地址，超时 = 包发出去了没人理。

---

## 5. 坑

1. **`block_ips` 不能含 `127.0.0.1`**。有些 Clash 风格配置默认把 `127.0.0.1`、`0.0.0.0` 丢进 `block_ips` 当广告黑洞；一旦命中，hosts 改写出来的 127.0.0.1 会被直接吞掉。检查一下 Profile 的 `dns.block_ips`，有就去掉。
2. **规则顺序**。模块里的两条 `DIRECT` 如果被合并到你 profile 的兜底规则之后，等于没写。Egern 一般把模块规则前置，但保守起见：确认规则列表里 `ip_cidr 127.0.0.1/32` 在上面。
3. **同一时间只能有一个 VPN**。开着别的隧道（LocalDevVPN、SideStore 的 StosVPN）时，10.7.0.1 会被它们抢走。
4. **iOS 17 早期版本**上 remoted 可能只绑 IPv6 link-local，这在 Egern 侧无解，属于系统行为。
5. **实在不行就用原版 .sgmodule**。Egern 本身支持直接添加 Surge 模块（工具 → 模块），Surge 的 `[IP Rewrite]` 那条如果被兼容层吃掉，就不用转了。实测这台机器上 `10.7.0.1:22` 是秒拒的，说明当前已经有东西在把 10.7.0.1 回送到本机。
