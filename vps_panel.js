/**
 * vps_panel.js — Surge 信息面板脚本（VPS 监控）
 * 配合 vps_agent.py 使用：面板每 update-interval 秒拉一次 /status
 * $argument 形如：host=1.2.3.4&port=8787&token=ABCDEF
 */

var CFG = (function () {
    var raw = (typeof $argument === "string" && $argument) ? $argument : "";
    var o = {};
    raw.split("&").forEach(function (kv) {
        if (!kv) return;
        var i = kv.indexOf("=");
        var k = i < 0 ? kv : kv.slice(0, i);
        var v = i < 0 ? "" : kv.slice(i + 1);
        try { o[decodeURIComponent(k.trim())] = decodeURIComponent(v.trim()); }
        catch (e) { o[k.trim()] = v.trim(); }
    });
    return {
        host: (o.host || "").trim(),
        port: (o.port || "8787").trim(),
        token: (o.token || "").trim(),
        name: (o.name || "").trim(),
        scheme: (o.scheme || "http").trim(),
        path: (o.path || "/status").trim(),
        mask: String(o.mask || "true").toLowerCase() !== "false",
        limit: Number(o.limit) || 2000,
        reset: Number(o.reset) || 1,
        timeout: Number(o.timeout) || 8
    };
})();

var KEY = "vps.panel.v1." + CFG.host;

// ------------------------------------------------------------------ 小工具
function bar(pct, cells) {
    cells = cells || 10;
    var p = Math.max(0, Math.min(100, Number(pct) || 0));
    var n = Math.round(p / 100 * cells);
    if (p > 0 && n === 0) n = 1;
    var s = "";
    for (var i = 0; i < cells; i++) s += i < n ? "█" : "░";
    return s;
}

function pad3(p) {
    var v = Math.round(Number(p) || 0);
    if (v >= 100) return "100";
    if (v < 10) return "  " + v;
    return " " + v;
}

function bytes(n) {
    n = Number(n) || 0;
    if (n <= 0) return "0B";
    var u = ["B", "K", "M", "G", "T", "P"];
    var i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    var s = n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(1);
    return s.replace(/\.0$/, "") + u[i];
}

function duration(sec) {
    sec = Number(sec) || 0;
    var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    if (d > 0) return d + "天" + h + "时";
    if (h > 0) return h + "时" + m + "分";
    return m + "分";
}

function clock(ts) {
    var d = new Date(ts || Date.now());
    var p = function (x) { return (x < 10 ? "0" : "") + x; };
    return p(d.getHours()) + ":" + p(d.getMinutes());
}

function maskHost(h) {
    if (!CFG.mask || !h) return h;
    if (h.indexOf(":") >= 0 && h.indexOf(".") < 0) {
        var v6 = h.split(":");
        return v6.slice(0, 2).join(":") + ":****";
    }
    var v4 = h.split(".");
    if (v4.length === 4) return v4[0] + "." + v4[1] + "." + v4[2] + ".***";
    return h;
}

function num(x, d) { var v = Number(x); return isFinite(v) ? v : (d || 0); }

// ------------------------------------------------------------------ 流量
function trafficOf(d) {
    var vn = d.vnstat;
    if (vn && (num(vn.rx) + num(vn.tx)) > 0) {
        return { used: num(vn.rx) + num(vn.tx), src: "vnstat" };
    }
    var net = d.net || {};
    var rx = num(net.rx), tx = num(net.tx);
    var now = new Date();
    var base = null;
    try { base = JSON.parse($persistentStore.read(KEY + ".base") || "null"); } catch (e) { base = null; }
    if (!base) {
        $persistentStore.write(JSON.stringify({ rx: rx, tx: tx, month: now.getMonth() }), KEY + ".base");
        return { used: 0, src: "刚建立基线" };
    }
    var rollover = base.month !== now.getMonth() && now.getDate() >= CFG.reset;
    var rebooted = rx < num(base.rx) || tx < num(base.tx);
    if (rollover || rebooted) {
        $persistentStore.write(JSON.stringify({ rx: rx, tx: tx, month: now.getMonth() }), KEY + ".base");
        return { used: 0, src: rollover ? "新周期" : "重启后重算" };
    }
    return { used: Math.max(0, (rx - num(base.rx)) + (tx - num(base.tx))), src: "月差值" };
}

// ------------------------------------------------------------------ 渲染
function render(d, stale) {
    var cpu = num(d.cpu);
    var mem = d.mem || {}, disk = d.disk || {};
    var tf = trafficOf(d);
    var limitBytes = CFG.limit * 1024 * 1024 * 1024;
    var tfPct = limitBytes > 0 ? Math.min(100, tf.used * 100 / limitBytes) : 0;

    var lines = [];
    lines.push("CPU " + bar(cpu) + " " + pad3(cpu) + "%  " + num(d.cores, 1) + "核");
    lines.push("RAM " + bar(num(mem.pct)) + " " + pad3(num(mem.pct)) + "%  " + bytes(mem.used) + "/" + bytes(mem.total));
    lines.push("DSK " + bar(num(disk.pct)) + " " + pad3(num(disk.pct)) + "%  " + bytes(disk.used) + "/" + bytes(disk.total));
    lines.push("NET " + bar(tfPct) + " " + pad3(tfPct) + "%  " + bytes(tf.used) + "/" + CFG.limit + "G");
    lines.push("UP " + duration(d.uptime) + " · " + clock(d.ts) + (stale ? " · 缓存" : ""));

    var worst = Math.max(cpu, num(mem.pct), num(disk.pct), tfPct);
    var style = worst >= 90 ? "error" : worst >= 78 ? "alert" : "info";
    if (stale) style = "alert";

    var title = CFG.name || d.host || maskHost(CFG.host) || "VPS";
    if (title.length > 18) title = title.slice(0, 18);

    return {
        title: title,
        content: lines.join("\n"),
        style: style
    };
}

function fromCache(reason) {
    var cached = null;
    try { cached = JSON.parse($persistentStore.read(KEY) || "null"); } catch (e) { cached = null; }
    if (cached && cached.data) {
        var r = render(cached.data, true);
        r.title = (CFG.name || cached.data.host || "VPS");
        return r;
    }
    return {
        title: CFG.name || "VPS",
        content: "⚠️ 连接失败\n" + String(reason || "未知错误").slice(0, 60) +
                 "\n检查 host / token / 防火墙",
        style: "error"
    };
}

function finish(obj) { $done(obj); }

// ------------------------------------------------------------------ 主流程
function main() {
    if (!CFG.host) {
        return finish({ title: "VPS 监控", content: "还没配置\n在模块参数里填 host 和 token", style: "alert" });
    }
    var url = CFG.scheme + "://" + CFG.host + ":" + CFG.port + CFG.path +
              "?token=" + encodeURIComponent(CFG.token);

    $httpClient.get({
        url: url,
        timeout: CFG.timeout,
        headers: { "Accept": "application/json", "User-Agent": "Surge-VPS-Panel/1.0" }
    }, function (err, resp, body) {
        if (err) return finish(fromCache(err));
        var code = resp && resp.status ? resp.status : 0;
        if (code !== 200) return finish(fromCache("HTTP " + code));
        var data = null;
        try { data = JSON.parse(body); } catch (e) { return finish(fromCache("数据解析失败")); }
        if (!data || data.ok === false) return finish(fromCache((data && data.error) || "采集失败"));

        try { $persistentStore.write(JSON.stringify({ data: data, ts: Date.now() }), KEY); } catch (e) {}
        finish(render(data, false));
    });
}

main();
