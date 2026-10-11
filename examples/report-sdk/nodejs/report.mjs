#!/usr/bin/env node
/**
 * ClkLog 神策数据格式最简上报客户端（Node.js 18+，零依赖：内置 fetch / FormData / URLSearchParams）。
 *
 * 规范文档：仓库根目录《数据上报规范与流程.md》§1（编码硬要求）、§2（事件结构）、§3（用户标识口径）。
 *
 * 要点：
 * - 表单字段 data = JSON 数组 → base64 → urlencode；直接 POST 原始 JSON 会 200 但静默丢数据（§1.3）；
 * - ClkLog 不解析神策顶层 login_id/original_id：登录ID 走 identities.user_key，
 *   登录绑定匿名ID 走 properties.$track_signup_original_id（§3）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ENDPOINT = 'https://example.com/receiver/api/gp';
const DEFAULT_PROJECT = 'clklogapp';
const EVENT_NAME = 'SdkSpecTest';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ClkLogClient {
  /**
   * @param {object} options
   * @param {string} options.endpoint    上报地址
   * @param {string} options.project     项目名
   * @param {string} options.token       项目 token（禁止硬编码，见 AGENTS.md 红线 3）
   * @param {number} [options.batchSize] 攒批条数，达到即自动发送
   * @param {number} [options.timeoutMs] 单次 HTTP 超时
   */
  constructor({ endpoint, project, token, batchSize = 10, timeoutMs = 10000 }) {
    this.endpoint = endpoint;
    this.project = project;
    this.token = token;
    this.batchSize = batchSize > 0 ? batchSize : 10;
    this.timeoutMs = timeoutMs;
    this.maxAttempts = 3;
    this.queue = [];      // 待发送事件
    this.loginId = null;  // 登录ID，login() 后自动携带到 identities.user_key
  }

  /** 行为事件；登录后自动携带 identities.user_key。 */
  async track(distinctId, event, properties = {}) {
    this.enqueue(this.withIdentity({
      type: 'track',
      event,
      distinct_id: distinctId,
      time: Date.now(), // 毫秒时间戳（秒级会时间错乱）
      properties: properties ?? {},
    }));
    await this.#maybeFlush();
  }

  /** 用户属性（覆盖写）；登录后自动携带 identities.user_key。 */
  async profileSet(distinctId, properties = {}) {
    this.enqueue(this.withIdentity({
      type: 'user_set',
      distinct_id: distinctId,
      time: Date.now(),
      properties: properties ?? {},
    }));
    await this.#maybeFlush();
  }

  /**
   * 登录关联：上报 track_signup 绑定匿名ID，之后事件自动带 user_key。
   * ClkLog 口径：identities.user_key=登录ID，properties.$track_signup_original_id=匿名ID。
   */
  async login(loginId, anonymousId) {
    this.loginId = loginId;
    this.enqueue({
      type: 'track_signup',
      event: '$SignUp',
      distinct_id: loginId,
      identities: { user_key: loginId },
      properties: { $track_signup_original_id: anonymousId },
      time: Date.now(),
    });
    await this.#maybeFlush();
  }

  /** 发送队列内全部事件：JSON 数组 → base64 → urlencode 表单 POST，失败重试退避。 */
  async flush() {
    if (this.queue.length === 0) return;

    const payload = Buffer.from(JSON.stringify(this.queue), 'utf8').toString('base64');
    const body = new URLSearchParams({
      project: this.project,
      token: this.token,
      data: payload,
    });

    let lastError = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const resp = await fetch(this.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: '*/*' },
          body,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (resp.status === 200) {
          await resp.arrayBuffer(); // 释放响应体
          console.log(`[clklog] flushed ${this.queue.length} events OK`);
          this.queue = [];
          return;
        }
        lastError = `http ${resp.status}: ${(await resp.text()).slice(0, 200)}`;
      } catch (err) {
        lastError = `${err?.name ?? 'Error'}: ${err?.message ?? err}`;
      }
      await sleep(attempt * 500); // 线性退避
    }
    throw new Error(`flush failed after ${this.maxAttempts} attempts: ${lastError}`);
  }

  withIdentity(event) {
    if (this.loginId !== null) {
      event.identities = { user_key: this.loginId };
    }
    return event;
  }

  enqueue(event) {
    this.queue.push(event);
  }

  async #maybeFlush() {
    if (this.queue.length >= this.batchSize) {
      await this.flush();
    }
  }
}

/** 按需加载 ../.env（已存在的环境变量优先），仅取 CLKLOG_* 键。 */
function loadDotenv() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, '..', '.env'), join(process.cwd(), '.env')];
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
    console.log(`[clklog] loaded env from ${path}`);
    return;
  }
  console.log('[clklog] .env not found, fallback to system env');
}

async function main() {
  loadDotenv();

  // token 只从环境变量读取，禁止硬编码入库（AGENTS.md 红线 3）
  const token = process.env.CLKLOG_TOKEN;
  if (!token) {
    console.error('missing env CLKLOG_TOKEN');
    process.exitCode = 1;
    return;
  }
  const endpoint = process.env.CLKLOG_ENDPOINT || DEFAULT_ENDPOINT;
  const project = process.env.CLKLOG_PROJECT || DEFAULT_PROJECT;

  const runId = `nodejs-${Math.floor(Date.now() / 1000)}`;   // <lang>-<unix 秒>
  const anonId = `sdk-test-anon-${runId}`;                   // 匿名ID（登录前，全程稳定）
  const loginId = `uid-nodejs-${runId}`;                     // 登录ID

  const cli = new ClkLogClient({ endpoint, project, token, batchSize: 10 });

  // 1. 登录前：匿名事件（不带 identities）
  await cli.track(anonId, EVENT_NAME, {
    test_run_id: runId, sdk_lang: 'nodejs', step: 'before_login',
  });
  // 2. 登录关联：之后所有事件自动携带 identities.user_key
  await cli.login(loginId, anonId);
  // 3. 用户属性（登录态）
  await cli.profileSet(anonId, {
    vip_level: 3, register_channel: 'app_store', sdk_lang: 'nodejs',
  });
  // 4. 登录后行为事件：distinct_id 仍为匿名ID，登录ID走 identities.user_key
  await cli.track(anonId, EVENT_NAME, {
    test_run_id: runId,
    sdk_lang: 'nodejs',
    amount: 99.5,
    is_new_user: true,
    product_id: 'P1001',
    product_name: '测试商品',
  });
  // 5. 登录后购买事件
  await cli.track(anonId, 'Purchase', {
    test_run_id: runId,
    order_id: `O${runId}`,
    amount: 99.5,
    pay_type: 'alipay',
  });
  await cli.flush();

  console.log(`DONE run_id = ${runId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
