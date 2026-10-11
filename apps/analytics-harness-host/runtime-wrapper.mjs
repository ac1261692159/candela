import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { mergeDefaultWorkspace } from './workspace-registry.mjs';

const DSH_HOME = '/dsh-home';
const WORKSPACE = '/workspace';
const INSTANCE_ROOT = '/run/clklog';
const RUNTIME_SOCKET = join(INSTANCE_ROOT, 'runtime.sock');
const READY_FILE = join(INSTANCE_ROOT, 'ready.json');
const DSH_PORT = 39200;
const RELAY_PORT = 39100;
const MAX_RELAY_BODY = 16 * 1024 * 1024;
const SAFE_RUNTIME_ID = /^air_[a-zA-Z0-9_-]{20,}$/;
const ALLOWED_PERMISSION = new Set(['read-only', 'workspace-write', 'danger-full-access']);

process.umask(0o077);

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`缺少参数 ${name}`);
  return process.argv[index + 1];
}

function parseSpec(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Runtime spec 无效');
  const spec = value;
  if (!SAFE_RUNTIME_ID.test(spec.runtime_id)) throw new Error('runtime_id 无效');
  if (typeof spec.capability !== 'string' || !/^[A-Za-z0-9_-]{32,}$/.test(spec.capability)) {
    throw new Error('Runtime capability 无效');
  }
  if (!ALLOWED_PERMISSION.has(spec.permission_mode)) throw new Error('permission_mode 无效');
  if (spec.gateway_socket !== '/gateway/server.sock') throw new Error('gateway_socket 无效');
  return spec;
}

async function replaceFile(source, destination, mode = 0o600) {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.next`;
  await copyFile(source, temporary);
  await chmod(temporary, mode);
  await rename(temporary, destination);
}

async function ensurePluginLink(destination) {
  const source = '/opt/clklog-harness/plugins/analytics-tools';
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  try {
    const info = await lstat(destination);
    if (!info.isSymbolicLink() || (await readlink(destination)) !== source) {
      throw new Error('Harness plugin 路径被非预期内容占用');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await symlink(source, destination, 'dir');
  }
}

async function ensureDefaultWorkspace() {
  const storagePath = join(DSH_HOME, 'storages', 'workspace.json');
  await mkdir(dirname(storagePath), { recursive: true, mode: 0o700 });
  let current = null;
  try {
    current = JSON.parse(await readFile(storagePath, 'utf8'));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const next = mergeDefaultWorkspace(
    current,
    await realpath(WORKSPACE),
    randomUUID(),
    new Date().toISOString(),
  );
  if (next === current) return;
  const temporary = `${storagePath}.next`;
  await writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, storagePath);
}

async function prepareProfile() {
  const profileRoot = join(DSH_HOME, 'profiles', 'clklog-web');
  await mkdir(profileRoot, { recursive: true, mode: 0o700 });
  await replaceFile(
    '/opt/clklog-harness/profile/package.json',
    join(profileRoot, 'package.json'),
  );
  await replaceFile(
    '/opt/clklog-harness/profile/cordis.patch.yml',
    join(profileRoot, 'cordis.patch.yml'),
  );
  await ensurePluginLink(
    join(profileRoot, 'node_modules', '@clklog', 'analytics-harness-tools'),
  );
}

function safeHeaders(headers, host) {
  const result = { ...headers, host };
  delete result['content-length'];
  delete result.connection;
  if (result.origin) result.origin = `http://${host}`;
  return result;
}

function createModelAndToolRelay(spec) {
  return createServer((request, response) => {
    const path = request.url ?? '/';
    if (!path.startsWith('/model/') && !path.startsWith('/tools/')) {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'gateway_path_not_allowed' }));
      return;
    }
    const declared = Number(request.headers['content-length'] ?? 0);
    if (!Number.isFinite(declared) || declared > MAX_RELAY_BODY) {
      response.writeHead(413).end();
      request.destroy();
      return;
    }
    let received = 0;
    request.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_RELAY_BODY) request.destroy(new Error('relay_body_too_large'));
    });
    const upstream = httpRequest(
      {
        socketPath: spec.gateway_socket,
        method: request.method,
        path,
        headers: {
          ...safeHeaders(request.headers, 'clklog-gateway'),
          authorization: `Bearer ${spec.capability}`,
          'x-clklog-runtime-id': spec.runtime_id,
        },
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message: 'clklog_gateway_unavailable' }));
    });
    request.pipe(upstream);
  });
}

function writeUpgradeRequest(upstream, request, head) {
  const headers = safeHeaders(request.headers, `127.0.0.1:${DSH_PORT}`);
  headers.connection = 'Upgrade';
  headers.upgrade = request.headers.upgrade ?? 'websocket';
  const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/1.1`];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`);
  }
  upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
  if (head.length > 0) upstream.write(head);
}

function createDshUnixProxy() {
  const server = createServer((request, response) => {
    const upstream = httpRequest(
      {
        host: '127.0.0.1',
        port: DSH_PORT,
        method: request.method,
        path: request.url,
        headers: safeHeaders(request.headers, `127.0.0.1:${DSH_PORT}`),
      },
      (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      },
    );
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end('harness_runtime_unavailable');
    });
    request.pipe(upstream);
  });
  server.on('upgrade', (request, socket, head) => {
    const upstream = createConnection({ host: '127.0.0.1', port: DSH_PORT });
    upstream.once('connect', () => {
      writeUpgradeRequest(upstream, request, head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  return server;
}

function listen(server, target) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(target, () => {
      server.off('error', reject);
      resolvePromise();
    });
  });
}

function close(server) {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

function launchDsh(spec) {
  const executable = '/opt/clklog-harness/node_modules/@deepseek-ai/dsh/lib/bin.js';
  const child = spawn(
    process.execPath,
    [executable, '--profile', 'clklog-web', '--no-open', '--host', '127.0.0.1', '--port', String(DSH_PORT)],
    {
      cwd: WORKSPACE,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        HOME: DSH_HOME,
        DSH_HOME,
        TMPDIR: '/tmp',
        LANG: 'C.UTF-8',
        SHELL: '/bin/bash',
        NODE_ENV: 'production',
        DSH_TELEMETRY_DISABLED: '1',
        DSH_PERMISSION_MODE: spec.permission_mode,
        CLKLOG_MODEL_CAPABILITY: spec.capability,
        CLKLOG_GATEWAY_BASE_URL: `http://127.0.0.1:${RELAY_PORT}`,
      },
    },
  );
  child.stderr.on('data', (chunk) => {
    const line = chunk.toString('utf8').replace(/token=[A-Za-z0-9_-]+/g, 'token=[redacted]').trim();
    if (line) process.stderr.write(`[dsh] ${line.slice(0, 2_000)}\n`);
  });
  return child;
}

function waitForLaunchToken(child) {
  return new Promise((resolvePromise, reject) => {
    let stdout = '';
    const timeout = setTimeout(() => reject(new Error('Harness Web 启动超时')), 45_000);
    const fail = (error) => {
      clearTimeout(timeout);
      reject(error);
    };
    const onExit = (code) => fail(new Error(`Harness Web 启动失败 (${String(code)})`));
    const consume = (chunk) => {
      stdout = `${stdout}${chunk.toString('utf8')}`.slice(-16_384);
      const match = stdout.match(/dsh web:\s+http:\/\/[^?\s]+\/\?token=([A-Za-z0-9_-]+)/);
      if (!match) return;
      child.off('exit', onExit);
      child.off('error', fail);
      clearTimeout(timeout);
      resolvePromise(match[1]);
    };
    child.stdout.on('data', consume);
    if (child.exitCode != null) {
      fail(new Error(`Harness Web 启动失败 (${String(child.exitCode)})`));
      return;
    }
    child.once('exit', onExit);
    child.once('error', fail);
  });
}

async function main() {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    throw new Error('Harness Runtime 拒绝以 UID 0 运行');
  }
  const spec = parseSpec(JSON.parse(await readFile(argument('--spec'), 'utf8')));
  await prepareProfile();
  await ensureDefaultWorkspace();
  await mkdir(INSTANCE_ROOT, { recursive: true, mode: 0o700 });
  await unlink(RUNTIME_SOCKET).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });

  const relay = createModelAndToolRelay(spec);
  const proxy = createDshUnixProxy();
  await listen(relay, RELAY_PORT);
  await listen(proxy, RUNTIME_SOCKET);
  await chmod(RUNTIME_SOCKET, 0o600);

  const child = launchDsh(spec);
  const token = await waitForLaunchToken(child);
  const temporary = `${READY_FILE}.next`;
  await writeFile(
    temporary,
    `${JSON.stringify({ schema_version: 1, runtime_id: spec.runtime_id, upstream_token: token })}\n`,
    { mode: 0o600 },
  );
  await rename(temporary, READY_FILE);
  process.stdout.write(`[clklog-harness] runtime ready (${spec.runtime_id})\n`);

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    child.kill('SIGTERM');
    await Promise.allSettled([close(proxy), close(relay)]);
    await unlink(RUNTIME_SOCKET).catch(() => undefined);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
  const code = await new Promise((resolvePromise) => child.once('exit', resolvePromise));
  await shutdown();
  process.exitCode = typeof code === 'number' ? code : 1;
}

main().catch((error) => {
  process.stderr.write(`[clklog-harness] ${error instanceof Error ? error.message : 'runtime_failed'}\n`);
  process.exitCode = 1;
});
