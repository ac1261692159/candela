import { HarnessRuntimeManagerService } from './harness-runtime-manager.service';
import { runInNewContext } from 'vm';
import {
  HarnessWebProxyService,
  isDeadHarnessSocket,
  redactHarnessPath,
} from './harness-web-proxy.service';

describe('HarnessWebProxyService', () => {
  const runtimes = {
    getAuthorizedRuntime: jest.fn(),
    consumeHostTicket: jest.fn(),
  } as unknown as HarnessRuntimeManagerService;
  const service = new HarnessWebProxyService(runtimes);
  const internal = service as unknown as {
    rewriteBody: (
      body: string,
      runtimeId: string,
      access: string,
      contentType?: string,
    ) => string;
    signedAccess: (runtimeId: string, expires: number) => string;
    validAccess: (runtimeId: string, access: string) => boolean;
    parseExternalPath: (value: string) => {
      runtimeId: string;
      access: string;
      upstreamPath: string;
    } | null;
    upstreamHeaders: (
      request: { headers: Record<string, string | string[] | undefined> },
      runtime: { upstreamCookie?: string },
    ) => Record<string, string | string[]>;
    downstreamHeaders: (
      source: Record<string, string | string[] | undefined>,
      runtimeId: string,
      access: string,
      rewritten: boolean,
      events?: boolean,
    ) => Record<string, string | string[]>;
  };
  const runtimeId = `air_${'a'.repeat(24)}`;

  it('rewrites HTML assets and injects a fetch/WebSocket prefix shim', () => {
    const access = internal.signedAccess(runtimeId, Date.now() + 60_000);
    const result = internal.rewriteBody(
      '<html><head><base href="/"></head><body><script src="/plugins/client.js"></script><script>fetch("/api/remote.mux")</script></body></html>',
      runtimeId,
      access,
    );
    const prefix = `/sa/harness/${runtimeId}/${access}`;
    expect(result).toContain(`${prefix}/plugins/client.js`);
    expect(result).toContain(`<base href="${prefix}/"`);
    expect(result).toContain('globalThis.__clklogStorage');
    expect(result).toContain(`(${JSON.stringify(prefix)})`);
    expect(result).toContain('globalThis.fetch=');
    expect(result).toContain('globalThis.WebSocket=');
    expect(result).toContain('PerformanceObserver');
    expect(result).toContain('startTime');
    expect(result).toContain('text/event-stream');
    // 官方弹层开合要通知宿主：面板据此临时扩宽（phase: clklog-analytics-ai-panel-surface-v1）
    expect(result).toContain('clklog:harness-dialog');
    expect(result).toContain('[role="dialog"],[aria-modal="true"]');
    expect(result).toContain(`fetch("${prefix}/api/remote.mux")`);
    expect(result).toContain('HTMLScriptElement');
  });

  it('does not rewrite the official DSH RPC channel string "/api"', () => {
    const access = internal.signedAccess(runtimeId, Date.now() + 60_000);
    const result = internal.rewriteBody(
      'if (channel !== "/api") throw new Error("bad"); const combo = "/plugins/??@deepseek-ai/x/client.js";',
      runtimeId,
      access,
      'application/javascript',
    );
    const prefix = `/sa/harness/${runtimeId}/${access}`;
    expect(result).toContain('channel !== "/api"');
    expect(result).toContain(`"${prefix}/plugins/??@deepseek-ai/x/client.js"`);
    expect(result).not.toContain(`"${prefix}/api"`);
  });

  it('signs a path capability for one runtime and rejects tampering or another runtime', () => {
    const value = internal.signedAccess(runtimeId, Date.now() + 60_000);
    expect(internal.validAccess(runtimeId, value)).toBe(true);
    expect(internal.validAccess(runtimeId, `${value}x`)).toBe(false);
    expect(internal.validAccess(`air_${'b'.repeat(24)}`, value)).toBe(false);
  });

  it('renews only an owned, authorized runtime and keeps the same runtime prefix', async () => {
    const context = { runtimeId, userId: 'u', project: 'p', tabId: 't', capability: 'fixture' };
    const manager = { getAuthorizedRuntime: jest.fn().mockResolvedValue(context), authorizeCapability: jest.fn() };
    const proxy = new HarnessWebProxyService(manager as never);
    await expect(proxy.renewConnection('other', 'p', 't', runtimeId)).rejects.toThrow('connection_missing');
    const value = await proxy.renewConnection('u', 'p', 't', runtimeId);
    expect(value.prefix).toContain(`/sa/harness/${runtimeId}/`);
    expect(manager.authorizeCapability).toHaveBeenCalledTimes(1);
    manager.getAuthorizedRuntime.mockRejectedValue(new Error('登录失效'));
    await expect(proxy.renewConnection('u', 'p', 't', runtimeId)).rejects.toThrow('登录失效');
  });

  it('rewrites old absolute RPC paths after renewal without retrying a failed POST', async () => {
    const access = internal.signedAccess(runtimeId, Date.now() + 60_000);
    const html = internal.rewriteBody('<head></head>', runtimeId, access, 'text/html');
    const script = html.match(/<script>([\s\S]*)<\/script>/)![1];
    const nativeFetch = jest.fn().mockResolvedValue({ status: 401 });
    const parent = { postMessage: jest.fn() };
    let receive: (event: unknown) => void;
    const sandbox = { URL, Request, Map, Element: class { setAttribute() {} }, fetch: nativeFetch, parent,
      location: { href: `https://fixture.test/sa/harness/${runtimeId}/${access}/`, host: 'fixture.test', origin: 'https://fixture.test' },
      addEventListener: (_type: string, callback: typeof receive) => { receive = callback; } };
    runInNewContext(script, sandbox);
    const fresh = internal.signedAccess(runtimeId, Date.now() + 120_000);
    receive!({ source: {}, origin: 'https://fixture.test', data: { type: 'clklog:harness-renewed', prefix: `/sa/harness/${runtimeId}/${fresh}/` } });
    await sandbox.fetch('/api/session/prompt', { method: 'POST' });
    expect(nativeFetch.mock.calls[0][0]).toContain(access);
    receive!({ source: parent, origin: 'https://fixture.test', data: { type: 'clklog:harness-renewed', prefix: `/sa/harness/${runtimeId}/${fresh}/` } });
    await sandbox.fetch(`https://fixture.test/sa/harness/${runtimeId}/${access}/api/session/prompt`, { method: 'POST' });
    expect(nativeFetch.mock.calls[1][0]).toContain(fresh);
    expect(nativeFetch).toHaveBeenCalledTimes(2);
    expect(parent.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'clklog:harness-unauthorized' }), '*');
    await sandbox.fetch('https://elsewhere.test/api/hello');
    expect(nativeFetch.mock.calls[2][0]).toBe('https://elsewhere.test/api/hello');
  });

  it('applies a renewal from the parent even in an opaque-origin sandbox iframe', async () => {
    const access = internal.signedAccess(runtimeId, Date.now() + 60_000);
    const html = internal.rewriteBody('<head></head>', runtimeId, access, 'text/html');
    const script = html.match(/<script>([\s\S]*)<\/script>/)![1];
    const nativeFetch = jest.fn().mockResolvedValue({ status: 200 });
    const parent = { postMessage: jest.fn() };
    let receive: (event: unknown) => void;
    const sandbox = {
      URL,
      Request,
      Map,
      Element: class { setAttribute() {} },
      fetch: nativeFetch,
      parent,
      // 面板是 sandbox iframe：opaque origin 下 origin 为 "null"
      location: { href: `https://fixture.test/sa/harness/${runtimeId}/${access}/`, host: 'fixture.test', origin: 'null' },
      addEventListener: (_type: string, callback: typeof receive) => { receive = callback; },
    };
    runInNewContext(script, sandbox);
    const fresh = internal.signedAccess(runtimeId, Date.now() + 120_000);
    receive!({ source: parent, origin: 'https://fixture.test', data: { type: 'clklog:harness-renewed', prefix: `/sa/harness/${runtimeId}/${fresh}/` } });
    await sandbox.fetch('/api/session/create', { method: 'POST' });
    expect(nativeFetch.mock.calls[0][0]).toContain(fresh);
    // 别的窗口发来的续期一律忽略（前缀合法但发送方不是父页面）
    await sandbox.fetch('/api/session/create', { method: 'POST' });
    receive!({ source: {}, origin: 'https://fixture.test', data: { type: 'clklog:harness-renewed', prefix: `/sa/harness/${runtimeId}/${access}/` } });
    await sandbox.fetch('/api/session/create', { method: 'POST' });
    expect(nativeFetch.mock.calls[2][0]).toContain(fresh);
  });

  it('strips cross-site fetch metadata before the upstream /api trust fence', () => {
    const headers = internal.upstreamHeaders(
      {
        headers: {
          host: 'analytics.example',
          origin: 'null',
          'sec-fetch-site': 'cross-site',
          cookie: 'browser=1',
        },
      },
      { upstreamCookie: 'dsh-auth=ok' },
    );
    expect(headers.host).toBe('127.0.0.1:39200');
    expect(headers.origin).toBe('http://127.0.0.1:39200');
    expect(headers['sec-fetch-site']).toBeUndefined();
    expect(headers.cookie).toBe('dsh-auth=ok');
  });

  it('strips content-length from SSE so HTTP/2 clients are not RST', () => {
    const access = internal.signedAccess(runtimeId, Date.now() + 60_000);
    const headers = internal.downstreamHeaders(
      {
        'content-type': 'text/event-stream',
        'content-length': '0',
        'content-encoding': 'gzip',
      },
      runtimeId,
      access,
      false,
      true,
    );
    expect(headers['content-length']).toBeUndefined();
    expect(headers['content-encoding']).toBeUndefined();
    expect(headers['cache-control']).toContain('no-transform');
    expect(headers['content-type']).toBe('text/event-stream');
    expect(headers['x-accel-buffering']).toBe('no');
  });

  it('parses only the namespaced external runtime route', () => {
    const access = internal.signedAccess(runtimeId, Date.now() + 60_000);
    expect(
      internal.parseExternalPath(`/sa/harness/${runtimeId}/${access}/api/remote.mux?x=1`),
    ).toMatchObject({ runtimeId, access, upstreamPath: '/api/remote.mux?x=1' });
    expect(internal.parseExternalPath('/sa/api/report/schema')).toBeNull();
  });

  it('rewrites opaque-origin browser globals in official JavaScript', () => {
    const access = internal.signedAccess(runtimeId, Date.now() + 60_000);
    const result = internal.rewriteBody(
      'const INTERNAL_BASE = "http://dsh.internal";localStorage.setItem("x", "y")',
      runtimeId,
      access,
      'application/javascript',
    );
    expect(result).toContain('new URL(globalThis.location.href).href');
    expect(result).toContain('globalThis.__clklogStorage.setItem');
  });
});

describe('harness proxy error helpers', () => {
  it('redacts signed access tokens from proxy paths', () => {
    expect(
      redactHarnessPath(
        '/air_aaaaaaaaaaaaaaaaaaaaaaaa/1780000000000.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/api/session/prompt',
      ),
    ).toBe('/air_aaaaaaaaaaaaaaaaaaaaaaaa/<access>/api/session/prompt');
    const missing = Object.assign(new Error('connect ENOENT /rt/air_x/runtime.sock'), {
      code: 'ENOENT',
    });
    expect(isDeadHarnessSocket(missing)).toBe(true);
    expect(isDeadHarnessSocket(new Error('harness_upstream_timeout'))).toBe(false);
    expect(isDeadHarnessSocket(new Error('aborted'))).toBe(false);
  });
});
