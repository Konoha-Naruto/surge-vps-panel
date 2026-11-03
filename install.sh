#!/usr/bin/env bash
# vps-agent 一键安装（systemd / OpenRC 通吃）
# 用法：
#   bash install.sh                 # 自动生成口令
#   TOKEN=你的口令 bash install.sh  # 指定口令
#   PORT=9000 bash install.sh       # 改端口
set -euo pipefail

PORT="${PORT:-8787}"
BIND="${BIND:-0.0.0.0}"
REPO="${REPO:-https://raw.githubusercontent.com/Konoha-Naruto/surge-vps-panel/main}"
SRC="${SRC:-}"          # 可选：本地 vps_agent.py 路径
TOKEN="${TOKEN:-}"

[ "$(id -u)" -eq 0 ] || { echo "请用 root 运行"; exit 1; }

# ---------- 口令 ----------
if [ -z "$TOKEN" ]; then
  TOKEN=$( (openssl rand -hex 16 2>/dev/null) || head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' )
  echo "[+] 已生成随机口令"
fi

# ---------- python3 ----------
if ! command -v python3 >/dev/null 2>&1; then
  echo "[*] 安装 python3 ..."
  if command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq python3
  elif command -v dnf >/dev/null 2>&1; then dnf install -y -q python3
  elif command -v yum >/dev/null 2>&1; then yum install -y -q python3
  elif command -v apk >/dev/null 2>&1; then apk add --no-cache python3
  else echo "[!] 请自行安装 python3"; exit 1; fi
fi

# ---------- 落地 agent ----------
install -m 0755 /dev/null /usr/local/bin/vps-agent
if [ -n "$SRC" ] && [ -f "$SRC" ]; then
  cp "$SRC" /usr/local/bin/vps-agent
else
  curl -fsSL "$REPO/vps_agent.py" -o /usr/local/bin/vps-agent
fi
chmod 0755 /usr/local/bin/vps-agent
printf 'TOKEN=%s\nPORT=%s\nBIND=%s\n' "$TOKEN" "$PORT" "$BIND" > /etc/vps-agent.conf
chmod 600 /etc/vps-agent.conf

# ---------- 服务 ----------
if [ -d /run/systemd/system ]; then
  cat > /etc/systemd/system/vps-agent.service <<EOF
[Unit]
Description=VPS monitor agent for Surge panel
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/vps-agent.conf
ExecStart=/usr/local/bin/vps-agent --bind \${BIND} --port \${PORT} --token \${TOKEN}
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now vps-agent >/dev/null 2>&1 || systemctl restart vps-agent
  echo "[+] systemd 服务 vps-agent 已启动"
elif command -v rc-update >/dev/null 2>&1; then
  cat > /etc/init.d/vps-agent <<'EOF'
#!/sbin/openrc-run
name="vps-agent"
command="/usr/local/bin/vps-agent"
command_args="--bind ${BIND} --port ${PORT} --token ${TOKEN}"
command_background=true
pidfile="/run/vps-agent.pid"
depend() { need net; }
EOF
  . /etc/vps-agent.conf
  sed -i "s|\${BIND}|$BIND|; s|\${PORT}|$PORT|; s|\${TOKEN}|$TOKEN|" /etc/init.d/vps-agent
  chmod 0755 /etc/init.d/vps-agent
  rc-update add vps-agent default >/dev/null 2>&1 || true
  rc-service vps-agent restart >/dev/null 2>&1 || rc-service vps-agent start
  echo "[+] OpenRC 服务 vps-agent 已启动"
else
  . /etc/vps-agent.conf
  pkill -f '/usr/local/bin/vps-agent' 2>/dev/null || true
  nohup /usr/local/bin/vps-agent --bind "$BIND" --port "$PORT" --token "$TOKEN" >/var/log/vps-agent.log 2>&1 &
  echo "[+] 无 systemd/OpenRC，已用 nohup 启动（重启后需手动拉起，建议写进 rc.local）"
fi

# ---------- 防火墙 ----------
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$PORT"/tcp >/dev/null 2>&1 && echo "[+] ufw 已放行 $PORT/tcp"
elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-port="$PORT"/tcp >/dev/null 2>&1
  firewall-cmd --reload >/dev/null 2>&1 && echo "[+] firewalld 已放行 $PORT/tcp"
fi

# ---------- 自检 ----------
sleep 1
if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  echo "[✓] 本机自检通过"
else
  echo "[!] 本机自检失败，看日志：journalctl -u vps-agent -n 50"
fi

PUBIP=$(curl -fsS --max-time 4 https://api.ipify.org 2>/dev/null || echo "你的服务器IP")
cat <<EOF

================ Surge 模块参数 ================
host   : $PUBIP
port   : $PORT
token  : $TOKEN
limit  : 2000      # 月流量限额 GB，按需改
reset  : 1         # 流量重置日
===============================================
安装模块：在 Surge 里打开下面的链接（或用模块 → 从 URL 安装）

surge:///install-module?url=https%3A%2F%2Fraw.githubusercontent.com%2FKonoha-Naruto%2Fsurge-vps-panel%2Fmain%2Fvps_monitor.sgmodule

装完点模块 → VPS 服务器监控 → 修改参数，把上面三项填进去。
EOF
