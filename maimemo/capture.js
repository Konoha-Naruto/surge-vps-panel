/*
 * 墨墨签到抓包 · Surge http-request 脚本
 * 只读记录，不修改请求；用于提取「签到」对应的真实接口与鉴权方式。
 * 数据只写入 Surge 本地 $persistentStore，键名 mm_capture_v1。
 */
const KEY = "mm_capture_v1";
const MAX = 80;

const url = $request.url || "";
const method = ($request.method || "GET").toUpperCase();
const headers = $request.headers || {};
const body = $request.body || "";

const KEEP = [
  "authorization", "x-token", "token", "cookie", "x-csrf-token",
  "x-sign", "sign", "signature", "x-timestamp", "timestamp",
  "x-device-id", "device-id", "x-request-id", "x-client-version",
  "app-version", "x-app-version", "user-agent", "content-type"
];

function pickHeaders(h) {
  const out = {};
  for (const k of Object.keys(h)) {
    if (KEEP.indexOf(String(k).toLowerCase()) >= 0) {
      out[String(k).toLowerCase()] = String(h[k]).slice(0, 800);
    }
  }
  return out;
}

let arr = [];
try { arr = JSON.parse($persistentStore.read(KEY) || "[]"); } catch (e) { arr = []; }
arr.push({
  t: Date.now(),
  m: method,
  u: url.slice(0, 600),
  h: pickHeaders(headers),
  b: String(body).slice(0, 3000)
});
if (arr.length > MAX) arr = arr.slice(-MAX);
$persistentStore.write(JSON.stringify(arr), KEY);

console.log("[MMCAP] " + method + " " + url.split("?")[0]);
$done({});
