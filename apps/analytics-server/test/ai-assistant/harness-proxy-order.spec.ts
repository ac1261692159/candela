/**
 * Harness 反向代理的**中间件顺序**回归（2026-09-16 线上故障）。
 *
 * 故障现象：面板里「选择工作区」点不动——引擎点选后调 `POST /api/session/create`，
 * 上游回 400 `body is not JSON`，客户端把乐观选中回滚，UI 永远停在「选择工作区」。
 *
 * 根因：`main.ts` 把 `json()` / `urlencoded()` 注册在 harness 代理**之前**，
 * `application/json` 的请求体先被解析器消费掉，代理再读 `request` 流只能拿到空 body，
 * 转发时 content-length=0 → 上游 DSH 的 RPC 处理器 `request.json()` 失败 → 400。
 *
 * 本文件锁两件事：
 * 1. `src/main.ts` 里的注册顺序（源码不变量，防止再次把解析器提到代理前面）；
 * 2. 代理拿到**未解析过的**请求体时能把 body 原样转发（集成验证，真实 HTTP + 真实 unix socket）。
 */
jest.mock('../../src/config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    background_workers: false,
    __specConfigMock: true,
  },
}));

import { createServer, Server } from 'http';
import { request as httpRequest } from 'http';
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express, { json } from 'express';
import { HarnessWebProxyService } from '../../src/modules/ai-assistant/harness-web-proxy.service';
import type { HarnessRuntimeManagerService } from '../../src/modules/ai-assistant/harness-runtime-manager.service';

const RUNTIME_ID = `air_${'a'.repeat(24)}`;
const ENVELOPE = JSON.stringify({
  type: 'client-request',
  rpcId: '11111111-2222-4333-8444-555555555555',
  method: 'session/create',
  payload: { args: { request: { workspaceId: '7b5d137f-e26d-48b9-aa9e-198997d7472b' } } },
});

let dir: string;
let socketPath: string;
let upstream: Server;
let received: { url: string; body: string }[];

beforeAll(async () => {
  received = [];
  dir = mkdtempSync(join(tmpdir(), 'harness-proxy-'));
  socketPath = join(dir, 'runtime.sock');
  upstream = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk.toString('utf8');
    });
    request.on('end', () => {
      received.push({ url: request.url ?? '', body });
      response.writeHead(200, { 'content-type': 'application/json' });
      // 复刻 DSH 上游对空 body 的判定，便于断言「客户端看到的就是 400」
      response.end(body ? JSON.stringify({ ok: true }) : JSON.stringify({ error: 'body is not JSON' }));
    });
  });
  await new Promise<void>((resolvePromise) => upstream.listen(socketPath, resolvePromise));
});

afterAll(async () => {
  await new Promise<void>((resolvePromise) => upstream.close(() => resolvePromise()));
  rmSync(dir, { recursive: true, force: true });
});

function buildApp(order: 'proxy-first' | 'parsers-first') {
  const runtimes = {
    getAuthorizedRuntime: jest.fn(async () => ({ runtimeId: RUNTIME_ID, socketPath })),
    reviveRuntime: jest.fn(),
    authorizeCapability: jest.fn(),
  } as unknown as HarnessRuntimeManagerService;
  const proxy = new HarnessWebProxyService(runtimes);
  const internal = proxy as unknown as { signedAccess: (runtimeId: string, expires: number) => string };
  const access = internal.signedAccess(RUNTIME_ID, Date.now() + 60_000);

  const app = express();
  const mount = () => app.use('/sa/harness', proxy.handle.bind(proxy));
  if (order === 'proxy-first') {
    mount();
    app.use(json({ limit: '1mb' }));
  } else {
    app.use(json({ limit: '1mb' }));
    mount();
  }
  return { app, path: `/sa/harness/${RUNTIME_ID}/${access}/api/session/create` };
}

function post(server: Server, path: string, body: string, contentType = 'application/json') {
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return new Promise<{ status: number; body: string }>((resolvePromise, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': contentType, 'content-length': Buffer.byteLength(body) } },
      (response) => {
        let text = '';
        response.on('data', (chunk) => {
          text += chunk.toString('utf8');
        });
        response.on('end', () => resolvePromise({ status: response.statusCode ?? 0, body: text }));
      },
    );
    request.once('error', reject);
    request.end(body);
  });
}

function listen(app: express.Express) {
  return new Promise<Server>((resolvePromise) => {
    const server = createServer(app);
    server.listen(0, '127.0.0.1', () => resolvePromise(server));
  });
}

describe('main.ts 中间件顺序（源码不变量）', () => {
  const source = readFileSync(join(__dirname, '../../src/main.ts'), 'utf8');
  const proxyAt = source.indexOf("app.use('/sa/harness'");

  it('harness 代理注册在所有 body 解析之前', () => {
    const firstParserAt = source.indexOf('json({ limit:');
    expect(proxyAt).toBeGreaterThan(-1);
    expect(firstParserAt).toBeGreaterThan(-1);
    expect(proxyAt).toBeLessThan(firstParserAt);
    // 关掉 Nest 默认解析器，否则默认解析器同样会在代理之前消费 body
    expect(source).toContain('bodyParser: false');
  });

  it('CORS 注册在 harness 代理之前（opaque origin iframe 的跨域放行）', () => {
    const corsAt = source.indexOf('app.enableCors(');
    expect(corsAt).toBeGreaterThan(-1);
    expect(corsAt).toBeLessThan(proxyAt);
  });
});

describe('Harness 代理转发请求体', () => {
  it('代理在解析器之前：JSON 信封原样到达上游，客户端拿到 200', async () => {
    const { app, path } = buildApp('proxy-first');
    const server = await listen(app);
    try {
      const response = await post(server, path, ENVELOPE);
      expect(received.at(-1)?.body).toBe(ENVELOPE);
      expect(response.status).toBe(200);
      expect(response.body).toContain('"ok":true');
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  it('反面：解析器在代理之前会吃掉 body（线上故障的最小复现）', async () => {
    const { app, path } = buildApp('parsers-first');
    const server = await listen(app);
    try {
      const response = await post(server, path, ENVELOPE);
      expect(received.at(-1)?.body).toBe('');
      expect(response.body).toContain('body is not JSON');
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });
});
