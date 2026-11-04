#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验证 10.7.0.1 是否被反射回本机（Egern 原生 hosts 改写 / Surge reflect 同理）。

判定原理：
  10.7.0.1 不是任何真实网卡上的地址。
  - 若反射生效 → 连接落到本机回环：
      * 49152（remoted，TLS-PSK）收到垃圾字节会立刻 RST；
      * 22 这类没人听的端口会立刻 RST → Connection refused。
  - 若没进 TUN / 没改写 → 包发出去无人应答 → timed out。

用法: python3 check_loopback.py [ip] [port]
"""
import socket
import sys
import time

HOST = sys.argv[1] if len(sys.argv) > 1 else "10.7.0.1"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 49152


def probe(host, port, timeout=4.0):
    s = socket.socket()
    s.settimeout(timeout)
    t0 = time.time()
    try:
        s.connect((host, port))
    except ConnectionRefusedError:
        return "refused", time.time() - t0
    except socket.timeout:
        return "timeout", time.time() - t0
    except Exception as e:                      # noqa: BLE001
        return "%s:%s" % (type(e).__name__, e), time.time() - t0
    try:
        s.sendall(b"\x00" * 8)
        s.recv(64)
        return "recv", time.time() - t0
    except ConnectionResetError:
        return "reset", time.time() - t0
    except socket.timeout:
        return "recv-timeout", time.time() - t0
    except Exception as e:                      # noqa: BLE001
        return "%s:%s" % (type(e).__name__, e), time.time() - t0
    finally:
        s.close()


def main():
    print("目标: %s:%d\n" % (HOST, PORT))
    a, ta = probe(HOST, PORT)
    b, tb = probe(HOST, 22)
    print("  %s:%-5d  -> %-14s %.2fs" % (HOST, PORT, a, ta))
    print("  %s:%-5d  -> %-14s %.2fs" % (HOST, 22, b, tb))
    print()

    local = a in ("reset", "refused", "recv") or b == "refused"
    if local:
        print("✅ 反射已生效：%s 的连接落到了本机网络栈。" % HOST)
        if a == "timeout":
            print("   （49152 超时但 22 秒拒 —— 大概率是 remoted 没监听，"
                  "跟回环配置无关）")
    else:
        print("❌ 没打回本机，两者都超时。按顺序查：")
        print("   1) Profile.yaml 里 vif_included_routes 有没有 %s/32" % HOST)
        print("   2) 模块有没有启用、dns.hosts 有没有生效（看 Egern 连接日志）")
        print("   3) dns.block_ips 里是不是混进了 127.0.0.1")
        print("   4) 有没有别的 VPN 同时在跑")
    sys.exit(0 if local else 1)


if __name__ == "__main__":
    main()
