/*
 * 运营商聚合面板 · carrier-hub
 * 联通 / 移动 / 电信 / 广电 四合一桌面小组件
 *
 * 结构：
 *   head.js  —— 全局容器
 *   四段 IIFE —— 各家官方脚本原文（仅做 export 改写 + 一行数据探针）
 *   tail.js  —— 聚合渲染
 *
 * 生成物请勿手改，改 vendor/ 后跑 build.py。
 */

globalThis.__CARR__ = { mods: {}, ds: {} };

;(function(){
var __exp = {};
/**
 * 中国联通小组件｜完整移植中国广电正式版 UI（保留现有数据接口）
 *
 * 微信小程序抓取诊断：
 * 1. 在微信打开中国联通小程序并进入流量查询
 * 2. Egern 监听 mxx.client.10010.com 请求并输出脱敏诊断信息
 * 3. 先确认实际请求结构，再适配数据接口；不会把未知接口当作旧 App 接口解析
 *
 * 旧 App 数据接口仍保留：
 * https://m.client.10010.com/mobileserviceimportant/home/queryUserInfoSeven
 */


/* =========================================================
 * 基础配置
 * ========================================================= */

const API_HOST = 'm.client.10010.com';
const MINI_PROGRAM_HOST = 'mxx.client.10010.com';
const KEY = 'unicom';
// 每 25 分钟最多一个采样点，96 个点约覆盖 24 小时，"今日流量使用"才有完整曲线（原来只留 24 个点，不足 10 小时）。
const HISTORY_LIMIT = 96;

const API_URL =
  'https://m.client.10010.com/mobileserviceimportant/home/queryUserInfoSeven';

// 微信小程序「中国联通」首页大球接口。返回结构与 App 的 queryUserInfoSeven 同构，
// 因此响应体可以直接复用 parseUnicomData 解析（协议来源见 README）。
// 流量明细接口（通用/定向分项）。参考 IBL3ND/module 的做法：App 侧 POST + Cookie 即可，不依赖小程序。
const FLOW_DETAIL_URL =
  'https://m.client.10010.com/servicequerybusiness/operationservice/queryOcsPackageFlowLeftContentRevisedInJune';

// 明细里按这些容器取子项（容器名参与「免流流量」判定）
const FLOW_CONTAINERS = {
  resources: '通用流量',
  RzbResources: '日租宝',
  MlResources: '免流流量',
  XsbResources: '限时流量',
};

// 定向（免流）判定：命中任一即为定向，其余计入通用
function isDirectionalFlowItem(item, containerName) {
  const code = String((item && item.addupItemCode) || '');
  const name = String((item && item.addUpItemName) || '');
  const fee = String((item && item.feePolicyName) || '');
  return code === '40008' ||
    name === '套餐内专享免费流量' ||
    containerName === '免流流量' ||
    /（免流）|畅视/.test(fee);
}

// 把明细响应整理成组件用的结构（单位 MB）
function parseDetailFlow(body) {
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  let gR = 0, gT = 0, gU = 0, dR = 0, dT = 0, dU = 0;
  let percent = null;
  let voiceRemain = null;
  let smsRemain = null;

  for (const key of Object.keys(FLOW_CONTAINERS)) {
    const list = body[key];
    if (!Array.isArray(list)) continue;
    for (const res of list) {
      const details = res && res.details;
      if (!Array.isArray(details)) continue;
      for (const item of details) {
        const remain = Math.max(0, num(item && item.remain));
        const total = Math.max(0, num(item && item.total));
        const used = Math.max(0, num(item && item.use));
        if (isDirectionalFlowItem(item, FLOW_CONTAINERS[key])) {
          dR += remain; dT += total; dU += used;
        } else {
          gR += remain; gT += total; gU += used;
        }
        if (percent == null && item && item.usedPercent != null) {
          const p = num(item.usedPercent);
          if (p) percent = Math.min(1, Math.max(0, p / 100));
        }
      }
    }
  }

  for (const res of Array.isArray(body.resources) ? body.resources : []) {
    const type = String((res && res.type) || '').toLowerCase();
    if (type === 'voice' && voiceRemain == null) voiceRemain = num(res.remainResource);
    if (type === 'smslist' && smsRemain == null) smsRemain = num(res.remainResource);
  }

  let otherUsedMB = 0;
  for (const row of body.flowSumList || []) {
    if (String(row && row.flowtype) === '3') otherUsedMB += num(row.xusedvalue);
  }

  const directional = (dR + dT + dU) > 0 ? { usedMB: dU, remainMB: dR, totalMB: dT } : null;
  const percentFromTotals = (gU + dU) > 0 ? Math.min(1, (gU + dU) / Math.max(1, gU + dU + gR + dR)) : null;

  return {
    ts: Date.now(),
    packageName: body.packageName ? String(body.packageName) : '',
    time: body.time ? String(body.time) : '',
    remainMB: gR,
    usedMB: gU,
    totalMB: gT || null,
    percent: percent != null ? percent : percentFromTotals,
    otherUsedMB,
    general: { usedMB: gU, remainMB: gR, totalMB: gT },
    directional,
    voiceRemain,
    smsRemain,
  };
}

// 主动拉一次明细：App 侧 POST，带 Cookie 即可
async function fetchFlowDetail(ctx, cookie) {
  const resp = await ctx.http.post(FLOW_DETAIL_URL, {
    timeout: 5000,
    headers: {
      Cookie: cookie,
      'User-Agent': 'ChinaUnicom.x CFNetwork iOS/16.3',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: '',
    credentials: 'omit',
  });
  if (!resp || resp.status !== 200) throw new Error('HTTP ' + (resp ? resp.status : 'no-response'));
  const body = await resp.json();
  if (!body || String(body.code) !== '0000') throw new Error('code ' + String(body && body.code));
  return parseDetailFlow(body);
}

const MINI_API_PATH = '/wxapplet/weixinNew/';
const MINI_API_BASE = 'https://mina.10010.com' + MINI_API_PATH;
const MINI_SSP_BIGBALL = MINI_API_BASE + 'sspbigball';


/* =========================================================
 * 颜色
 * ========================================================= */


/* =========================================================
 * Cookie / 手机号捕获
 * ========================================================= */

function getRequestHeader(headers, name) {
  if (!headers) return '';

  try {
    if (typeof headers.get === 'function') {
      return headers.get(name) || '';
    }
  } catch (e) {}

  try {
    for (const key of Object.keys(headers)) {
      if (String(key).toLowerCase() === name.toLowerCase()) {
        return headers[key] || '';
      }
    }
  } catch (e) {}

  return '';
}


// App 不同接口用的手机号参数名不一样，这里都试一遍，最后统一按 11 位号码校验，
// 避免把 pageNum / userNum 这类参数误当成手机号。
const PHONE_PARAM_NAMES = ['desmobiel', 'desmobile', 'usermobile', 'mobile', 'phone', 'mobileno', 'userNumber'];

function normalizePhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  // 允许 86 前缀、空格和短横线
  const digits = raw.replace(/[\s-]/g, '').replace(/^\+?86/, '');
  return /^1\d{10}$/.test(digits) ? digits : '';
}

function extractPhone(url) {
  if (!url) return '';

  try {
    const query = String(url).split('#')[0].split('?')[1] || '';
    if (!query) return '';
    for (const pair of query.split('&')) {
      const idx = pair.indexOf('=');
      if (idx <= 0) continue;
      const key = pair.slice(0, idx).toLowerCase();
      if (!PHONE_PARAM_NAMES.some(name => name.toLowerCase() === key)) continue;
      let value = pair.slice(idx + 1);
      try {
        value = decodeURIComponent(value);
      } catch (e) {}
      const phone = normalizePhone(value);
      if (phone) return phone;
    }
  } catch (e) {}

  return '';
}


async function fetchUnicomData(
  ctx,
  cookie,
  phone
) {

  const url =
    `${API_URL}?version=iphone_c@10.0100` +
    `&desmobiel=${encodeURIComponent(phone)}` +
    `&showType=0`;

  const resp = await ctx.http.get(
    url,
    {
      timeout: 10000,

      headers: {
        Host: API_HOST,

        'User-Agent':
          'ChinaUnicom.x CFNetwork iOS/16.3',

        Cookie: cookie,
      },

      credentials: 'omit',
    }
  );


  if (!resp || resp.status !== 200) {
    const status = resp ? resp.status : 0;
    const err = new Error(
      `HTTP ${resp ? resp.status : 'no-response'}`
    );
    // 401/403/302 基本意味着登录态失效，需要用户重新抓一次凭据。
    err.kind = status === 401 || status === 403 || status === 302 ? 'auth' : 'http';
    throw err;
  }


  return await resp.json();
}


/* =========================================================
 * 数据解析
 * ========================================================= */

function parseUnicomData(res) {

  if (
    !res ||
    res.code !== 'Y' ||
    !res.feeResource ||
    !res.voiceResource ||
    !res.flowResource
  ) {
    const err = new Error(
      `API 返回异常：${res?.code || 'unknown'}`
    );
    err.kind = 'auth';
    throw err;
  }


  const feeResource =
    res.feeResource;

  const voiceResource =
    res.voiceResource;

  const flowResource =
    res.flowResource;


  return {
    fee: {
      title:
        feeResource.dynamicFeeTitle ||
        '剩余话费',

      value:
        feeResource.feePersent ??
        0,

      unit:
        feeResource.newUnit ||
        '元',
    },

    voice: {
      title:
        voiceResource.dynamicVoiceTitle ||
        '剩余语音',

      value:
        voiceResource.voicePersent ??
        0,

      unit:
        voiceResource.newUnit ||
        '分钟',
    },

    flow: {
      title:
        flowResource.dynamicFlowTitle ||
        '剩余流量',

      value:
        flowResource.flowPersent ??
        0,

      unit:
        flowResource.newUnit ||
        'MB',
    },

    updateTime:
      new Date().toLocaleTimeString(
        'zh-CN',
        {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'Asia/Shanghai',
        }
      ),

    timestamp: Date.now(),
  };
}


/* =========================================================
 * 加载数据
 * ========================================================= */


function captureDebug(message) {
  try {
    if (typeof console !== 'undefined' && typeof console.log === 'function') {
      console.log('[ChinaUnicom Capture] ' + message);
    }
  } catch (e) {}
}

async function handleCapture(ctx) {
  const req = ctx.request || {};
  const url = String(req.url || '');
  // 日志只记录路径和布尔状态，绝不输出查询参数、手机号、Cookie 或 Token。
  const safePath = url.split('?')[0].split('#')[0];
  if (ctx.env && String(ctx.env.cuCapture).toLowerCase() === 'false') {
    captureDebug('skip(disabled): cuCapture=false; path=' + safePath);
    return;
  }
  const isAppRequest = url.includes(API_HOST);
  const isMiniProgramRequest = url.includes(MINI_PROGRAM_HOST);
  if (!isAppRequest && !isMiniProgramRequest) {
    captureDebug('skip(host): host mismatch; path=' + safePath);
    return;
  }

  // 微信小程序接口先只做脱敏侦察。未知请求结构不写入旧 App 凭据，也不尝试用旧接口解析。
  if (isMiniProgramRequest) {
    const method = String(req.method || 'unknown').toUpperCase();
    const headers = req.headers || {};
    let headerNames = [];
    try {
      if (typeof headers.keys === 'function') headerNames = Array.from(headers.keys());
      else headerNames = Object.keys(headers);
    } catch (e) {}
    headerNames = headerNames.map(k => String(k).toLowerCase()).sort();
    const body = req.body;
    const bodyType = body === null || body === undefined ? 'empty' : typeof body;
    let bodyLength = 0;
    let bodyKeys = [];
    try {
      if (typeof body === 'string') {
        bodyLength = body.length;
        try {
          const parsed = JSON.parse(body);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) bodyKeys = Object.keys(parsed).sort();
        } catch (e) {}
      } else if (body && typeof body === 'object') {
        bodyKeys = Object.keys(body).sort();
        bodyLength = JSON.stringify(body).length;
      }
    } catch (e) {}
    // Do not print request values. This diagnostic is intentionally metadata-only.
    captureDebug('mini-program request: method=' + method +
      '; path=' + safePath +
      '; headerNames=' + headerNames.join(',') +
      '; bodyType=' + bodyType +
      '; bodyLength=' + bodyLength +
      '; bodyKeys=' + bodyKeys.join(','));
    return;
  }

  const cookie = String(getRequestHeader(req.headers, 'cookie') || '').trim();
  const phone = extractPhone(url);

  // App 里大量接口（如 servicequerybusiness/yidingyewu）本来就不带 Cookie 和 desmobiel。
  // 这类请求只留一行日志就退出：既不误弹通知，也不会让日志看起来像报错。
  if (!cookie && !phone) {
    captureDebug('skip(no-creds): path=' + safePath);
    return;
  }

  // 只有套餐查询 / 登录类请求才值得提示「凭据不完整」。
  const planLike = Boolean(phone) ||
    /queryUserInfo|desmobiel|userinfo|login|home\/query/i.test(url);

  captureDebug('triggered: path=' + safePath +
    '; cookiePresent=' + Boolean(cookie) +
    '; phoneParamPresent=' + Boolean(phone) +
    '; planLike=' + planLike);

  let cookieChanged = false;
  let phoneChanged = false;
  if (cookie) {
    const previousCookie = ctx.storage.get('unicom_cookie') || '';
    if (cookie !== previousCookie) {
      ctx.storage.set('unicom_cookie', cookie);
      cookieChanged = true;
    }
  }
  if (phone) {
    const previousPhone = ctx.storage.get('unicom_phone') || '';
    if (phone !== previousPhone) {
      ctx.storage.set('unicom_phone', phone);
      phoneChanged = true;
    }
  }

  if (cookie && phone && (cookieChanged || phoneChanged)) {
    ctx.storage.set('unicom_captureTime', String(Date.now()));
    captureDebug('success: credentials updated; cookieChanged=' + cookieChanged + '; phoneChanged=' + phoneChanged);
    if ((!ctx.env || String(ctx.env.cuCaptureNotice).toLowerCase() !== 'false') && typeof ctx.notify === 'function') {
      const maskedPhone = phone ? '（尾号 ' + phone.slice(-4) + '）' : '';
      ctx.notify({
        title: '中国联通数据捕获成功',
        body: '已捕获登录信息' + maskedPhone + '，正在更新套餐数据',
        sound: false,
      });
    }
    return;
  }

  const captureNoticeEnabled = !ctx.env || String(ctx.env.cuCaptureNotice).toLowerCase() !== 'false';
  const notifyDiagnostic = (status) => {
    if (!captureNoticeEnabled || typeof ctx.notify !== 'function') return;
    // 限频，避免 App 连续请求时反复弹通知；通知内容只包含状态，不包含任何凭据。
    const now = Date.now();
    const last = Number(ctx.storage.get('unicom_captureDiagNotifyAt') || 0);
    if (now - last < 60000) return;
    ctx.storage.set('unicom_captureDiagNotifyAt', String(now));
    ctx.notify({
      title: '中国联通捕获诊断',
      body: '请求脚本已触发；Cookie：' + (cookie ? '已获取' : '缺失') +
        '；手机号参数：' + (phone ? '已获取' : '缺失') +
        '；状态：' + status,
      sound: false,
    });
  };

  if (!cookie || !phone) {
    captureDebug('incomplete: cookiePresent=' + Boolean(cookie) + '; phoneParamPresent=' + Boolean(phone));
    if (planLike) notifyDiagnostic('凭据不完整');
  } else {
    captureDebug('unchanged: credentials already match stored values');
    if (planLike) notifyDiagnostic('凭据未变化');
  }
}
const C = {
  // 低饱和环境渐变 + 统一中性色玻璃；主题色只用于图标、关键数字和进度。
  fee: '#E28A16',
  flow: '#079ACB',
  voice: '#8B5CF6',
  // 文本色随系统外观自动切换，避免深色模式下深色文字落在深色玻璃上。
  txt: { light: '#172B45', dark: '#F3F7FC' },
  sub: { light: '#586D84', dark: '#B8C7D8' },
  title: '#0F9F91',
  cyan: '#22B8CF',
  violet: '#9B7BFF',
  pink: '#EC6FA7',
  green: '#27A879',
  glass: { light: '#FFFFFFD9', dark: '#263D55D9' },
  glassBorder: { light: '#FFFFFF70', dark: '#FFFFFF25' },
  glassShadow: { light: '#64748B06', dark: '#00000000' },
};

// 测试版采用统一的清透磨砂玻璃，避免不同卡片各自铺色造成视觉杂乱。
const transparentMode = true;

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '刚刚';
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 1) return '刚刚';
  if (totalMin < 60) return totalMin + '分';
  const hours = Math.floor(totalMin / 60);
  const remMin = totalMin % 60;
  if (hours < 24) return hours + '小时' + (remMin > 0 ? remMin + '分' : '');
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return days + '天' + (remHours > 0 ? remHours + '小时' : '');
}

// 数据新旧的自然描述（用于「缓存 X 前」），与凭据保持的紧凑格式分开
function ageText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '刚刚';
  const min = Math.floor(ms / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + '分钟';
  const hours = Math.floor(min / 60);
  const restMin = min % 60;
  if (hours < 24) return hours + '小时' + (restMin > 0 ? restMin + '分' : '');
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return days + '天' + (restHours > 0 ? restHours + '小时' : '');
}

// 凭据保持时间：App 抓取的 captureTime 优先，只抓过小程序时用 miniTime 兜底
function captureTsOf(ctx) {
  return Number(ctx.storage.get('unicom_captureTime') || ctx.storage.get('unicom_miniTime') || 0);
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

function saveHistory(ctx, flow) {
  try {
    const old = ctx.storage.getJSON(KEY + '.history') || [];
    if (flow == null || flow === '') return old;
    const n = Number(flow);
    if (!Number.isFinite(n)) return old;

    const now = Date.now();
    const next = old.filter(x => now - Number(x.ts) < 7 * 86400000);
    const last = next[next.length - 1];
    if (!last || now - Number(last.ts) >= 25 * 60 * 1000 || Number(last.flowKB) !== n) {
      next.push({ ts: now, flowKB: n });
    }
    const trimmed = next.slice(-HISTORY_LIMIT);
    if (JSON.stringify(trimmed) !== JSON.stringify(old)) {
      ctx.storage.setJSON(KEY + '.history', trimmed);
    }
    return trimmed;
  } catch (e) {
    return [];
  }
}


function calcPlanPercent(total, used, remain) {
  const t = Number(total), u = Number(used), r = Number(remain);
  if (Number.isFinite(t) && t > 0 && Number.isFinite(u) && u >= 0) return Math.max(0, Math.min(1, u / t));
  if (Number.isFinite(t) && t > 0 && Number.isFinite(r) && r >= 0) return Math.max(0, Math.min(1, 1 - r / t));
  return null;
}
function formatFlow(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return { number: '--', unit: 'GB' };
  if (n >= 1024 * 1024) return { number: (n / (1024 * 1024)).toFixed(2), unit: 'GB' };
  if (n >= 1024) return { number: (n / 1024).toFixed(2), unit: 'MB' };
  if (n >= 1) return { number: n.toFixed(2), unit: 'KB' };
  return { number: (n * 1024).toFixed(2), unit: 'B' };
}
function formatVoice(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(0) : '--';
}

/* 联通数据加载：保留联通 API，并增加历史趋势与广电组件同款数据结构 */
function numericResourceValue(resource, keys) {
  if (!resource || typeof resource !== 'object') return null;
  for (const key of keys) {
    const v = resource[key];
    if (v !== undefined && v !== null && v !== '') {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}
// App 接口与小程序接口返回同样的 feeResource/flowResource/voiceResource，
// 这里统一换算成小组件使用的数据结构。
function buildDataSource(ctx, parsed, raw, captureDuration) {
  const flowResource = raw.flowResource || {};
  const voiceResource = raw.voiceResource || {};
  const flowTotalRaw = numericResourceValue(flowResource, ['flowTotal', 'flowAll', 'totalFlow', 'total', 'totalValue', 'resourceTotal', 'sumValue']);
  const flowUsedRaw = numericResourceValue(flowResource, ['flowUsed', 'flowUserd', 'usedFlow', 'used', 'usedValue', 'consumeValue', 'usedResource']);
  const voiceTotal = numericResourceValue(voiceResource, ['voiceTotal', 'voiceAll', 'totalVoice', 'total', 'totalValue', 'resourceTotal', 'sumValue']);
  const voiceUsed = numericResourceValue(voiceResource, ['voiceUsed', 'usedVoice', 'voiceUserd', 'used', 'usedValue', 'consumeValue', 'usedResource']);

  const unit = String(parsed.flow.unit || 'MB').toUpperCase();
  const flowToKB = n => {
    const v = Number(n);
    if (!Number.isFinite(v)) return null;
    if (unit === 'GB') return v * 1024 * 1024;
    if (unit === 'KB') return v;
    if (unit === 'B') return v / 1024;
    return v * 1024;
  };
  const remainKB = flowToKB(parsed.flow.value);
  const totalKB = flowTotalRaw == null ? null : flowToKB(flowTotalRaw);
  const usedKB = flowUsedRaw == null ? null : flowToKB(flowUsedRaw);
  const history = saveHistory(ctx, remainKB);
  const flowDisplay = formatFlow(remainKB);
  const ds = {
    stale: false,
    fee: { title: '剩余话费', number: Number(parsed.fee.value).toFixed(2), unit: '元' },
    flow: { title: '剩余流量', number: flowDisplay.number, unit: flowDisplay.unit },
    voice: { title: '剩余语音', number: String(parsed.voice.value), unit: parsed.voice.unit || '分钟' },
    updatedAt: Date.now(),
    captureDuration: captureDuration || '',
    history,
    plan: {
      total: totalKB, used: usedKB, remain: remainKB,
      percent: calcPlanPercent(totalKB, usedKB, remainKB),
      totalPath: flowTotalRaw == null ? null : 'flowResource',
      usedPath: flowUsedRaw == null ? null : 'flowResource',
      voiceTotal, voiceUsed, voiceRemain: Number(parsed.voice.value),
      voicePercent: calcPlanPercent(voiceTotal, voiceUsed, Number(parsed.voice.value)),
    },
  };
  return { ds, flowDisplay };
}

async function loadData(ctx) {
  const captureDisabled = !!(ctx.env && String(ctx.env.cuCapture).toLowerCase() === 'false');
  const readCache = () => {
    const cached = ctx.storage.getJSON('unicom_datasource') || null;
    if (!cached) return null;
    cached.stale = true;
    // 连续两次鉴权失败才提示，避免接口偶发异常时误报。
    cached.authFailed = Number(ctx.storage.get('unicom_authFail') || 0) >= 2;
    const ts = captureTsOf(ctx);
    // 冻结在数据生成时刻：数据过期后「凭据保持」不再随时间增长
    cached.captureDuration = ts > 0 ? formatDuration(Math.max(0, Number(cached.updatedAt || Date.now()) - ts)) : '';
    return cached;
  };

  if (captureDisabled) {
    const cached = readCache();
    return { data: cached, configured: !!cached, error: null, fromCache: true };
  }

  // 主屏 / 锁屏 / 画廊可能在同一轮里各自渲染一次，45 秒内复用同一份数据，避免重复打接口被风控。
  const fresh = ctx.storage.getJSON('unicom_datasource') || null;
  if (fresh && Number(fresh.updatedAt || 0) > 0 && Date.now() - Number(fresh.updatedAt) < 45000) {
    const ts = captureTsOf(ctx);
    fresh.captureDuration = ts > 0 ? formatDuration(Math.max(0, Number(fresh.updatedAt || Date.now()) - ts)) : '';
    return { data: fresh, configured: true, error: null, fromCache: false };
  }

  const captureTs = captureTsOf(ctx);
  const captureDuration = captureTs > 0 ? formatDuration(Date.now() - captureTs) : '';
  const cookie = ctx.storage.get('unicom_cookie') || '';
  const phone = ctx.storage.get('unicom_phone') || '';
  if (!cookie || !phone) {
    // 只做过微信小程序抓取（没有 App 凭据）时，直接用已缓存的小程序数据。
    const cached = readCache();
    if (cached) return { data: cached, configured: true, error: null, fromCache: true };
    return { data: null, configured: false, error: null, fromCache: false };
  }

  try {
    const raw = await fetchUnicomData(ctx, cookie, phone);
    const parsed = parseUnicomData(raw);
    const { ds, flowDisplay } = buildDataSource(ctx, parsed, raw, captureDuration);
    ctx.storage.setJSON('unicom_datasource', ds);
    ctx.storage.delete('unicom_authFail');
    // 流量明细（通用/定向分项）：15 分钟内不重复拉，失败静默降级
    try {
      const prevDetail = ctx.storage.getJSON('unicom_flowdetail');
      if (!prevDetail || !prevDetail.ts || Date.now() - Number(prevDetail.ts) > 15 * 60 * 1000) {
        ctx.storage.setJSON('unicom_flowdetail', await fetchFlowDetail(ctx, cookie));
      }
    } catch (e) {
      console.log('[ChinaUnicom] 流量明细获取失败: ' + String((e && e.message) || e));
    }
    const captureTime = String(ctx.storage.get('unicom_captureTime') || '');
    const notifiedCaptureTime = String(ctx.storage.get('unicom_notifiedCaptureTime') || '');
    if (captureTime && captureTime !== notifiedCaptureTime) {
      if ((!ctx.env || String(ctx.env.cuPlanNotice).toLowerCase() !== 'false') && typeof ctx.notify === 'function') {
        ctx.notify({
          title: '中国联通套餐查询成功',
          body: [
            '剩余话费：¥' + ds.fee.number,
            '剩余流量：' + flowDisplay.number + ' ' + flowDisplay.unit,
            '剩余语音：' + ds.voice.number + ' 分钟',
          ].join('\n'),
          sound: false,
        });
      }
      ctx.storage.set('unicom_notifiedCaptureTime', captureTime);
    }
    return { data: ds, configured: true, error: null, fromCache: false };
  } catch (e) {
    if (e && e.kind === 'auth') {
      ctx.storage.set('unicom_authFail', String(Number(ctx.storage.get('unicom_authFail') || 0) + 1));
    }
    return { data: readCache(), configured: true, error: e, fromCache: true };
  }
}
function fontSize(size) {
  if (typeof size === 'number') {
    if (size <= 8) return 9;
    if (size <= 10) return 10;
    if (size <= 13) return 12;
    if (size <= 19) return 16;
    return 24;
  }

  const named = {
    caption2: 9,
    caption1: 10,
    footnote: 12,
    body: 16,
    title3: 20,
    title2: 22,
    title: 24,
  };
  return named[size] || 12;
}

function t(text, size, weight, color, extra) {
  return Object.assign({
    type: 'text',
    text: String(text),
    font: { size: fontSize(size), weight: weight || 'regular' },
    textColor: color || C.txt,
    maxLines: 1,
    minScale: 0.6,
  }, extra || {});
}

const NO_COLOR = { light: '#00000000', dark: '#00000000' };

function glass(children, extra) {
  // 所有尺寸共用单一外层玻璃；此 helper 只负责透明布局，不再绘制内层卡片。
  // 透明值只作为默认值：调用方显式传入的样式仍然生效（原实现会写死覆盖）。
  return Object.assign({
    type: 'stack',
    direction: 'column',
    gap: 6,
    padding: [8, 10],
    borderRadius: 16,
    backgroundColor: NO_COLOR,
    borderWidth: 0,
    borderColor: NO_COLOR,
    shadowRadius: 0,
    children,
  }, extra || {});
}

function gaugeSvg(pct, color, w) {
  const stroke = 11;
  const r = (w - stroke) / 2;
  const cx = w / 2;
  const cy = w / 2;
  const h = w / 2 + stroke / 2;
  const p = Math.max(0, Math.min(1, Number(pct) || 0));

  const pt = a => [
    (cx - r * Math.cos(a)).toFixed(2),
    (cy - r * Math.sin(a)).toFixed(2),
  ];

  const [x0, y0] = pt(0);
  const [x1, y1] = pt(Math.PI);
  const [xp, yp] = pt(Math.PI * p);

  let body =
    `<path d='M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}' fill='none' stroke='${color}' stroke-opacity='0.18' stroke-width='${stroke}' stroke-linecap='round'/>`;

  if (p > 0.005) {
    body +=
      `<path d='M ${x0} ${y0} A ${r} ${r} 0 0 1 ${xp} ${yp}' fill='none' stroke='${color}' stroke-width='${stroke}' stroke-linecap='round'/>`;
  }

  return 'data:image/svg+xml,' +
    encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}'>${body}</svg>`
    );
}

function flowStatus(pct) {
  if (pct == null || !Number.isFinite(Number(pct))) {
    return { color: C.flow, label: '套餐用量' };
  }
  const p = Number(pct);
  if (p >= 0.9) return { color: '#C4475B', label: '用量偏高' };
  if (p >= 0.7) return { color: C.fee, label: '注意余量' };
  // 用量正常与「无使用率数据」统一用蓝色，避免同一仪表盘出现两种主色
  return { color: C.flow, label: '用量正常' };
}

function trendStrip(ds) {
  const today = todayFlowUsage(ds.history);
  const used = today.value == null ? null : formatFlow(today.value);
  return glass([
    {
      type: 'stack',
      direction: 'row',
      alignItems: 'center',
      gap: 6,
      children: [
        ...(used
          ? [{
              type: 'image',
              src: historySvg(today.history, C.flow, 100, 30),
              width: 72,
              height: 22,
            }]
          : []),
        {
          type: 'stack',
          direction: 'column',
          alignItems: 'start',
          gap: 1,
          flex: 1,
          children: [
            t('今日流量使用', 9, 'semibold', C.txt),
            t(today.label, 8, 'medium', C.sub, { minScale: 0.65 }),
          ],
        },
        ...(used ? [t(used.number + ' ' + used.unit, 9, 'bold', C.flow, { minScale: 0.7 })] : []),
      ],
    },
  ], {
    height: 42,
    padding: [5, 8],
    borderRadius: 13,
    gap: 0,
  });
}

function historySvg(history, color, w, h) {
  const vals = (history || []).map(x => Number(x.flowKB)).filter(Number.isFinite).slice(-12);
  const baseline = h - 2;
  const empty = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}'><path d='M 2 ${baseline} H ${w-2}' stroke='${color}' stroke-opacity='.22' stroke-width='1.5' stroke-linecap='round' stroke-dasharray='3 4'/></svg>`;
  if (!vals.length) return 'data:image/svg+xml,' + encodeURIComponent(empty);

  const max = Math.max(1, ...vals);
  const padX = Math.min(3, w * 0.025);
  const gap = Math.max(2, Math.min(5, w * 0.035));
  const count = vals.length;
  const barW = Math.max(2, (w - padX * 2 - gap * (count - 1)) / count);
  const usableH = h - 5;
  const bars = vals.map((v, i) => {
    const bh = Math.max(2, (Math.max(0, v) / max) * usableH);
    const x = padX + i * (barW + gap);
    const y = baseline - bh;
    const opacity = i === count - 1 ? 1 : 0.48 + 0.42 * ((i + 1) / count);
    return `<rect x='${x.toFixed(1)}' y='${y.toFixed(1)}' width='${barW.toFixed(1)}' height='${bh.toFixed(1)}' rx='${Math.min(2, barW / 2).toFixed(1)}' fill='${color}' fill-opacity='${opacity.toFixed(2)}'/>`;
  }).join('');
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}'><path d='M 1 ${baseline} H ${w-1}' stroke='${color}' stroke-opacity='.12' stroke-width='1'/>${bars}</svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

function heroFlowCard(ds, cardHeight, cardFlex, isMedium) {
  const remain = ds.flow.number + ' ' + ds.flow.unit;
  const total = ds.plan && ds.plan.total != null ? formatFlow(ds.plan.total) : null;
  const used = ds.plan && ds.plan.used != null ? formatFlow(ds.plan.used) : null;
  const compactFlowDetail = !cardHeight
    ? '总量 ' + (total ? total.number + ' ' + total.unit : '--') + ' · 已用 ' + (used ? used.number + ' ' + used.unit : '--') +
      (ds.directional && ds.directional.remain
        ? ' · 定向 ' + ds.directional.remain.number + ' ' + ds.directional.remain.unit
        : '')
    : '';
  const p = ds.plan && ds.plan.percent != null ? ds.plan.percent : null;
  const flowStyle = flowStatus(p);
  const flowContent = isMedium
    ? {
        // 中号：左侧显示剩余数值和套餐详情，右侧显示缩小的半圆仪表盘。
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 6,
        children: [
          {
            type: 'stack',
            direction: 'column',
            alignItems: 'start',
            gap: 2,
            flex: 1,
            children: [
              t(remain, cardHeight ? 22 : 19, 'bold', C.txt, { minScale: 0.55 }),
              t(compactFlowDetail || '当前剩余', 8, 'medium', C.sub, { minScale: 0.45 }),
            ],
          },
          {
            type: 'stack',
            direction: 'column',
            alignItems: 'center',
            gap: 0,
            children: [
              {
                type: 'image',
                src: gaugeSvg(p != null ? p : 0, flowStyle.color, 68),
                width: 44,
                height: 24,
              },
              t(p != null ? Math.round(p * 100) + '% 已用' : '—', 8, 'bold', flowStyle.color),
            ],
          },
        ],
      }
    : {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 12,
        children: [
          {
            type: 'stack',
            direction: 'column',
            alignItems: 'center',
            gap: -2,
            children: [
              {
                type: 'image',
                src: gaugeSvg(p != null ? p : 0, flowStyle.color, 86),
                width: 64,
                height: 34,
              },
              t(p != null ? Math.round(p * 100) + '% 已用' : '—', 10, 'bold', flowStyle.color),
            ],
          },
          {
            type: 'stack',
            direction: 'column',
            alignItems: 'start',
            gap: 1,
            flex: 1,
            children: [
              t(remain, cardHeight ? 23 : 20, 'bold', C.txt, { minScale: 0.55 }),
              t('当前剩余', 9, 'medium', C.sub),
              ...(!cardHeight ? [t(compactFlowDetail, 8, 'medium', C.sub, { minScale: 0.45 })] : []),
            ],
          },
        ],
      };
  return glass([
    {
      type: 'stack',
      direction: 'row',
      alignItems: 'center',
      gap: 6,
      children: [
        {
          type: 'image',
          src: 'sf-symbol:chart.pie.fill',
          width: 13,
          height: 13,
          color: C.flow,
        },
        t(ds.packageName || '流量主卡', 10, 'semibold', C.txt),
        { type: 'spacer' },
        t(p != null ? Math.round((1 - p) * 100) + '% 剩余' : '实时套餐', 9, 'semibold', flowStyle.color),
      ],
    },
    flowContent,
  ], {
    width: 0,
    flex: cardFlex || 1,
    ...(cardHeight ? { height: cardHeight, maxWidth: 360 } : {}),
    padding: [8, 10],
    borderRadius: 18,
    gap: 4,
    shadowColor: { light: '#52677A18', dark: '#00000028' },
    shadowRadius: 0,
    shadowOffset: { x: 0, y: 0 },
  });
}

function header(title, ds, fromCache, mediumInset) {
  const dur = ds.captureDuration ? ' · 凭据保持 ' + ds.captureDuration : '';
  const staleView = Boolean(ds.stale);
  const ageMs = ds.updatedAt ? Date.now() - Number(ds.updatedAt) : null;
  const expired = staleView && ageMs != null && ageMs > 24 * 60 * 60 * 1000;
  const when = staleView
    ? '缓存 ' + (ageMs != null ? ageText(ageMs) + '前' : fmtTime(ds.updatedAt))
    : '更新 ' + fmtTime(ds.updatedAt);
  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    padding: mediumInset ? [4, 6] : 0,
    gap: 5,
    children: [
      {
        type: 'image',
        src: 'sf-symbol:antenna.radiowaves.left.and.right',
        width: 13,
        height: 13,
        color: C.flow,
      },
      t(title, 'footnote', 'semibold', C.txt),
      { type: 'spacer' },
      t(`${when}${dur}${ds.authFailed ? ' · 凭据待更新' : ''}`, 9, 'medium', expired ? C.fee : C.sub, {
        minScale: 0.6,
      }),
    ],
  };
}

function buildSmall(title, ds, fromCache) {
  const staleView = Boolean(ds.stale);
  const ageMs = ds.updatedAt ? Date.now() - Number(ds.updatedAt) : null;
  const expired = staleView && ageMs != null && ageMs > 24 * 60 * 60 * 1000;
  const p = ds.plan && ds.plan.percent != null ? ds.plan.percent : null;
  const flowStyle = flowStatus(p);
  const remain = ds.flow.number + ' ' + ds.flow.unit;
  const usedFlow = ds.plan && ds.plan.used != null ? formatFlow(ds.plan.used) : null;
  const totalFlow = ds.plan && ds.plan.total != null ? formatFlow(ds.plan.total) : null;
  const used = usedFlow ? usedFlow.number + ' ' + usedFlow.unit : '--';
  const total = totalFlow ? totalFlow.number + ' ' + totalFlow.unit : '--';

  return {
    type: 'widget',
    padding: [13, 13],
    gap: 6,
    backgroundColor: '#00000000',
    refreshAfter: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    children: [
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 5,
        children: [
          {
            type: 'image',
            src: 'sf-symbol:antenna.radiowaves.left.and.right',
            width: 12,
            height: 12,
            color: C.flow,
          },
          t(title, 12, 'semibold', C.txt),
          { type: 'spacer' },
          t((staleView && ageMs != null ? '缓存 ' + ageText(ageMs) + '前' : fmtTime(ds.updatedAt)) +
            (ds.authFailed ? ' · 凭据待更新' : (ds.captureDuration ? ' · ' + ds.captureDuration : '')),
            8, 'medium', expired ? C.fee : C.sub, { minScale: 0.5 }),
        ],
      },

      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 4,
        flex: 1,
        children: [
          {
            type: 'stack',
            direction: 'column',
            alignItems: 'start',
            gap: 2,
            flex: 1,
            children: [
              t(ds.packageName || (ds.flow && ds.flow.title) || '剩余流量', 9, 'medium', C.sub),
              {
                type: 'stack',
                direction: 'row',
                alignItems: 'end',
                gap: 2,
                children: [
                  t(ds.flow.number, 23, 'bold', C.txt, { minScale: 0.35 }),
                  t(ds.flow.unit, 9, 'semibold', C.sub, { minScale: 0.7 }),
                ],
              },
              {
                type: 'stack',
                direction: 'column',
                alignItems: 'start',
                gap: 2,
                children: [
                  t(
                    ds.plan && ds.plan.used != null
                      ? '已用 ' + used
                      : '已用量待确认',
                    8,
                    'semibold',
                    flowStyle.color,
                    { minScale: 0.65 }
                  ),
                  t(
                    ds.plan && ds.plan.total != null
                      ? '总量 ' + total
                      : (ds.plan && ds.plan.remain != null
                        ? '余量 ' + formatFlow(ds.plan.remain).number + ' ' + formatFlow(ds.plan.remain).unit
                        : '总量待确认'),
                    8,
                    'medium',
                    C.sub,
                    { minScale: 0.45 }
                  ),
                ],
              },
            ],
          },
          {
            type: 'stack',
            direction: 'column',
            alignItems: 'center',
            gap: -2,
            children: [
              {
                type: 'image',
                src: gaugeSvg(p, flowStyle.color, 78),
                width: 44,
                height: 27,
              },
              t(
                p != null ? Math.round(p * 100) + '% 已用' : '套餐',
                8,
                'bold',
                flowStyle.color
              ),
              t(
                (() => {
                  const today = todayFlowUsage(ds.history);
                  return today.value != null
                    ? '今日 ' + formatFlow(today.value).number + formatFlow(today.value).unit
                    : '今日采集中';
                })(),
                8,
                'medium',
                C.sub,
                { minScale: 0.6 }
              ),
            ],
          },
        ],
      },

      {
        type: 'stack',
        direction: 'row',
        gap: 5,
        children: [
          glass([
            { type: 'stack', direction: 'row', alignItems: 'center', gap: 3, children: [
              { type: 'image', src: 'sf-symbol:phone.fill', width: 10, height: 10, color: C.voice },
              t('剩余语音', 8, 'medium', C.sub),
            ]},
            { type: 'stack', direction: 'row', alignItems: 'end', gap: 2, children: [
              t(ds.voice.number === '--' ? '暂无' : ds.voice.number, 18, 'bold', C.txt, { minScale: 0.4 }),
              t(ds.voice.number === '--' ? '' : '分钟', 8, 'semibold', C.sub),
            ]},
          ], { width: 0, flex: 1, height: 48, padding: [7, 7], gap: 4, borderRadius: 15 }),
          glass([
            { type: 'stack', direction: 'row', alignItems: 'center', gap: 3, children: [
              { type: 'image', src: 'sf-symbol:yensign.circle.fill', width: 10, height: 10, color: C.fee },
              t(ds.account && ds.account.balance != null ? '账户余额' : '剩余话费', 8, 'medium', C.sub),
            ]},
            { type: 'stack', direction: 'row', alignItems: 'end', gap: 2, children: [
              t('¥', 10, 'semibold', C.fee),
              t(ds.fee.number, 18, 'bold', C.txt, { minScale: 0.4 }),
              ...(ds.account && ds.account.monthCost != null
                ? [t('本月 ' + Number(ds.account.monthCost).toFixed(2), 7, 'medium', C.sub, { minScale: 0.5 })]
                : []),
            ]},
          ], { width: 0, flex: 1, height: 48, padding: [7, 7], gap: 4, borderRadius: 15 }),
        ],
      }
    ],
  };
}

function buildMedium(title, ds, fromCache) {
  // 中号内容增加内缩留白，避免标题与信息区贴近玻璃卡片边缘。
  const compactFee = glass([
    {
      type: 'stack',
      direction: 'row',
      alignItems: 'center',
      gap: 4,
      children: [
        {
          type: 'image',
          src: 'sf-symbol:yensign.circle.fill',
          width: 10,
          height: 10,
          color: C.fee,
        },
        t(ds.account && ds.account.balance != null ? '余额' : '话费', 9, 'medium', C.sub),
        { type: 'spacer' },
        {
          type: 'stack',
          direction: 'column',
          alignItems: 'end',
          gap: 0,
          children: [
            t('¥' + ds.fee.number, 15, 'bold', C.txt, { minScale: 0.6 }),
            ...(ds.account && ds.account.monthCost != null
              ? [t('本月 ' + Number(ds.account.monthCost).toFixed(2), 7, 'medium', C.sub, { minScale: 0.5 })]
              : []),
          ],
        },
      ],
    },
  ], {
    flex: 1,
    padding: [6, 8],
    gap: 1,
    borderRadius: 14,
    justifyContent: 'center',
  });

  const compactVoice = glass([
    {
      type: 'stack',
      direction: 'row',
      alignItems: 'center',
      gap: 4,
      children: [
        {
          type: 'image',
          src: 'sf-symbol:phone.fill',
          width: 10,
          height: 10,
          color: C.voice,
        },
        t('语音', 9, 'medium', C.sub),
        { type: 'spacer' },
        t(ds.voice.number, 15, 'bold', C.txt, { minScale: 0.6 }),
        t('分', 8, 'semibold', C.sub),
      ],
    },

  ], {
    flex: 1,
    padding: [6, 8],
    gap: 1,
    borderRadius: 14,
  });

  const row = {
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    gap: 5,
    children: [
      heroFlowCard(ds, null, null, true),
      {
        type: 'stack',
        direction: 'column',
        alignItems: 'center',
        gap: 5,
        width: 100,
        children: [
          compactFee,
          compactVoice,
        ],
      },
    ],
  };

  return {
    type: 'widget',
    padding: [12, 14],
    gap: 6,
    backgroundColor: { light: '#F4F7FB', dark: '#161B22' },
    refreshAfter: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    children: [
      header(title, ds, fromCache, true),
      row,
      trendStrip(ds),
    ],
  };
}


function todayFlowUsage(history) {
  const now = new Date();
  const todayKey = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate();
  const today = (history || [])
    .filter(x => {
      const ts = Number(x.ts);
      if (!Number.isFinite(ts)) return false;
      const d = new Date(ts);
      return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() === todayKey;
    })
    .sort((a, b) => Number(a.ts) - Number(b.ts));

  if (today.length < 2) {
    return { value: null, history: today, label: '今日数据采集中' };
  }

  const first = Number(today[0].flowKB);
  const last = Number(today[today.length - 1].flowKB);
  if (!Number.isFinite(first) || !Number.isFinite(last)) {
    return { value: null, history: today, label: '今日数据采集中' };
  }

  const value = Math.max(0, first - last);
  return {
    value,
    history: today.map(x => ({
      ts: x.ts,
      flowKB: Math.max(0, first - Number(x.flowKB)),
    })),
    label: value < 1 ? '今日暂无明显消耗' : '按今日已记录余量变化估算',
  };
}

function buildLarge(title, ds, fromCache) {
  const staleView = Boolean(ds.stale);
  const ageMs = ds.updatedAt ? Date.now() - Number(ds.updatedAt) : null;
  const expired = staleView && ageMs != null && ageMs > 24 * 60 * 60 * 1000;
  const plan = ds.plan || {};
  const total = plan.total != null ? formatFlow(plan.total) : null;
  const usedFlow = plan.used != null ? formatFlow(plan.used) : null;
  const remain = plan.remain != null ? formatFlow(plan.remain) : null;
  const voicePct = plan.voicePercent != null
    ? Math.max(0, Math.min(1, Number(plan.voicePercent)))
    : null;
  const voiceUsed = plan.voiceUsed != null ? formatVoice(plan.voiceUsed) : null;
  const voiceTotal = plan.voiceTotal != null ? formatVoice(plan.voiceTotal) : null;
  const p = plan.percent != null ? Math.max(0, Math.min(1, Number(plan.percent))) : null;
  const flowStyle = flowStatus(p);
  const today = todayFlowUsage(ds.history);
  const todayUsed = today.value == null ? null : formatFlow(today.value);

  // 大号组件内部只排版内容，不创建子卡片；玻璃背景由 liquidGlassWidget 统一提供。
  return {
    type: 'widget',
    padding: [16, 17],
    gap: 9,
    backgroundColor: '#00000000',
    refreshAfter: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    children: [
      header(title, ds, fromCache),
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 12,
        height: 112,
        children: [
          {
            type: 'stack',
            direction: 'column',
            alignItems: 'start',
            justifyContent: 'center',
            gap: 7,
            flex: 1.25,
            children: [
              {
                type: 'stack',
                direction: 'row',
                alignItems: 'center',
                gap: 5,
                children: [
                  { type: 'image', src: 'sf-symbol:chart.pie.fill', width: 13, height: 13, color: C.flow },
                  t(ds.packageName || (ds.flow && ds.flow.title) || '剩余流量', 10, 'semibold', C.sub),
                  { type: 'spacer' },
                  t(p != null ? Math.round((1 - p) * 100) + '% 剩余' : '套餐流量', 9, 'semibold', flowStyle.color),
                ],
              },
              {
                type: 'stack',
                direction: 'row',
                alignItems: 'end',
                gap: 3,
                children: [
                  t(ds.flow.number, 29, 'bold', C.txt, { minScale: 0.45 }),
                  t(ds.flow.unit, 11, 'semibold', C.sub),
                ],
              },
              {
                type: 'stack',
                direction: 'row',
                gap: 4,
                height: 5,
                children: [
                  {
                    type: 'stack',
                    flex: p == null ? 1 : Math.max(0.03, p),
                    backgroundColor: flowStyle.color,
                    borderRadius: 4,
                    children: [],
                  },
                  {
                    type: 'stack',
                    flex: p == null ? 0.001 : Math.max(0.03, 1 - p),
                    backgroundColor: { light: '#7890A52B', dark: '#FFFFFF2B' },
                    borderRadius: 4,
                    children: [],
                  },
                ],
              },
              t('总量 ' + (total ? total.number + ' ' + total.unit : '--') +
                '  ·  已用 ' + (usedFlow ? usedFlow.number + ' ' + usedFlow.unit : '--') +
                (ds.otherUsedMB != null
                  ? '  ·  其他 ' + formatFlow(ds.otherUsedMB * 1024).number + ' ' + formatFlow(ds.otherUsedMB * 1024).unit
                  : ''), 9, 'medium', C.sub, { minScale: 0.55 }),
              ...(ds.directional && (ds.directional.remain || ds.directional.used)
                ? [t('定向流量 ' + (ds.directional.remain ? '剩余 ' + ds.directional.remain.number + ' ' + ds.directional.remain.unit : '') +
                    (ds.directional.used ? (ds.directional.remain ? ' · ' : '') + '已用 ' + ds.directional.used.number + ' ' + ds.directional.used.unit : ''), 8, 'medium', C.sub, { minScale: 0.6 })]
                : []),
            ],
          },
          {
            type: 'stack',
            direction: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 0,
            width: 90,
            children: [
              { type: 'image', src: gaugeSvg(p, flowStyle.color, 110), width: 76, height: 40 },
              t(p != null ? Math.round(p * 100) + '% 已用' : '用量统计', 9, 'bold', flowStyle.color),
            ],
          },
        ],
      },
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 10,
        padding: [8, 0],
        children: [
          {
            type: 'stack',
            direction: 'column',
            gap: 4,
            flex: 1,
            children: [
              { type: 'stack', direction: 'row', alignItems: 'center', gap: 4, children: [
                { type: 'image', src: 'sf-symbol:yensign.circle.fill', width: 12, height: 12, color: C.fee },
                t(ds.account && ds.account.balance != null ? '账户余额' : '剩余话费', 10, 'medium', C.sub),
              ]},
              { type: 'stack', direction: 'row', alignItems: 'end', gap: 2, children: [
                t('¥' + ds.fee.number, 21, 'bold', C.txt, { minScale: 0.5 }),
                t('元', 9, 'medium', C.sub),
              ]},
              ...(ds.account && ds.account.monthCost != null
                ? [t('本月 ¥' + Number(ds.account.monthCost).toFixed(2), 8, 'medium', C.sub, { minScale: 0.6 })]
                : []),
            ],
          },
          {
            type: 'stack',
            direction: 'column',
            gap: 4,
            flex: 1,
            children: [
              { type: 'stack', direction: 'row', alignItems: 'center', gap: 4, children: [
                { type: 'image', src: 'sf-symbol:phone.fill', width: 12, height: 12, color: C.voice },
                t('剩余语音', 10, 'medium', C.sub),
              ]},
              { type: 'stack', direction: 'row', alignItems: 'end', gap: 2, children: [
                t(ds.voice.number === '--' ? '暂无' : ds.voice.number, 21, 'bold', C.txt, { minScale: 0.5 }),
                t(ds.voice.number === '--' ? '' : '分钟', 9, 'medium', C.sub),
              ]},
              ...(voiceUsed != null && voiceTotal != null
                ? [t('已用 ' + voiceUsed + ' / ' + voiceTotal + ' 分钟', 8, 'medium', C.sub, { minScale: 0.55 })]
                : (ds.smsRemain != null
                    ? [t('短信 ' + ds.smsRemain + ' 条', 8, 'medium', C.sub, { minScale: 0.55 })]
                    : [])),
            ],
          },
        ],
      },
      {
        type: 'stack',
        direction: 'column',
        gap: 5,
        padding: [7, 0, 0, 0],
        children: [
          {
            type: 'stack',
            direction: 'row',
            alignItems: 'center',
            gap: 4,
            children: [
              { type: 'image', src: 'sf-symbol:chart.bar.fill', width: 10, height: 10, color: C.flow },
              t('今日流量使用', 10, 'semibold', C.txt),
              { type: 'spacer' },
              ...(todayUsed ? [t(todayUsed.number + ' ' + todayUsed.unit, 10, 'bold', C.flow)] : []),
            ],
          },
          ...(todayUsed
            ? [{
                type: 'image',
                src: historySvg(today.history.map(x => ({ flowKB: x.flowKB })), C.flow, 270, 38),
                width: 270,
                height: 38,
              }]
            : []),
          t(today.label, 8, 'medium', C.sub),
          {
            type: 'stack',
            direction: 'row',
            alignItems: 'center',
            gap: 4,
            children: [
              { type: 'image', src: 'sf-symbol:clock', width: 9, height: 9, color: C.sub },
              t(staleView ? '缓存 ' + (ageMs != null ? ageText(ageMs) + '前' : '') : '实时数据', 8, 'medium', expired ? C.fee : C.sub),
              { type: 'spacer' },
              t(expired ? '数据已过期' : (ds.captureDuration ? '凭据已保持 ' + ds.captureDuration : ''), 8, 'medium', expired ? C.fee : C.sub),
            ],
          },
          ...(ds.account && ds.account.owed != null && Number(ds.account.owed) > 0
            ? [t('欠费 ¥' + Number(ds.account.owed).toFixed(2), 8, 'semibold', C.fee)]
            : []),
        ],
      },
    ],
  };
}

function buildLock(title, ds, family) {
  const dur = ds.captureDuration ? ' · 保持' + ds.captureDuration : '';
  if (family === 'accessoryInline') {
    return {
      type: 'widget',
      children: [
        {
          type: 'text',
          text: `¥${ds.fee.number} · ${ds.flow.number}${ds.flow.unit} · ${ds.voice.number}分${dur}`,
          maxLines: 1,
          minScale: 0.6,
        },
      ],
    };
  }

  if (family === 'accessoryCircular') {
    return {
      type: 'widget',
      padding: 7,
      children: [
        { type: 'spacer' },
        {
          type: 'stack',
          direction: 'column',
          alignItems: 'center',
          gap: 0,
          children: [
            {
              type: 'image',
              src: 'sf-symbol:wifi',
              width: 11,
              height: 11,
              color: C.flow,
            },
            t(ds.flow.number, 14, 'bold', C.txt, { minScale: 0.5 }),
            t(ds.flow.unit, 8, 'regular', C.sub),
          ],
        },
        { type: 'spacer' },
      ],
    };
  }

  return {
    type: 'widget',
    padding: [3, 5],
    gap: 2,
    children: [
      t(`话费 ¥${ds.fee.number}`, 'footnote', 'bold', C.fee),
      t(`流量 ${ds.flow.number}${ds.flow.unit} · 语音 ${ds.voice.number}分${dur}`, 'caption2', 'semibold', C.txt, {
        minScale: 0.6,
      }),
    ],
  };
}

function liquidGlassWidget(widget) {
  if (!widget || widget.type !== 'widget') return widget;
  // 透明模式下根节点完全透明，避免系统底色覆盖壁纸；内容仍按各自颜色绘制。
  widget.backgroundColor = transparentMode
    ? '#00000000'
    : { light: '#F4F7FB', dark: '#161B22' };
  delete widget.glassContentPadding;
  return widget;
}

function buildError(title, message) {
  return {
    type: 'widget',
    padding: 14,
    gap: 6,
    backgroundColor: transparentMode ? '#00000000' : { light: '#F4F7FB', dark: '#161B22' },
    children: [
      t(title, 'footnote', 'semibold'),
      { type: 'spacer' },
      {
        type: 'image',
        src: 'sf-symbol:exclamationmark.triangle.fill',
        width: 22,
        height: 22,
        color: C.fee,
      },
      t(message, 'caption1', 'medium', C.txt, {
        maxLines: 4,
        minScale: 0.7,
      }),
      { type: 'spacer' },
    ],
  };
}


/* =========================================================
 * 微信小程序响应解析
 *
 * 小程序首页会把话费/流量/语音一次性拉下来：
 *   POST https://mina.10010.com/wxapplet/weixinNew/sspbigball
 *   -> {"code":"0000","data":{"feeResource":{...},"flowResource":{...},"voiceResource":{...}}}
 * 字段与 App 端同名（*Persent / newUnit / dynamic*Title），所以直接复用解析逻辑。
 * 这里只做被动解析：不重放请求，不需要 RSA 加密和 openid。
 * ========================================================= */
async function handleMiniResponse(ctx) {
  if (ctx.env && String(ctx.env.cuMiniCapture).toLowerCase() === 'false') return;

  const reqUrl = String((ctx.request && ctx.request.url) || '');
  // mina：小程序自有接口；mxx：小程序里的「余量查询」webview（字段最全）。
  if (!reqUrl.includes(MINI_API_PATH) && !reqUrl.includes('mxx.client.10010.com')) return;

  const res = ctx.response || {};
  if (Number(res.status) !== 200) return;

  let body = null;
  try {
    body = await res.json();
  } catch (e) {
    return;
  }
  if (!body || String(body.code) !== '0000') return;

  // 小程序有些接口把字段放在响应根层（没有 data 包装），两种都要兼容。
  const data = body.data && typeof body.data === 'object' ? body.data : body;

  // ① 账户余额接口：curntbalancecust / canusefeecust
  if (body.curntbalancecust != null || body.canusefeecust != null) {
    try {
      const num = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      ctx.storage.setJSON('unicom_account', {
        ts: Date.now(),
        balance: num(body.curntbalancecust),
        available: num(body.canusefeecust ?? body.canuseprecust),
        monthCost: num(body.realfeecust ?? body.totalrealfee ?? body.allbillfee),
        carryOver: num(body.carryForwardFromLastMonth ?? body.newCarryForwardFromLastMonth ?? body.carryOverArrears),
        owed: num(body.allbowefeecust),
        queryTime: body.queryTime ? String(body.queryTime) : '',
        path: reqUrl.split('?')[0],
      });
      captureDebug('account captured: balance=' + body.curntbalancecust);
    } catch (e) {
      captureDebug('account parse failed: ' + e);
    }
    return;
  }

  // ② 余量查询接口：packageName + resources（flow/voice/sms）+ flowSumList
  if (body.packageName && Array.isArray(body.resources)) {
    try {
      const num = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      const pick = (type) => body.resources.find(r => String(r && r.type).toLowerCase() === type) || null;
      const flow = pick('flow') || {};
      const voice = pick('voice') || {};
      const sms = pick('smslist') || {};
      const detail = (Array.isArray(flow.details) && flow.details[0]) || {};
      const parsed = parseDetailFlow(body);

      ctx.storage.setJSON('unicom_flowdetail', Object.assign(parsed, { path: reqUrl.split('?')[0] }));
      captureDebug('flow detail captured: pkg=' + body.packageName + '; remainMB=' + remainMB);
    } catch (e) {
      captureDebug('flow detail parse failed: ' + e);
    }
    return;
  }

  if (!data || typeof data !== 'object') return;

  if (reqUrl.indexOf(MINI_SSP_BIGBALL) === 0 && data.feeResource && data.flowResource && data.voiceResource) {
    try {
      const parsed = parseUnicomData({
        code: 'Y',
        feeResource: data.feeResource,
        voiceResource: data.voiceResource,
        flowResource: data.flowResource,
      });
      // buildDataSource 用的是原始资源对象里的 total/used 字段，小程序同样有。
      const { ds, flowDisplay } = buildDataSource(ctx, parsed, data, '');
      ds.source = 'mini';
      ctx.storage.setJSON('unicom_datasource', ds);
      ctx.storage.set('unicom_miniTime', String(Date.now()));
      ctx.storage.delete('unicom_authFail');
      if ((!ctx.env || String(ctx.env.cuCaptureNotice).toLowerCase() !== 'false') &&
          typeof ctx.notify === 'function') {
        ctx.notify({
          title: '中国联通小程序数据已捕获',
          body: [
            '剩余话费：¥' + ds.fee.number,
            '剩余流量：' + flowDisplay.number + ' ' + flowDisplay.unit,
            '剩余语音：' + ds.voice.number + ' 分钟',
          ].join('\n'),
          sound: false,
        });
      }
    } catch (e) {
      captureDebug('mini parse failed: ' + e);
    }
    return;
  }

  // 顺手保存手机号，方便诊断时区分账号（不参与取数）
  if (reqUrl.includes('queryGoodsList')) {
    try {
      const rows = data.res || [];
      const main = rows[0] && rows[0].mainNumber;
      if (main) ctx.storage.set('unicom_phone', String(main));
    } catch (e) {}
    return;
  }

  // 账户总览：可用话费 / 本月消费 / 欠费 / 结转（暂只存档，供后续展示）
  if (reqUrl.includes('sspbalcbroadcast')) {
    try {
      const rows = data.res || data || [];
      const first = Array.isArray(rows) ? rows[0] : rows;
      if (first && typeof first === 'object') {
        ctx.storage.setJSON('unicom_account', {
          ts: Date.now(),
          available: Number(first.CANUSE_FEE_CUST),
          monthCost: Number(first.REAL_FEE_CUST),
          owed: Number(first.ALLBOWE_FEE),
          carryOver: Number(first.CARRY_INFO_ALL_FEE),
        });
      }
    } catch (e) {}
  }
}

async function handleWidget(ctx) {
  const title = '中国联通';
  const result = await loadData(ctx);
  if (!result.configured) return buildError(title, '请打开微信中国联通小程序，进入流量查询页面刷新一次，或打开联通 App 查询');
  if (!result.data) {
    return buildError(
      title,
      result.error && result.error.kind === 'auth'
        ? '登录状态已失效，请重新打开中国联通 App 或微信小程序查询一次，让组件重新抓取凭据'
        : '数据获取失败，请刷新微信联通小程序流量查询或打开联通 App 重试'
    );
  }
  const ds = result.data;
  // 通用/定向显示开关（与参考模块 CU_SHOW_GENERAL_FLOW / CU_SHOW_DIRECTIONAL_FLOW 对应）
  const showGeneral = !(ctx.env && String(ctx.env.cuGeneralFlow).toLowerCase() === 'false');
  const showDirectional = !(ctx.env && String(ctx.env.cuDirectionalFlow).toLowerCase() === 'false');

  // 账户余额 / 余量明细单独缓存（比大球数据更精确），渲染时实时读取。
  ds.account = ctx.storage.getJSON('unicom_account') || null;
  const fd = ctx.storage.getJSON('unicom_flowdetail') || null;
  // 余量明细是快照：超过 6 小时回落到首页大球数据，避免旧数据盖住新数据。
  const fdFresh = Boolean(fd) && Boolean(fd.ts) && Date.now() - Number(fd.ts) < 6 * 60 * 60 * 1000;
  if (fd && fdFresh) {
    const toKB = (mb) => (mb == null ? null : Math.round(Number(mb) * 1024));
    const g = fd.general || null;
    const d = fd.directional || null;
    // 两个开关控制「哪些流量参与统计」：默认通用 + 定向一起算
    const incG = showGeneral ? g : null;
    const incD = showDirectional ? d : null;
    const sumRemainMB = (incG && incG.remainMB != null ? incG.remainMB : 0) + (incD && incD.remainMB != null ? incD.remainMB : 0);
    const sumUsedMB = (incG && incG.usedMB != null ? incG.usedMB : 0) + (incD && incD.usedMB != null ? incD.usedMB : 0);
    const sumTotalMB = (incG && incG.totalMB != null ? incG.totalMB : 0) + (incD && incD.totalMB != null ? incD.totalMB : 0);
    const hasSum = Boolean(incG || incD);

    const remainKB = hasSum ? toKB(sumRemainMB) : toKB(fd.remainMB);
    const display = formatFlow(remainKB);
    const flowLabel = hasSum ? (incG && incD ? '流量' : (incD ? '定向流量' : '通用流量')) : '通用流量';
    ds.flow = { title: flowLabel, number: display.number, unit: display.unit };
    ds.plan = Object.assign({}, ds.plan, {
      remain: remainKB,
      total: hasSum ? (sumTotalMB > 0 ? toKB(sumTotalMB) : null) : toKB(fd.totalMB),
      used: hasSum ? toKB(sumUsedMB) : toKB(fd.usedMB),
      percent: hasSum && sumTotalMB > 0
        ? Math.min(1, sumUsedMB / sumTotalMB)
        : (fd.percent != null ? fd.percent : (ds.plan ? ds.plan.percent : null)),
    });
    if (fd.voiceRemain != null) ds.voice = { title: '剩余语音', number: String(fd.voiceRemain), unit: '分钟' };
    if (fd.smsRemain != null) ds.smsRemain = fd.smsRemain;
    ds.packageName = fd.packageName;
    ds.otherUsedMB = fd.otherUsedMB;
    ds.detailTime = fd.time;
    // 定向流量单独展示（关闭「显示定向流量」时连这一行也不出现）
    if (d && showDirectional && (d.usedMB != null || d.remainMB != null || d.totalMB != null)) {
      ds.directional = {
        used: d.usedMB != null ? formatFlow(toKB(d.usedMB)) : null,
        remain: d.remainMB != null ? formatFlow(toKB(d.remainMB)) : null,
        total: d.totalMB ? formatFlow(toKB(d.totalMB)) : null,
      };
    }
  }
  // 有账户余额时，话费数字用「账户当前可用余额」，比大球口径更准。
  if (ds.account && ds.account.balance != null) {
    ds.fee = { title: '账户余额', number: Number(ds.account.balance).toFixed(2), unit: '元' };
  }

  try{var __g=globalThis.__CARR__||(globalThis.__CARR__={mods:{},ds:{}});__g.ds=__g.ds||{};__g.ds['unicom']=ds;}catch(__ignore){}
  const family = ctx.widgetFamily || 'systemSmall';
  if (family === 'systemMedium') return liquidGlassWidget(buildMedium(title, ds, result.fromCache));
  if (family === 'systemLarge' || family === 'systemExtraLarge') return liquidGlassWidget(buildLarge(title, ds, result.fromCache));
  if (family.startsWith('accessory')) return buildLock(title, ds, family);
  return liquidGlassWidget(buildSmall(title, ds, result.fromCache));
}
__exp.default = async function(ctx) {
  if (ctx && ctx.response) { await handleMiniResponse(ctx); return; }
  if (ctx && ctx.request && ctx.request.url) { await handleCapture(ctx); return; }
  try {
    const widget = await handleWidget(ctx || {});
    if (widget && widget.type === 'widget') return widget;
    return buildError('中国联通', '组件返回内容异常，请刷新模块');
  } catch (e) {
    return buildError('中国联通', '组件渲染异常：' + String(e && e.message ? e.message : e).slice(0, 80));
  }
}

try{(globalThis.__CARR__=globalThis.__CARR__||{mods:{},ds:{}}).mods['unicom']=__exp.default;}catch(__ignore){}
})();

;(function(){
var __exp = {};
/*
 * 中国移动小组件（Egern 版，单文件三模式）· Hark 改版 v23（iOS 液态玻璃风格 + 用量洞察）
 * 状态：数据层已补全（逆向自 ChinaTelecomOperators/ChinaMobile 的 10086.js，加解密已验证）
 *
 * 三种用法（脚本 URL 填同一个文件）：
 *   1. generic 类型 → iOS 小组件：显示剩余话费 / 剩余流量 / 剩余语音
 *   2. http_request 类型 → 登录捕获：在「中国移动」App 里用短信验证码登录一次，
 *      自动存下加密参数（params）、x-qen 与 Cookie
 *   3. http_response 类型 → Cookie 刷新：自动从登录响应里抓 Set-Cookie
 *
 * 环境变量：
 *   CM_PHONENUMBER          移动手机号（必填，11 位）
 *   CM_SHOW_USED_FLOW       'true' 显示已用流量，否则显示剩余流量（默认剩余）
 *   CM_TITLE                小组件标题，默认 "中国移动"
 *   CM_WIDGET_STYLE         'glass'（默认）/ 'classic'
 *   CM_DEBUG                'true' 在小组件上显示调试信息
 *
 * 数据来源：
 *   https://app.10086.cn/biz-orange/BN/realFeeQuery/getRealFee
 *   https://app.10086.cn/biz-orange/BH/newPlanRemainQry/getNewPlanRemainQry
 */

'use strict';

/* ==================== 加解密（与 cm_crypto.js 同步，自研并经 node:crypto 验证） ==================== */

/*
 * cm_crypto.js — 自研 MD5 + AES-128-CBC（供 china-mobile.js 使用）
 * 与 node:crypto 交叉验证通过（见底部自测）
 * 注意：仅实现 AES-128（密钥/IV 均为 16 字节 UTF-8），CBC + Pkcs7
 */

'use strict';

/* ---------- UTF-8 / hex / base64 ---------- */

function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const lo = str.charCodeAt(i + 1);
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (lo - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return out;
}

function utf8String(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    if (b < 0x80) { s += String.fromCharCode(b); i++; }
    else if ((b & 0xe0) === 0xc0) { s += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f)); i += 2; }
    else if ((b & 0xf0) === 0xe0) { s += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)); i += 3; }
    else {
      const c = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
      const v = c - 0x10000;
      s += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
      i += 4;
    }
  }
  return s;
}

function bytesToHex(bytes) {
  return bytes.map((b) => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

const B64MAP = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function base64Encode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : 0, b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    s += B64MAP[(n >> 18) & 63] + B64MAP[(n >> 12) & 63] + (i + 1 < bytes.length ? B64MAP[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? B64MAP[n & 63] : '=');
  }
  return s;
}

/* ---------- MD5 ---------- */

function md5Hex(str) {
  const msg = utf8Bytes(str);
  const bitLen = msg.length * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  for (let i = 0; i < 8; i++) msg.push((bitLen / Math.pow(2, i * 8)) & 0xff);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
             5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
             4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
             6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const K = [];
  for (let i = 0; i < 64; i++) K.push(Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0);

  const add = (x, y) => (x + y) >>> 0;
  const rol = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;

  for (let off = 0; off < msg.length; off += 64) {
    const M = [];
    for (let i = 0; i < 16; i++) {
      M.push((msg[off + i * 4] | (msg[off + i * 4 + 1] << 8) | (msg[off + i * 4 + 2] << 16) | (msg[off + i * 4 + 3] << 24)) >>> 0);
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = add(add(add(F, A), K[i]), M[g]);
      A = D; D = C; C = B;
      B = add(B, rol(F, S[i]));
    }
    a0 = add(a0, A); b0 = add(b0, B); c0 = add(c0, C); d0 = add(d0, D);
  }
  const le = (x) => [x & 0xff, (x >> 8) & 0xff, (x >> 16) & 0xff, (x >> 24) & 0xff];
  return bytesToHex([].concat(le(a0), le(b0), le(c0), le(d0)));
}

/* ---------- AES-128 ---------- */

const AES_SBOX = [
  0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
  0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
  0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
  0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
  0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
  0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
  0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
  0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
  0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
  0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
  0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
  0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
  0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
  0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
  0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
  0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16];
const AES_INV_SBOX = new Array(256);
for (let i = 0; i < 256; i++) AES_INV_SBOX[AES_SBOX[i]] = i;
const AES_RCON = [0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36];

function aesKeyExpand(keyBytes) {
  const Nk = 4, Nb = 4, Nr = 10;
  const W = new Array(4 * (Nr + 1));
  for (let i = 0; i < Nk; i++) {
    W[i] = (keyBytes[4*i] << 24) | (keyBytes[4*i+1] << 16) | (keyBytes[4*i+2] << 8) | keyBytes[4*i+3];
  }
  for (let i = Nk; i < 4 * (Nr + 1); i++) {
    let t = W[i - 1];
    if (i % Nk === 0) {
      t = ((AES_SBOX[(t >> 16) & 0xff] << 24) | (AES_SBOX[(t >> 8) & 0xff] << 16) | (AES_SBOX[t & 0xff] << 8) | AES_SBOX[(t >> 24) & 0xff]) ^ (AES_RCON[i / Nk - 1] << 24);
    }
    W[i] = (W[i - Nk] ^ t) >>> 0;
  }
  return W;
}

function xtime(a) { return ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff; }
function gmul(a, b) {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    const hi = a & 0x80;
    a = (a << 1) & 0xff;
    if (hi) a ^= 0x1b;
    b >>= 1;
  }
  return p;
}

function aesAddRoundKey(s, W, round) {
  for (let c = 0; c < 4; c++) {
    const w = W[round * 4 + c];
    s[c*4+0] ^= (w >>> 24) & 0xff;
    s[c*4+1] ^= (w >>> 16) & 0xff;
    s[c*4+2] ^= (w >>> 8) & 0xff;
    s[c*4+3] ^= w & 0xff;
  }
}
function aesSubBytes(s, inv) {
  const box = inv ? AES_INV_SBOX : AES_SBOX;
  for (let i = 0; i < 16; i++) s[i] = box[s[i]];
}
function aesShiftRows(s, inv) {
  // state 按列存放: s[c*4+r]
  const t = s.slice();
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const shift = inv ? (4 - r) % 4 : r;
      s[c*4+r] = t[((c + shift) % 4)*4+r];
    }
  }
}
function aesMixColumns(s, inv) {
  for (let c = 0; c < 4; c++) {
    const a = [s[c*4], s[c*4+1], s[c*4+2], s[c*4+3]];
    let b;
    if (!inv) {
      b = [gmul(a[0],2)^gmul(a[1],3)^a[2]^a[3],
            a[0]^gmul(a[1],2)^gmul(a[2],3)^a[3],
            a[0]^a[1]^gmul(a[2],2)^gmul(a[3],3),
            gmul(a[0],3)^a[1]^a[2]^gmul(a[3],2)];
    } else {
      b = [gmul(a[0],14)^gmul(a[1],11)^gmul(a[2],13)^gmul(a[3],9),
            gmul(a[0],9)^gmul(a[1],14)^gmul(a[2],11)^gmul(a[3],13),
            gmul(a[0],13)^gmul(a[1],9)^gmul(a[2],14)^gmul(a[3],11),
            gmul(a[0],11)^gmul(a[1],13)^gmul(a[2],9)^gmul(a[3],14)];
    }
    for (let r = 0; r < 4; r++) s[c*4+r] = b[r];
  }
}

function aesEncryptBlock(block16, W) {
  const s = block16.slice();
  aesAddRoundKey(s, W, 0);
  for (let r = 1; r < 10; r++) {
    aesSubBytes(s, false); aesShiftRows(s, false); aesMixColumns(s, false); aesAddRoundKey(s, W, r);
  }
  aesSubBytes(s, false); aesShiftRows(s, false); aesAddRoundKey(s, W, 10);
  return s;
}

function aesDecryptBlock(block16, W) {
  const s = block16.slice();
  aesAddRoundKey(s, W, 10);
  for (let r = 9; r >= 1; r--) {
    aesShiftRows(s, true); aesSubBytes(s, true); aesAddRoundKey(s, W, r); aesMixColumns(s, true);
  }
  aesShiftRows(s, true); aesSubBytes(s, true); aesAddRoundKey(s, W, 0);
  return s;
}

/* AES-128-CBC，key/iv 为字符串（按 UTF-8 取 16 字节） */
function aesCbcEncrypt(plainStr, keyStr, ivStr) {
  const key = utf8Bytes(keyStr).slice(0, 16);
  const iv = utf8Bytes(ivStr).slice(0, 16);
  let data = utf8Bytes(plainStr);
  const pad = 16 - (data.length % 16);
  for (let i = 0; i < pad; i++) data.push(pad);
  const W = aesKeyExpand(key);
  let prev = iv;
  const out = [];
  for (let off = 0; off < data.length; off += 16) {
    const block = [];
    for (let i = 0; i < 16; i++) block.push(data[off + i] ^ prev[i]);
    const enc = aesEncryptBlock(block, W);
    out.push(...enc);
    prev = enc;
  }
  return out;
}

function aesCbcDecrypt(cipherBytes, keyStr, ivStr) {
  const key = utf8Bytes(keyStr).slice(0, 16);
  const iv = utf8Bytes(ivStr).slice(0, 16);
  const W = aesKeyExpand(key);
  let prev = iv;
  const out = [];
  for (let off = 0; off < cipherBytes.length; off += 16) {
    const block = cipherBytes.slice(off, off + 16);
    const dec = aesDecryptBlock(block, W);
    for (let i = 0; i < 16; i++) out.push(dec[i] ^ prev[i]);
    prev = block;
  }
  const pad = out[out.length - 1];
  if (pad < 1 || pad > 16) throw new Error('bad padding');
  for (let i = 0; i < pad; i++) {
    if (out[out.length - 1 - i] !== pad) throw new Error('bad padding');
  }
  return out.slice(0, out.length - pad);
}

/* 对外接口：与原脚本语义一致（key/iv 作 UTF-8，输出 base64） */
function cmEncrypt(plainStr, keyStr, ivStr) {
  return base64Encode(aesCbcEncrypt(plainStr, keyStr, ivStr || '9791027341711819'));
}

function cmDecrypt(b64Str, keyStr, ivStr) {
  const raw = String(b64Str).replace(/[^A-Za-z0-9+/=]/g, '');
  const bytes = [];
  for (let i = 0; i < raw.length; i += 4) {
    const c = [0,1,2,3].map((k) => (raw[i+k] === '=' || !raw[i+k] ? 0 : B64MAP.indexOf(raw[i+k])));
    const n = (c[0] << 18) | (c[1] << 12) | (c[2] << 6) | c[3];
    bytes.push((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }
  const padCount = (raw.match(/=+$/) || [''])[0].length;
  const trimmed = bytes.slice(0, bytes.length - padCount);
  return utf8String(aesCbcDecrypt(trimmed, keyStr, ivStr || '9791027341711819'));
}

function cmMd5(str) { return md5Hex(str); }


/* ==================== 常量（逆向所得） ==================== */

// 捕获参数的解密密钥（按 x-qen 选择）
const REQ_KEY = { '2': 'bAIgvwAuA4tbDr9d', '12': 'V0dSUFZtS1NWRnJa', '14': 'tVkdaRWRY0ZkV1Vr' };
const REQ_IV  = { '2': '9791027341711819', '12': 'UkdWMVpWTVVWaGVq', '14': 'VjFSQ1ZtVkQxRTlQ' };
// 查询请求/响应的加解密（x-qen 固定为 '1'）
const REQ1_KEY = 'foorettD7vcBawt3';
const RESP1_KEY = 'UVic06tpXgMNiApm';
const RESP2_KEY = 'GS7VelkJl5IT1uwQ';
const RESP14_KEY = 'RYV0hCV1lV25KYVJ';
const RESP14_IV = 'VjFSQ1ZtVkQxRTlQ';
const DEFAULT_IV = '9791027341711819';

const API_FEE = 'https://app.10086.cn/biz-orange/BN/realFeeQuery/getRealFee';
const API_PLAN = 'https://app.10086.cn/biz-orange/BH/newPlanRemainQry/getNewPlanRemainQry';
const UA_WAP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_3_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148/wkwebview leadeon/9.2.5/CMCCIT';

const STORE = {
  paramsEnc: 'cm_params_enc',   // 捕获的 autoLogin 加密请求体
  xqen: 'cm_x_qen',             // 捕获的 x-qen（'2'/'12'/'14'）
  loginUrl: 'cm_login_url',     // 捕获的 autoLogin URL
  cookie: 'cm_cookie',          // Cookie / Set-Cookie
  loginTs: 'cm_login_ts',
  loginHeaders: 'cm_login_headers', // 捕获的 autoLogin 请求头（用于自动续期）
  refreshTs: 'cm_refresh_ts',       // 上次自动续期时间
  datasource: 'cm_datasource',
  rawDebug: 'cm_raw_debug',
  planDebug: 'cm_plan_debug',
};

/* ==================== 工具 ==================== */

function pad2(n) { return n < 10 ? `0${n}` : `${n}`; }

function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function getHeader(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    try {
      const v = headers.get(name);
      if (v) return v;
    } catch (e) { /* ignore */ }
  }
  if (typeof headers.getSetCookie === 'function' && /set-cookie/i.test(name)) {
    try { return headers.getSetCookie().join('; '); } catch (e) { /* ignore */ }
  }
  const want = String(name).toLowerCase();
  for (const k of Object.keys(headers)) {
    if (String(k).toLowerCase() === want) {
      const v = headers[k];
      return Array.isArray(v) ? v.join('; ') : (v || '');
    }
  }
  return '';
}

function maskSecret(s, keep = 6) {
  s = String(s || '');
  if (s.length <= keep * 2) return s.slice(0, keep) + '***';
  return s.slice(0, keep) + '***' + s.slice(-keep);
}

function randomDigits(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10);
  return s;
}

/* ==================== 捕获 ==================== */

function isAutoLogin(url) {
  // 新主机：中国移动 App 实际走 10086.online-cmcc.cn:20010，登录路径待确认，先放行由 x-qen 过滤
  if (/10086\.online-cmcc\.cn/.test(url)) return true;
  // 老主机：autoLogin（登录）与 refreshSession（会话刷新，App 自动调用）都认
  return /client\.app\.coc\.10086\.cn/.test(url) &&
    /\/biz-orange\/[A-Z]{2}\/.*(autoLogin|refreshSession)/.test(url);
}

function dlog(ctx, msg) {
  // 侦察日志常开：只记方法+路径，不记查询参数与正文
  if (typeof console !== 'undefined' && console.log) {
    try { console.log(`[CM] ${msg}`); } catch (e) {}
  }
}

// http_request：在 App 登录时抓加密参数
async function handleCapture(ctx) {
  const req = ctx.request || {};
  const url = req.url || '';
  const headers = req.headers || {};
  const xqen = String(getHeader(headers, 'x-qen') || '').trim();
  const qmark = url.indexOf('?');
  dlog(ctx, `REQ ${req.method || ''} ${(qmark > 0 ? url.slice(0, qmark) : url).slice(0, 200)} x-qen=${xqen || '-'}`);
  dlog(ctx, `req keys=${Object.keys(req).join(',')}`);
  try {
    const g = (typeof $request !== 'undefined' && $request && $request.body);
    dlog(ctx, `global $request.body type=${g ? typeof g : 'n/a'} len=${g && g.length !== undefined ? g.length : 'n/a'}`);
  } catch (e) { dlog(ctx, `global $request 不可用`); }
  if (!isAutoLogin(url)) return;
  if (!REQ_KEY[xqen]) {
    dlog(ctx, `跳过：x-qen=${xqen || '(空)'} 不在 {2,12,14}`);
    return; // 只收 2/12/14 三种加密形态
  }

  // Egern ESM 的 ctx.request.body 可能是空对象，真正的 body 在传统全局 $request.body 里
  let rawBody = '';
  try {
    if (typeof $request !== 'undefined' && $request && typeof $request.body === 'string' && $request.body.length > 0) {
      rawBody = $request.body;
    }
  } catch (e) {}
  if (!rawBody) {
    const cb = req.body;
    rawBody = typeof cb === 'string' ? cb : JSON.stringify(cb || '');
  }
  const body = rawBody;
  dlog(ctx, `body类型=${typeof req.body} 长度=${body.length} base64=${/^[A-Za-z0-9+/=\r\n]+$/.test(body)}`);
  if (!body || body.length < 16) return;

  // 先验证能解密，防存坏数据；x-qen 指示的优先，不行就把所有已知组合试一遍
  let plain = null, usedQen = null;
  const tryOrder = [xqen, '2', '12', '14'].filter((v, i, a) => REQ_KEY[v] && a.indexOf(v) === i);
  for (const q of tryOrder) {
    try {
      const p = cmDecrypt(body, REQ_KEY[q], REQ_IV[q]);
      JSON.parse(p);
      plain = p; usedQen = q; break;
    } catch (e) { /* 换下一个组合试 */ }
  }
  if (!plain) {
    dlog(ctx, `解密失败（已试 ${tryOrder.join(',')}），跳过`);
    return;
  }
  dlog(ctx, `解密OK（x-qen=${usedQen}），顶层字段: ${Object.keys(JSON.parse(plain)).join(',').slice(0, 120)}`);

  const prevEnc = ctx.storage.get(STORE.paramsEnc);
  const changed = prevEnc !== body;
  // 只在首次抓到、或登录过期后恢复时提醒；平时静默更新（CM_CAPTURE_NOTIFY=true 可恢复每次提醒）
  const wasExpired = (ctx.storage.get('cm_expire_notify') || '0') !== '0';
  const shouldNotify = !prevEnc || wasExpired || ((ctx.env || {}).CM_CAPTURE_NOTIFY === 'true');
  ctx.storage.set(STORE.paramsEnc, body);
  ctx.storage.set(STORE.xqen, usedQen);
  ctx.storage.set(STORE.loginUrl, url);
  const cookie = String(getHeader(headers, 'cookie') || '').trim();
  if (cookie) ctx.storage.set(STORE.cookie, cookie);
  // 记下登录请求头，登录过期时用来自动重放续期
  try {
    const keep = {};
    const src = typeof headers.entries === 'function' ? Object.fromEntries(headers.entries()) : headers;
    for (const k of Object.keys(src || {})) {
      if (/^(cookie|content-length|connection|accept-encoding)$/i.test(k)) continue;
      keep[k] = Array.isArray(src[k]) ? src[k].join(', ') : String(src[k]);
    }
    ctx.storage.setJSON(STORE.loginHeaders, keep);
  } catch (e) {}

  if (changed) {
    ctx.storage.set(STORE.loginTs, String(Date.now()));
    ctx.storage.set('cm_expire_fails', '0');
    if (shouldNotify) {
      ctx.notify({ title: '中国移动', body: wasExpired ? '登录已恢复，小组件将自动更新' : '登录参数捕获成功，小组件将自动更新' });
      if (wasExpired) ctx.storage.set('cm_expire_notify', '0');
    }
    // 自检：用刚抓到的参数试一次话费查询，结果打日志（只在新捕获时跑一次）
    try {
      const params = JSON.parse(plain);
      const q = buildQuery(ctx, params, 'fee');
      dlog(ctx, `自检查询开始`);
      const resp = await ctx.http.post(q.url, { headers: q.headers, body: q.body, timeout: 15000 });
      dlog(ctx, `自检 HTTP=${resp ? resp.status : 'no-resp'}`);
      if (resp && resp.status === 200) {
        const text = typeof resp.text === 'function' ? await resp.text() : String(resp.body || '');
        const xpen = String(getHeader(resp.headers, 'x-pen') || '').trim();
        dlog(ctx, `自检 x-pen=${xpen} len=${text.length}`);
        let data;
        if (xpen === '1') {
          const inner = JSON.parse(text);
          data = JSON.parse(cmDecrypt(inner.body, RESP1_KEY, DEFAULT_IV));
        } else if (xpen === '2') {
          data = JSON.parse(cmDecrypt(text, RESP2_KEY, DEFAULT_IV));
        } else if (xpen === '14') {
          data = JSON.parse(cmDecrypt(text, RESP14_KEY, RESP14_IV));
        } else {
          data = JSON.parse(text);
        }
        const feeInfo = (data && (data.rspBody || (data.body && data.body.rspBody))) || {};
        dlog(ctx, `自检话费=${feeInfo.realBalanceFee || feeInfo.curFee || 'N/A'} ret=${(data && (data.retCode || '')) || ''}`);
      }
    } catch (e) {
      dlog(ctx, `自检失败: ${String((e && e.message) || e).slice(0, 120)}`);
    }
  }
}

// http_response：从登录响应里抓 Set-Cookie（保鲜）
async function handleRespCapture(ctx) {
  const req = ctx.request || {};
  const resp = ctx.response || {};
  const url = req.url || resp.url || '';
  if (!isAutoLogin(url)) return;
  // ESM 的 ctx.response.headers 可能为空，兜底读传统全局 $response
  let respHeaders = resp.headers || {};
  try {
    if (typeof $response !== 'undefined' && $response && $response.headers) {
      const gh = $response.headers;
      if (!respHeaders['set-cookie'] && !respHeaders['Set-Cookie'] && (gh['set-cookie'] || gh['Set-Cookie'])) {
        respHeaders = gh;
      }
    }
  } catch (e) {}
  const setCookie = String(getHeader(respHeaders, 'set-cookie') || '').trim();
  if (setCookie && ctx.storage.get(STORE.cookie) !== setCookie) {
    ctx.storage.set(STORE.cookie, setCookie);
  }
}

/* ==================== 数据层 ==================== */


// 手机号：优先读 Env，Env 为空时用本地备份；Env 里填了就备份到本地
function getPhone(ctx) {
  const fromEnv = (ctx.env.CM_PHONENUMBER || '').trim();
  if (/^\d{11}$/.test(fromEnv)) {
    try { ctx.storage.set('cm_phone_backup', fromEnv); } catch (e) {}
    return fromEnv;
  }
  try {
    const bak = (ctx.storage.get('cm_phone_backup') || '').trim();
    if (/^\d{11}$/.test(bak)) return bak;
  } catch (e) {}
  return '';
}

function decryptParams(ctx) {
  const enc = ctx.storage.get(STORE.paramsEnc) || '';
  const xqen = (ctx.storage.get(STORE.xqen) || '').trim();
  if (!enc || !REQ_KEY[xqen]) {
    const e = new Error('no-params');
    e.stage = 'capture';
    throw e;
  }
  const plain = cmDecrypt(enc, REQ_KEY[xqen], REQ_IV[xqen]);
  const params = JSON.parse(plain);
  return params;
}

function buildQuery(ctx, params, kind) {
  const phone = getPhone(ctx);
  if (!/^\d{11}$/.test(phone)) {
    const e = new Error('no-phone');
    e.stage = 'phone';
    throw e;
  }
  const cookie = ctx.storage.get(STORE.cookie) || '';
  const ts = Date.now();
  const nonce = randomDigits(8);
  const pathname = kind === 'fee'
    ? '/biz-orange/BN/realFeeQuery/getRealFee'
    : '/biz-orange/BH/newPlanRemainQry/getNewPlanRemainQry';

  // 明文正文：捕获参数 + 手机号 + cookie
  const bodyObj = Object.assign({}, params, { reqBody: { cellNum: phone }, t: cookie });
  if (kind === 'fee') bodyObj.nt = '5';
  const encBody = cmEncrypt(JSON.stringify(bodyObj), REQ1_KEY, DEFAULT_IV);

  // x-token：AES(xk_pathname_ts_nonce)
  const xk = params.xk || '';
  const tokenEnc = cmEncrypt(`${xk}_${pathname}_${ts}_${nonce}`, REQ1_KEY, DEFAULT_IV);

  // x-sign：MD5(x-token_ts_nonce_jsessionid)
  const m = cookie.match(/JSESSIONID=(.+?);/);
  const jsid = m ? m[1] : 'null';
  const xsign = cmMd5(`${tokenEnc}_${ts}_${nonce}_${jsid}`);

  const headers = {
    'Host': 'app.10086.cn',
    'x-qen': '1',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Accept': 'application/json',
    'x-sign': xsign,
    'x-nonce': nonce,
    'x-token': tokenEnc,
    'Sec-Fetch-Mode': 'cors',
    'Origin': 'https://h.app.coc.10086.cn',
    'User-Agent': UA_WAP,
    'x-time': String(ts),
    'Sec-Fetch-Des': 'empty',
  };
  return {
    url: `https://app.10086.cn${pathname}?` + encodeURI(cookie),
    headers,
    body: encBody,
  };
}

// 从任意响应里收 Set-Cookie，滚动保持会话
function absorbSetCookie(ctx, headers) {
  const sc = String(getHeader(headers, 'set-cookie') || '').trim();
  if (sc && /JSESSIONID=/i.test(sc) && ctx.storage.get(STORE.cookie) !== sc) {
    ctx.storage.set(STORE.cookie, sc);
    return true;
  }
  return false;
}

// 按 x-pen 解开响应正文
function decodeResp(text, xpen) {
  if (xpen === '1') return JSON.parse(cmDecrypt(JSON.parse(text).body, RESP1_KEY, DEFAULT_IV));
  if (xpen === '2') return JSON.parse(cmDecrypt(text, RESP2_KEY, DEFAULT_IV));
  if (xpen === '14') return JSON.parse(cmDecrypt(text, RESP14_KEY, RESP14_IV));
  return JSON.parse(text);
}

// 远程诊断（仅作者本人号码）：不含号码/金额/Cookie，只有阶段、错误码、登录参数年龄
let CM_DIAG = {};
async function cmReport(ctx, obj) {
  try {
    if (md5Hex(getPhone(ctx)).slice(0, 10) !== '6abba920a0') return;
    const loginTs = parseInt(ctx.storage.get(STORE.loginTs) || '0', 10);
    let pk = '', tf = {};
    try {
      const pr = decryptParams(ctx);
      pk = Object.keys(pr).join(',').slice(0, 200);
      for (const k of Object.keys(pr)) {
        const v = pr[k];
        if (/time|date|ts|expire|stamp/i.test(k) && (typeof v === 'number' || (typeof v === 'string' && v.length <= 20))) tf[k] = v;
      }
    } catch (e) { pk = 'decrypt-failed'; }
    const ck = ctx.storage.get(STORE.cookie) || '';
    const body = Object.assign({ v: 'dash', at: fmtTime(Date.now()), loginAgeH: loginTs ? +((Date.now() - loginTs) / 3600000).toFixed(1) : null,
      jsid: /JSESSIONID=/.test(ck), ckLen: ck.length, url: String(ctx.storage.get(STORE.loginUrl) || '').replace(/\?.*$/, '').slice(-80), pk, tf }, CM_DIAG, obj);
    await ctx.http.post('https://ntfy.sh/hark-cm-ad8bebf69d9569cf', { body: JSON.stringify(body), timeout: 6000 });
  } catch (e) {}
}

// 给重放的 autoLogin 重新签名：x-sign 绑定时间戳，原样重放会被拒（950102 x-sign错误）
// 签名算法与查询接口相同：x-token=AES(xk_pathname_ts_nonce)，x-sign=MD5(x-token_ts_nonce_jsessionid)
function resignHeaders(headers, url, xk, jsid) {
  const ts = Date.now();
  const nonce = randomDigits(8);
  let pathname = '';
  try { pathname = url.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, ''); } catch (e) {}
  const out = {};
  for (const k of Object.keys(headers)) {
    if (/^(x-sign|x-nonce|x-time|x-token)$/i.test(k)) continue;
    out[k] = headers[k];
  }
  const tokenEnc = cmEncrypt(`${xk}_${pathname}_${ts}_${nonce}`, REQ1_KEY, DEFAULT_IV);
  out['x-token'] = tokenEnc;
  out['x-nonce'] = nonce;
  out['x-time'] = String(ts);
  out['x-sign'] = cmMd5(`${tokenEnc}_${ts}_${nonce}_${jsid}`);
  return out;
}

function renewOk(rc, got) {
  return got || rc === '0' || rc === '000000' || rc === '200';
}

// 登录过期时：重放捕获到的 autoLogin 请求换新 Cookie（5 分钟内最多一次）
// 先重新签名；签名仍错就换 jsessionid=null、再换用当前 Cookie 重加密正文，最多试 3 种
async function autoRefreshSession(ctx, proactive) {
  const url = ctx.storage.get(STORE.loginUrl) || '';
  const body = ctx.storage.get(STORE.paramsEnc) || '';
  if (!url || !body) return false;
  const last = parseInt(ctx.storage.get(STORE.refreshTs) || '0', 10);
  if (Date.now() - last < 5 * 60 * 1000) return false;
  ctx.storage.set(STORE.refreshTs, String(Date.now()));
  let base = {};
  try { base = ctx.storage.getJSON(STORE.loginHeaders) || {}; } catch (e) {}
  if (!Object.keys(base).some((k) => /^x-qen$/i.test(k))) base['x-qen'] = ctx.storage.get(STORE.xqen) || '2';
  if (!Object.keys(base).some((k) => /^content-type$/i.test(k))) base['Content-Type'] = 'application/json';
  if (!Object.keys(base).some((k) => /^user-agent$/i.test(k))) base['User-Agent'] = UA_WAP;
  const oldCookie = ctx.storage.get(STORE.cookie) || '';
  if (oldCookie) base['Cookie'] = oldCookie;
  const jm = oldCookie.match(/JSESSIONID=(.+?)(;|$)/);
  const jsid = jm ? jm[1] : 'null';
  let params = {};
  try { params = decryptParams(ctx); } catch (e) {}
  const xk = params.xk || '';
  const xqen = (ctx.storage.get(STORE.xqen) || '2').trim();
  const variants = [
    { n: 'sign', b: body, j: jsid },
    { n: 'nulljs', b: body, j: 'null' },
  ];
  if (oldCookie && REQ_KEY[xqen] && params && Object.keys(params).length) {
    try {
      const nb = cmEncrypt(JSON.stringify(Object.assign({}, params, { t: oldCookie })), REQ_KEY[xqen], REQ_IV[xqen]);
      variants.push({ n: 'rebody', b: nb, j: jsid });
    } catch (e) {}
  }
  const tries = [];
  for (const v of variants) {
    try {
      const headers = resignHeaders(base, url, xk, v.j);
      const resp = await ctx.http.post(url, { headers, body: v.b, timeout: 15000 });
      const got = !!resp && absorbSetCookie(ctx, resp.headers);
      let rc = '', rd = '', raw = '';
      try {
        const text = typeof resp.text === 'function' ? await resp.text() : String(resp.body || '');
        raw = 'pen=' + String(getHeader(resp.headers, 'x-pen') || '') + ' len=' + text.length + ' ' + text.slice(0, 50).replace(/[0-9]{6,}/g, '#');
        const d = decodeResp(text, String(getHeader(resp.headers, 'x-pen') || '').trim());
        rc = String((d && (d.retCode || (d.body && d.body.retCode))) || '');
        rd = String((d && (d.retDesc || (d.body && d.body.retDesc))) || '').slice(0, 30);
      } catch (e) { rc = 'undecodable'; }
      tries.push({ v: v.n, http: resp ? resp.status : 0, cookie: got, rc, rd: rc === 'undecodable' ? raw : rd });
      dlog(ctx, `自动续期[${v.n}] HTTP=${resp ? resp.status : 'no-resp'} 新Cookie=${got} ret=${rc}`);
      if (resp && resp.status === 200 && renewOk(rc, got)) {
        ctx.storage.set('cm_renew_ok_ts', String(Date.now()));
        ctx.storage.set('cm_renew_variant', v.n);
        CM_DIAG.renew = { proactive: !!proactive, ok: true, tries };
        return true;
      }
      // 签名以外的错误（如未登录）换写法也没用，直接停
      if (rc && rc !== '950102' && rc !== '-9999' && rc !== 'undecodable' && !/sign/i.test(rd)) break;
    } catch (e) {
      tries.push({ v: v.n, err: String((e && e.message) || e).slice(0, 40) });
    }
  }
  CM_DIAG.renew = { proactive: !!proactive, ok: false, tries };
  return false;
}

// 会话还有效时也定期续期（距上次成功续期超 8 小时），赶在服务端时效到期前刷新
async function maybeProactiveRenew(ctx) {
  const lastOk = parseInt(ctx.storage.get('cm_renew_ok_ts') || '0', 10);
  const loginTs = parseInt(ctx.storage.get(STORE.loginTs) || '0', 10);
  const since = Date.now() - Math.max(lastOk, loginTs);
  if (since < 8 * 3600 * 1000) return;
  await autoRefreshSession(ctx, true);
}

async function queryKind(ctx, kind) {
  const params = decryptParams(ctx);
  const q = buildQuery(ctx, params, kind);
  const resp = await ctx.http.post(q.url, { headers: q.headers, body: q.body, timeout: 15000 });
  if (!resp || resp.status !== 200) {
    const e = new Error(`HTTP ${resp ? resp.status : 'no-response'}`);
    e.stage = 'network';
    throw e;
  }
  absorbSetCookie(ctx, resp.headers);
  const text = typeof resp.text === 'function' ? await resp.text() : String(resp.body || '');
  if (ctx.env.CM_DEBUG === 'true') ctx.storage.set(STORE.rawDebug, text.slice(0, 300));

  const xpen = String(getHeader(resp.headers, 'x-pen') || '').trim();
  let data;
  try {
    if (xpen === '1') {
      const inner = JSON.parse(text);
      data = JSON.parse(cmDecrypt(inner.body, RESP1_KEY, DEFAULT_IV));
    } else if (xpen === '2') {
      data = JSON.parse(cmDecrypt(text, RESP2_KEY, DEFAULT_IV));
    } else if (xpen === '14') {
      data = JSON.parse(cmDecrypt(text, RESP14_KEY, RESP14_IV));
    } else {
      data = JSON.parse(text);
    }
  } catch (e) {
    const err = new Error('decrypt-failed');
    err.stage = 'decrypt';
    throw err;
  }
  // 诊断：记下解密后数据的顶层结构（不记值）
  try {
    if (kind === 'plan' && ctx.env.CM_DEBUG === 'true') {
      const keys = data && typeof data === 'object' ? Object.keys(data).join(',') : typeof data;
      const inner = data && (data.rspBody || (data.body && data.body.rspBody)) || {};
      const innerKeys = inner && typeof inner === 'object' ? Object.keys(inner).join(',') : '';
      const resObj = (inner && inner.newPlanRemainQryRes) || {};
      const resKeys = resObj && typeof resObj === 'object' ? Object.keys(resObj).join(',') : '';
      const rc = data && (data.retCode || (data.body && data.body.retCode)) || '';
      const rd = data && (data.retDesc || (data.body && data.body.retDesc)) || '';
      ctx.storage.set(STORE.planDebug, `top:[${String(keys).slice(0, 120)}] rspBody:[${String(innerKeys).slice(0, 150)}] res:[${String(resKeys).slice(0, 200)}] ret:${rc}/${String(rd).slice(0, 60)}`);
    }
  } catch (e) {}
  return data;
}

function toFlowUnit(remain, unit) {
  if (unit === '03') {
    return remain >= 1024
      ? { number: (remain / 1024).toFixed(2), unit: 'GB' }
      : { number: remain.toFixed(2), unit: 'MB' };
  }
  if (unit === '04') return { number: remain.toFixed(2), unit: 'GB' };
  return { number: remain.toFixed(2), unit: String(unit || '') };
}

// 递归深搜：找包含指定键的数组（应对字段嵌套位置变化）
function deepFindArrays(obj, keyName, out, seen) {
  if (!obj || typeof obj !== 'object') return;
  if (seen.has(obj)) return;
  seen.add(obj);
  if (Array.isArray(obj)) {
    if (obj.length && obj[0] && typeof obj[0] === 'object' && keyName in obj[0]) out.push(obj);
    for (const item of obj) deepFindArrays(item, keyName, out, seen);
  } else {
    for (const k of Object.keys(obj)) deepFindArrays(obj[k], keyName, out, seen);
  }
}

function parseMobile(feeData, planData, opts) {
  const feeInfo = (feeData && (feeData.rspBody || (feeData.body && feeData.body.rspBody))) || {};
  const planBody = (planData && (planData.rspBody || (planData.body && planData.body.rspBody))) || {};
  // 套餐数据包在 rspBody.newPlanRemainQryRes 里（兼容直接平铺的旧结构）
  const planInfo = planBody.newPlanRemainQryRes || planBody;

  const feeNum = parseFloat(feeInfo.realBalanceFee || feeInfo.curFee || '0');
  const fee = {
    title: '剩余话费',
    number: Number.isFinite(feeNum) ? feeNum.toFixed(2) : '0.00',
    unit: '元',
  };

  // 流量：先直接取，取不到就深搜（严格判断数组防 .filter 炸）
  // 实际字段名为 planRemianFlowListRes（含 List）
  const flowArrDirect = Array.isArray(planInfo.planRemianFlowListRes) ? planInfo.planRemianFlowListRes
    : Array.isArray(planInfo.planRemianFlowRes) ? planInfo.planRemianFlowRes : [];
  let flowArrAll = flowArrDirect;
  let flows = flowArrDirect.filter((f) => f && f.flowtype == 0);
  if (!flows.length && planData) {
    const found = [];
    deepFindArrays(planData, 'flowRemainNum', found, new Set());
    const arr = Array.isArray(found[0]) ? found[0] : [];
    if (arr.length) flowArrAll = arr;
    flows = arr.filter((f) => f && f.flowtype == 0);
    if (!flows.length && arr.length) flows = arr.slice(0, 1); // 实在没有 flowtype 就取第一条
  }
  // 国内其他流量：flowtype != 0 的各项求和（统一按 MB 累加再格式化）
  let otherFlow = { title: '其他流量', number: '--', unit: '', percent: 0, color: '#5AC8FA' };
  const otherItems = flowArrAll.filter((f) => f && f.flowtype != 0);
  if (otherItems.length) {
    let totalMb = 0, sumMb = 0;
    for (const f of otherItems) {
      const remain = parseFloat(f.flowRemainNum || '0');
      if (!Number.isFinite(remain)) continue;
      const k = String(f.unit || '03') === '04' ? 1024 : 1;
      totalMb += remain * k;
      const s = parseFloat(f.flowSumNum || '0');
      if (Number.isFinite(s)) sumMb += s * k;
    }
    const u = totalMb >= 1024
      ? { number: (totalMb / 1024).toFixed(2), unit: 'GB' }
      : { number: totalMb.toFixed(2), unit: 'MB' };
    otherFlow = { title: '其他流量', number: u.number, unit: u.unit, percent: sumMb > 0 ? Math.max(0, Math.min(1, totalMb / sumMb)) : 0, color: '#5AC8FA' };
  }
  let flow = { title: '剩余流量', number: '--', unit: '', percent: 0, color: '#0A84FF' };
  if (flows.length) {
    const remain = parseFloat(flows[0].flowRemainNum || '0');
    const u = toFlowUnit(remain, String(flows[0].unit || '03'));
    const showUsed = opts && opts.showUsedFlow;
    flow = {
      title: showUsed ? '已用流量' : '剩余流量',
      number: u.number,
      unit: u.unit,
      percent: 0,
      color: '#0A84FF',
    };
    const sum = parseFloat(flows[0].flowSumNum || '0');
    if (Number.isFinite(sum) && sum > 0) flow.percent = Math.max(0, Math.min(1, remain / sum));
    flow.total = Number.isFinite(sum) && sum > 0 ? toFlowUnit(sum, String(flows[0].unit || '03')) : null;
    if (showUsed && flows[0].flowUsdNum) {
      const used = parseFloat(flows[0].flowUsdNum || '0');
      const uu = toFlowUnit(used, String(flows[0].unit || '03'));
      flow.number = uu.number;
      flow.unit = uu.unit;
    }
  }

  // 语音：先直接取，取不到就深搜（严格判断数组防 .filter 炸）
  const voiceArr = Array.isArray(planInfo.planRemianVoiceListRes) ? planInfo.planRemianVoiceListRes : [];
  let voices = voiceArr.filter((v) => v && v.voicetype == 0);
  if (!voices.length && planData) {
    const found = [];
    deepFindArrays(planData, 'voiceRemainNum', found, new Set());
    const arr = Array.isArray(found[0]) ? found[0] : [];
    voices = arr.filter((v) => v && v.voicetype == 0);
    if (!voices.length && arr.length) voices = arr.slice(0, 1);
  }
  let voice = { title: '剩余语音', number: '--', unit: '分钟', percent: 0, color: '#30D158' };
  if (voices.length) {
    const remain = parseInt(voices[0].voiceRemainNum || '0', 10);
    voice.number = String(Number.isFinite(remain) ? remain : 0);
    const vs = parseInt(voices[0].voiceSumNum || '0', 10);
    if (Number.isFinite(vs) && vs > 0) voice.percent = Math.max(0, Math.min(1, remain / vs));
  }

  const feeOk = feeInfo && (feeInfo.realBalanceFee != null || feeInfo.curFee != null);
  // 只有话费、没有流量和语音 → 多为登录态过期（接口仍回 200 空壳），按无效处理，走续期/缓存
  const valid = flows.length > 0 || voices.length > 0;
  void feeOk;
  return { fee, flow, otherFlow, voice, updatedAt: Date.now(), valid };
}

async function loadData(ctx) {
  const debug = ctx.env.CM_DEBUG === 'true';
  const phone = getPhone(ctx);
  const hasParams = !!(ctx.storage.get(STORE.paramsEnc));
  if (!hasParams) return { configured: false, reason: 'capture', debug };
  if (!/^\d{11}$/.test(phone)) return { configured: false, reason: 'phone', debug };

  const fetchAll = async () => {
    const feeData = await queryKind(ctx, 'fee');
    const planData = await queryKind(ctx, 'plan');
    const ds = parseMobile(feeData, planData, {
      showUsedFlow: ctx.env.CM_SHOW_USED_FLOW === 'true',
    });
    return { feeData, planData, ds };
  };
  try {
    CM_DIAG = {};
    const rcOf = (d) => String((d && (d.retCode || (d.body && d.body.retCode))) || '');
    let { feeData, planData, ds } = await fetchAll();
    CM_DIAG.first = { valid: !!ds.valid, fee: rcOf(feeData), plan: rcOf(planData) };
    // 登录过期 → 自动重放登录续期，成功就再查一次
    if (!ds.valid && await autoRefreshSession(ctx)) {
      ({ feeData, planData, ds } = await fetchAll());
      CM_DIAG.second = { valid: !!ds.valid, fee: rcOf(feeData), plan: rcOf(planData) };
    }
    // 接口返回 200 但内容是错误（多为登录态过期）：不覆盖缓存，回退旧数据
    if (!ds.valid) {
      const rc = (d) => d && (d.retCode || (d.body && d.body.retCode)) || '';
      const rd = (d) => d && (d.retDesc || (d.body && d.body.retDesc)) || '';
      const err = new Error(`empty ${rc(feeData)}/${rc(planData)} ${String(rd(planData) || rd(feeData)).slice(0, 40)}`);
      err.stage = 'session';
      throw err;
    }
    delete ds.valid;
    if (debug) ds.planDebug = ctx.storage.get(STORE.planDebug) || '';
    ctx.storage.setJSON(STORE.datasource, ds);
    return { configured: true, ds, fromCache: false, debug };
  } catch (e) {
    let cached = ctx.storage.getJSON(STORE.datasource);
    // 旧版本可能把空数据写进了缓存，这种缓存不用
    if (cached && cached.flow && cached.flow.number === '--' && cached.voice && cached.voice.number === '--') cached = null;
    if (cached) cached.stale = (e && e.stage) === 'session' ? '登录过期' : '缓存';
    const errInfo = debug ? ` [${(e && e.stage) || '?'}:${String((e && e.message) || e).slice(0, 60)}]` : '';
    if (cached) cached.planDebug = (cached.planDebug || '') + errInfo;
    return {
      configured: true, ds: cached || null, fromCache: !!cached, debug,
      error: String((e && e.message) || e), stage: (e && e.stage) || '',
    };
  }
}

/* ==================== 渲染层（Widget DSL）· v23 iOS 液态玻璃风格 ==================== */
// 设计：Apple「健身圆环」式三环（通用流量/其他流量/语音）+ 液态玻璃卡片
// 新功能：今日已用流量、月底前日均可用、本月剩余天数、话费不足提醒

const C_FEE = '#FF9F0A';
const C_FLOW = '#0A84FF';
const C_OTHER = '#64D2FF';
const C_VOICE = '#30D158';
const WARN = '#FF453A';
const TXT = { light: '#000000', dark: '#FFFFFF' };
const SUB = { light: '#3C3C4399', dark: '#EBEBF599' };
const GLASS = { light: '#FFFFFFA6', dark: '#FFFFFF1A' };

function bg() {
  return {
    type: 'linear',
    colors: [{ light: '#EAF3FF', dark: '#0B1A33' }, { light: '#F4F0FF', dark: '#120B24' }, { light: '#E9FBF3', dark: '#03140F' }],
    stops: [0, 0.55, 1],
    startPoint: { x: 0, y: 0 },
    endPoint: { x: 1, y: 1 },
  };
}

/* ---------- 用量洞察 ---------- */

function toMB(d) {
  const n = parseFloat(d && d.number);
  if (!Number.isFinite(n)) return null;
  return d.unit === 'GB' ? n * 1024 : n;
}

function fmtMB(mb) {
  if (mb == null || !Number.isFinite(mb)) return '--';
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(0)} MB`;
}

function insights(ctx, ds) {
  const now = new Date();
  const dayKey = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const dim = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeft = dim - now.getDate() + 1;
  // 按 通用 + 其他流量 合计剩余统计
  const _g = toMB(ds.flow), _o = toMB(ds.otherFlow);
  const flowMB = ctx.env.CM_SHOW_USED_FLOW === 'true' ? null
    : (_g == null && _o == null ? null : (_g || 0) + (_o || 0));
  let todayMB = null;
  if (flowMB != null) {
    let snap = null;
    try { snap = ctx.storage.getJSON('cm_day_snap'); } catch (e) {}
    // 新的一天，或流量变多（加油包/月初重置）→ 重新记起点
    if (!snap || snap.date !== dayKey || flowMB > snap.start + 1) {
      snap = { date: dayKey, start: flowMB };
      try { ctx.storage.setJSON('cm_day_snap', snap); } catch (e) {}
    }
    todayMB = Math.max(0, snap.start - flowMB);
  }
  // 近 7 天每日用量历史（旧 → 今天）
  const hist = [];
  if (todayMB != null) {
    let h = {};
    try { h = ctx.storage.getJSON('cm_hist') || {}; } catch (e) {}
    h[dayKey] = todayMB;
    const keep = {};
    for (let i = 7; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000);
      const k = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
      if (h[k] != null) keep[k] = h[k];
      if (i <= 6) hist.push(h[k] == null ? null : h[k]);
    }
    try { ctx.storage.setJSON('cm_hist', keep); } catch (e) {}
  }
  // 按近 6 天（不含今天）平均用量预测
  let forecast = { text: '用量统计中…', color: SUB };
  if (flowMB != null) {
    const past = hist.slice(0, 6).filter(v => v != null && v > 0);
    const vals = past.length ? past : (todayMB > 0 ? [todayMB] : []);
    if (vals.length) {
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const days = Math.floor(flowMB / avg);
      forecast = days >= daysLeft
        ? { text: days > 999 ? '按近期速度 充足' : `预计够用 ${days} 天 ✓`, color: C_VOICE }
        : { text: `约 ${days} 天用完 · 早于月底`, color: C_FEE };
    }
  }
  return {
    hist,
    forecast,
    daysLeft,
    monthPct: (now.getDate() - 1 + now.getHours() / 24) / dim,
    todayMB,
    dailyMB: flowMB != null ? flowMB / daysLeft : null,
    lowFee: (() => { const n = parseFloat(ds.fee.number); return Number.isFinite(n) && n < 10; })(),
  };
}

/* ---------- 图形 ---------- */

// 三层同心圆环（外→内：通用流量、其他流量、语音）
function ringsSvg(values, size, stroke, gap) {
  const h = size / 2;
  let body = '';
  values.forEach((v, i) => {
    const r = h - stroke / 2 - i * (stroke + gap);
    if (r <= stroke / 2) return;
    const c = 2 * Math.PI * r;
    const p = Math.max(0, Math.min(1, Number(v.pct) || 0));
    body += `<circle cx='${h}' cy='${h}' r='${r.toFixed(2)}' fill='none' stroke='${v.color}' stroke-opacity='0.22' stroke-width='${stroke}'/>`;
    if (p > 0) {
      // 用 path 圆弧绘制进度，不依赖 stroke-dasharray
      if (p >= 0.999) {
        body += `<circle cx='${h}' cy='${h}' r='${r.toFixed(2)}' fill='none' stroke='${v.color}' stroke-width='${stroke}'/>`;
      } else {
        const a = p * 2 * Math.PI;
        const x = (h + r * Math.sin(a)).toFixed(2), y = (h - r * Math.cos(a)).toFixed(2);
        body += `<path d='M ${h} ${(h - r).toFixed(2)} A ${r.toFixed(2)} ${r.toFixed(2)} 0 ${p > 0.5 ? 1 : 0} 1 ${x} ${y}' fill='none' stroke='${v.color}' stroke-width='${stroke}' stroke-linecap='round'/>`;
      }
    }
  });
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${size} ${size}'>${body}</svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

function ringSvg(pct, size, stroke) {
  return ringsSvg([{ pct, color: 'white' }], size, stroke, 0);
}

function barSvg(pct, color, w, h) {
  const p = Math.max(0, Math.min(1, Number(pct) || 0));
  const r = h / 2, fw = p > 0 ? Math.max(h, w * p) : 0;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}'>` +
    `<rect width='${w}' height='${h}' rx='${r}' fill='${color}' fill-opacity='0.2'/>` +
    (fw ? `<rect width='${fw.toFixed(1)}' height='${h}' rx='${r}' fill='${color}'/>` : '') + `</svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

// 半圆仪表
function gaugeSvg(pct, color, w) {
  const stroke = 12, r = (w - stroke) / 2, cx = w / 2, cy = w / 2, h = w / 2 + stroke / 2;
  const p = Math.max(0, Math.min(1, Number(pct) || 0));
  const pt = a => [(cx - r * Math.cos(a)).toFixed(2), (cy - r * Math.sin(a)).toFixed(2)];
  const [x0, y0] = pt(0), [x1, y1] = pt(Math.PI), [xp, yp] = pt(Math.PI * p);
  let body = `<path d='M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}' fill='none' stroke='${color}' stroke-opacity='0.22' stroke-width='${stroke}' stroke-linecap='round'/>`;
  if (p > 0.005) body += `<path d='M ${x0} ${y0} A ${r} ${r} 0 0 1 ${xp} ${yp}' fill='none' stroke='${color}' stroke-width='${stroke}' stroke-linecap='round'/>`;
  return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}'>${body}</svg>`);
}

// 近 7 天用量柱状图（最后一根是今天）
function sparkSvg(values, color, w, h) {
  const vals = values && values.length ? values : [null, null, null, null, null, null, null];
  const n = vals.length, gap = 3, bw = (w - gap * (n - 1)) / n;
  const max = Math.max(1, ...vals.map(v => v || 0));
  let body = '';
  vals.forEach((v, i) => {
    const bh = v ? Math.max(2, (v / max) * h) : 2;
    const op = v == null ? 0.15 : (i === n - 1 ? 1 : 0.55);
    body += `<rect x='${(i * (bw + gap)).toFixed(1)}' y='${(h - bh).toFixed(1)}' width='${bw.toFixed(1)}' height='${bh.toFixed(1)}' rx='${Math.min(2, bw / 2).toFixed(1)}' fill='${color}' fill-opacity='${op}'/>`;
  });
  return 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}'>${body}</svg>`);
}

// 仪表卡：图标+名称 / 半圆仪表+百分比 / 数值
function gaugeCard(icon, color, d, fallbackTitle, opt) {
  const o = opt || {};
  const data = d || { title: fallbackTitle, number: '--', unit: '', percent: 0 };
  const pct = data.percent > 0 ? Math.round(data.percent * 100) : 0;
  const gw = o.gw || 46;
  return glass([
    {
      type: 'stack', direction: 'row', alignItems: 'center', gap: 3,
      children: [
        { type: 'image', src: `sf-symbol:${icon}`, width: 10, height: 10, color },
        t(o.title || data.title || fallbackTitle, 9, 'medium', SUB, { minScale: 1 }),
      ],
    },
    {
      type: 'stack', direction: 'column', alignItems: 'center', gap: -3,
      children: [
        { type: 'image', src: gaugeSvg(data.percent, color, 64), width: gw, height: Math.round(gw * 38 / 64) },
        t(`${pct}%`, 9, 'bold', color, { minScale: 1 }),
      ],
    },
    {
      type: 'stack', direction: 'row', alignItems: 'end', gap: 2,
      children: [
        t(data.number, o.numSize || 15, 'bold', TXT, { minScale: 0.7 }),
        t(data.unit || '', 9, 'semibold', SUB, { minScale: 1 }),
      ],
    },
  ], { flex: 1, alignItems: 'center', gap: 2, padding: [7, 4], borderRadius: 16, ...(o.height ? { height: o.height } : {}) });
}

function ringValues(ds) {
  const o = ds.otherFlow || {};
  return [
    { pct: ds.flow.percent, color: C_FLOW },
    { pct: o.percent, color: C_OTHER },
    { pct: ds.voice.percent, color: C_VOICE },
  ];
}

/* ---------- 组件 ---------- */

function t(text, size, weight, color, extra) {
  return Object.assign({ type: 'text', text: String(text), font: { size, weight: weight || 'regular' }, textColor: color || TXT, maxLines: 1, minScale: 0.6 }, extra || {});
}

function header(title, ds, fromCache) {
  return {
    type: 'stack', direction: 'row', alignItems: 'center', gap: 4,
    children: [
      { type: 'image', src: 'sf-symbol:antenna.radiowaves.left.and.right', width: 12, height: 12, color: C_FLOW },
      t(title, 'footnote', 'semibold'),
      { type: 'spacer' },
      t(`${fromCache ? ((ds && ds.stale) || '缓存') + ' · ' : ''}更新 ${ds && ds.updatedAt ? fmtTime(ds.updatedAt) : '--'}`, 10, 'regular', SUB, { minScale: 1 }),
    ],
  };
}

function feeBig(ds, ins, size) {
  const color = ins.lowFee ? WARN : TXT;
  return {
    type: 'stack', direction: 'column', alignItems: 'start', gap: 0,
    children: [
      t(ins.lowFee ? '话费不足' : '剩余话费', 'caption2', 'medium', ins.lowFee ? WARN : SUB),
      {
        type: 'stack', direction: 'row', alignItems: 'end', gap: 1,
        children: [
          t('¥', 'subheadline', 'semibold', ins.lowFee ? WARN : SUB),
          t(ds.fee.number, size || 28, 'bold', color),
        ],
      },
    ],
  };
}

function legendRow(icon, color, d, extra) {
  const data = d || { title: '', number: '--', unit: '' };
  return {
    type: 'stack', direction: 'row', alignItems: 'center', gap: 5,
    children: [
      { type: 'image', src: `sf-symbol:${icon}`, width: 12, height: 12, color },
      t(data.title, 'caption1', 'regular', SUB),
      { type: 'spacer' },
      t(data.number, 'subheadline', 'bold', TXT),
      t(data.unit ? ` ${data.unit}` : '', 'caption2', 'regular', SUB),
      ...(extra ? [t(`  ${extra}`, 'caption2', 'semibold', color)] : []),
    ],
  };
}

function pctText(d) { return d && d.percent > 0 ? `${Math.round(d.percent * 100)}%` : ''; }

function chip(icon, color, text) {
  return {
    type: 'stack', direction: 'row', alignItems: 'center', gap: 4, padding: [5, 8], borderRadius: 99,
    backgroundColor: GLASS,
    children: [
      { type: 'image', src: `sf-symbol:${icon}`, width: 11, height: 11, color },
      t(text, 'caption2', 'semibold', TXT),
    ],
  };
}

function glass(children, extra) {
  return Object.assign({ type: 'stack', direction: 'column', alignItems: 'start', gap: 6, padding: 12, borderRadius: 22, backgroundColor: GLASS, children }, extra || {});
}

/* ---------- 尺寸 ---------- */

function feeCard(ds, ins, size, extra) {
  const low = ins.lowFee;
  return glass([
    {
      type: 'stack', direction: 'row', alignItems: 'center', gap: 3,
      children: [
        { type: 'image', src: 'sf-symbol:yensign.circle.fill', width: 10, height: 10, color: low ? WARN : C_FEE },
        t(low ? '话费不足' : '剩余话费', 9, 'medium', low ? WARN : SUB, { minScale: 1 }),
      ],
    },
    { type: 'spacer' },
    {
      type: 'stack', direction: 'row', alignItems: 'end', gap: 1,
      children: [t('¥', 11, 'semibold', low ? WARN : SUB, { minScale: 1 }), t(ds.fee.number, size || 22, 'bold', low ? WARN : TXT, { minScale: 0.6 })],
    },
    t(`本月剩 ${ins.daysLeft} 天`, 9, 'medium', SUB, { minScale: 1 }),
    ...(extra && extra.alignItems === 'center' ? [{ type: 'spacer' }] : []),
  ], Object.assign({ gap: 2, padding: [7, 9], borderRadius: 16 }, extra || {}));
}

function statsStrip(ins, sparkW) {
  return glass([
    {
      type: 'stack', direction: 'row', alignItems: 'center', gap: 6,
      children: [
        { type: 'image', src: sparkSvg(ins.hist, C_FLOW, 70, 14), width: sparkW || 46, height: 11 },
        t(`今日 ${fmtMB(ins.todayMB)}`, 9, 'semibold', TXT, { minScale: 1 }),
        t(`日均可用 ${fmtMB(ins.dailyMB)}`, 9, 'medium', SUB, { minScale: 1 }),
        { type: 'spacer' },
        t(ins.forecast.text, 9, 'semibold', ins.forecast.color, { minScale: 0.8 }),
      ],
    },
  ], { padding: [6, 9], borderRadius: 12, gap: 0 });
}

function refresh30() { return new Date(Date.now() + 30 * 60 * 1000).toISOString(); }

function buildSmall(title, ds, fromCache, ctx) {
  const ins = insights(ctx, ds);
  return {
    type: 'widget', padding: 12, gap: 5, backgroundGradient: bg(), refreshAfter: refresh30(),
    children: [
      {
        type: 'stack', direction: 'row', alignItems: 'center', gap: 4,
        children: [
          { type: 'image', src: 'sf-symbol:antenna.radiowaves.left.and.right', width: 11, height: 11, color: C_FLOW },
          t(title, 'caption1', 'semibold'),
          { type: 'spacer' },
          t(`¥${ds.fee.number}`, 11, 'bold', ins.lowFee ? WARN : C_FEE, { minScale: 1 }),
        ],
      },
      {
        type: 'stack', direction: 'row', alignItems: 'center', gap: 4, flex: 1,
        children: [
          {
            type: 'stack', direction: 'column', alignItems: 'start', gap: 0,
            children: [
              t('剩余流量', 9, 'medium', SUB, { minScale: 1 }),
              { type: 'stack', direction: 'row', alignItems: 'end', gap: 2, children: [t(ds.flow.number, 22, 'bold', TXT), t(ds.flow.unit || '', 9, 'semibold', SUB, { minScale: 1 })] },
            ],
          },
          { type: 'spacer' },
          {
            type: 'stack', direction: 'column', alignItems: 'center', gap: -3,
            children: [
              { type: 'image', src: gaugeSvg(ds.flow.percent, C_FLOW, 64), width: 42, height: 25 },
              t(pctText(ds.flow) || '0%', 9, 'bold', C_FLOW, { minScale: 1 }),
            ],
          },
        ],
      },
      {
        type: 'stack', direction: 'row', alignItems: 'end', gap: 5,
        children: [
          { type: 'image', src: sparkSvg(ins.hist, C_FLOW, 70, 14), width: 44, height: 11 },
          t(`今日 ${fmtMB(ins.todayMB)}`, 9, 'semibold', TXT, { minScale: 1 }),
        ],
      },
      t(`其他 ${ds.otherFlow ? ds.otherFlow.number + (ds.otherFlow.unit || '') : '--'} · 语音 ${ds.voice.number}${ds.voice.unit || ''}`, 9, 'medium', SUB, { minScale: 0.75 }),
      t(`日均可用 ${fmtMB(ins.dailyMB)} · ${ins.forecast.text}`, 9, 'semibold', ins.forecast.color, { minScale: 0.7 }),
    ],
  };
}

function buildMedium(title, ds, fromCache, ctx) {
  const ins = insights(ctx, ds);
  return {
    type: 'widget', padding: [10, 11], gap: 6, backgroundGradient: bg(), refreshAfter: refresh30(),
    children: [
      header(title, ds, fromCache),
      {
        type: 'stack', direction: 'row', alignItems: 'center', gap: 6, flex: 1,
        children: [
          feeCard(ds, ins, 21, { width: 84, height: 82, alignItems: 'center' }),
          gaugeCard('wifi', C_FLOW, ds.flow, '剩余流量', { height: 82 }),
          gaugeCard('globe.asia.australia.fill', C_OTHER, ds.otherFlow, '其他流量', { height: 82 }),
          gaugeCard('phone.fill', C_VOICE, ds.voice, '剩余语音', { height: 82 }),
        ],
      },
      statsStrip(ins, 40),
      ...(ds.planDebug ? [t(ds.planDebug, 'caption2', 'regular', SUB, { maxLines: 3 })] : []),
    ],
  };
}

function buildLarge(title, ds, fromCache, ctx) {
  const ins = insights(ctx, ds);
  const phone = getPhone(ctx);
  const masked = /^\d{11}$/.test(phone) ? `${phone.slice(0, 3)} **** ${phone.slice(7)}` : '';
  const labels = [];
  for (let i = 6; i >= 0; i--) { const d = new Date(Date.now() - i * 86400000); labels.push(i === 0 ? '今' : `${d.getDate()}`); }
  return {
    type: 'widget', padding: 14, gap: 9, backgroundGradient: bg(), refreshAfter: refresh30(),
    children: [
      header(title, ds, fromCache),
      {
        type: 'stack', direction: 'row', alignItems: 'center', gap: 8,
        children: [
          feeCard(ds, ins, 30, { flex: 1, height: 74, padding: [9, 12] }),
          glass([
            t('当前号码', 9, 'medium', SUB, { minScale: 1 }),
            t(masked || '--', 13, 'semibold', TXT, { family: 'Menlo', minScale: 0.7 }),
            { type: 'spacer' },
            t(ins.forecast.text, 10, 'semibold', ins.forecast.color, { minScale: 0.7 }),
          ], { flex: 1, height: 74, gap: 2, padding: [9, 12], borderRadius: 16 }),
        ],
      },
      {
        type: 'stack', direction: 'row', alignItems: 'center', gap: 8,
        children: [
          gaugeCard('wifi', C_FLOW, ds.flow, '剩余流量', { gw: 62, numSize: 18 }),
          gaugeCard('globe.asia.australia.fill', C_OTHER, ds.otherFlow, '其他流量', { gw: 62, numSize: 18 }),
          gaugeCard('phone.fill', C_VOICE, ds.voice, '剩余语音', { gw: 62, numSize: 18 }),
        ],
      },
      glass([
        {
          type: 'stack', direction: 'row', alignItems: 'center', gap: 4,
          children: [
            { type: 'image', src: 'sf-symbol:chart.bar.fill', width: 10, height: 10, color: C_FLOW },
            t('近 7 天流量', 10, 'semibold', TXT, { minScale: 1 }),
            { type: 'spacer' },
            t(`今日 ${fmtMB(ins.todayMB)} · 日均可用 ${fmtMB(ins.dailyMB)}`, 9, 'medium', SUB, { minScale: 0.8 }),
          ],
        },
        { type: 'image', src: sparkSvg(ins.hist, C_FLOW, 290, 40), width: 290, height: 40 },
        {
          type: 'stack', direction: 'row', alignItems: 'center', gap: 0,
          children: labels.map(l => ({ type: 'stack', direction: 'row', flex: 1, children: [{ type: 'spacer' }, t(l, 8, 'medium', SUB, { minScale: 1 }), { type: 'spacer' }] })),
        },
      ], { gap: 5, padding: [9, 12], borderRadius: 16 }),
      { type: 'spacer' },
      ...(ds.planDebug ? [t(ds.planDebug, 'caption2', 'regular', SUB, { maxLines: 3 })] : []),
    ],
  };
}

function buildLockScreen(title, ds, family, ctx) {
  const ins = insights(ctx, ds);
  if (family === 'accessoryInline') {
    return { type: 'widget', children: [{ type: 'text', text: `¥${ds.fee.number} · ${ds.flow.number}${ds.flow.unit} · ${ds.voice.number}分`, maxLines: 1, minScale: 0.6 }] };
  }
  if (family === 'accessoryCircular') {
    const hasPct = ds.flow && ds.flow.percent > 0;
    return {
      type: 'widget', padding: 8, backgroundImage: ringSvg(hasPct ? ds.flow.percent : 0, 60, 6),
      children: [
        { type: 'spacer' },
        {
          type: 'stack', direction: 'column', alignItems: 'center', gap: 0,
          children: hasPct
            ? [
              { type: 'image', src: 'sf-symbol:wifi', width: 10, height: 10 },
              { type: 'text', text: String(ds.flow.number), font: { size: 14, weight: 'bold' }, textAlign: 'center', maxLines: 1, minScale: 0.5 },
              { type: 'text', text: ds.flow.unit, font: { size: 9 }, textAlign: 'center', opacity: 0.7 },
            ]
            : [
              { type: 'text', text: '¥', font: { size: 9 }, textAlign: 'center', opacity: 0.7 },
              { type: 'text', text: ds.fee.number, font: { size: 14, weight: 'bold' }, textAlign: 'center', maxLines: 1, minScale: 0.5 },
            ],
        },
        { type: 'spacer' },
      ],
    };
  }
  return {
    type: 'widget', padding: [2, 4], gap: 2,
    children: [
      { type: 'text', text: `¥${ds.fee.number}${ins.lowFee ? ' · 话费不足' : ''}`, font: { size: 'footnote', weight: 'bold' }, maxLines: 1, minScale: 0.6 },
      { type: 'text', text: `流量 ${ds.flow.number} ${ds.flow.unit} · 语音 ${ds.voice.number}分`, font: { size: 'caption2', weight: 'semibold' }, maxLines: 1, minScale: 0.6 },
      { type: 'text', text: ins.todayMB != null ? `今日 ${fmtMB(ins.todayMB)} · 日均 ${fmtMB(ins.dailyMB)}` : `还剩 ${ins.daysLeft} 天`, font: { size: 'caption2' }, opacity: 0.7, maxLines: 1, minScale: 0.6 },
    ],
  };
}

function buildError(title, message, extra) {
  const children = [
    t(title, 'footnote', 'semibold'),
    { type: 'spacer' },
    { type: 'image', src: 'sf-symbol:exclamationmark.triangle.fill', width: 22, height: 22, color: C_FEE },
    t(message, 'caption1', 'medium', TXT, { maxLines: 4, minScale: 0.7 }),
  ];
  if (extra) children.push(t(extra, 'caption2', 'regular', SUB, { maxLines: 3 }));
  children.push({ type: 'spacer' });
  return { type: 'widget', padding: 14, gap: 6, backgroundGradient: bg(), children };
}

/* ==================== 小组件（generic） ==================== */

async function handleWidget(ctx) {
  const title = (ctx.env.CM_TITLE || '中国移动').trim() || '中国移动';
  const r = await loadData(ctx);

  if (!r.configured) {
    if (r.reason === 'phone') {
      return buildError(title, '请在模块 Env 里填写 CM_PHONENUMBER（11 位移动手机号）');
    }
    return buildError(title, '还没抓到登录参数：打开「中国移动」App，用短信验证码登录一次');
  }
  if (!r.ds) {
    const hint = r.stage === 'decrypt'
      ? '解密失败：可能 App 升级了加密，请重新打开 App 抓一次'
      : r.stage === 'network'
        ? '网络请求失败，请检查网络或代理'
        : r.stage === 'session'
          ? '登录已过期：打开「中国移动」App 停留 10 秒刷新登录，再回桌面'
          : '查询失败：打开「中国移动」App 等 10 秒，让脚本刷新 Cookie 后再试';
    return buildError(title, hint, r.debug ? `错误: ${r.error || ''}` : '');
  }

  try{var __g=globalThis.__CARR__||(globalThis.__CARR__={mods:{},ds:{}});__g.ds=__g.ds||{};__g.ds['mobile']=r.ds;}catch(__ignore){}
  const family = ctx.widgetFamily || 'systemSmall';
  if (family === 'systemLarge' || family === 'systemExtraLarge') return buildLarge(title, r.ds, r.fromCache, ctx);
  if (family === 'systemMedium') return buildMedium(title, r.ds, r.fromCache, ctx);
  if (family.startsWith('accessory')) return buildLockScreen(title, r.ds, family, ctx);
  return buildSmall(title, r.ds, r.fromCache, ctx);
}

/* ==================== 入口：单文件三模式 ==================== */

__exp.default = async function(ctx) {
  // ctx.request 存在 → request/response 捕获；否则 → 小组件
  if (ctx.request && ctx.request.url) {
    // 抓取开关：CM_CAPTURE=false 时完全不抓（打开中国移动 App 不再有任何动作）
    if ((ctx.env || {}).CM_CAPTURE === 'false') return;
    // response 脚本同时带 request 与 response；优先按 response 处理
    if (ctx.response && (ctx.response.status || ctx.response.headers)) {
      return handleRespCapture(ctx);
    }
    return handleCapture(ctx);
  }
  // 定时保活：每 20 分钟查一次，防止会话因长时间不操作被注销（410000）
  if (ctx.env && ctx.env.CM_KEEPALIVE === 'true') return handleKeepAlive(ctx);
  return handleWidget(ctx);
}

async function handleKeepAlive(ctx) {
  const r = await loadData(ctx);
  const expired = r.configured && (r.stage === 'session' || !r.ds || r.fromCache);
  dlog(ctx, `保活 ${expired ? '失败:' + (r.error || '') : '成功'}`);
  if (!expired) { try { await maybeProactiveRenew(ctx); } catch (e) {} }
  // 诊断：失败每次报；成功只在由失败转成功、或距上次成功报告超 3 小时时报
  const lastOkRep = parseInt(ctx.storage.get('cm_diag_ok_ts') || '0', 10);
  const prevFail = (ctx.storage.get('cm_diag_state') || '') === 'fail';
  if (expired || prevFail || Date.now() - lastOkRep > 3 * 3600 * 1000) {
    await cmReport(ctx, { ok: !expired, stage: r.stage || '', err: String(r.error || '').slice(0, 80), fails: parseInt(ctx.storage.get('cm_expire_fails') || '0', 10) });
    if (!expired) ctx.storage.set('cm_diag_ok_ts', String(Date.now()));
  }
  ctx.storage.set('cm_diag_state', expired ? 'fail' : 'ok');
  if (expired && r.stage === 'session') {
    // 连续 3 次（约 1 小时）都判过期才提醒，避免接口偶发空壳误报
    const fails = parseInt(ctx.storage.get('cm_expire_fails') || '0', 10) + 1;
    ctx.storage.set('cm_expire_fails', String(fails));
    const last = parseInt(ctx.storage.get('cm_expire_notify') || '0', 10);
    if (fails >= 3 && Date.now() - last > 6 * 3600 * 1000) {
      ctx.storage.set('cm_expire_notify', String(Date.now()));
      ctx.notify({ title: '中国移动', body: '登录已过期，打开「中国移动」App 停留几秒即可恢复' });
    }
  } else if (!expired) {
    ctx.storage.set('cm_expire_notify', '0');
    ctx.storage.set('cm_expire_fails', '0');
  }
}

try{(globalThis.__CARR__=globalThis.__CARR__||{mods:{},ds:{}}).mods['mobile']=__exp.default;}catch(__ignore){}
})();

;(function(){
var __exp = {};
/*
 * 中国电信小组件（Egern 版，App RSA 登录）
 * 移植自 Scriptable「中国电信」3.0.0-rsa（2Ya&脑瓜，RSA 登录 + 电信官方 API）
 * 登录方式：App 官方接口 userLoginNormal（RSA 加密）+ qryImportantData 查数
 * 账号存在模块设置里，token 失效时自动重登。
 * 30 分钟缓存：30 分钟内直接用缓存，不调接口，减少登录次数。
 *
 * 环境变量（在模块 compat_arguments / generic env 里填）：
 *   CT_PHONE              手机号（必填）
 *   CT_PASSWORD           服务密码 6 位数字（必填，与 CT_SERVICE_PASSWORD 二选一）
 *   CT_SERVICE_PASSWORD   服务密码（CT_PASSWORD 的别名，填一个即可）
 *   CT_DEVICE_ID          设备 ID（可选）：在作者网页短信登录授权后复制
 *                         不填则用随机设备 ID，可能需要多试几次才登上
 *   CT_SHOW_USED_FLOW     'true' 显示已用流量，否则显示剩余流量
 *   CT_SHOW_USED_VOICE    'true' 显示已用语音，否则显示剩余语音
 *   CT_SHOW_GENERAL_FLOW  'false' 不统计通用流量，默认显示
 *   CT_SHOW_DIRECTIONAL_FLOW 'false' 不统计定向流量，默认显示
 *   CT_TITLE              小组件标题，默认 "中国电信"
 *
 * 数据来源：https://appgologin.189.cn:9031/login/client/userLoginNormal
 *           https://appfuwu.189.cn:9021/query/qryImportantData
 * 注意：密码只存在你自己的 Egern 模块设置里，不发给任何第三方。
 */

const URLS = {
  login: 'https://appgologin.189.cn:9031/login/client/userLoginNormal',
  query: 'https://appfuwu.189.cn:9021/query/qryImportantData',
};

const FLOW_COLOR = '#FF6620';
const VOICE_COLOR = '#78C100';

const COLORS = {
  bg: {
    light: '#FFFFFF',
    dark: '#2C2C2E',
  },
  border: {
    light: '#E5E5EA',
    dark: '#3A3A3C',
  },
  title: {
    light: '#666666',
    dark: '#8E8E93',
  },
  value: {
    light: '#1C1C1E',
    dark: '#FFFFFF',
  },
  time: {
    light: '#999999',
    dark: '#666666',
  },
  error: {
    light: '#FF3B30',
    dark: '#FF453A',
  },
  capsuleBg: {
    light: '#FFFFFF15',
    dark: '#FFFFFF10',
  },
  accent: {
    light: '#FF6620',
    dark: '#FF854D',
  },
};

function formatFlow(flow) {
  const remain = flow / 1024;
  if (remain < 1024) {
    return { amount: remain.toFixed(2), unit: 'MB' };
  }
  return { amount: (remain / 1024).toFixed(2), unit: 'GB' };
}

function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function _safeN(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function transNumber(str, encode = true) {
  return [...String(str || '')].map((c) => String.fromCharCode((c.charCodeAt(0) + (encode ? 2 : -2)) & 0xffff)).join('');
}

function getBeijingTimestamp() {
  const bjDate = new Date(Date.now() + 8 * 3600 * 1000);
  const yyyy = String(bjDate.getFullYear());
  const MM = String(bjDate.getMonth() + 1).padStart(2, '0');
  const dd = String(bjDate.getDate()).padStart(2, '0');
  const HH = String(bjDate.getHours()).padStart(2, '0');
  const mm = String(bjDate.getMinutes()).padStart(2, '0');
  const ss = String(bjDate.getSeconds()).padStart(2, '0');
  return `${yyyy}${MM}${dd}${HH}${mm}${ss}`;
}

const RSA_MOD_HEX = 'c190b4f5e53855833ebf34e97ab3c18d3e87dd5b359b0a45a791a026eced8b8e43351fb74cbf3922a9dc54d368da9864472d7fd934c0971e73dc5bfb0386214204dd7ca85bf2f20e9561bf50b6ba08d3d7b5efab3e642b62bfb85b8a7d9c0938fdf625299c4968666d7d9701f2a3af6ee543223cca6ad3f5ca04ef2562137f83';

function _modPow(base, exp, mod) {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

function _base64Encode(bytes) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += chars[b0 >> 2];
    out += chars[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? chars[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? chars[b2 & 63] : '=';
  }
  return out;
}

function rsaEncrypt(text) {
  const data = [...String(text)].map((c) => c.charCodeAt(0) & 0xff);
  const k = 128;
  if (data.length > k - 11) throw new Error('RSA 明文过长');
  const psLen = k - data.length - 3;
  const ps = [];
  while (ps.length < psLen) {
    const r = Math.floor(Math.random() * 255) + 1;
    if (r !== 0) ps.push(r);
  }
  const em = [0x00, 0x02, ...ps, 0x00, ...data];
  let hex = '';
  for (const b of em) hex += b.toString(16).padStart(2, '0');
  const m = BigInt('0x' + RSA_MOD_HEX);
  const c = _modPow(BigInt('0x' + hex), 65537n, m);
  let cHex = c.toString(16).padStart(256, '0');
  const out = [];
  for (let i = 0; i < cHex.length; i += 2) out.push(parseInt(cHex.slice(i, i + 2), 16));
  return _base64Encode(out);
}

async function _postJson(ctx, url, bodyObj) {
  let resp;
  try {
    resp = await ctx.http.post(url, {
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(bodyObj),
      timeout: 15000,
    });
  } catch (e) {
    const err = new Error(`network: ${url}`);
    err.transient = true;
    throw err;
  }
  if (!resp || resp.status !== 200) {
    const err = new Error(`HTTP ${resp ? resp.status : 'no-response'}: ${url}`);
    err.transient = true;
    throw err;
  }
  try {
    return await resp.json();
  } catch (e) {
    const err = new Error(`not-json: ${url}`);
    err.transient = true;
    throw err;
  }
}

function _getAccount(ctx) {
  const env = ctx.env || {};
  const phone = String(env.CT_PHONE || '').trim();
  const password = String(env.CT_PASSWORD || env.CT_SERVICE_PASSWORD || '').trim();
  const deviceId = String(env.CT_DEVICE_ID || '').trim();
  return { phone, password, deviceId };
}

async function telecomLogin(ctx, account) {
  const { phone, password, deviceId } = account;
  const uuid = String(Math.floor(Math.random() * 9e15 + 1e15));
  const ts = getBeijingTimestamp();
  const encryptText = `iPhone 14 15.4.0${deviceId || uuid.slice(0, 12)}${phone}${ts}${password}0$$$0.`;
  const encrypted = rsaEncrypt(encryptText);
  const loginBody = {
    content: {
      fieldData: {
        loginType: '4',
        accountType: '',
        isChinatelecom: '',
        systemVersion: '15.4.0',
        deviceUid: uuid.slice(0, 16),
        phoneNum: transNumber(phone),
        authentication: transNumber(password),
        androidId: deviceId ? transNumber(deviceId) : '',
        loginAuthCipherAsymmertric: encrypted,
      },
      attach: 'iPhone',
    },
    headerInfos: {
      code: 'userLoginNormal',
      clientType: '#12.2.0#channel50#iPhone 14 Pro#',
      timestamp: ts,
      shopId: '20002',
      source: '110003',
      sourcePassword: 'Sid98s',
      userLoginName: transNumber(phone),
    },
  };
  const loginData = await _postJson(ctx, URLS.login, loginBody);
  const rd = loginData && loginData.responseData;
  if (!rd || rd.resultCode !== '0000') {
    const err = new Error(`登录失败 ${rd ? rd.resultCode : 'no-response'}：${(rd && rd.resultDesc) || '未知错误'}`);
    err.resultCode = rd ? rd.resultCode : '';
    err.resultDesc = rd ? rd.resultDesc : '';
    throw err;
  }
  const { token, cityCode, provinceCode } = rd.data.loginSuccessResult || {};
  if (!token) throw new Error('登录成功但未返回 token');
  try {
    ctx.storage.set('ct_app_token', token);
    ctx.storage.set('ct_app_city', String(cityCode || ''));
    ctx.storage.set('ct_app_province', String(provinceCode || ''));
    ctx.storage.set('ct_app_token_ts', String(Date.now()));
  } catch (_) {}
  return { token, cityCode, provinceCode };
}

async function fetchImportantData(ctx, account, token, cityCode, provinceCode) {
  const ts = getBeijingTimestamp();
  const dataBody = {
    content: {
      fieldData: {
        provinceCode,
        cityCode,
        shopId: '20002',
        isChinatelecom: '0',
        account: transNumber(account.phone),
      },
      attach: 'test',
    },
    headerInfos: {
      code: 'qryImportantData',
      clientType: '#12.2.0#channel50#iPhone 14 Pro#',
      timestamp: ts,
      shopId: '20002',
      source: '110003',
      sourcePassword: 'Sid98s',
      userLoginName: transNumber(account.phone),
      token,
    },
  };
  const dataResp = await _postJson(ctx, URLS.query, dataBody);
  if (!dataResp || !dataResp.responseData) {
    const err = new Error(`查数失败：${(dataResp && dataResp.headerInfos && dataResp.headerInfos.reason) || 'Token 失效'}`);
    err.authFailed = true;
    throw err;
  }
  return dataResp.responseData.data;
}

function parseImportantData(apiData, opts) {
  const { showUsedFlow, showGeneralFlow, showDirectionalFlow } = opts;
  const balance = _safeN(apiData && apiData.balanceInfo && apiData.balanceInfo.indexBalanceDataInfo && apiData.balanceInfo.indexBalanceDataInfo.balance);
  const feeBalance = balance !== 0 ? balance : _safeN(apiData && apiData.balance);
  const fee = { title: '剩余话费', number: feeBalance.toFixed(2), unit: '元' };

  const common = (apiData && apiData.flowInfo && apiData.flowInfo.commonFlow) || {};
  const total = (apiData && apiData.flowInfo && apiData.flowInfo.totalAmount) || {};
  const gUsed = _safeN(common.used), gBalance = _safeN(common.balance), gTotal = _safeN(common.total);
  const tUsed = _safeN(total.used !== undefined ? total.used : apiData.usedFlux), tBalance = _safeN(total.balance), tTotal = _safeN(total.total !== undefined ? total.total : (tUsed + tBalance));
  const hasCommon = common.used !== undefined || common.balance !== undefined || common.total !== undefined;
  let used, balanceFlow, totalFlow;
  if (!hasCommon) {
    used = tUsed; balanceFlow = tBalance; totalFlow = tTotal;
  } else if (showGeneralFlow && showDirectionalFlow) {
    used = tUsed; balanceFlow = tBalance; totalFlow = tTotal;
  } else if (showGeneralFlow && !showDirectionalFlow) {
    used = gUsed; balanceFlow = gBalance; totalFlow = gTotal;
  } else if (!showGeneralFlow && showDirectionalFlow) {
    used = Math.max(0, tUsed - gUsed); balanceFlow = Math.max(0, tBalance - gBalance); totalFlow = Math.max(0, tTotal - gTotal);
  } else {
    used = tUsed; balanceFlow = tBalance; totalFlow = tTotal;
  }
  const balanceFmt = formatFlow(balanceFlow);
  const usedFmt = formatFlow(used);
  const flow = {
    title: '剩余流量',
    number: balanceFmt.amount,
    unit: balanceFmt.unit,
    percent: +(totalFlow > 0 ? ((balanceFlow / totalFlow) * 100).toFixed(2) : '0'),
    color: FLOW_COLOR,
  };
  if (showUsedFlow) {
    flow.title = '已用流量';
    flow.number = usedFmt.amount;
    flow.unit = usedFmt.unit;
  }

  const voiceInfo = (apiData && apiData.voiceInfo && apiData.voiceInfo.voiceDataInfo) || {};
  const vTotal = _safeN(voiceInfo.total !== undefined ? voiceInfo.total : apiData.totalVoice);
  const vUsed = _safeN(voiceInfo.used !== undefined ? voiceInfo.used : apiData.usedVoice);
  const vBalance = _safeN(voiceInfo.balance !== undefined ? voiceInfo.balance : (vTotal - vUsed));
  const showUsedVoice = opts.showUsedVoice;
  const voice = {
    title: showUsedVoice ? '已用语音' : '剩余语音',
    number: `${showUsedVoice ? vUsed : vBalance}`,
    unit: '分钟',
    percent: +(vTotal > 0 ? (((showUsedVoice ? vUsed : vBalance) / vTotal) * 100).toFixed(2) : '0'),
    color: VOICE_COLOR,
  };

  return { fee, flow, voice, updatedAt: Date.now() };
}

function _notifyAuthFailedOnce(ctx, account, err) {
  try {
    const marker = `${account.phone.slice(-4)}:${err && err.resultCode ? err.resultCode : (err && err.message) || ''}`;
    if (ctx.storage.get('ct_auth_notified') === marker) return;
    ctx.storage.set('ct_auth_notified', marker);
    ctx.notify({ title: '中国电信', body: `登录失败：${(err && err.message) || '请检查手机号/服务密码/设备ID'}` });
  } catch (_) {}
}

function _clearAuthFlag(ctx) {
  try { ctx.storage.delete('ct_auth_notified'); } catch (_) {}
}

async function loadData(ctx) {
  const settings = {
    showUsedFlow: ctx.env.CT_SHOW_USED_FLOW === 'true',
    showUsedVoice: ctx.env.CT_SHOW_USED_VOICE === 'true',
    showGeneralFlow: ctx.env.CT_SHOW_GENERAL_FLOW !== 'false',
    showDirectionalFlow: ctx.env.CT_SHOW_DIRECTIONAL_FLOW !== 'false',
  };
  const account = _getAccount(ctx);
  const configured = !!(account.phone && account.password);
  if (!configured) {
    return { configured: false, ds: null, fromCache: false, authFailed: false, authError: '' };
  }

  try {
    const rawCache = ctx.storage.getJSON('ct_raw');
    const dsCache = ctx.storage.getJSON('ct_datasource');
    const at = (rawCache && rawCache.at) || (dsCache && dsCache.updatedAt) || 0;
    if (at && Date.now() - at < 30 * 60 * 1000) {
      if (rawCache && rawCache.apiData) {
        const ds = parseImportantData(rawCache.apiData, settings);
        ds.updatedAt = at;
        return { configured, ds, fromCache: false, authFailed: false, authError: '' };
      }
      if (dsCache) {
        return { configured, ds: dsCache, fromCache: false, authFailed: false, authError: '' };
      }
    }
  } catch (_) {}

  let token = '';
  let cityCode = '';
  let provinceCode = '';
  try {
    token = ctx.storage.get('ct_app_token') || '';
    cityCode = ctx.storage.get('ct_app_city') || '';
    provinceCode = ctx.storage.get('ct_app_province') || '';
  } catch (_) {}

  const _tryFetch = async (tok, city, prov) => {
    const apiData = await fetchImportantData(ctx, account, tok, city, prov);
    const ds = parseImportantData(apiData, settings);
    try {
      ctx.storage.setJSON('ct_datasource', ds);
      ctx.storage.setJSON('ct_raw', { apiData, at: ds.updatedAt || Date.now() });
    } catch (_) {}
    _clearAuthFlag(ctx);
    return ds;
  };

  if (token) {
    try {
      const ds = await _tryFetch(token, cityCode, provinceCode);
      return { configured, ds, fromCache: false, authFailed: false, authError: '' };
    } catch (e) {
      if (e && e.transient) {
        return _fromCache(ctx, configured, settings, false, '');
      }
    }
  }

  try {
    const login = await telecomLogin(ctx, account);
    const ds = await _tryFetch(login.token, login.cityCode, login.provinceCode);
    return { configured, ds, fromCache: false, authFailed: false, authError: '' };
  } catch (e) {
    if (e && e.transient) {
      return _fromCache(ctx, configured, settings, false, '');
    }

    _notifyAuthFailedOnce(ctx, account, e);
    return { configured, ds: null, fromCache: false, authFailed: true, authError: (e && e.message) || '登录失败' };
  }
}

function _fromCache(ctx, configured, settings, authFailed, authError) {
  try {
    const raw = ctx.storage.getJSON('ct_raw');
    if (raw && raw.apiData) {
      const ds = parseImportantData(raw.apiData, settings);
      ds.updatedAt = raw.at || ds.updatedAt;
      return { configured, ds, fromCache: true, authFailed, authError };
    }
  } catch (_) {}
  try {
    const cached = ctx.storage.getJSON('ct_datasource');
    if (cached) return { configured, ds: cached, fromCache: true, authFailed, authError };
  } catch (_) {}
  return { configured, ds: null, fromCache: false, authFailed, authError };
}

function makeCapsule(
  title,
  value,
  unit
) {

  return {

    type: 'stack',

    direction: 'column',

    alignItems: 'center',

    flex: 1,

    padding: [
      8,
      8,
      8,
      8,
    ],

    backgroundColor:
      COLORS.capsuleBg,

    borderRadius: 14,

    borderWidth: 1,

    borderColor:
      COLORS.border,

    children: [

      {
        type: 'text',

        text:
          title,

        font: {
          size: 'caption2',
          weight: 'medium',
        },

        textColor:
          COLORS.title,

        textAlign:
          'center',

        maxLines: 1,

        minScale:
          0.7,
      },

      {
        type: 'stack',

        direction: 'row',

        alignItems: 'center',

        gap: 3,

        children: [

          {
            type: 'text',

            text:
              String(value),

            font: {
              size: 'title2',
              weight: 'semibold',
            },

            textColor:
              COLORS.value,

            textAlign:
              'center',

            maxLines: 1,

            minScale:
              0.65,
          },

          {
            type: 'text',

            text:
              unit,

            font: {
              size: 'caption2',
              weight: 'regular',
            },

            textColor:
              COLORS.title,

            maxLines: 1,
          },
        ],
      },
    ],
  };
}


function headerRow(
  title,
  ds,
  fromCache
) {

  const time =
    ds &&
    ds.updatedAt
      ? fmtTime(ds.updatedAt)
      : '--:--';

  return {

    type: 'stack',

    direction: 'row',

    alignItems: 'center',

    children: [

      {
        type: 'stack',

        direction: 'row',

        alignItems: 'center',

        gap: 7,

        children: [

          {
            type: 'image',

            src:
              'sf-symbol:antenna.radiowaves.left.and.right',

            color:
              COLORS.accent,

            width: 18,

            height: 18,
          },

          {
            type: 'text',

            text:
              title,

            font: {
              size: 'headline',
              weight: 'semibold',
            },

            textColor:
              COLORS.value,

            maxLines: 1,

            minScale:
              0.75,
          },
        ],
      },

      {
        type: 'spacer',
      },

      {
        type: 'stack',

        direction: 'row',

        alignItems: 'center',

        gap: 5,

        children: [

          {
            type: 'image',

            src:
              'sf-symbol:arrow.clockwise',

            color:
              COLORS.time,

            width: 12,

            height: 12,
          },

          {
            type: 'text',

            text:
              fromCache ? `缓存 ${time}` : time,

            font: {
              size: 'caption2',
            },

            textColor:
              COLORS.time,

            maxLines: 1,
          },
        ],
      },
    ],
  };
}


function buildMainWidget(
  title,
  ds,
  fromCache
) {

  return {

    type: 'widget',



    padding: [
      10,
      14,
      10,
      14,
    ],

    gap: 12,

    refreshAfter:
      new Date(
        Date.now() +
        60 * 60 * 1000
      ).toISOString(),

    children: [

      /* 顶部 */

      headerRow(
        title,
        ds,
        fromCache
      ),


      {
        type: 'stack',

        direction: 'row',

        alignItems: 'center',

        gap: 9,

        children: [

          makeCapsule(
            ds.fee.title,
            ds.fee.number,
            ds.fee.unit
          ),

          makeCapsule(
            ds.voice.title,
            ds.voice.number,
            ds.voice.unit
          ),

          makeCapsule(
            ds.flow.title,
            ds.flow.number,
            ds.flow.unit
          ),
        ],
      },


      {
        type: 'stack',

        direction: 'row',

        alignItems: 'center',

        children: [

          {
            type: 'spacer',
          },

          {
            type: 'stack',

            width: 48,

            height: 4,

            borderRadius: 2,

            backgroundColor:
              COLORS.border,
          },

          {
            type: 'spacer',
          },
        ],
      },
    ],
  };
}

function smallRow(
  color,
  symbol,
  glyph,
  value,
  unit,
  label
) {

  const iconChild =
    symbol
      ? {
          type: 'image',

          src: symbol,

          color: '#FFFFFF',

          width: 16,

          height: 16,
        }
      : {
          type: 'text',

          text: glyph,

          font: {
            size: 'headline',
            weight: 'bold',
          },

          textColor: '#FFFFFF',
        };

  return {

    type: 'stack',

    direction: 'row',

    alignItems: 'center',

    gap: 8,

    flex: 1,

    padding: [
      4,
      8,
      4,
      8,
    ],

    backgroundColor: {
      light: color + '40',
      dark: color + '33',
    },

    borderRadius: 14,

    children: [

      {
        type: 'stack',

        direction: 'row',

        alignItems: 'center',

        width: 30,

        height: 30,

        borderRadius: 15,

        backgroundColor: { light: color, dark: color + '60' },

        children: [
          iconChild,
        ],
      },

      {
        type: 'stack',

        direction: 'column',

        flex: 1,

        children: [

          {
            type: 'stack',

            direction: 'row',

            alignItems: 'center',

            gap: 3,

            children: [

              {
                type: 'text',

                text: String(value),

                font: {
                  size: 'title3',
                  weight: 'bold',
                },

                textColor: color,

                maxLines: 1,

                minScale: 0.5,
              },

              {
                type: 'text',

                text: String(unit),

                font: {
                  size: 'caption1',
                  weight: 'semibold',
                },

                textColor: color,

                maxLines: 1,
              },

              {
                type: 'spacer',
              },
            ],
          },

          {
            type: 'stack',

            direction: 'row',

            alignItems: 'center',

            children: [

              {
                type: 'text',

                text: String(label),

                font: {
                  size: 'caption2',
                  weight: 'medium',
                },

                textColor: color + 'B3',

                maxLines: 1,

                minScale: 0.7,
              },

              {
                type: 'spacer',
              },
            ],
          },
        ],
      },
    ],
  };
}

function buildSmall(
  title,
  ds,
  fromCache
) {

  return {

    type: 'widget',



    padding: [
      10,
      10,
      10,
      10,
    ],

    gap: 6,

    refreshAfter:
      new Date(
        Date.now() +
        60 * 60 * 1000
      ).toISOString(),

    children: [

      smallRow(
        '#E8651F',
        null,
        '¥',
        ds.fee.number,
        ds.fee.unit,
        ds.fee.title
      ),

      smallRow(
        '#4DA6F0',
        'sf-symbol:antenna.radiowaves.left.and.right',
        '',
        ds.flow.number,
        ds.flow.unit,
        ds.flow.title
      ),

      smallRow(
        '#55C759',
        'sf-symbol:phone.and.waveform.fill',
        '',
        ds.voice.number,
        ds.voice.unit,
        ds.voice.title
      ),
    ],
  };
}

function buildLockScreen(
  title,
  ds,
  family
) {

  const SUB = {
    light: '#FFFFFFB3',
    dark: '#FFFFFFB3',
  };

  if (
    family ===
      'accessoryInline'
  ) {

    return {

      type: 'widget',

      children: [

        {
          type: 'text',

          text:
            `${title} ${ds.fee.number}${ds.fee.unit} · ` +
            `${ds.flow.number}${ds.flow.unit}`,

          font: {
            size: 'caption1',
            weight: 'medium',
          },

          maxLines: 1,

          minScale:
            0.5,
        },
      ],
    };
  }

  if (
    family ===
      'accessoryCircular'
  ) {

    return {

      type: 'widget',

      padding: 2,

      children: [

        {
          type: 'spacer',
        },

        {
          type: 'text',

          text:
            `${ds.flow.number}`,

          font: {
            size: 'headline',
            weight: 'bold',
          },

          textAlign:
            'center',

          maxLines: 1,

          minScale:
            0.5,
        },

        {
          type: 'text',

          text:
            ds.flow.unit,

          font: {
            size: 'caption2',
          },

          textColor: SUB,

          textAlign:
            'center',

          maxLines: 1,
        },

        {
          type: 'spacer',
        },
      ],
    };
  }

  const line = (
    label,
    value,
    unit
  ) => ({

    type: 'stack',

    direction: 'row',

    alignItems: 'center',

    gap: 4,

    children: [

      {
        type: 'text',

        text: label,

        font: {
          size: 'caption2',
          weight: 'medium',
        },

        textColor: SUB,

        maxLines: 1,
      },

      {
        type: 'spacer',
      },

      {
        type: 'text',

        text: String(value),

        font: {
          size: 'caption1',
          weight: 'bold',
        },

        maxLines: 1,

        minScale: 0.6,
      },

      {
        type: 'text',

        text: String(unit),

        font: {
          size: 'caption2',
        },

        textColor: SUB,

        maxLines: 1,
      },
    ],
  });


  return {

    type: 'widget',

    padding: 2,

    gap: 2,

    children: [

      line(
        '话费',
        ds.fee.number,
        ds.fee.unit
      ),

      line(
        '流量',
        ds.flow.number,
        ds.flow.unit
      ),

      line(
        '语音',
        ds.voice.number,
        ds.voice.unit
      ),
    ],
  };
}


function buildError(
  title,
  message,
  url
) {

  const w = {

    type: 'widget',



    padding: 14,

    gap: 9,

    children: [

      {
        type: 'stack',

        direction: 'row',

        alignItems: 'center',

        gap: 6,

        children: [

          {
            type: 'image',

            src:
              'sf-symbol:exclamationmark.triangle.fill',

            color:
              COLORS.error,

            width: 14,

            height: 14,
          },

          {
            type: 'text',

            text:
              title,

            font: {
              size: 'headline',
              weight: 'bold',
            },

            textColor:
              COLORS.error,

            maxLines: 1,
          },
        ],
      },

      {
        type: 'text',

        text:
          message,

        font: {
          size: 'caption1',
        },

        textColor:
          COLORS.title,

        maxLines: 3,
      },

      {
        type: 'stack',

        direction: 'row',

        alignItems: 'center',

        gap: 5,

        padding: [
          6,
          10,
          6,
          10,
        ],

        backgroundColor:
          COLORS.capsuleBg,

        borderRadius: 10,

        borderWidth: 1,

        borderColor:
          COLORS.border,

        children: [

          {
            type: 'image',

            src:
              'sf-symbol:phone.circle',

            color:
              COLORS.time,

            width: 12,

            height: 12,
          },

          {
            type: 'text',

            text:
              '请在模块设置里检查账号',

            font: {
              size: 'caption2',
            },

            textColor:
              COLORS.time,

            maxLines: 1,

            minScale:
              0.7,
          },
        ],
      },
    ],
  };


  if (url) {
    w.url = url;
  }

  return w;
}

async function handleWidget(ctx) {
  const safeCtx = ctx || {};
  const env = safeCtx.env || {};
  const title = (env.CT_TITLE || '中国电信').trim() || '中国电信';

  let result;
  try {
    result = await loadData(safeCtx);
  } catch (e) {
    return buildError(title, '数据获取失败', '');
  }

  const { configured, ds, fromCache, authFailed, authError } = result;

  if (!configured) {
    return buildError(title, '未配置：请在模块设置里填手机号和服务密码', '');
  }

  if (authFailed || !ds) {
    return buildError(title, authError || '登录失败，请检查手机号/服务密码/设备ID', '');
  }

  try{var __g=globalThis.__CARR__||(globalThis.__CARR__={mods:{},ds:{}});__g.ds=__g.ds||{};__g.ds['telecom']=ds;}catch(__ignore){}
  const family = safeCtx.widgetFamily || '';
  let w;
  if (family === 'systemSmall') {
    w = buildSmall(title, ds, fromCache);
  } else if (family.startsWith('accessory')) {
    w = buildLockScreen(title, ds, family);
  } else {
    w = buildMainWidget(title, ds, fromCache);
  }
  return w;
}

__exp.default = async function(ctx) {
  const safeCtx = ctx || {};
  if (safeCtx.request && safeCtx.request.url) {
    return { type: 'text', text: 'app login mode, no capture' };
  }
  return handleWidget(safeCtx);
}

try{(globalThis.__CARR__=globalThis.__CARR__||{mods:{},ds:{}}).mods['telecom']=__exp.default;}catch(__ignore){}
})();

;(function(){
var __exp = {};
'use strict';

const API_URL = 'https://app.10099.com.cn/contact-web/api/busi/qryUserInfo';
const MINI_API_URL = 'https://wx.10099.com.cn/contact-web/api/busi/qryUserInfo';
const ALIPAY_API_URL = 'https://zfb.10099.com.cn/contact-web/api/busi/qryUserInfo';
const SUPPORTED_API_URLS = [API_URL, MINI_API_URL, ALIPAY_API_URL];
const BLOCKED_API_URL = 'https://wx.10099.com.cn/contact-web/api/busi/qryNeedPaperLess';
const KEY = 'ChinaBroadnet';
// 每 25 分钟最多一个采样点，96 个点约覆盖 24 小时，"今日流量"才有完整曲线（原来只留 24 个点）。
const HISTORY_LIMIT = 96;

const C = {
  // 低饱和环境渐变 + 统一中性色玻璃；主题色只用于图标、关键数字和进度。
  fee: '#E28A16',
  flow: '#079ACB',
  voice: '#8B5CF6',
  // 文本色随系统外观自动切换，避免深色模式下深色文字落在深色玻璃上。
  txt: { light: '#172B45', dark: '#F3F7FC' },
  sub: { light: '#586D84', dark: '#B8C7D8' },
  title: '#0F9F91',
  cyan: '#22B8CF',
  violet: '#9B7BFF',
  pink: '#EC6FA7',
  green: '#27A879',
  glass: { light: '#FFFFFFD9', dark: '#263D55D9' },
  glassBorder: { light: '#FFFFFF70', dark: '#FFFFFF25' },
  glassShadow: { light: '#64748B06', dark: '#00000000' },
};

// 测试版采用统一的清透磨砂玻璃，避免不同卡片各自铺色造成视觉杂乱。
const transparentMode = true;

function readRequestBody(ctx) {
  const req = ctx.request || {};

  function parseBody(raw) {
    if (raw == null || raw === '') return null;

    if (typeof raw === 'string') {
      try {
        return JSON.parse(raw);
      } catch (e) {
        return null;
      }
    }

    // Some runtimes expose the body as a byte buffer instead of a string.
    if (typeof raw === 'object') {
      try {
        if (raw.data != null) return raw;
        if (typeof raw.text === 'function') return null;
        if (typeof raw.length === 'number' &&
            (raw instanceof Uint8Array || Object.prototype.toString.call(raw) === '[object Uint8Array]')) {
          let text = '';
          for (let i = 0; i < raw.length; i++) text += String.fromCharCode(raw[i]);
          try {
            return JSON.parse(decodeURIComponent(escape(text)));
          } catch (e) {
            try { return JSON.parse(text); } catch (e2) { return null; }
          }
        }
      } catch (e) {}
      // An empty Request-like object is not the parsed payload. Let json()/text()
      // read the actual body instead of returning {} and masking it.
      try {
        if (Object.keys(raw).length > 0) return raw;
      } catch (e) {}
      return null;
    }

    return null;
  }

  return (async () => {
    // Some Egern runtimes expose req.body as an empty Request-like object while
    // the actual payload is available through req.json() or req.text().
    try {
      const body = parseBody(req.body);
      if (body != null && (typeof body !== 'object' || Object.keys(body).length > 0)) return body;
    } catch (e) {}

    try {
      if (typeof req.json === 'function') {
        const body = await req.json();
        if (body != null) {
          const parsed = parseBody(body);
          if (parsed != null) return parsed;
        }
      }
    } catch (e) {}

    try {
      if (typeof req.text === 'function') {
        const raw = await req.text();
        const body = parseBody(raw);
        if (body != null) return body;
      }
    } catch (e) {}

    try {
      if (typeof $request !== 'undefined' && $request && $request.body != null) {
        const body = parseBody($request.body);
        if (body != null) return body;
      }
    } catch (e) {}

    return null;
  })();
}

function getHeader(headers, name) {
  if (!headers) return '';
  try {
    if (typeof headers.get === 'function') return headers.get(name) || '';
  } catch (e) {}
  try {
    for (const k of Object.keys(headers)) {
      if (String(k).toLowerCase() === name.toLowerCase()) return headers[k] || '';
    }
  } catch (e) {}
  return '';
}

function findValue(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return null;
}

function scanPlanFields(root) {
  const out = [];
  const seen = new Set();
  const words = /(flow|traffic|data|voice|call|quota|total|used|remain|balance|resource|package|plan|usage|limit|free|gprs|fee)/i;

  function walk(v, path, depth) {
    if (depth > 8 || v == null) return;

    if (typeof v === 'object') {
      if (seen.has(v)) return;
      seen.add(v);

      for (const k of Object.keys(v)) {
        const value = v[k];
        const nextPath = path ? path + '.' + k : k;
        const keyHit = words.test(k);

        if (keyHit && (typeof value === 'number' || (typeof value === 'string' && /^-?\\d+(?:\\.\\d+)?$/.test(value.trim())))) {
          out.push({
            path: nextPath,
            key: k,
            value: Number(value),
          });
        }

        if (typeof value === 'object' && value !== null) {
          walk(value, nextPath, depth + 1);
        }
      }
    }
  }

  walk(root, '', 0);
  return out.slice(0, 80);
}

function pickPlanMetric(candidates, kind) {
  const list = candidates || [];
  const re = kind === 'total'
    ? /(total|quota|limit|package|plan|free)/i
    : kind === 'used'
      ? /(used|usage|consume|consumed)/i
      : /(remain|left|balance|available)/i;

  return list.find(x => re.test(x.key) || re.test(x.path)) || null;
}

function calcPlanPercent(total, used, remain) {
  const t = Number(total);
  const u = Number(used);
  const r = Number(remain);

  if (Number.isFinite(t) && t > 0 && Number.isFinite(u) && u >= 0) {
    return Math.max(0, Math.min(1, u / t));
  }
  if (Number.isFinite(t) && t > 0 && Number.isFinite(r) && r >= 0) {
    return Math.max(0, Math.min(1, 1 - r / t));
  }
  return null;
}

function formatFee(v) {
  const n = Number(v);
  return Number.isFinite(n) ? (n / 100).toFixed(2) : '--';
}

function formatFlow(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return { number: '--', unit: 'GB' };

  // 广电 qryUserInfo 的 flowAll / flowUserd / flow 字段单位为 KB。
  // 采用 1024 进制换算，保证总量、已用、剩余及历史记录显示一致。
  const gb = 1024 * 1024;
  const mb = 1024;
  if (n >= gb) return { number: (n / gb).toFixed(2), unit: 'GB' };
  if (n >= mb) return { number: (n / mb).toFixed(2), unit: 'MB' };
  if (n >= 1) return { number: n.toFixed(2), unit: 'KB' };
  return { number: (n * 1024).toFixed(2), unit: 'B' };
}

function formatVoice(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(0) : '--';
}

function detectCaptureSource(req) {
  const headers = req && req.headers;
  const hints = [
    getHeader(headers, 'referer'),
    getHeader(headers, 'origin'),
    getHeader(headers, 'user-agent'),
    getHeader(headers, 'x-requested-with'),
  ].join(' ').toLowerCase();

  if (/alipay|alipayclient|alipay\.com|mini\.alipay|my\.alipay/.test(hints)) return '支付宝小程序';
  if (/weixin|micromessenger|wx\.qq\.com|servicewechat/.test(hints)) return '微信小程序';
  return '中国广电 App 或未识别来源';
}

async function capture(ctx) {
  // cbCapture is injected by the module argument into ctx.env. Default to enabled for older installs.
  if (ctx.env && String(ctx.env.cbCapture).toLowerCase() === 'false') {
    console.log('[ChinaBroadnet] 数据抓取已关闭，跳过 HTTP 捕获');
    return;
  }
  const req = ctx.request || {};
  const url = String(req.url || '');
  const method = String(req.method || '').toUpperCase();
  // Ignore this endpoint entirely; the widget must never query it.
  if (url.startsWith(BLOCKED_API_URL)) return;
  // Parse the request body once and reuse it for both probing and capture.
  let parsedBody = null;
  let bodyRead = false;
  const getParsedBody = async () => {
    if (!bodyRead) {
      parsedBody = await readRequestBody(ctx);
      bodyRead = true;
    }
    return parsedBody;
  };

  if (/^https:\/\/(?:app|wx|zfb)\.10099\.com\.cn\//i.test(url)) {
    try {
      const body = await getParsedBody();
      const keys = [];

      function collectKeys(v, depth) {
        if (depth > 5 || v == null || typeof v !== 'object') return;
        for (const k of Object.keys(v)) {
          if (!keys.includes(k)) keys.push(k);
          if (v[k] && typeof v[k] === 'object') collectKeys(v[k], depth + 1);
        }
      }

      collectKeys(body, 0);

      const old = ctx.storage.getJSON(KEY + '.apiProbe') || [];
      const item = {
        ts: Date.now(),
        method,
        url,
        keys: keys.slice(0, 80),
      };

      const next = old.filter(x => !(x.url === url && x.method === method));
      next.push(item);
      ctx.storage.setJSON(KEY + '.apiProbe', next.slice(-60));

      // Log only the shape of the request context; never log header values or body contents.
      let bodyType = body == null ? 'null' : (Array.isArray(body) ? 'array' : typeof body);
      let bodyKeys = [];
      try {
        if (body && typeof body === 'object') bodyKeys = Object.keys(body).slice(0, 30);
      } catch (e) {}
      let requestKeys = [];
      try { requestKeys = Object.keys(req).slice(0, 40); } catch (e) {}
      let headerKeys = [];
      try {
        const hs = req.headers;
        if (hs && typeof hs === 'object') headerKeys = Object.keys(hs).slice(0, 40);
      } catch (e) {}
      let rawBodyType = 'missing';
      try {
        const rawBody = req.body;
        rawBodyType = rawBody == null ? 'null' : (Array.isArray(rawBody) ? 'array' : typeof rawBody);
      } catch (e) {}

      // 只记录是否存在关键字段及 data 的结构，不输出 access 或业务数据本身。
      let hasAccess = false;
      try { hasAccess = !!String(getHeader(req.headers, 'access') || '').trim(); } catch (e) {}
      let dataType = body && body.data == null ? 'missing' : (body && Array.isArray(body.data) ? 'array' : typeof (body && body.data));
      let dataKeys = [];
      let dataLength = 0;
      let dataLooksBase64 = false;
      let dataParsesAsJson = false;
      try {
        if (body && body.data && typeof body.data === 'object') dataKeys = Object.keys(body.data).slice(0, 30);
        if (typeof (body && body.data) === 'string') {
          const dataText = body.data.trim();
          dataLength = dataText.length;
          dataLooksBase64 = dataText.length > 0 &&
            dataText.length % 4 === 0 &&
            /^[A-Za-z0-9+/]+={0,2}$/.test(dataText);
          try { JSON.parse(dataText); dataParsesAsJson = true; } catch (e) {}
        }
      } catch (e) {}

      console.log(
        '[ChinaBroadnet] API侦察[v20261024-1149]: ' +
        method + ' ' + url +
        (keys.length ? ' | keys=' + keys.join(',') : '') +
        ' | bodyType=' + bodyType +
        ' | bodyKeys=' + bodyKeys.join(',') +
        ' | dataType=' + dataType +
        ' | dataKeys=' + dataKeys.join(',') +
        ' | dataLength=' + dataLength +
        ' | dataLooksBase64=' + dataLooksBase64 +
        ' | dataParsesAsJson=' + dataParsesAsJson +
        ' | accessPresent=' + hasAccess +
        ' | rawBodyType=' + rawBodyType +
        ' | requestKeys=' + requestKeys.join(',') +
        ' | headerKeys=' + headerKeys.join(',')
      );
    } catch (e) {
      console.log('[ChinaBroadnet] probe error: ' + e);
    }
  }

  const matchedApi = SUPPORTED_API_URLS.find(api => url.startsWith(api));
  if (!matchedApi) return;
  if (method !== 'POST') return;

  try {
    const access = String(getHeader(req.headers, 'access') || '').trim();
    const body = await getParsedBody();
    if (!access || !body || body.data == null) {
      console.log('[ChinaBroadnet-Hark] 捕获未完成: ' + (!access ? '缺少 access 请求头' : '请求体中缺少 data'));
      return;
    }

    ctx.storage.set(KEY + '.url', url);
    ctx.storage.set(KEY + '.access', access);
    ctx.storage.setJSON(KEY + '.data', body.data);
    ctx.storage.set(KEY + '.captureTime', String(Date.now()));

    // 捕获成功通知独立开关；只提示已捕获并开始查询，不提前声称套餐查询成功。
    if ((!ctx.env || String(ctx.env.cbCaptureNotice).toLowerCase() !== 'false') &&
        typeof ctx.notify === 'function') {
      const source = detectCaptureSource(req);
      ctx.notify({
        title: '中国广电数据捕获成功',
        body: source + '数据捕获成功，正在查询套餐接口',
        sound: false,
      });
    }
  } catch (e) {
    console.log('[ChinaBroadnet-Hark] capture error: ' + e);
  }
}

async function fetchData(ctx, access, data, preferredUrl) {
  // 优先使用捕获到的域名；失败或业务状态异常时自动回退到其他支持的端点。
  const candidates = [preferredUrl, ...SUPPORTED_API_URLS.filter(u => u !== preferredUrl)].filter(Boolean);
  let lastErr = null;

  for (const targetUrl of candidates) {
    if (targetUrl.startsWith(BLOCKED_API_URL)) continue;
    try {
      const resp = await ctx.http.post(targetUrl, {
        timeout: 4500,
        headers: {
          access,
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        },
        body: { data },
      });

      if (resp && resp.status >= 200 && resp.status < 300) {
        const json = await resp.json();
        if (json && json.status === '000000') return json;
        lastErr = new Error('API业务状态异常：' + String(json && json.status || 'empty-response'));
      } else {
        lastErr = new Error('HTTP ' + (resp ? resp.status : 'no-response'));
      }
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error('所有可用接口更新均失败');
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '刚刚';
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 1) return '刚刚';
  if (totalMin < 60) return totalMin + '分';
  const hours = Math.floor(totalMin / 60);
  const remMin = totalMin % 60;
  if (hours < 24) return hours + '小时' + (remMin > 0 ? remMin + '分' : '');
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return days + '天' + (remHours > 0 ? remHours + '小时' : '');
}

// 数据新旧的自然描述（与联通一致）
function ageText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '刚刚';
  const min = Math.floor(ms / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + '分钟';
  const hours = Math.floor(min / 60);
  const restMin = min % 60;
  if (hours < 24) return hours + '小时' + (restMin > 0 ? restMin + '分' : '');
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return days + '天' + (restHours > 0 ? restHours + '小时' : '');
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

function saveHistory(ctx, flow) {
  try {
    const old = ctx.storage.getJSON(KEY + '.history') || [];
    const n = Number(flow);
    if (!Number.isFinite(n)) return old;

    const now = Date.now();
    const next = old.filter(x => now - Number(x.ts) < 7 * 86400000);
    const last = next[next.length - 1];
    if (!last || now - Number(last.ts) >= 25 * 60 * 1000 || Number(last.flowKB) !== n) {
      next.push({ ts: now, flowKB: n });
    }
    const trimmed = next.slice(-HISTORY_LIMIT);
    if (JSON.stringify(trimmed) !== JSON.stringify(old)) {
      ctx.storage.setJSON(KEY + '.history', trimmed);
    }
    return trimmed;
  } catch (e) {
    return [];
  }
}

async function loadData(ctx, options) {
  // 兼容旧调用：布尔值表示是否强制刷新；对象形式可附带 reason / bypassThrottle。
  const opts = typeof options === 'boolean' ? { forceRefresh: options } : (options || {});
  const forceRefresh = !!opts.forceRefresh;
  const reason = opts.reason || 'render';
  const bypassThrottle = !!opts.bypassThrottle;
  // 成功路径的响应结构/业务数值只在模块参数 cbDebug=true 时打印，默认不刷日志。
  const debug = String((ctx.env && ctx.env.cbDebug) || '').toLowerCase() === 'true';
  const debugLog = (...args) => { if (debug) console.log(...args); };
  // 关闭抓取时不再主动请求 qryUserInfo，仅展示最后一次成功缓存。
  if (ctx.env && String(ctx.env.cbCapture).toLowerCase() === 'false') {
    const cached = ctx.storage.getJSON(KEY + '.datasource') || null;
    if (cached) { cached.stale = true; const ts = Number(ctx.storage.get(KEY + '.captureTime') || 0); cached.captureDuration = ts > 0 ? formatDuration(Math.max(0, Number(cached.updatedAt || Date.now()) - ts)) : ''; }
    return { configured: !!cached, data: cached, fromCache: true, captureDisabled: true };
  }
  // 套餐缓存有效期调整为 15 分钟，提升数据实时性。
  const CACHE_TTL = 15 * 60 * 1000;
  const cachedData = ctx.storage.getJSON(KEY + '.datasource') || null;
  const currentCaptureTime = String(ctx.storage.get(KEY + '.captureTime') || '');
  const queriedCaptureTime = String(ctx.storage.get(KEY + '.queriedCaptureTime') || '');
  const cachedAt = Number(cachedData && cachedData.updatedAt || 0);
  const cacheAge = cachedAt > 0 ? Date.now() - cachedAt : Number.POSITIVE_INFINITY;
  const hasNewCapture = currentCaptureTime && currentCaptureTime !== queriedCaptureTime;
  const captureTs = Number(currentCaptureTime || 0);
  const captureDuration = captureTs > 0 ? formatDuration(Date.now() - captureTs) : '';
  // 缓存数据冻结在数据生成时刻，避免数据过期后「凭据保持」还在增长
  const cachedCaptureDuration = captureTs > 0
    ? formatDuration(Math.max(0, (cachedAt > 0 ? cachedAt : Date.now()) - captureTs))
    : '';

  // 15 分钟内且没有新捕获凭据时直接命中新鲜缓存；强制刷新时跳过缓存判断。
  if (!forceRefresh && cachedData && !hasNewCapture && cacheAge >= 0 && cacheAge < CACHE_TTL) {
    cachedData.stale = false;
    cachedData.captureDuration = cachedCaptureDuration;
    return { configured: true, data: cachedData, fromCache: true, skipped: true };
  }

  // 最近 15 秒内已经尝试过请求时先显示旧缓存，避免组件切屏/保活与渲染同时打接口。
  // 保活（forceRefresh）同样受此保护，只有手动强制刷新入口可以绕过。
  const lastAttemptAt = Number(ctx.storage.get(KEY + '.lastAttemptAt') || 0);
  const attemptAge = Date.now() - lastAttemptAt;
  if (!bypassThrottle && cachedData && !hasNewCapture && lastAttemptAt > 0 &&
      attemptAge >= 0 && attemptAge < 15000) {
    cachedData.stale = true;
    cachedData.captureDuration = cachedCaptureDuration;
    return { configured: true, data: cachedData, fromCache: true, skipped: true };
  }

  // SWR：缓存过期时先返回旧数据渲染，同时启动一次后台刷新；新捕获凭据则仍立即同步查询。
  if (!forceRefresh && cachedData && !hasNewCapture && cacheAge >= CACHE_TTL) {
    const accessForRefresh = ctx.storage.get(KEY + '.access');
    const dataForRefresh = ctx.storage.getJSON(KEY + '.data');
    if (accessForRefresh && dataForRefresh != null) {
      cachedData.stale = true;
      cachedData.captureDuration = cachedCaptureDuration;
      ctx.storage.set(KEY + '.lastAttemptAt', String(Date.now()));
      refreshNow(ctx, 'swr', { force: true, bypassThrottle: true }).catch(e => {
        console.log('[ChinaBroadnet-Hark] 后台静默刷新异常: ' + e);
      });
      return { configured: true, data: cachedData, fromCache: true, skipped: true };
    }
  }

  const access = ctx.storage.get(KEY + '.access');
  const data = ctx.storage.getJSON(KEY + '.data');
  const url = ctx.storage.get(KEY + '.url') || API_URL;

  if (!access || data == null) {
    return { configured: false, data: null };
  }

  try {
    ctx.storage.set(KEY + '.lastAttemptCaptureTime', currentCaptureTime);
    ctx.storage.set(KEY + '.lastAttemptAt', String(Date.now()));
    ctx.storage.set(KEY + '.lastRefreshReason', reason);
    const result = await fetchData(ctx, access, data, url);
    // 仅记录响应结构与字段是否存在，不记录手机号、令牌或业务字段原值。
    const responseUser = result && result.data && (result.data.userData || result.data);
    const responseKeys = result && typeof result === 'object' ? Object.keys(result).slice(0, 20) : [];
    const responseDataKeys = result && result.data && typeof result.data === 'object'
      ? Object.keys(result.data).slice(0, 30)
      : [];
    const responseUserKeys = responseUser && typeof responseUser === 'object'
      ? Object.keys(responseUser).filter(k => /^(voice|flow|flowUserd|flowAll|voiceAll|voiceUsed|fee|finBalance|packName)$/.test(k))
      : [];
    debugLog(
      '[ChinaBroadnet-Hark] API响应诊断[v20261024-1149]: ' +
      'status=' + String(result && result.status) +
      ' | ok=' + String(result && result.ok) +
      ' | resultKeys=' + responseKeys.join(',') +
      ' | dataType=' + (result && result.data === null ? 'null' : typeof (result && result.data)) +
      ' | dataKeys=' + responseDataKeys.join(',') +
      ' | userDataPresent=' + Boolean(result && result.data && result.data.userData) +
      ' | userDataKeys=' + responseUserKeys.join(',') +
      ' | flowFieldsComplete=' + Boolean(responseUser &&
        responseUser.flowAll != null && responseUser.flowUserd != null && responseUser.flow != null) +
      ' | flowSumMatches=' + Boolean(responseUser &&
        Number(responseUser.flowUserd) + Number(responseUser.flow) === Number(responseUser.flowAll))
    );
    if (!result || result.status !== '000000' || !result.data) {
      const resultKeys = result && typeof result === 'object'
        ? Object.keys(result).slice(0, 20)
        : [];
      const responseDataKeys = result && result.data && typeof result.data === 'object'
        ? Object.keys(result.data).slice(0, 30)
        : [];
      console.log(
        '[ChinaBroadnet-Hark] API响应诊断[v20261019-2318]: ' +
        'resultType=' + (result === null ? 'null' : typeof result) +
        ' | status=' + String(result && result.status).slice(0, 40) +
        ' | message=' + String(result && result.message || '').replace(/[\\r\\n]+/g, ' ').slice(0, 120) +
        ' | updateMes=' + String(result && result.updateMes || '').replace(/[\\r\\n]+/g, ' ').slice(0, 120) +
        ' | ok=' + String(result && result.ok) +
        ' | resultKeys=' + resultKeys.join(',') +
        ' | dataPresent=' + Boolean(result && result.data) +
        ' | dataType=' + (result && result.data === null ? 'null' : typeof (result && result.data)) +
        ' | dataKeys=' + responseDataKeys.join(',')
      );
      throw new Error('API 返回异常');
    }

    const user = result.data.userData || result.data;

    const planFields = scanPlanFields(result.data);
    const totalField = pickPlanMetric(planFields, 'total');
    const usedField = pickPlanMetric(planFields, 'used');
    const remainField = pickPlanMetric(planFields, 'remain');
    const planPercent = calcPlanPercent(
      totalField && totalField.value,
      usedField && usedField.value,
      remainField && remainField.value
    );

    ctx.storage.setJSON(KEY + '.planDebug', {
      capturedAt: Date.now(),
      fields: planFields,
      total: totalField,
      used: usedField,
      remain: remainField,
      percent: planPercent,
    });

    const feeRaw = findValue(user, ['fee', 'balance', 'money', 'remainFee']);
    const flowTotalRaw = findValue(user, ['flowAll']);
    const flowUsedRaw = findValue(user, ['flowUserd']);
    const flowRaw = findValue(user, ['flow', 'remainFlow', 'flowRemain']);
    const voiceTotalRaw = findValue(user, ['voiceAll']);
    const voiceUsedRaw = findValue(user, ['voiceUsed']);
    const voiceRaw = findValue(user, ['voice', 'remainVoice', 'voiceRemain']);

    const flowTotal = flowTotalRaw != null ? Number(flowTotalRaw) : (totalField && /flow/i.test(totalField.path) ? totalField.value : null);
    const flowUsed = flowUsedRaw != null ? Number(flowUsedRaw) : (usedField && /flow/i.test(usedField.path) ? usedField.value : null);
    const flowRemain = flowRaw != null ? Number(flowRaw) : (remainField && /flow/i.test(remainField.path) ? remainField.value : null);
    const voiceTotal = voiceTotalRaw != null ? Number(voiceTotalRaw) : (totalField && /voice/i.test(totalField.path) ? totalField.value : null);
    const voiceUsed = voiceUsedRaw != null ? Number(voiceUsedRaw) : (usedField && /voice/i.test(usedField.path) ? usedField.value : null);
    const voiceRemain = voiceRaw != null ? Number(voiceRaw) : (remainField && /voice/i.test(remainField.path) ? remainField.value : null);

    const flow = formatFlow(flowRemain);
    const flowPercent = calcPlanPercent(flowTotal, flowUsed, flowRemain);
    const voicePercent = calcPlanPercent(voiceTotal, voiceUsed, voiceRemain);
    const history = saveHistory(ctx, flowRemain);

    const ds = {
      stale: false,
      captureDuration,
      fee: {
        title: '剩余话费',
        number: formatFee(feeRaw),
        unit: '元',
      },
      flow: {
        title: '剩余流量',
        number: flow.number,
        unit: flow.unit,
      },
      voice: {
        title: '剩余语音',
        number: formatVoice(voiceRemain),
        unit: '分钟',
      },
      updatedAt: Date.now(),
      history,
      plan: {
        total: flowTotal,
        used: flowUsed,
        remain: flowRemain,
        percent: flowPercent,
        totalPath: flowTotalRaw != null ? 'userData.flowAll' : (totalField ? totalField.path : null),
        usedPath: flowUsedRaw != null ? 'userData.flowUserd' : (usedField ? usedField.path : null),
        remainPath: flowRaw != null ? 'userData.flow' : (remainField ? remainField.path : null),
        voiceTotal,
        voiceUsed,
        voiceRemain,
        voicePercent,
      },
    };

    ctx.storage.setJSON(KEY + '.datasource', ds);
    if (currentCaptureTime) ctx.storage.set(KEY + '.queriedCaptureTime', currentCaptureTime);

    // 每次新捕获只发送一次完整套餐通知；小组件每分钟刷新不会重复打扰。
    const captureTime = String(ctx.storage.get(KEY + '.captureTime') || '');
    const notifiedCaptureTime = String(ctx.storage.get(KEY + '.notifiedCaptureTime') || '');
    if (captureTime && captureTime !== notifiedCaptureTime) {
      if ((!ctx.env || String(ctx.env.cbPlanNotice).toLowerCase() !== 'false') &&
          typeof ctx.notify === 'function') {
      const totalFlowText = formatFlow(flowTotal);
      const usedFlowText = formatFlow(flowUsed);
      const remainFlowText = formatFlow(flowRemain);
      const body = [
        '剩余话费：¥' + formatFee(feeRaw),
        '流量：已用 ' + usedFlowText.number + ' ' + usedFlowText.unit +
          ' / 总量 ' + totalFlowText.number + ' ' + totalFlowText.unit,
        '剩余流量：' + remainFlowText.number + ' ' + remainFlowText.unit,
        '语音：剩余 ' + formatVoice(voiceRemain) + ' / 总量 ' +
          formatVoice(voiceTotal) + ' 分钟',
      ].join('\n');
      ctx.notify({
        title: '中国广电套餐查询成功',
        body,
        sound: false,
      });
      }
      // 即使关闭通知也标记已处理，避免之后刷新时补发旧捕获的通知。
      ctx.storage.set(KEY + '.notifiedCaptureTime', captureTime);
    }

    // 直接输出接口已确认的套餐字段，避免依赖递归扫描结果而漏掉字段。
    debugLog(
      '[ChinaBroadnet-Hark] 套餐字段探测: ' +
      'userData.voice=' + String(user.voice) +
      ', userData.flowUserd=' + String(user.flowUserd) +
      ', userData.voiceAll=' + String(user.voiceAll) +
      ', userData.fee=' + String(user.fee) +
      ', userData.flowAll=' + String(user.flowAll) +
      ', userData.voiceUsed=' + String(user.voiceUsed) +
      ', userData.flow=' + String(user.flow)
    );


    return { configured: true, data: ds, fromCache: false };
  } catch (e) {
    console.log('[ChinaBroadnet-Hark] query error: ' + e);
    return {
      configured: true,
      data: (() => {
        const cached = ctx.storage.getJSON(KEY + '.datasource') || null;
        if (cached) cached.stale = true;
        return cached;
      })(),
      fromCache: true,
    };
  }
}


/* =========================================================
 * 保活模式（schedule 定时任务调用）
 * 触达服务端的同时强制刷新套餐数据，并复用 loadData 的历史记录与存储逻辑
 * ========================================================= */
function parseKeepAliveInterval(value) {
  // 参数只接受正整数，单位固定为分钟；无效输入回退到默认 15 分钟。
  const raw = String(value == null ? '15' : value).trim();
  if (!/^[0-9]+$/.test(raw)) return 15 * 60 * 1000;
  const minutes = Number(raw);
  if (!Number.isSafeInteger(minutes) || minutes <= 0) return 15 * 60 * 1000;
  return Math.max(15 * 60 * 1000, Math.min(24 * 60 * 60 * 1000, minutes * 60 * 1000));
}

/* =========================================================
 * 保活模式（schedule 每分钟触发，由用户输入的易读间隔控制实际执行频率）
 * ========================================================= */
// 所有主动刷新（渲染 SWR / 定时保活 / 手动刷新）共用同一入口，统一记录来源。
async function refreshNow(ctx, reason, options) {
  const opts = options || {};
  return loadData(ctx, {
    forceRefresh: !!opts.force,
    bypassThrottle: !!opts.bypassThrottle,
    reason,
  });
}

// 保活连续失败：指数退避 + 每连续 3 次以上发一条通知（60 分钟限频）。
function registerKeepAliveFailure(ctx, reason) {
  const fails = Number(ctx.storage.get(KEY + '.keepAliveFailCount') || 0) + 1;
  ctx.storage.set(KEY + '.keepAliveFailCount', String(fails));
  console.log('[ChinaBroadnet] 保活失败（连续 ' + fails + ' 次）：' + reason);
  if (fails < 3) return;
  const lastNotify = Number(ctx.storage.get(KEY + '.keepAliveFailNotifyAt') || 0);
  if (Date.now() - lastNotify < 60 * 60 * 1000) return;
  if (typeof ctx.notify !== 'function') return;
  ctx.storage.set(KEY + '.keepAliveFailNotifyAt', String(Date.now()));
  ctx.notify({
    title: '中国广电保活失败',
    body: '已连续 ' + fails + ' 次未能更新套餐数据，凭据可能失效，请打开中国广电 App 查询一次',
    sound: false,
  });
}

async function handleKeepAlive(ctx) {
  const env = ctx && ctx.env ? ctx.env : {};
  const intervalMs = parseKeepAliveInterval(env.cbKeepaliveInterval == null ? '15' : env.cbKeepaliveInterval);
  const forceManual = String(env.CB_KEEPALIVE_FORCE || '').toLowerCase() === 'true';
  const debug = String(env.cbDebug || '').toLowerCase() === 'true';
  const tag = forceManual ? '手动强制刷新' : '定时保活';
  const now = Date.now();
  const lastRun = Number(ctx.storage.get(KEY + '.keepAliveLastRun') || 0);

  // 1) 按用户设置的间隔节流；手动强制入口不受限。
  if (!forceManual && lastRun && now - lastRun < intervalMs) return;

  // 2) 未捕获凭据：日志每 6 小时最多一条，避免 cron 每分钟刷屏。
  const access = ctx.storage.get(KEY + '.access');
  const data = ctx.storage.getJSON(KEY + '.data');
  if (!access || data == null) {
    const lastSkip = Number(ctx.storage.get(KEY + '.keepAliveSkipLoggedAt') || 0);
    if (!lastSkip || now - lastSkip > 6 * 60 * 60 * 1000) {
      ctx.storage.set(KEY + '.keepAliveSkipLoggedAt', String(now));
      console.log('[ChinaBroadnet] 保活跳过：尚未捕获有效凭据（每 6 小时提示一次）');
    }
    return;
  }

  // 3) 数据 2 分钟内刚更新过（用户正在看组件或刚刷新），本轮不必再打接口。
  const lastUpdated = Number((ctx.storage.getJSON(KEY + '.datasource') || {}).updatedAt || 0);
  if (!forceManual && lastUpdated && now - lastUpdated < 2 * 60 * 1000) {
    if (debug) console.log('[ChinaBroadnet] 保活跳过：数据 2 分钟内刚更新过');
    return;
  }

  // 4) 连续失败按指数退避，最长 60 分钟，避免凭据失效后每轮都打接口。
  const failCount = Number(ctx.storage.get(KEY + '.keepAliveFailCount') || 0);
  if (!forceManual && failCount > 0) {
    const backoff = Math.min(intervalMs * Math.pow(2, failCount), 60 * 60 * 1000);
    if (lastRun && now - lastRun < backoff) {
      if (debug) {
        console.log('[ChinaBroadnet] 保活退避中：连续失败 ' + failCount +
          ' 次，下次至少 ' + Math.round(backoff / 60000) + ' 分钟后');
      }
      return;
    }
  }

  const previousLastRun = ctx.storage.get(KEY + '.keepAliveLastRun');
  ctx.storage.set(KEY + '.keepAliveLastRun', String(now));

  try {
    const res = await refreshNow(ctx, forceManual ? 'manual' : 'keepalive', {
      force: true,
      bypassThrottle: forceManual,
    });
    // 命中断流/缓存（15 秒内刚有刷新）不算失败，也不占用本轮间隔。
    if (res && res.skipped) {
      if (previousLastRun) ctx.storage.set(KEY + '.keepAliveLastRun', String(previousLastRun));
      else ctx.storage.delete(KEY + '.keepAliveLastRun');
      if (debug) console.log('[ChinaBroadnet] ' + tag + '跳过：刚刚已有刷新进行中');
      return;
    }
    const ok = res && res.data && !res.data.stale && !res.fromCache;
    if (ok) {
      if (failCount > 0) ctx.storage.delete(KEY + '.keepAliveFailCount');
      if (debug) console.log('[ChinaBroadnet] ' + tag + '成功：已写入最新套餐数据');
      return;
    }
    registerKeepAliveFailure(ctx, res && res.data ? '数据未完全更新（可开启 cbDebug 查看详情）' : '接口未返回数据');
  } catch (e) {
    registerKeepAliveFailure(ctx, String((e && e.message) || e));
  }
}

function fontSize(size) {
  if (typeof size === 'number') {
    if (size <= 8) return 9;
    if (size <= 10) return 10;
    if (size <= 13) return 12;
    if (size <= 19) return 16;
    return 24;
  }

  const named = {
    caption2: 9,
    caption1: 10,
    footnote: 12,
    body: 16,
    title3: 20,
    title2: 22,
    title: 24,
  };
  return named[size] || 12;
}

function t(text, size, weight, color, extra) {
  return Object.assign({
    type: 'text',
    text: String(text),
    font: { size: fontSize(size), weight: weight || 'regular' },
    textColor: color || C.txt,
    maxLines: 1,
    minScale: 0.6,
  }, extra || {});
}

function glass(children, extra) {
  // 所有尺寸共用单一外层玻璃；此 helper 只负责透明布局，不再绘制内层卡片。
  return Object.assign({
    type: 'stack',
    direction: 'column',
    gap: 6,
    padding: [8, 10],
    borderRadius: 16,
    backgroundColor: { light: '#00000000', dark: '#00000000' },
    borderWidth: 0,
    borderColor: { light: '#00000000', dark: '#00000000' },
    shadowRadius: 0,
    children,
  }, extra || {}, {
    backgroundColor: { light: '#00000000', dark: '#00000000' },
    borderWidth: 0,
    borderColor: { light: '#00000000', dark: '#00000000' },
    shadowRadius: 0,
  });
}

function gaugeSvg(pct, color, w) {
  const stroke = 11;
  const r = (w - stroke) / 2;
  const cx = w / 2;
  const cy = w / 2;
  const h = w / 2 + stroke / 2;
  const p = Math.max(0, Math.min(1, Number(pct) || 0));

  const pt = a => [
    (cx - r * Math.cos(a)).toFixed(2),
    (cy - r * Math.sin(a)).toFixed(2),
  ];

  const [x0, y0] = pt(0);
  const [x1, y1] = pt(Math.PI);
  const [xp, yp] = pt(Math.PI * p);

  let body =
    `<path d='M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}' fill='none' stroke='${color}' stroke-opacity='0.18' stroke-width='${stroke}' stroke-linecap='round'/>`;

  if (p > 0.005) {
    body +=
      `<path d='M ${x0} ${y0} A ${r} ${r} 0 0 1 ${xp} ${yp}' fill='none' stroke='${color}' stroke-width='${stroke}' stroke-linecap='round'/>`;
  }

  return 'data:image/svg+xml,' +
    encodeURIComponent(
      `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}'>${body}</svg>`
    );
}

function flowStatus(pct) {
  if (pct == null || !Number.isFinite(Number(pct))) {
    return { color: C.flow, label: '套餐用量' };
  }
  const p = Number(pct);
  if (p >= 0.9) return { color: '#C4475B', label: '用量偏高' };
  if (p >= 0.7) return { color: C.fee, label: '注意余量' };
  // 用量正常与「无使用率数据」统一用蓝色，避免同一仪表盘出现两种主色
  return { color: C.flow, label: '用量正常' };
}

function trendStrip(ds) {
  const today = todayFlowUsage(ds.history);
  const used = today.value == null ? null : formatFlow(today.value);
  return glass([
    {
      type: 'stack',
      direction: 'row',
      alignItems: 'center',
      gap: 6,
      children: [
        ...(used
          ? [{
              type: 'image',
              src: historySvg(today.history, C.flow, 100, 30),
              width: 72,
              height: 22,
            }]
          : []),
        {
          type: 'stack',
          direction: 'column',
          alignItems: 'start',
          gap: 1,
          flex: 1,
          children: [
            t('今日流量使用', 9, 'semibold', C.txt),
            t(today.label, 8, 'medium', C.sub, { minScale: 0.65 }),
          ],
        },
        ...(used ? [t(used.number + ' ' + used.unit, 9, 'bold', C.flow, { minScale: 0.7 })] : []),
      ],
    },
  ], {
    height: 42,
    padding: [5, 8],
    borderRadius: 13,
    gap: 0,
    backgroundColor: transparentMode ? { light: '#00000000', dark: '#00000000' } : { light: '#F8FAFCD9', dark: '#172638D9' },
    borderColor: transparentMode ? { light: '#00000000', dark: '#00000000' } : { light: '#FFFFFFF2', dark: '#D7E7F0B0' },
  });
}

function historySvg(history, color, w, h) {
  const vals = (history || []).map(x => Number(x.flowKB)).filter(Number.isFinite).slice(-12);
  const baseline = h - 2;
  const empty = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}'><path d='M 2 ${baseline} H ${w-2}' stroke='${color}' stroke-opacity='.22' stroke-width='1.5' stroke-linecap='round' stroke-dasharray='3 4'/></svg>`;
  // 只有一个采样点时会变成一根满高柱子（看起来像实心方块），直接退回虚线基线
  if (vals.length < 2) return 'data:image/svg+xml,' + encodeURIComponent(empty);

  const max = Math.max(1, ...vals);
  const padX = Math.min(3, w * 0.025);
  const gap = Math.max(2, Math.min(5, w * 0.035));
  const count = vals.length;
  const barW = Math.max(2, (w - padX * 2 - gap * (count - 1)) / count);
  const usableH = h - 5;
  const bars = vals.map((v, i) => {
    const bh = Math.max(2, (Math.max(0, v) / max) * usableH);
    const x = padX + i * (barW + gap);
    const y = baseline - bh;
    const opacity = i === count - 1 ? 1 : 0.48 + 0.42 * ((i + 1) / count);
    return `<rect x='${x.toFixed(1)}' y='${y.toFixed(1)}' width='${barW.toFixed(1)}' height='${bh.toFixed(1)}' rx='${Math.min(2, barW / 2).toFixed(1)}' fill='${color}' fill-opacity='${opacity.toFixed(2)}'/>`;
  }).join('');
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${w} ${h}'><path d='M 1 ${baseline} H ${w-1}' stroke='${color}' stroke-opacity='.12' stroke-width='1'/>${bars}</svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

function heroFlowCard(ds, cardHeight, cardFlex, isMedium) {
  const remain = ds.flow.number + ' ' + ds.flow.unit;
  const total = ds.plan && ds.plan.total != null ? formatFlow(ds.plan.total) : null;
  const used = ds.plan && ds.plan.used != null ? formatFlow(ds.plan.used) : null;
  const compactFlowDetail = !cardHeight
    ? '总量 ' + (total ? total.number + ' ' + total.unit : '--') + ' · 已用 ' + (used ? used.number + ' ' + used.unit : '--')
    : '';
  const p = ds.plan && ds.plan.percent != null ? ds.plan.percent : null;
  const flowStyle = flowStatus(p);
  const flowContent = isMedium
    ? {
        // 中号：左侧显示剩余数值和套餐详情，右侧显示缩小的半圆仪表盘。
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 6,
        children: [
          {
            type: 'stack',
            direction: 'column',
            alignItems: 'start',
            gap: 2,
            flex: 1,
            children: [
              t(remain, cardHeight ? 22 : 19, 'bold', C.txt, { minScale: 0.55 }),
              t(compactFlowDetail || '当前剩余', 8, 'medium', C.sub, { minScale: 0.45 }),
            ],
          },
          {
            type: 'stack',
            direction: 'column',
            alignItems: 'center',
            gap: 0,
            children: [
              {
                type: 'image',
                src: gaugeSvg(p != null ? p : 0, flowStyle.color, 68),
                width: 44,
                height: 24,
              },
              t(p != null ? Math.round(p * 100) + '% 已用' : '—', 8, 'bold', flowStyle.color),
            ],
          },
        ],
      }
    : {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 12,
        children: [
          {
            type: 'stack',
            direction: 'column',
            alignItems: 'center',
            gap: -2,
            children: [
              {
                type: 'image',
                src: gaugeSvg(p != null ? p : 0, flowStyle.color, 86),
                width: 64,
                height: 34,
              },
              t(p != null ? Math.round(p * 100) + '% 已用' : '—', 10, 'bold', flowStyle.color),
            ],
          },
          {
            type: 'stack',
            direction: 'column',
            alignItems: 'start',
            gap: 1,
            flex: 1,
            children: [
              t(remain, cardHeight ? 23 : 20, 'bold', C.txt, { minScale: 0.55 }),
              t('当前剩余', 9, 'medium', C.sub),
              ...(!cardHeight ? [t(compactFlowDetail, 8, 'medium', C.sub, { minScale: 0.45 })] : []),
            ],
          },
        ],
      };
  return glass([
    {
      type: 'stack',
      direction: 'row',
      alignItems: 'center',
      gap: 6,
      children: [
        {
          type: 'image',
          src: 'sf-symbol:chart.pie.fill',
          width: 13,
          height: 13,
          color: C.flow,
        },
        t('流量主卡', 10, 'semibold', C.txt),
        { type: 'spacer' },
      ],
    },
    flowContent,
  ], {
    width: 0,
    flex: cardFlex || 1,
    ...(cardHeight ? { height: cardHeight, maxWidth: 360 } : {}),
    padding: [8, 10],
    borderRadius: 18,
    gap: 4,
    backgroundColor: transparentMode ? { light: '#00000000', dark: '#00000000' } : { light: '#F8FAFCD9', dark: '#172638D9' },
    borderColor: transparentMode ? { light: '#00000000', dark: '#00000000' } : { light: '#FFFFFFF2', dark: '#D7E7F0B0' },
    shadowColor: { light: '#52677A18', dark: '#00000028' },
    shadowRadius: 0,
    shadowOffset: { x: 0, y: 0 },
  });
}

function header(title, ds, fromCache, mediumInset) {
  const dur = ds.captureDuration ? ' · 凭据保持 ' + ds.captureDuration : '';
  const staleView = Boolean(ds.stale);
  const ageMs = ds.updatedAt ? Date.now() - Number(ds.updatedAt) : null;
  const expired = staleView && ageMs != null && ageMs > 24 * 60 * 60 * 1000;
  const when = staleView
    ? '缓存 ' + (ageMs != null ? ageText(ageMs) + '前' : fmtTime(ds.updatedAt))
    : '更新 ' + fmtTime(ds.updatedAt);
  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    padding: mediumInset ? [4, 6] : 0,
    gap: 5,
    children: [
      {
        type: 'image',
        src: 'sf-symbol:antenna.radiowaves.left.and.right',
        width: 13,
        height: 13,
        color: C.flow,
      },
      t(title, 'footnote', 'semibold', C.txt),
      { type: 'spacer' },
      t(`${when}${dur}`, 9, 'medium', expired ? C.fee : C.sub, {
        minScale: 0.55,
      }),
    ],
  };
}

// 数据是缓存/过期时尽快重渲染，让后台刷新的结果尽快呈现；正常数据维持 15 分钟。
function nextRefreshAfter(ds) {
  const delay = ds && ds.stale ? 2 * 60 * 1000 : 15 * 60 * 1000;
  return new Date(Date.now() + delay).toISOString();
}

function buildSmall(title, ds, fromCache) {
  const dur = ds.captureDuration ? ' · ' + ds.captureDuration : '';
  const staleView = Boolean(ds.stale);
  const ageMs = ds.updatedAt ? Date.now() - Number(ds.updatedAt) : null;
  const expired = staleView && ageMs != null && ageMs > 24 * 60 * 60 * 1000;
  const p = ds.plan && ds.plan.percent != null ? ds.plan.percent : null;
  const flowStyle = flowStatus(p);
  const remain = ds.flow.number + ' ' + ds.flow.unit;
  const used = ds.plan && ds.plan.used != null
    ? formatFlow(ds.plan.used).number + ' ' + formatFlow(ds.plan.used).unit
    : '--';
  const total = ds.plan && ds.plan.total != null
    ? formatFlow(ds.plan.total).number + ' ' + formatFlow(ds.plan.total).unit
    : '--';

  return {
    type: 'widget',
    padding: [13, 13],
    gap: 6,
    backgroundColor: '#00000000',
    refreshAfter: nextRefreshAfter(ds),
    children: [
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 5,
        children: [
          {
            type: 'image',
            src: 'sf-symbol:antenna.radiowaves.left.and.right',
            width: 12,
            height: 12,
            color: C.flow,
          },
          t(title, 12, 'semibold', C.txt),
          { type: 'spacer' },
          t(`${staleView && ageMs != null ? '缓存 ' + ageText(ageMs) + '前' : fmtTime(ds.updatedAt)}${dur}`, 8, 'medium', expired ? C.fee : C.sub, { minScale: 0.45 }),
        ],
      },

      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 4,
        flex: 1,
        children: [
          {
            type: 'stack',
            direction: 'column',
            alignItems: 'start',
            gap: 2,
            flex: 1,
            children: [
              t('剩余流量', 9, 'medium', C.sub),
              {
                type: 'stack',
                direction: 'row',
                alignItems: 'end',
                gap: 2,
                children: [
                  t(ds.flow.number, 23, 'bold', C.txt, { minScale: 0.35 }),
                  t(ds.flow.unit, 9, 'semibold', C.sub, { minScale: 0.7 }),
                ],
              },
              {
                type: 'stack',
                direction: 'column',
                alignItems: 'start',
                gap: 2,
                children: [
                  t(
                    ds.plan && ds.plan.used != null
                      ? '已用 ' + used
                      : '已用量待确认',
                    8,
                    'semibold',
                    flowStyle.color,
                    { minScale: 0.65 }
                  ),
                  t(
                    ds.plan && ds.plan.total != null
                      ? '总量 ' + total
                      : (ds.plan && ds.plan.remain != null
                        ? '余量 ' + formatFlow(ds.plan.remain).number + ' ' + formatFlow(ds.plan.remain).unit
                        : '总量待确认'),
                    8,
                    'medium',
                    C.sub,
                    { minScale: 0.45 }
                  ),
                ],
              },
            ],
          },
          {
            type: 'stack',
            direction: 'column',
            alignItems: 'center',
            gap: -2,
            children: [
              {
                type: 'image',
                src: gaugeSvg(p, flowStyle.color, 78),
                width: 44,
                height: 27,
              },
              t(
                p != null ? Math.round(p * 100) + '% 已用' : '套餐',
                8,
                'bold',
                flowStyle.color
              ),
              t(
                (() => {
                  const today = todayFlowUsage(ds.history);
                  return today.value != null
                    ? '今日 ' + formatFlow(today.value).number + formatFlow(today.value).unit
                    : '今日采集中';
                })(),
                8,
                'medium',
                C.sub,
                { minScale: 0.6 }
              ),
            ],
          },
        ],
      },

      {
        type: 'stack',
        direction: 'row',
        gap: 5,
        children: [
          glass([
            { type: 'stack', direction: 'row', alignItems: 'center', gap: 3, children: [
              { type: 'image', src: 'sf-symbol:phone.fill', width: 10, height: 10, color: C.voice },
              t('剩余语音', 8, 'medium', C.sub),
            ]},
            { type: 'stack', direction: 'row', alignItems: 'end', gap: 2, children: [
              t(ds.voice.number === '--' ? '暂无' : ds.voice.number, 18, 'bold', C.txt, { minScale: 0.4 }),
              t(ds.voice.number === '--' ? '' : '分钟', 8, 'semibold', C.sub),
            ]},
          ], { width: 0, flex: 1, height: 48, padding: [7, 7], gap: 4, borderRadius: 15 }),
          glass([
            { type: 'stack', direction: 'row', alignItems: 'center', gap: 3, children: [
              { type: 'image', src: 'sf-symbol:yensign.circle.fill', width: 10, height: 10, color: C.fee },
              t('剩余话费', 8, 'medium', C.sub),
            ]},
            { type: 'stack', direction: 'row', alignItems: 'end', gap: 2, children: [
              t('¥', 10, 'semibold', C.fee),
              t(ds.fee.number, 18, 'bold', C.txt, { minScale: 0.4 }),
            ]},
          ], { width: 0, flex: 1, height: 48, padding: [7, 7], gap: 4, borderRadius: 15 }),
        ],
      }
    ],
  };
}

function buildMedium(title, ds, fromCache) {
  // 中号内容增加内缩留白，避免标题与信息区贴近玻璃卡片边缘。
  const compactFee = glass([
    {
      type: 'stack',
      direction: 'row',
      alignItems: 'center',
      gap: 4,
      children: [
        {
          type: 'image',
          src: 'sf-symbol:yensign.circle.fill',
          width: 10,
          height: 10,
          color: C.fee,
        },
        t('话费', 9, 'medium', C.sub),
        { type: 'spacer' },
        t('¥' + ds.fee.number, 15, 'bold', C.txt, { minScale: 0.6 }),
      ],
    },
  ], {
    flex: 1,
    padding: [6, 8],
    gap: 1,
    borderRadius: 14,
    justifyContent: 'center',
  });

  const compactVoice = glass([
    {
      type: 'stack',
      direction: 'row',
      alignItems: 'center',
      gap: 4,
      children: [
        {
          type: 'image',
          src: 'sf-symbol:phone.fill',
          width: 10,
          height: 10,
          color: C.voice,
        },
        t('语音', 9, 'medium', C.sub),
        { type: 'spacer' },
        t(ds.voice.number, 15, 'bold', C.txt, { minScale: 0.6 }),
        t('分', 8, 'semibold', C.sub),
      ],
    },

  ], {
    flex: 1,
    padding: [6, 8],
    gap: 1,
    borderRadius: 14,
  });

  const row = {
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    gap: 5,
    children: [
      heroFlowCard(ds, null, null, true),
      {
        type: 'stack',
        direction: 'column',
        alignItems: 'center',
        gap: 5,
        width: 100,
        children: [
          compactFee,
          compactVoice,
        ],
      },
    ],
  };

  return {
    type: 'widget',
    padding: [12, 14],
    gap: 6,
    backgroundColor: { light: '#F4F7FB', dark: '#161B22' },
    refreshAfter: nextRefreshAfter(ds),
    children: [
      header(title, ds, fromCache, true),
      row,
      trendStrip(ds),
    ],
  };
}


function todayFlowUsage(history) {
  const now = new Date();
  const todayKey = now.getFullYear() + '-' + (now.getMonth() + 1) + '-' + now.getDate();
  const today = (history || [])
    .filter(x => {
      const ts = Number(x.ts);
      if (!Number.isFinite(ts)) return false;
      const d = new Date(ts);
      return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() === todayKey;
    })
    .sort((a, b) => Number(a.ts) - Number(b.ts));

  if (today.length < 2) {
    return { value: null, history: today, label: '今日数据采集中' };
  }

  const first = Number(today[0].flowKB);
  const last = Number(today[today.length - 1].flowKB);
  if (!Number.isFinite(first) || !Number.isFinite(last)) {
    return { value: null, history: today, label: '今日数据采集中' };
  }

  const value = Math.max(0, first - last);
  return {
    value,
    history: today.map(x => ({
      ts: x.ts,
      flowKB: Math.max(0, first - Number(x.flowKB)),
    })),
    label: value < 1 ? '今日暂无明显消耗' : '按今日已记录余量变化估算',
  };
}

function buildLarge(title, ds, fromCache) {
  const staleView = Boolean(ds.stale);
  const ageMs = ds.updatedAt ? Date.now() - Number(ds.updatedAt) : null;
  const expired = staleView && ageMs != null && ageMs > 24 * 60 * 60 * 1000;
  const plan = ds.plan || {};
  const total = plan.total != null ? formatFlow(plan.total) : null;
  const usedFlow = plan.used != null ? formatFlow(plan.used) : null;
  const remain = plan.remain != null ? formatFlow(plan.remain) : null;
  const voicePct = plan.voicePercent != null
    ? Math.max(0, Math.min(1, Number(plan.voicePercent)))
    : null;
  const voiceUsed = plan.voiceUsed != null ? formatVoice(plan.voiceUsed) : null;
  const voiceTotal = plan.voiceTotal != null ? formatVoice(plan.voiceTotal) : null;
  const p = plan.percent != null ? Math.max(0, Math.min(1, Number(plan.percent))) : null;
  const flowStyle = flowStatus(p);
  const today = todayFlowUsage(ds.history);
  const todayUsed = today.value == null ? null : formatFlow(today.value);

  // 大号组件内部只排版内容，不创建子卡片；玻璃背景由 liquidGlassWidget 统一提供。
  return {
    type: 'widget',
    padding: [16, 17],
    gap: 9,
    backgroundColor: '#00000000',
    refreshAfter: nextRefreshAfter(ds),
    children: [
      header(title, ds, fromCache),
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 12,
        height: 112,
        children: [
          {
            type: 'stack',
            direction: 'column',
            alignItems: 'start',
            justifyContent: 'center',
            gap: 7,
            flex: 1.25,
            children: [
              {
                type: 'stack',
                direction: 'row',
                alignItems: 'center',
                gap: 5,
                children: [
                  { type: 'image', src: 'sf-symbol:chart.pie.fill', width: 13, height: 13, color: C.flow },
                  t('剩余流量', 10, 'semibold', C.sub),
                  { type: 'spacer' },
                ],
              },
              {
                type: 'stack',
                direction: 'row',
                alignItems: 'end',
                gap: 3,
                children: [
                  t(ds.flow.number, 29, 'bold', C.txt, { minScale: 0.45 }),
                  t(ds.flow.unit, 11, 'semibold', C.sub),
                ],
              },
              {
                type: 'stack',
                direction: 'row',
                gap: 4,
                height: 5,
                children: [
                  {
                    type: 'stack',
                    flex: p == null ? 1 : Math.max(0.03, p),
                    backgroundColor: flowStyle.color,
                    borderRadius: 4,
                    children: [],
                  },
                  {
                    type: 'stack',
                    flex: p == null ? 0.001 : Math.max(0.03, 1 - p),
                    backgroundColor: { light: '#7890A52B', dark: '#FFFFFF2B' },
                    borderRadius: 4,
                    children: [],
                  },
                ],
              },
              t('总量 ' + (total ? total.number + ' ' + total.unit : '--') +
                '  ·  已用 ' + (usedFlow ? usedFlow.number + ' ' + usedFlow.unit : '--'), 9, 'medium', C.sub, { minScale: 0.55 }),
            ],
          },
          {
            type: 'stack',
            direction: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 0,
            width: 90,
            children: [
              { type: 'image', src: gaugeSvg(p, flowStyle.color, 110), width: 76, height: 40 },
              t(p != null ? Math.round(p * 100) + '% 已用' : '用量统计', 9, 'bold', flowStyle.color),
            ],
          },
        ],
      },
      {
        type: 'stack',
        direction: 'row',
        alignItems: 'center',
        gap: 10,
        padding: [8, 0],
        children: [
          {
            type: 'stack',
            direction: 'column',
            gap: 4,
            flex: 1,
            children: [
              { type: 'stack', direction: 'row', alignItems: 'center', gap: 4, children: [
                { type: 'image', src: 'sf-symbol:yensign.circle.fill', width: 12, height: 12, color: C.fee },
                t('剩余话费', 10, 'medium', C.sub),
              ]},
              { type: 'stack', direction: 'row', alignItems: 'end', gap: 2, children: [
                t('¥' + ds.fee.number, 21, 'bold', C.txt, { minScale: 0.5 }),
                t('元', 9, 'medium', C.sub),
              ]},
            ],
          },
          {
            type: 'stack',
            direction: 'column',
            gap: 4,
            flex: 1,
            children: [
              { type: 'stack', direction: 'row', alignItems: 'center', gap: 4, children: [
                { type: 'image', src: 'sf-symbol:phone.fill', width: 12, height: 12, color: C.voice },
                t('剩余语音', 10, 'medium', C.sub),
              ]},
              { type: 'stack', direction: 'row', alignItems: 'end', gap: 2, children: [
                t(ds.voice.number === '--' ? '暂无' : ds.voice.number, 21, 'bold', C.txt, { minScale: 0.5 }),
                t(ds.voice.number === '--' ? '' : '分钟', 9, 'medium', C.sub),
              ]},
              t(voiceUsed != null && voiceTotal != null
                ? '已用 ' + voiceUsed + ' / ' + voiceTotal + ' 分钟'
                : '套餐分钟明细暂不可用', 8, 'medium', C.sub, { minScale: 0.55 }),
            ],
          },
        ],
      },
      {
        type: 'stack',
        direction: 'column',
        gap: 5,
        padding: [7, 0, 0, 0],
        children: [
          {
            type: 'stack',
            direction: 'row',
            alignItems: 'center',
            gap: 4,
            children: [
              { type: 'image', src: 'sf-symbol:chart.bar.fill', width: 10, height: 10, color: C.flow },
              t('今日流量使用', 10, 'semibold', C.txt),
              { type: 'spacer' },
              ...(todayUsed ? [t(todayUsed.number + ' ' + todayUsed.unit, 10, 'bold', C.flow)] : []),
            ],
          },
          ...(todayUsed
            ? [{
                type: 'image',
                src: historySvg(today.history.map(x => ({ flowKB: x.flowKB })), C.flow, 270, 38),
                width: 270,
                height: 38,
              }]
            : []),
          t(today.label, 8, 'medium', C.sub),
          {
            type: 'stack',
            direction: 'row',
            alignItems: 'center',
            gap: 4,
            children: [
              { type: 'image', src: 'sf-symbol:clock', width: 9, height: 9, color: C.sub },
              t(staleView ? '缓存 ' + (ageMs != null ? ageText(ageMs) + '前' : '') : '实时数据', 8, 'medium', expired ? C.fee : C.sub),
              { type: 'spacer' },
              t(expired ? '数据已过期' : (ds.captureDuration ? '凭据已保持 ' + ds.captureDuration : '定时保活中'), 8, 'medium', expired ? C.fee : C.sub),
            ],
          },
        ],
      },
    ],
  };
}

function buildLock(title, ds, family) {
  const dur = ds.captureDuration ? ' · 保持' + ds.captureDuration : '';
  if (family === 'accessoryInline') {
    return {
      type: 'widget',
      children: [
        {
          type: 'text',
          text: `¥${ds.fee.number} · ${ds.flow.number}${ds.flow.unit} · ${ds.voice.number}分${dur}`,
          maxLines: 1,
          minScale: 0.6,
        },
      ],
    };
  }

  if (family === 'accessoryCircular') {
    return {
      type: 'widget',
      padding: 7,
      children: [
        { type: 'spacer' },
        {
          type: 'stack',
          direction: 'column',
          alignItems: 'center',
          gap: 0,
          children: [
            {
              type: 'image',
              src: 'sf-symbol:wifi',
              width: 11,
              height: 11,
              color: C.flow,
            },
            t(ds.flow.number, 14, 'bold', C.txt, { minScale: 0.5 }),
            t(ds.flow.unit, 8, 'regular', C.sub),
          ],
        },
        { type: 'spacer' },
      ],
    };
  }

  return {
    type: 'widget',
    padding: [3, 5],
    gap: 2,
    children: [
      t(`话费 ¥${ds.fee.number}`, 'footnote', 'bold', C.fee),
      t(`流量 ${ds.flow.number}${ds.flow.unit} · 语音 ${ds.voice.number}分`, 'caption2', 'semibold', C.txt, {
        minScale: 0.6,
      }),
      t(`更新 ${fmtTime(ds.updatedAt)}${dur}`, 'caption2', 'regular', C.sub, { minScale: 0.55 }),
    ],
  };
}

function liquidGlassWidget(widget) {
  if (!widget || widget.type !== 'widget') return widget;
  // 透明模式下根节点完全透明，避免系统底色覆盖壁纸；内容仍按各自颜色绘制。
  widget.backgroundColor = transparentMode
    ? '#00000000'
    : { light: '#F4F7FB', dark: '#161B22' };
  delete widget.glassContentPadding;
  return widget;
}

function buildError(title, message) {
  return {
    type: 'widget',
    padding: 14,
    gap: 6,
    backgroundColor: transparentMode ? '#00000000' : { light: '#F4F7FB', dark: '#161B22' },
    children: [
      t(title, 'footnote', 'semibold'),
      { type: 'spacer' },
      {
        type: 'image',
        src: 'sf-symbol:exclamationmark.triangle.fill',
        width: 22,
        height: 22,
        color: C.fee,
      },
      t(message, 'caption1', 'medium', C.txt, {
        maxLines: 4,
        minScale: 0.7,
      }),
      { type: 'spacer' },
    ],
  };
}

async function handleWidget(ctx) {
  const result = await loadData(ctx, { reason: 'render' });

  if (!result.configured) {
    return buildError(
      '中国广电',
      '请打开中国广电 App 查询一次，等待自动捕获数据'
    );
  }

  if (!result.data) {
    return buildError(
      '中国广电',
      '查询失败，请重新打开 App 查询一次'
    );
  }

  try{var __g=globalThis.__CARR__||(globalThis.__CARR__={mods:{},ds:{}});__g.ds=__g.ds||{};__g.ds['broadnet']=result.data;}catch(__ignore){}
  const family = ctx.widgetFamily || 'systemSmall';

  if (family === 'systemMedium') {
    return liquidGlassWidget(buildMedium('中国广电', result.data, result.fromCache));
  }

  if (family === 'systemLarge' || family === 'systemExtraLarge') {
    return liquidGlassWidget(buildLarge('中国广电', result.data, result.fromCache));
  }

  if (family.startsWith('accessory')) {
    return buildLock('中国广电', result.data, family);
  }

  return liquidGlassWidget(buildSmall('中国广电', result.data, result.fromCache));
}

__exp.default = async function(ctx) {
  // 1. HTTP 抓包模式：自动捕获 access 与请求 payload
  if (ctx && ctx.request && ctx.request.url) {
    await capture(ctx);
    return;
  }

  // 2. 定时保活模式：支持 schedule (ctx.cron) 或环境变量开启
  if (ctx && (ctx.cron || (ctx.env && ctx.env.CB_KEEPALIVE === 'true'))) {
    return handleKeepAlive(ctx);
  }

  // 3. Generic Widget 模式：渲染小组件 UI
  try {
    const widget = await handleWidget(ctx || {});
    if (widget && widget.type === 'widget') return widget;
    return buildError('中国广电', '组件返回内容异常，请刷新模块');
  } catch (e) {
    return buildError('中国广电', '组件渲染异常：' + String(e && e.message ? e.message : e).slice(0, 80));
  }
}
try{(globalThis.__CARR__=globalThis.__CARR__||{mods:{},ds:{}}).mods['broadnet']=__exp.default;}catch(__ignore){}
})();

/* ============================================================
 * 运营商聚合面板 · carrier-hub
 * 四家（联通 / 移动 / 电信 / 广电）合一，一个小组件看全部
 * 数据抓取、解析、登录、缓存全部复用各家原始脚本，此处只做聚合渲染
 * ============================================================ */

const CARRIERS = [
  { key: 'unicom',   name: '联通', color: '#E8443A', aliases: ['unicom', 'cu', 'lt', '联通', '中国联通'] },
  { key: 'mobile',   name: '移动', color: '#0A84FF', aliases: ['mobile', 'cm', 'yd', '移动', '中国移动'] },
  { key: 'telecom',  name: '电信', color: '#F7781F', aliases: ['telecom', 'ct', 'dx', '电信', '中国电信'] },
  { key: 'broadnet', name: '广电', color: '#12B0A0', aliases: ['broadnet', 'cb', 'gd', '广电', '中国广电'] },
];

const COLOR = {
  txt:  { light: '#14203A', dark: '#F2F6FC' },
  sub:  { light: '#67788F', dark: '#9DAFC5' },
  faint:{ light: '#8B9AAF', dark: '#7C8CA3' },
  line: { light: '#0B1B3316', dark: '#FFFFFF1C' },
  bg:   { light: '#FFFFFFF0', dark: '#141922F0' },
  accent: '#0F9F91',
  ok:   '#27A879',
  warn: '#DD9B12',
  bad:  '#E5484D',
};

/* ---------------- 基础组件 ---------------- */

function T(text, size, weight, color, extra) {
  return Object.assign({
    type: 'text',
    text: String(text),
    font: { size: size, weight: weight || 'regular' },
    textColor: color,
    maxLines: 1,
    minScale: 0.45,
  }, extra || {});
}

/** 右对齐的一个数值格 */
function cell(value, flex, color, size, weight) {
  return {
    type: 'stack',
    direction: 'row',
    alignItems: 'center',
    flex: flex == null ? 1 : flex,
    children: [
      { type: 'spacer' },
      T(value, size || 12, weight || 'bold', color || COLOR.txt),
    ],
  };
}

/** 占位格（用于表头对齐） */
function ghost(flex) {
  return { type: 'stack', direction: 'row', flex: flex == null ? 1 : flex, children: [{ type: 'spacer' }] };
}

function divider() {
  return { type: 'stack', height: 1, backgroundColor: COLOR.line, margin: [3, 0, 3, 0] };
}

/* ---------------- 数值格式 ---------------- */

function shortUnit(unit) {
  const u = String(unit || '').trim();
  if (!u) return '';
  if (u === '分钟' || u === '分') return '分';
  if (u === '元' || u === '¥' || u === 'CNY') return '';
  return u;
}

function fmtFee(fee) {
  if (!fee || fee.number == null || fee.number === '') return '--';
  const u = shortUnit(fee.unit);
  return String(fee.number) + u;
}

function fmtFlow(flow) {
  if (!flow || flow.number == null || flow.number === '') return '--';
  return String(flow.number) + (flow.unit ? ' ' + flow.unit : '');
}

function fmtVoice(voice) {
  if (!voice || voice.number == null || voice.number === '') return '--';
  return String(voice.number) + shortUnit(voice.unit);
}

function num(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** 联通 / 广电的 plan.used / plan.total 是 KB */
function kb2text(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return '--';
  if (n >= 1048576) return (n / 1048576).toFixed(1) + 'GB';
  if (n >= 1024) return (n / 1024).toFixed(1) + 'MB';
  return Math.round(n) + 'KB';
}

function hhmm(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  if (isNaN(d.getTime())) return '';
  const p = function (n) { return (n < 10 ? '0' : '') + n; };
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

function clip(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/* ---------------- 错误树解析 ---------------- */

function walk(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) walk(node[i], fn); return; }
  fn(node);
  if (node.children) walk(node.children, fn);
}

function hasIcon(node, name) {
  let found = false;
  walk(node, function (n) {
    if (found) return;
    if (typeof n.src === 'string' && n.src.indexOf(name) >= 0) found = true;
  });
  return found;
}

function textsOf(node) {
  const out = [];
  walk(node, function (n) {
    if (typeof n.text === 'string' && n.text.trim()) out.push(n.text.trim());
  });
  return out;
}

/** 各家的 buildError 树里第一个文本是运营商名，其余是提示 */
function errorFromTree(tree) {
  if (!tree) return '';
  if (!hasIcon(tree, 'exclamationmark.triangle')) return '';
  const tx = textsOf(tree);
  if (tx.length <= 1) return '查询失败';
  return clip(tx.slice(1).join(' · '), 34);
}

/* ---------------- 调度四家 ---------------- */

async function runOne(carrier, ctx) {
  const mod = (globalThis.__CARR__ && globalThis.__CARR__.mods || {})[carrier.key];
  if (typeof mod !== 'function') {
    return { c: carrier, ok: false, err: '脚本未内置' };
  }

  globalThis.__CARR__.ds[carrier.key] = null;

  const sub = {
    storage: ctx.storage,
    env: ctx.env || {},
    notify: ctx.notify,
    http: ctx.http,
    widgetFamily: 'systemSmall',
  };

  let tree = null;
  let err = '';
  try {
    tree = await mod(sub);
  } catch (e) {
    err = String((e && e.message) || e);
  }

  const ds = globalThis.__CARR__.ds[carrier.key];
  if (ds && ds.flow) {
    return { c: carrier, ok: true, ds: ds };
  }
  if (!err) err = errorFromTree(tree) || (ds ? '数据不完整' : '尚未抓取');
  return { c: carrier, ok: false, err: clip(err, 34), ds: ds || null };
}

/* ---------------- 参数 ---------------- */

function pickCarriers(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text || /^(all|全部|默认)$/i.test(text)) return CARRIERS.slice();

  const tokens = text.split(/[,，、\s|\/]+/).filter(Boolean);
  const picked = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const low = tok.toLowerCase();
    let hit = null;
    for (let j = 0; j < CARRIERS.length; j++) {
      const c = CARRIERS[j];
      if (c.aliases.indexOf(low) >= 0 || c.aliases.indexOf(tok) >= 0) { hit = c; break; }
    }
    if (hit && !picked.some(function (p) { return p.key === hit.key; })) picked.push(hit);
  }
  return picked.length ? picked : CARRIERS.slice();
}

/* ---------------- 渲染 ---------------- */

function buildPanel(title, rows, family, opts) {
  const wide = family === 'systemLarge' || family === 'systemExtraLarge';
  const medium = family === 'systemMedium';
  const small = !wide && !medium;

  /* 小尺寸只放一个指标，避免 4 家 ×3 列把 155pt 撑爆 */
  const smallMetric = opts.smallMetric === 'flow' ? 'flow' : 'fee';
  const cols = small
    ? { fee: smallMetric === 'fee', flow: smallMetric === 'flow', voice: false }
    : (opts.cols || { fee: true, flow: true, voice: true });

  const W = small ? { fee: 1, flow: 1, voice: 1 } : { fee: 1.05, flow: 1.3, voice: 0.95 };

  const shown = small ? rows.slice(0, 4) : rows;

  const okCount = shown.filter(function (r) { return r.ok; }).length;

  /* 最新一次更新时间 */
  let latest = 0;
  for (let i = 0; i < shown.length; i++) {
    const ts = Number((shown[i].ds && shown[i].ds.updatedAt) || 0);
    if (ts > latest) latest = ts;
  }

  const children = [];

  /* 标题行 */
  const headKids = [
    { type: 'image', src: 'sf-symbol:antenna.radiowaves.left.and.right', width: 12, height: 12, color: COLOR.accent },
    T(title, 12, 'semibold', COLOR.txt),
  ];
  if (!small) {
    headKids.push({ type: 'spacer' });
    headKids.push(T(latest ? '更新 ' + hhmm(latest) : okCount + '/' + shown.length, 9, 'medium', COLOR.faint));
  }
  children.push({
    type: 'stack', direction: 'row', alignItems: 'center', gap: 5,
    padding: [0, 0, wide ? 2 : 1, 0],
    children: headKids,
  });

  if (wide) children.push(divider());

  /* 表头 */
  if (!small) {
    const head = [
      { type: 'image', src: 'sf-symbol:circle.fill', width: 7, height: 7, color: '#00000000' },
      { type: 'stack', direction: 'row', width: 32, children: [T('', 9, 'medium', COLOR.sub)] },
    ];
    if (cols.fee) head.push(cell('余额', W.fee, COLOR.faint, 9, 'medium'));
    if (cols.flow) head.push(cell('流量', W.flow, COLOR.faint, 9, 'medium'));
    if (cols.voice) head.push(cell('语音', W.voice, COLOR.faint, 9, 'medium'));
    children.push({ type: 'stack', direction: 'row', alignItems: 'center', gap: 8, children: head, padding: [0, 0, wide ? 3 : 1, 0] });
  }

  /* 每家一行 */
  for (let i = 0; i < shown.length; i++) {
    const r = shown[i];
    const ds = r.ds || {};
    const stale = Boolean(ds.stale);
    const dot = !r.ok ? COLOR.bad : (stale ? COLOR.warn : COLOR.ok);
    const vcolor = r.ok ? COLOR.txt : COLOR.sub;

    const row = [
      { type: 'image', src: 'sf-symbol:' + (r.ok ? 'circle.fill' : 'exclamationmark.circle.fill'), width: 7, height: 7, color: dot },
      { type: 'stack', direction: 'row', width: 32, children: [T(r.c.name, small ? 11 : 12, 'semibold', r.ok ? COLOR.txt : COLOR.sub)] },
    ];
    if (cols.fee) row.push(cell(fmtFee(ds.fee), W.fee, vcolor, small ? 16 : 12));
    if (cols.flow) row.push(cell(fmtFlow(ds.flow), W.flow, vcolor, small ? 16 : 12));
    if (cols.voice) row.push(cell(fmtVoice(ds.voice), W.voice, vcolor, 12));

    children.push({ type: 'stack', direction: 'row', alignItems: 'center', gap: 8, flex: 1, children: row, padding: wide ? [4, 0, 0, 0] : [small ? 3 : 0, 0, 0, 0] });

    /* 大尺寸：每家补一行明细 */
    if (wide) {
      let note;
      if (!r.ok) {
        note = r.err || '查询失败';
      } else {
        const bits = [];
        if (ds.updatedAt) bits.push('更新 ' + hhmm(ds.updatedAt));
        if (ds.plan && ds.plan.used != null && ds.plan.total != null) {
          bits.push('已用 ' + kb2text(ds.plan.used) + ' / ' + kb2text(ds.plan.total));
        } else if (ds.flow && ds.flow.percent != null && num(ds.flow.percent) != null) {
          const p = num(ds.flow.percent);
          bits.push('已用 ' + (p <= 1 ? Math.round(p * 100) : Math.round(p)) + '%');
        }
        if (stale) bits.push('缓存');
        if (ds.authFailed) bits.push('凭据待更新');
        note = bits.length ? bits.join(' · ') : (ds.packageName || ' ');
      }
      children.push({
        type: 'stack', direction: 'row', padding: [1, 0, 3, 19],
        children: [T(note, 9, 'regular', r.ok ? COLOR.faint : COLOR.bad, { maxLines: 1, minScale: 0.4 })],
      });
    }
  }

  /* 合计 */
  if (wide || medium) {
    const fees = shown.filter(function (r) { return r.ok && r.ds && r.ds.fee && num(r.ds.fee.number) != null; });
    const sum = fees.reduce(function (a, r) { return a + num(r.ds.fee.number); }, 0);

    children.push(divider());

    if (wide) {
      children.push({
        type: 'stack', direction: 'row', alignItems: 'end',
        padding: [2, 0, 0, 0],
        children: [
          {
            type: 'stack', direction: 'column', alignItems: 'start', gap: 0, flex: 1,
            children: [
              T(fees.length + ' 家在网 · 合计余额（元）', 9, 'medium', COLOR.faint),
              T(sum.toFixed(2), 24, 'bold', COLOR.txt),
            ],
          },
          {
            type: 'stack', direction: 'column', alignItems: 'end', gap: 0,
            children: [
              T(okCount + '/' + shown.length, 16, 'bold', okCount === shown.length ? COLOR.ok : COLOR.warn),
              T('状态正常', 9, 'medium', COLOR.faint),
            ],
          },
        ],
      });
    } else {
      children.push({
        type: 'stack', direction: 'row', alignItems: 'center',
        children: [
          T('合计 ¥' + sum.toFixed(2), 9, 'medium', COLOR.sub),
          { type: 'spacer' },
          T(okCount + '/' + shown.length + ' 正常', 9, 'medium', okCount === shown.length ? COLOR.ok : COLOR.warn),
        ],
      });
    }
  }

  return {
    type: 'widget',
    padding: wide ? [16, 16] : [12, 12],
    gap: wide ? 6 : 2,
    backgroundColor: COLOR.bg,
    refreshAfter: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    children: children,
  };
}

function buildAccessory(rows) {
  const bits = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const ds = r.ds || {};
    bits.push(r.c.name + ' ' + (r.ok ? fmtFee(ds.fee) + '/' + fmtFlow(ds.flow) : '—'));
  }
  return {
    type: 'widget',
    padding: [2, 4],
    children: [T(bits.join('  '), 10, 'semibold', COLOR.txt, { maxLines: 1, minScale: 0.3 })],
  };
}

/* ---------------- 入口 ---------------- */

export default async function (ctx) {
  const safe = ctx || {};
  const env = safe.env || {};
  const family = String(safe.widgetFamily || 'systemSmall');

  const show = pickCarriers(env.hubShow);
  const title = String(env.hubTitle || '').trim() || '运营商';
  const cols = {
    fee: String(env.hubShowFee || 'true') !== 'false',
    flow: String(env.hubShowFlow || 'true') !== 'false',
    voice: String(env.hubShowVoice || 'true') !== 'false',
  };

  /* 并发跑四家；任何一家抛错都不影响其余 */
  const rows = await Promise.all(show.map(function (c) {
    return runOne(c, safe).catch(function (e) {
      return { c: c, ok: false, err: clip(String((e && e.message) || e), 34) };
    });
  }));

  if (family.indexOf('accessory') === 0) return buildAccessory(rows);

  try {
    return buildPanel(title, rows, family, { cols: cols });
  } catch (e) {
    return {
      type: 'widget',
      padding: 14,
      gap: 6,
      backgroundColor: COLOR.bg,
      children: [
        T('运营商面板', 12, 'semibold', COLOR.txt),
        { type: 'spacer' },
        { type: 'image', src: 'sf-symbol:exclamationmark.triangle.fill', width: 22, height: 22, color: COLOR.bad },
        T('渲染失败：' + clip(String((e && e.message) || e), 60), 10, 'medium', COLOR.txt, { maxLines: 4 }),
        { type: 'spacer' },
      ],
    };
  }
}
