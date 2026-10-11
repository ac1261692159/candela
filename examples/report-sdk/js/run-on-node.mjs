#!/usr/bin/env node
/**
 * Web/H5 版 clklog.js 的 Node 自测入口（Node 24 内置 fetch，零依赖）。
 *
 * 为什么要有这个文件：浏览器 UI 无法在无头环境里给出「数据真的落库」的证据，而
 * `js/clklog.js` 的传输/编码/队列核心是**宿主无关**的（纯 JS base64 + 手写 urlencode +
 * fetch + 注入式 storage）。本文件用 createRequire 加载**同一份 clklog.js**，
 * 只把浏览器专属能力替换为等价物：
 *   - localStorage → 内存 storage（同步，接口同 localStorage）
 *   - navigator.sendBeacon → 不涉及（页面卸载路径只做特性探测，浏览器实测见 index.html）
 *
 * 实测层级（诚实说明）：
 *   - 已实测：完整 5 步链经真实 HTTPS 打到 receiver 并落 ClickHouse（verify.sh 判定）。
 *   - 未实测：浏览器 DOM 交互、sendBeacon 卸载兜底、localStorage 真实读写 —— 需要真浏览器。
 *
 * 用法：
 *   cd examples/report-sdk/js && node run-on-node.mjs
 *   node run-on-node.mjs --cors-check      # 只做 receiver 的 CORS 预检核对（浏览器路径可行性）
 *   node run-on-node.mjs --self-check      # 只做 body 编码回环自检，不发网络请求
 *   node run-on-node.mjs --batch-check     # 离线核对分批上限（单条 ≤50 事件 / body ≤1MB），不发网络请求
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ClkLog = require(join(HERE, 'clklog.js')); // 同一份 UMD 文件（module.exports 分支）

const DEFAULT_ENDPOINT = 'https://example.com/receiver/api/gp';
const DEFAULT_PROJECT = 'clklogapp';
const EVENT_NAME = 'SdkSpecTest';
const LIB = 'js';
const ARGS = new Set(process.argv.slice(2));

// ---------------------------------------------------------------- .env（只取 CLKLOG_*）
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

/** 模拟 localStorage 的同步内存存储（注入给 sdk.storage）。 */
function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _dump: () => Object.fromEntries(map),
  };
}

// ---------------------------------------------------------------- body 编码回环自检
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
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buf >> bits) & 0xff);
    }
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

/** 用 SDK 自己的编码函数生成 body，再反向解码，证明 data = base64 → urlencode 真实生效。 */
function selfCheck(project, token, sampleEvents) {
  const body = ClkLog.formBody(sampleEvents, project, token);
  const dataSegment = body.split('&data=')[1] || '';
  // 典型踩坑：base64 未 percent-encode → '+' 在表单里被解码成空格、'=' 被当成键值分隔 → 数据损坏。
  if (dataSegment.includes('+') || dataSegment.includes('/') || dataSegment.includes('=')) {
    throw new Error('data 段存在未转义的 base64 字符（+ / =）：urlencode 没生效');
  }
  const params = new URLSearchParams(body);
  const decoded = JSON.parse(b64decode(params.get('data')));
  const ok = decoded.length === sampleEvents.length
    && decoded.every((e, i) => e.type === sampleEvents[i].type && e.event === sampleEvents[i].event)
    && decoded.some((e) => e.properties && e.properties.product_name === '测试商品'); // UTF-8 往返（中文属性值）
  console.log(`[self-check] body=${body.length}B project=${params.get('project')} `
    + `data 无裸 + / =（转义生效），解码后 ${decoded.length} 条，UTF-8 中文属性往返 ${ok ? 'OK' : 'FAIL'}`);
  if (!ok) throw new Error('body 编码回环自检失败：协议编码路径有问题');
}

// ---------------------------------------------------------------- CORS 预检核对
async function corsCheck(endpoint) {
  const origin = 'http://localhost:8000'; // python3 -m http.server 默认源
  const resp = await fetch(endpoint, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  const allowOrigin = resp.headers.get('access-control-allow-origin');
  const allowHeaders = resp.headers.get('access-control-allow-headers');
  console.log(`[cors-check] HTTP ${resp.status} access-control-allow-origin=${allowOrigin} allow-headers=${allowHeaders}`);
  console.log(`[cors-check] 演示页（${origin}）可直发：${allowOrigin === origin || allowOrigin === '*' ? '是' : '否'}`
    + '（Content-Type: application/x-www-form-urlencoded 属 CORS 安全列表，实际请求不触发预检）');
}

// ---------------------------------------------------------------- 分批上限核对（离线，不发网络）
/**
 * 用桩 fetch 验证 SDK 真的按「单条 data ≤50 事件、body ≤1MB」切批：
 * 120 条小事件 + 4 条各带 ~400KB 属性的大事件（合计 JSON 远超 1MB）。
 */
async function batchCheck(token, project) {
  const requests = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ body: init.body });
    return { status: 200, text: async () => '' };
  };
  try {
    const clk = new ClkLog({ endpoint: 'http://stub.local/gp', project, token, batchSize: 50 });
    for (let i = 0; i < 120; i++) await clk.track('BatchCheck', { i });
    const big = 'x'.repeat(400 * 1024);
    for (let i = 0; i < 4; i++) await clk.track('BatchCheck', { i, big });
    await clk.flush();
  } finally {
    globalThis.fetch = realFetch;
  }
  const stats = requests.map((r) => ({
    events: JSON.parse(b64decode(new URLSearchParams(r.body).get('data'))).length,
    bytes: Buffer.byteLength(r.body, 'utf8'),
  }));
  const total = stats.reduce((n, s) => n + s.events, 0);
  const overCount = stats.filter((s) => s.events > 50);
  const overSize = stats.filter((s) => s.bytes > 1048576);
  console.log(`[batch-check] ${stats.length} 次请求，每次事件数 ${stats.map((s) => s.events).join('+')}=${total}，`
    + `最大 body ${Math.max(...stats.map((s) => s.bytes))}B`);
  if (total !== 124) throw new Error(`分批后总事件数应为 124，实际 ${total}`);
  if (overCount.length) throw new Error(`存在 >50 事件的请求：${JSON.stringify(overCount)}`);
  if (overSize.length) throw new Error(`存在 >1MB 的 body：${JSON.stringify(overSize)}`);
  console.log('[batch-check] 单条 data ≤50 事件、body ≤1MB 均成立');
}

// ---------------------------------------------------------------- 主流程
async function main() {
  loadDotenv();
  const endpoint = process.env.CLKLOG_ENDPOINT || DEFAULT_ENDPOINT;
  const project = process.env.CLKLOG_PROJECT || DEFAULT_PROJECT;

  if (ARGS.has('--cors-check')) {
    await corsCheck(endpoint);
    return;
  }

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
  const anonId = `sdk-test-anon-${runId}`;                  // 匿名ID（登录前 + 登录后都不变）
  const loginId = `uid-${LIB}-${runId}`;                    // 登录ID

  const clk = ClkLog.init({
    endpoint, project, token,
    batchSize: 10,      // 5 条 < 10，靠显式 flush 一次发出（与 Go 参考同序同批）
    storage: memoryStorage(), // 浏览器里用默认 localStorage，这里注入内存实现
    debug: true,
  });

  // 5 步链（顺序与 examples/report-sdk/go/main.go 一致）
  await clk.setDistinctId(anonId); // 演示页同样在初始化后固定匿名ID
  await clk.track(EVENT_NAME, { test_run_id: runId, sdk_lang: LIB, step: 'before_login' }, { distinctId: anonId });
  await clk.login(loginId, anonId);                     // → track_signup($SignUp) + $track_signup_original_id
  await clk.profileSet({ vip_level: 3, register_channel: 'app_store', sdk_lang: LIB }, { distinctId: anonId });
  await clk.track(EVENT_NAME, {
    test_run_id: runId, sdk_lang: LIB, amount: 99.5, is_new_user: true,
    product_id: 'P1001', product_name: '测试商品',
  }, { distinctId: anonId });
  await clk.track('Purchase', { test_run_id: runId, order_id: `O${runId}`, amount: 99.5, pay_type: 'alipay' }, { distinctId: anonId });

  selfCheck(project, token, [{ type: 'track', event: EVENT_NAME, distinct_id: anonId, time: Date.now(), properties: { product_name: '测试商品' } }]);

  if (clk.queueLength() !== 5) throw new Error(`队列应有 5 条，实际 ${clk.queueLength()}`);
  const sent = await clk.flush(); // 5 条一次发出（data = base64(JSON 数组) → urlencode）
  console.log(`[clklog] 本次 flush 发送 ${sent} 条，队列剩余 ${clk.queueLength()} 条`);

  console.log(`DONE run_id = ${runId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
