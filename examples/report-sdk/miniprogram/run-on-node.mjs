#!/usr/bin/env node
/**
 * 微信小程序版 miniprogram/clklog.js 的 Node 垫片自测入口（Node 24 内置 fetch，零依赖）。
 *
 * 为什么要有这个文件：本机没有微信开发者工具，无法跑真机/模拟器；但小程序 SDK 的
 * 传输与编码逻辑（纯 JS base64 + 手写 urlencode + wx.request + wx 同步存储）可以在 Node 下
 * 用**垫片**完整验证。这里用 fetch 实现一个最小 wx 对象，再 require **同一份 miniprogram/clklog.js**。
 *
 * 垫片严格按官方文档语义实现：
 *   - wx.getStorageSync(key)：缺 key 返回 ''（不是 null）——SDK 里已按此归一；
 *   - wx.setStorageSync / wx.removeStorageSync：同步键值存储；
 *   - wx.request：success 回调对任意 HTTP 状态都触发（需自行判断 statusCode），fail 仅网络层失败；
 *     字符串 data 原样发送；对象 data 才由基础库按 content-type 序列化（本垫片也照此模拟）。
 *   - wx.getSystemInfoSync：返回 devtools/iOS 沙盒信息；
 *   - wx.onAppHide：进程内注册回调，可被本脚本手动触发（用来测切后台补发路径）。
 *
 * ⚠️ 实测层级（诚实说明）：已实测＝Node 垫片下的完整 5 步链 + 真机同款传输报文落到 ClickHouse；
 *    未实测＝真机的域名白名单、基础库对 timeout（2.10.0+）的支持、真实 wx.onAppHide 触发时机、
 *    真机 storage 配额与隐私设置降级行为。这些必须在微信开发者工具/真机上再走一遍。
 *
 * 用法：
 *   cd examples/report-sdk/miniprogram && node run-on-node.mjs
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
const LIB = 'miniprogram';
const ARGS = new Set(process.argv.slice(2));

// ===================================================================== wx 垫片
const store = new Map();
const requestLog = [];   // 记录每次 wx.request 的调用细节，供断言「传的是预编码字符串」
const appHideHandlers = [];
let stubNetwork = false; // --batch-check 时置 true：不真发网络，直接回 200 并记录 body

function serializeObjectData(data, contentType) {
  // 官方行为：对象 data 由基础库按 content-type 序列化（urlencoded 用 encodeURIComponent）。
  if (contentType && contentType.indexOf('application/json') >= 0) return JSON.stringify(data);
  const parts = [];
  for (const k of Object.keys(data)) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(data[k])}`);
  return parts.join('&');
}

globalThis.wx = {
  getStorageSync(key) {
    return store.has(key) ? store.get(key) : '';
  },
  setStorageSync(key, value) {
    store.set(key, value);
  },
  removeStorageSync(key) {
    store.delete(key);
  },
  getSystemInfoSync() {
    return {
      platform: 'devtools',
      system: 'iOS 17.4',
      brand: 'devtools',
      model: 'iPhone 15 Pro',
      screenWidth: 390,
      screenHeight: 844,
      SDKVersion: '3.5.7',
      version: '8.0.5',
    };
  },
  onAppHide(handler) {
    appHideHandlers.push(handler);
  },
  request(options) {
    const header = options.header || {};
    const contentType = header['content-type'] || header['Content-Type'] || '';
    const rawData = options.data;
    const body = typeof rawData === 'string' ? rawData : serializeObjectData(rawData, contentType);
    const record = {
      url: options.url,
      method: options.method || 'GET',
      contentType,
      dataType: typeof rawData,
      body,
      bodyLength: body.length,
      timeout: options.timeout,
    };
    requestLog.push(record);

    if (stubNetwork) {
      record.statusCode = 200;
      setTimeout(() => {
        if (options.success) options.success({ statusCode: 200, data: '', header: {} });
        if (options.complete) options.complete({ statusCode: 200, data: '' });
      }, 0);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), (options.timeout || 10000) + 1000);
    fetch(options.url, { method: record.method, headers: header, body, signal: controller.signal })
      .then(async (resp) => {
        clearTimeout(timer);
        record.statusCode = resp.status;
        const text = await resp.text();
        // wx.request 的 success 对任意 HTTP 状态都触发
        if (options.success) options.success({ statusCode: resp.status, data: text, header: {} });
        if (options.complete) options.complete({ statusCode: resp.status, data: text });
      })
      .catch((err) => {
        clearTimeout(timer);
        const errMsg = `request:fail ${err && err.name === 'AbortError' ? 'timeout' : (err.message || err)}`;
        record.errMsg = errMsg;
        if (options.fail) options.fail({ errMsg });
        if (options.complete) options.complete({ errMsg });
      });
  },
};

const ClkLog = require(join(HERE, 'clklog.js')); // 同一份小程序 SDK（CommonJS 分支）

// ===================================================================== 工具函数
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

/** 用 SDK 自己的编码函数生成 body 再反解，证明 data = base64 → urlencode 真实生效。 */
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===================================================================== 分批上限核对（离线）
/**
 * 桩掉 wx.request，验证 SDK 真的按「单条 data ≤50 事件、body ≤1MB」切批：
 * 120 条小事件 + 4 条各带 ~400KB 属性的大事件。
 */
async function batchCheck(token, project) {
  stubNetwork = true;
  requestLog.length = 0;
  const clk = new ClkLog({ endpoint: 'https://stub.local/gp', project, token, batchSize: 50, autoCollectSystemInfo: false });
  for (let i = 0; i < 120; i++) await clk.track('BatchCheck', { i });
  const big = 'x'.repeat(400 * 1024);
  for (let i = 0; i < 4; i++) await clk.track('BatchCheck', { i, big });
  await clk.flush();
  stubNetwork = false;

  const stats = requestLog.map((r) => ({
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

// ===================================================================== 主流程
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
    batchSize: 50,            // 演示「显式 flush + 切后台补发」两条路径，不让攒批提前触发
    flushOnInit: false,
    storage: undefined,       // 用默认 wx 存储适配器（垫片提供 wx.getStorageSync 等）
    debug: true,
  });
  clk.bindAppHideFlush();     // 小程序切后台补发（wx.onAppHide）
  await clk.setDistinctId(anonId);

  // ---- 前 3 步：显式 flush（等价 Go 参考的一次批量发送）
  await clk.track(EVENT_NAME, { test_run_id: runId, sdk_lang: LIB, step: 'before_login' }, { distinctId: anonId });
  await clk.login(loginId, anonId);
  await clk.profileSet({ vip_level: 3, register_channel: 'app_store', sdk_lang: LIB }, { distinctId: anonId });
  selfCheck(project, token, [{ type: 'track', event: EVENT_NAME, distinct_id: anonId, time: Date.now(), properties: { product_name: '测试商品' } }]);
  const sentFirst = await clk.flush();
  console.log(`[clklog] 显式 flush 发送 ${sentFirst} 条（队列剩余 ${clk.queueLength()}）`);

  // ---- 后 2 步：留队列，交给 wx.onAppHide 补发路径（真机切后台时由基础库触发）
  await clk.track(EVENT_NAME, {
    test_run_id: runId, sdk_lang: LIB, amount: 99.5, is_new_user: true,
    product_id: 'P1001', product_name: '测试商品',
  }, { distinctId: anonId });
  await clk.track('Purchase', { test_run_id: runId, order_id: `O${runId}`, amount: 99.5, pay_type: 'alipay' }, { distinctId: anonId });
  if (clk.queueLength() !== 2) throw new Error(`切后台前队列应为 2 条，实际 ${clk.queueLength()}`);
  console.log(`[clklog] 触发 wx.onAppHide（模拟小程序切后台），队列 ${clk.queueLength()} 条待补发`);
  appHideHandlers.forEach((h) => h());
  // 等 onAppHide 触发的请求真正结束（statusCode / errMsg 落账），而不是只看队列长度
  const settled = () => requestLog.filter((r) => r.statusCode !== undefined || r.errMsg !== undefined).length;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && settled() < 2) await sleep(100);
  if (settled() < 2) throw new Error('等待 wx.onAppHide 补发请求结束超时');
  if (clk.queueLength() !== 0) throw new Error(`onAppHide 补发后队列仍剩 ${clk.queueLength()} 条`);

  // ---- 断言：两次请求都是「预编码字符串 + urlencoded content-type」，且共 5 条事件
  const okCalls = requestLog.filter((r) => r.url === endpoint && r.method === 'POST');
  const bad = okCalls.filter((r) => r.dataType !== 'string' || !/x-www-form-urlencoded/.test(r.contentType));
  if (bad.length) throw new Error(`wx.request 传参不符合预期：${JSON.stringify(bad.map((r) => ({ dataType: r.dataType, contentType: r.contentType })))}`);
  const counts = okCalls.map((r) => JSON.parse(b64decode(new URLSearchParams(r.body).get('data'))).length);
  const total = counts.reduce((a, b) => a + b, 0);
  console.log(`[shim] wx.request 共 ${okCalls.length} 次，均为 string data + application/x-www-form-urlencoded`
    + `（每批事件数 ${counts.join(' + ')} = ${total}，body ${okCalls.map((r) => r.bodyLength).join('/')}B，`
    + `statusCode ${okCalls.map((r) => r.statusCode).join(', ')}）`);
  if (total !== 5) throw new Error(`两次请求合计应有 5 条事件，实际 ${total}`);
  if (!okCalls.length || okCalls.some((r) => r.statusCode !== 200)) throw new Error('存在非 200 响应');

  console.log(`DONE run_id = ${runId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
