# Telegram 垃圾 IP 替换 · Egern 版

## 这玩意儿干嘛的

Telegram 的「转圈」不是网速问题，是**你这号被分到的那台 DC 机器当前拥堵**。
TG 客户端不走 DNS，直接从 `help.getConfig` 拿到一串 DC IP 就连，所以你改 DNS、换节点都没用。
唯一的办法：在手机上把**目标 IP 重写**成同一个 DC 里另一台正常的机器。

## 用哪个文件

| 文件 | 给谁用 | 说明 |
|---|---|---|
| `telegram-fktg.yaml` | **Egern（推荐）** | Egern 原生模块，`dns.hosts` 做 IP→IP 映射 |
| 上游 `FKTG.sgmodule` | Surge / Egern 导入 | Egern 也支持直接加 Surge 模块 URL，见下 |

## Egern 装法（二选一）

**A. 原生模块（推荐，语法干净）**

1. 工具 → 模块 → + → 添加本地文件 / URL，指向 `telegram-fktg.yaml`
2. 启用，重开 Telegram（后台划掉再打开）

**B. 直接加 Surge 模块**

```
https://raw.githubusercontent.com/BOBOLAOSHIV587/Rules/main/JS/FuckTelegram/FKTG.sgmodule
```

Egern 官方 FAQ 明确写了支持 Surge 模块，这条走的是同一套 `[Host]` 映射。

## 怎么确认生效

1. Egern → 请求记录（连接日志），筛 Telegram
2. 看**目标 IP**：应该出现 `91.108.56.147 / .135 / .130`，而不是 `.100 / .101 / .104 ...`
3. 转圈消失、消息秒刷 = 成了

## 铁律：不许跨 DC

| DC | 主地址 | 谁在用 |
|---|---|---|
| DC1 | 149.154.175.50 | 美洲 |
| DC2 | 149.154.167.51 | 欧洲 |
| DC3 | 149.154.175.100 | 美洲 |
| DC4 | 149.154.167.91 | 欧洲/中东 |
| **DC5** | **91.108.56.100** | **亚洲，+86 号码基本都在这** |

跨 DC 映射会被当成错误节点，表现是一直 connecting 或者来回重连。

## 自己加映射（转圈没治好时）

1. 转圈时打开 Egern 连接日志，记下 Telegram 正在连的那个 IP（就是「垃圾 IP」）
2. 在同一个 DC 的地址段里挑一个备用的（DC5 就 `91.108.56.x`）
3. 加一行：

```yaml
dns:
  hosts:
    "91.108.56.xxx": ["91.108.56.147", "91.108.56.135"]
```

4. 保存后重开 Telegram

## 来源

- FKTG 原始模块：Repcz / sooyaaabo → https://github.com/BOBOLAOSHIV587/Rules/tree/main/JS/FuckTelegram
- DC2 补充：ForestofTime/Surge `Module/Telegram-DC.sgmodule`
- 社区方案讨论：Surge 开发者 + Surge Pro 群组（P佬）
