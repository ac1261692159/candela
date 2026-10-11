#!/usr/bin/env node
/**
 * React Native 版 react-native/clklog.js 的 Node 自测入口（Node 24 内置 fetch，零依赖）。
 *
 * 为什么要有这个文件：本机没有 RN 运行时/打包器，无法验证原生壳；但 RN 侧的上报核心
 * （全局 fetch + 表单字符串 body + 纯 JS base64 + 手写 urlencode + 异步注入式 storage + 重试/队列）
 * 是纯 JS 且宿主无关的。本脚本 require **同一份 react-native/clklog.js**，只替换宿主能力：
 *   - AsyncStorage  → 注入内存 storage（异步实现，专门覆盖 SDK 的 await 路径）
 *   - AppState      → 注入伪 AppState（可手动触发 'background'，验证切后台补发）
 *   - Platform/Dimensions 自动采集 → 用 systemProperties 注入等价设备属性（真机由 RN 自动采集）
 *   - 全局 fetch 被包一层以记录真实请求（url / content-type / body 是否为字符串）
 *
 * ⚠️ 实测层级（诚实说明）：已实测＝RN 传输/队列核心在 Node 下跑通完整 5 步链并落 ClickHouse；
 *    未实测＝Metro 打包、AsyncStorage 原生模块、Android/iOS 真机的 AppState 与后台网络策略。
 *
 * 用法：
 *   cd examples/report-sdk/react-native && node run-on-node.mjs
 *   node run-on-node.mjs --self-check     # 只做 body 编码回环自检，不发网络请求
 *   node run-on-node.mjs --batch-check    # 离线核对分批上限（单条 ≤50 事件 / body ≤1MB），不发网络请求
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const DEFAULT_ENDPOINT = 'https://example.com/receiver/api/gp';
const DEFAULT_PROJECT = 'clklogapp';
const EVENT_NAME = 'SdkSpecTest';
const LIB = 'react-native';
const ARGS = new Set(process.argv.slice(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------- 宿主垫片：记录 fetch + 伪 AppState
const fetchLog = [];
const realFetch = globalThis.fetch;
let stubNetwork = false; // --batch-check 时置 true：不真发网络，直接回 200 并记录 body
globalThis.fetch = async function patchedFetch(url, init) {
  const record = { url: String(url), method: (init && init.method) || 'GET', contentType: '', dataType: typeof init?.body, body: init?.body };
  if (init && init.headers) record.contentType = init.headers['Content-Type'] || init.headers['content-type'] || '';
  fetchLog.push(record);
  if (stubNetwork) {
    record.statusCode = 200;
    return { status: 200, text: async () => '' };
  }
  try {
    const resp = await realFetch(url, init);
    record.statusCode = resp.status;
    return resp;
  } catch (err) {
    record.errMsg = String(err && err.message);
    throw err;
  }
};

const appStateHandlers = [];
const fakeAppState = {
  addEventListener(event, handler) {
    appStateHandlers.push({ event, handler });
    return { remove() { const i = appStateHandlers.findIndex((h) => h.handler === handler); if (i >= 0) appStateHandlers.splice(i, 1); } };
  },
};

/** 异步内存 storage：模拟 AsyncStorage（每次读写都返回 Promise）。 */
function asyncMemoryStorage() {
  const map = new Map();
  return {
    getItem: async (k) => { await sleep(0); return map.has(k) ? map.get(k) : null; },
    setItem: async (k, v) => { await sleep(0); map.set(k, String(v)); },
    removeItem: async (k) => { await sleep(0); map.delete(k); },
  };
}

const ClkLog = require(join(HERE, 'clklog.js')); // 同一份 RN SDK（CommonJS 分支）

// ------------------------------------------------------- 工具函数
function loadDotenv() {
  const candidates = [join(HERE, '..', '.env'), join(process.cwd(), '.env')];
  for (const path of candidates) {
    let text;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const idx = line.indexOf('=');
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      if (key && !process.env[key]) process.env[key] = value;
    }
    console.log(`[clklog] loaded env from ${path}（token 不打印）`);
    return;
  }
  console.log('[clklog] .env not found, fallback to system env');
}

function b64decode(str) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const clean = str.replace(/=+$/, '');
  const bytes = [];
  let buf = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = A.indexOf(ch);
    if (v < 0) throw new Error(`base64 非法字符: ${ch}`);
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; bytes.push((buf >> bits) & 0xff); }
  }
  return utf8decode(bytes);
}

function utf8decode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b0 = bytes[i++];
    if (b0 < 0x80) { out += String.fromCharCode(b0); continue; }
    if (b0 < 0xe0) { out += String.fromCharCode(((b0 & 0x1f) << 6) | (bytes[i++] & 0x3f)); continue; }
    if (b0 < 0xf0) { out += String.fromCharCode(((b0 & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f)); continue; }
    let cp = ((b0 & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    cp -= 0x10000;
    out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
  }
  return out;
}

function selfCheck(project, token, sampleEvents) {
  const body = ClkLog.formBody(sampleEvents, project, token);
  const dataSegment = body.split('&data=')[1] || '';
  if (dataSegment.includes('+') || dataSegment.includes('/') || dataSegment.includes('=')) {
    throw new Error('data 段存在未转义的 base64 字符（+ / =）：urlencode 没生效');
  }
  const params = new URLSearchParams(body);
  const decoded = JSON.parse(b64decode(params.get('data')));
  const ok = decoded.length === sampleEvents.length
    && decoded.every((e, i) => e.type === sampleEvents[i].type && e.event === sampleEvents[i].event)
    && decoded.some((e) => e.properties && e.properties.product_name === '测试商品');
  console.log(`[self-check] body=${body.length}B project=${params.get('project')} `
    + `data 无裸 + / =（转义生效），解码后 ${decoded.length} 条，UTF-8 中文属性往返 ${ok ? 'OK' : 'FAIL'}`);
  if (!ok) throw new Error('body 编码回环自检失败：协议编码路径有问题');
}

// ------------------------------------------------------- 分批上限核对（离线，不发网络）
/**
 * 桩掉 fetch（上面的 patchedFetch 在 stubNetwork 下直接回 200），验证 SDK 真的按
 * 「单条 data ≤50 事件、body ≤1MB」切批：120 条小事件 + 4 条各带 ~400KB 属性的大事件。
 */
async function batchCheck(token, project) {
  stubNetwork = true;
  fetchLog.length = 0;
  const clk = new ClkLog({
    endpoint: 'https://stub.local/gp', project, token, batchSize: 50,
    storage: asyncMemoryStorage(), autoCollectSystemInfo: false,
  });
  for (let i = 0; i < 120; i++) await clk.track('BatchCheck', { i });
  const big = 'x'.repeat(400 * 1024);
  for (let i = 0; i < 4; i++) await clk.track('BatchCheck', { i, big });
  await clk.flush();
  stubNetwork = false;

  const stats = fetchLog.map((r) => ({
    events: JSON.parse(b64decode(new URLSearchParams(r.body).get('data'))).length,
    bytes: Buffer.byteLength(r.body, 'utf8'),
  }));
  const total = stats.reduce((n, s) => n + s.events, 0);
  console.log(`[batch-check] ${stats.length} 次请求，每次事件数 ${stats.map((s) => s.events).join('+')}=${total}，`
    + `最大 body ${Math.max(...stats.map((s) => s.bytes))}B`);
  if (total !== 124) throw new Error(`分批后总事件数应为 124，实际 ${total}`);
  if (stats.some((s) => s.events > 50)) throw new Error(`存在 >50 事件的请求：${JSON.stringify(stats)}`);
  if (stats.some((s) => s.bytes > 1048576)) throw new Error(`存在 >1MB 的 body：${JSON.stringify(stats)}`);
  console.log('[batch-check] 单条 data ≤50 事件、body ≤1MB 均成立');
}

// ------------------------------------------------------- 主流程
async function main() {
  loadDotenv();
  const endpoint = process.env.CLKLOG_ENDPOINT || DEFAULT_ENDPOINT;
  const project = process.env.CLKLOG_PROJECT || DEFAULT_PROJECT;

  // token 只从环境变量读取，禁止硬编码入库（AGENTS.md 红线 3）
  const token = process.env.CLKLOG_TOKEN;
  if (!token) {
    console.error('missing env CLKLOG_TOKEN');
    process.exitCode = 1;
    return;
  }

  if (ARGS.has('--self-check')) {
    selfCheck(project, token, [{ type: 'track', event: 'SelfCheck', distinct_id: 'x', time: Date.now(), properties: { product_name: '测试商品' } }]);
    return;
  }

  if (ARGS.has('--batch-check')) {
    await batchCheck(token, project);
    return;
  }

  const runId = `${LIB}-${Math.floor(Date.now() / 1000)}`; // <lang>-<unix 秒>
  const anonId = `sdk-test-anon-${runId}`;
  const loginId = `uid-${LIB}-${runId}`;

  const clk = ClkLog.init({
    endpoint, project, token,
    batchSize: 50,                                  // 分两段发送：显式 flush + AppState 切后台补发
    flushOnInit: false,
    storage: asyncMemoryStorage(),                   // 真机用 AsyncStorage（默认），这里注入异步内存实现
    systemProperties: {                              // 真机由 RN Platform/Dimensions 自动采集
      $os: 'ios', $os_version: '17.4', $model: 'iPhone15,2',
      $screen_width: 390, $screen_height: 844,
    },
    debug: true,
  });
  clk.bindAppStateFlush(fakeAppState);               // 注入伪 AppState（真机传 RN 的 AppState）
  await clk.setDistinctId(anonId);

  // ---- 前 3 步：显式 flush（与 Go 参考同序）
  await clk.track(EVENT_NAME, { test_run_id: runId, sdk_lang: LIB, step: 'before_login' }, { distinctId: anonId });
  await clk.login(loginId, anonId);
  await clk.profileSet({ vip_level: 3, register_channel: 'app_store', sdk_lang: LIB }, { distinctId: anonId });
  selfCheck(project, token, [{ type: 'track', event: EVENT_NAME, distinct_id: anonId, time: Date.now(), properties: { product_name: '测试商品' } }]);
  const sentFirst = await clk.flush();
  console.log(`[clklog] 显式 flush 发送 ${sentFirst} 条（队列剩余 ${clk.queueLength()}）`);

  // ---- 后 2 步：留队列，交给 AppState 'background' 补发（真机退到后台时触发）
  await clk.track(EVENT_NAME, {
    test_run_id: runId, sdk_lang: LIB, amount: 99.5, is_new_user: true,
    product_id: 'P1001', product_name: '测试商品',
  }, { distinctId: anonId });
  await clk.track('Purchase', { test_run_id: runId, order_id: `O${runId}`, amount: 99.5, pay_type: 'alipay' }, { distinctId: anonId });
  if (clk.queueLength() !== 2) throw new Error(`切后台前队列应为 2 条，实际 ${clk.queueLength()}`);
  console.log(`[clklog] 触发 AppState change → background（模拟 RN 退到后台），队列 ${clk.queueLength()} 条待补发`);
  appStateHandlers.filter((h) => h.event === 'change').forEach((h) => h.handler('background'));
  const settled = () => fetchLog.filter((r) => r.statusCode !== undefined || r.errMsg !== undefined).length;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && (settled() < 2 || clk.queueLength() > 0)) await sleep(100);
  if (clk.queueLength() !== 0) throw new Error(`AppState 补发后队列仍剩 ${clk.queueLength()} 条`);

  // ---- 断言：两次真实 fetch 都是字符串 body + urlencoded，且合计 5 条事件
  const posts = fetchLog.filter((r) => r.url === endpoint && r.method === 'POST');
  const bad = posts.filter((r) => r.dataType !== 'string' || !/x-www-form-urlencoded/.test(r.contentType));
  if (bad.length) throw new Error(`fetch 传参不符合预期：${JSON.stringify(bad.map((r) => ({ dataType: r.dataType, contentType: r.contentType })))}`);
  const counts = posts.map((r) => JSON.parse(b64decode(new URLSearchParams(r.body).get('data'))).length);
  const total = counts.reduce((a, b) => a + b, 0);
  console.log(`[fetch] 共 ${posts.length} 次 POST，均为 string body + application/x-www-form-urlencoded`
    + `（每批事件数 ${counts.join(' + ')} = ${total}，body ${posts.map((r) => r.body.length).join('/')}B，`
    + `statusCode ${posts.map((r) => r.statusCode).join(', ')}）`);
  if (total !== 5) throw new Error(`两次请求合计应有 5 条事件，实际 ${total}`);
  if (!posts.length || posts.some((r) => r.statusCode !== 200)) throw new Error('存在非 200 响应');

  console.log(`DONE run_id = ${runId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
