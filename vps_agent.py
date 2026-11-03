#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
vps_agent.py — Surge 面板专用的 VPS 采集端（零依赖，仅标准库）

Usage: python3 vps_agent.py --port 8787 --token TOKEN [--bind 0.0.0.0]
接口：
  GET /status?token=xxx    -> JSON
  GET /health              -> ok

字段：host/os/kernel/uptime/load/cpu/cores/mem/swap/disk/net/vnstat
"""

import argparse
import hmac
import json
import os
import shutil
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

VERSION = "1.0.0"


# ---------------------------------------------------------------- 基础读取
def read_file(path, default=""):
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            return f.read()
    except Exception:
        return default


def meminfo():
    out = {}
    for line in read_file("/proc/meminfo").splitlines():
        parts = line.split(":")
        if len(parts) != 2:
            continue
        key = parts[0].strip()
        val = parts[1].strip().split()
        if val and val[0].isdigit():
            out[key] = int(val[0]) * 1024  # KB -> bytes
    return out


def cpu_snapshot():
    first = read_file("/proc/stat").splitlines()
    if not first:
        return 0, 0
    vals = [int(x) for x in first[0].split()[1:] if x.isdigit()]
    if len(vals) < 5:
        return 0, 0
    idle = vals[3] + vals[4]
    return sum(vals), idle


def cpu_percent(interval=0.25):
    t1, i1 = cpu_snapshot()
    time.sleep(interval)
    t2, i2 = cpu_snapshot()
    dt = t2 - t1
    if dt <= 0:
        return 0.0
    pct = (1.0 - float(i2 - i1) / float(dt)) * 100.0
    return round(max(0.0, min(100.0, pct)), 1)


def uptime_seconds():
    raw = read_file("/proc/uptime").split()
    try:
        return int(float(raw[0]))
    except Exception:
        return 0


def load_avg():
    raw = read_file("/proc/loadavg").split()
    try:
        return [float(raw[0]), float(raw[1]), float(raw[2])]
    except Exception:
        return [0.0, 0.0, 0.0]


def disk_usage(mount="/"):
    try:
        st = os.statvfs(mount)
    except Exception:
        return {"total": 1, "used": 0, "pct": 0, "mount": mount}
    total = st.f_blocks * st.f_frsize
    free = st.f_bavail * st.f_frsize
    used = total - free
    pct = round(used * 100.0 / total, 1) if total else 0
    return {"total": total, "used": used, "pct": pct, "mount": mount}


def net_counters():
    rx = tx = 0
    for line in read_file("/proc/net/dev").splitlines():
        if ":" not in line:
            continue
        name, data = line.split(":", 1)
        name = name.strip()
        if name == "lo" or name.startswith(("docker", "veth", "br-")):
            continue
        cols = data.split()
        if len(cols) < 9:
            continue
        try:
            rx += int(cols[0])
            tx += int(cols[8])
        except ValueError:
            continue
    return {"rx": rx, "tx": tx}


def vnstat_month():
    """有 vnstat 就返回本月流量（按 vnstat 的 MonthRotate），否则 None"""
    if not shutil.which("vnstat"):
        return None
    try:
        out = subprocess.run(
            ["vnstat", "--json", "m"],
            capture_output=True, timeout=3, text=True
        ).stdout
        data = json.loads(out)
        ifaces = data.get("interfaces") or []
        total_rx = total_tx = 0
        names = []
        period = None
        for iface in ifaces:
            months = ((iface.get("traffic") or {}).get("month")) or []
            if not months:
                continue
            m = months[0]
            total_rx += int(m.get("rx") or 0)
            total_tx += int(m.get("tx") or 0)
            names.append(iface.get("name") or "")
            date = m.get("date") or {}
            period = {"year": date.get("year"), "month": date.get("month")}
        if not names:
            return None
        return {
            "rx": total_rx,
            "tx": total_tx,
            "iface": ",".join([n for n in names if n]),
            "period": period,
        }
    except Exception:
        return None


def os_name():
    for line in read_file("/etc/os-release").splitlines():
        if line.startswith("PRETTY_NAME="):
            return line.split("=", 1)[1].strip().strip('"')
    return read_file("/etc/issue").strip().splitlines()[0] if read_file("/etc/issue").strip() else "Linux"


def collect(mount="/"):
    mi = meminfo()
    total = mi.get("MemTotal", 1)
    avail = mi.get("MemAvailable")
    if avail is None:
        avail = mi.get("MemFree", 0) + mi.get("Buffers", 0) + mi.get("Cached", 0)
    used = max(0, total - avail)
    sw_total = mi.get("SwapTotal", 0)
    sw_free = mi.get("SwapFree", 0)

    cores = os.cpu_count() or 1
    loads = load_avg()

    return {
        "ok": True,
        "agent": VERSION,
        "ts": int(time.time()),
        "host": os.uname().nodename,
        "os": os_name(),
        "kernel": os.uname().release,
        "cores": cores,
        "uptime": uptime_seconds(),
        "load": loads,
        # load 归一化后的占用（1 分钟），面板在拿不到瞬时 CPU 时的兜底
        "load_pct": round(min(100.0, loads[0] * 100.0 / cores), 1) if cores else 0,
        "cpu": cpu_percent(),
        "mem": {"total": total, "used": used, "pct": round(used * 100.0 / total, 1) if total else 0},
        "swap": {
            "total": sw_total,
            "used": max(0, sw_total - sw_free),
            "pct": round((sw_total - sw_free) * 100.0 / sw_total, 1) if sw_total else 0,
        },
        "disk": disk_usage(mount),
        "net": net_counters(),
        "vnstat": vnstat_month(),
    }


# ---------------------------------------------------------------- HTTP 层
class Handler(BaseHTTPRequestHandler):
    server_version = "VPSAgent/" + VERSION
    token = ""

    def log_message(self, fmt, *args):  # 静默，避免塞爆 journal
        pass

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        raw = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(raw)
        except Exception:
            pass

    def _auth_ok(self, qs):
        if not self.token:
            return True
        given = (qs.get("token") or [""])[0] or self.headers.get("X-Token", "")
        return hmac.compare_digest(str(given), str(self.token))

    def do_GET(self):
        u = urlparse(self.path)
        qs = parse_qs(u.query)
        if u.path in ("/health", "/ping"):
            return self._send(200, '{"ok":true}')
        if u.path not in ("/status", "/", "/api/status"):
            return self._send(404, '{"ok":false,"error":"not found"}')
        if not self._auth_ok(qs):
            return self._send(401, '{"ok":false,"error":"bad token"}')
        mount = qs.get("mount", ["/"])[0] or "/"
        try:
            data = collect(mount)
        except Exception as exc:  # 采集失败也要给面板一个可读错误
            return self._send(500, json.dumps({"ok": False, "error": str(exc)}))
        return self._send(200, json.dumps(data, ensure_ascii=False))

    do_HEAD = do_GET


def main():
    ap = argparse.ArgumentParser(description="VPS monitor agent for Surge panel")
    ap.add_argument("--bind", default="0.0.0.0", help="listen address, default 0.0.0.0; set 127.0.0.1 to use an SSH tunnel")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--token", default=os.environ.get("VPS_AGENT_TOKEN", ""))
    ap.add_argument("--mount", default="/", help="统计的磁盘挂载点")
    args = ap.parse_args()

    Handler.token = args.token.strip()
    if not Handler.token:
        print("[!] 没设 token，任何人都能读你的服务器状态。建议加 --token", file=sys.stderr)

    srv = ThreadingHTTPServer((args.bind, args.port), Handler)
    srv.daemon_threads = True
    print("vps_agent %s listening on %s:%d (token %s)" % (
        VERSION, args.bind, args.port, "set" if Handler.token else "EMPTY"))
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
