import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SAFE_ID = /^[a-zA-Z0-9_-]+$/;
const SAFE_RUNTIME_ID = /^air_[a-zA-Z0-9_-]{20,}$/;
const SAFE_CAPABILITY = /^[A-Za-z0-9_-]{32,}$/;
const PERMISSIONS = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const KINDS = new Set(['persistent', 'temporary']);
const MAX_REQUEST_BYTES = 1024 * 1024;
const READY_TIMEOUT_MS = 60_000;
/** Linux `sockaddr_un.sun_path` is 108 bytes including the trailing NUL. */
const MAX_UNIX_SOCKET_PATH_BYTES = 107;

process.umask(0o077);

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`缺少参数 ${name}`);
  return process.argv[index + 1];
}

/** 项目名会进入容器挂载路径：小写字母/数字开头，允许 - _，最长 64 */
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function hash(namespace, value) {
  return createHash('sha256').update(`${namespace}\0${value}`).digest('hex').slice(0, 32);
}

function within(parent, candidate) {
  const normalizedParent = resolve(parent);
  const normalizedCandidate = resolve(candidate);
  const child = relative(normalizedParent, normalizedCandidate);
  if (child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))) {
    return normalizedCandidate;
  }
  throw new Error('path_outside_harness_root');
}

function assertString(value, name, max = 191) {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0')) {
    throw new Error(`invalid_${name}`);
  }
  return value;
}

function validateEnsure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_request');
  const input = value;
  if (!SAFE_RUNTIME_ID.test(input.runtime_id)) throw new Error('invalid_runtime_id');
  if (!SAFE_ID.test(input.workspace_id)) throw new Error('invalid_workspace_id');
  if (!KINDS.has(input.kind)) throw new Error('invalid_workspace_kind');
  if (!SAFE_CAPABILITY.test(input.capability)) throw new Error('invalid_capability');
  if (!PERMISSIONS.has(input.permission_mode)) throw new Error('invalid_permission_mode');
  return {
    runtimeId: input.runtime_id,
    userId: assertString(input.user_id, 'user_id'),
    project: assertString(input.project_name, 'project_name'),
    workspaceId: input.workspace_id,
    kind: input.kind,
    capability: input.capability,
    permissionMode: input.permission_mode,
    appDir: input.app_dir === undefined ? null : assertString(input.app_dir, 'app_dir', 1_024),
  };
}

/**
 * 项目空间目录校验（phase: clklog-ai-workspace-project-isolation-v1 / -sync-v1）。
 *
 * 只认一种形状：<root>/ai_workspace/app/<项目名>，且必须是真实目录（拒 symlink）。
 * 项目名进入路径，因此先做字符集校验（禁 `..`、`/`、空白）；再与期望值逐字比对——
 * 刻意**不**把白名单放宽成「ai_workspace/app 下任意路径」，否则 upstream 一旦被污染
 * 就能把别的项目目录挂进容器。
 */
async function projectAppDirectory(config, project, candidate) {
  if (!PROJECT_NAME.test(project)) throw new Error('invalid_project_name');
  const expected = within(config.root, join(config.root, 'ai_workspace', 'app', project));
  if (candidate !== expected) throw new Error('app_dir_not_allowed');
  let info;
  try {
    info = await lstat(expected);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('app_dir_missing');
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error('app_dir_is_symlink');
  if (!info.isDirectory()) throw new Error('app_dir_not_directory');
  const canonical = await realpath(expected);
  if (canonical !== expected) throw new Error('app_dir_not_canonical');
  return expected;
}

async function loadConfig(path) {
  const value = JSON.parse(await readFile(path, 'utf8'));
  const identity = userInfo();
  if (typeof process.getuid !== 'function' || process.getuid() === 0) {
    throw new Error('broker_refuses_uid_0');
  }
  if (value.schema_version !== 1) throw new Error('invalid_broker_config_version');
  const home = await realpath(identity.homedir);
  const root = await realpath(assertString(value.root, 'root', 1_024));
  within(home, root);
  const harnessHost = await realpath(assertString(value.harness_host, 'harness_host', 1_024));
  const podman = assertString(value.podman_path, 'podman_path', 1_024);
  if (!isAbsolute(podman)) throw new Error('invalid_podman_path');
  const image = assertString(value.container_image, 'container_image', 512);
  if (/\s/.test(image)) throw new Error('invalid_container_image');
  const maxRuntimes = Number(value.max_runtimes);
  const maxWorkspaceBytes = Number(value.max_workspace_bytes);
  if (!Number.isSafeInteger(maxRuntimes) || maxRuntimes < 1 || maxRuntimes > 64) {
    throw new Error('invalid_max_runtimes');
  }
  if (!Number.isSafeInteger(maxWorkspaceBytes) || maxWorkspaceBytes < 1024 * 1024) {
    throw new Error('invalid_max_workspace_bytes');
  }
  return {
    root,
    harnessHost,
    podman,
    image,
    maxRuntimes,
    maxWorkspaceBytes,
    uid: process.getuid(),
    gid: process.getgid(),
    home,
    xdgRuntimeDir: `/run/user/${String(process.getuid())}`,
  };
}

function podmanEnvironment(config) {
  return {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: config.home,
    XDG_RUNTIME_DIR: config.xdgRuntimeDir,
    LANG: 'C.UTF-8',
  };
}

async function podman(config, args, timeout = 60_000) {
  return execFileAsync(config.podman, args, {
    env: podmanEnvironment(config),
    timeout,
    maxBuffer: 1024 * 1024,
  });
}

async function pathWithoutLinks(root, relativePath) {
  const segments = relativePath.split('/');
  let current = root;
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') throw new Error('invalid_managed_path');
    current = within(root, join(current, segment));
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('managed_path_is_symlink');
  }
  return current;
}

async function managedMounts(workspaceRoot) {
  const manifestPath = join(workspaceRoot, '.clklog', 'managed-manifest.json');
  const raw = await readFile(manifestPath, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > 2 * 1024 * 1024) throw new Error('managed_manifest_too_large');
  const manifest = JSON.parse(raw);
  if (manifest.schema_version !== 1 || !Array.isArray(manifest.entries)) {
    throw new Error('invalid_managed_manifest');
  }
  const paths = manifest.entries
    .filter((entry) => entry?.policy === 'managed_readonly' && typeof entry.path === 'string')
    .map((entry) => entry.path)
    .sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right));
  const roots = paths.filter(
    (candidate, index) => !paths.slice(0, index).some((parent) => candidate.startsWith(`${parent}/`)),
  );
  const mounts = [];
  for (const relativePath of roots) {
    const source = await pathWithoutLinks(workspaceRoot, relativePath);
    mounts.push({ source, target: `/workspace/${relativePath}` });
  }
  return mounts;
}

async function workspaceUsage(workspaceRoot, maximumBytes) {
  let bytes = 0;
  let entries = 0;
  const visit = async (path) => {
    const info = await lstat(path);
    entries += 1;
    if (entries > 100_000) throw new Error('workspace_entry_limit_exceeded');
    if (info.isSymbolicLink()) {
      // Never follow a link into another host path. The link itself is tiny and
      // resolves only inside the already isolated Runtime mount namespace.
      bytes += info.size;
    } else if (info.isDirectory()) {
      for (const name of await readdir(path)) await visit(join(path, name));
    } else if (info.isFile() || info.isSocket() || info.isFIFO()) {
      bytes += info.size;
    } else {
      throw new Error('workspace_special_file_rejected');
    }
    if (bytes > maximumBytes) throw new Error('workspace_quota_exceeded');
  };
  await visit(workspaceRoot);
  return { bytes, entries };
}

function mount(source, target, readOnly) {
  return `type=bind,src=${source},dst=${target}${readOnly ? ',ro=true' : ''}`;
}

async function containerExists(config, name) {
  try {
    await podman(config, ['container', 'exists', name], 10_000);
    return true;
  } catch {
    return false;
  }
}

async function readReady(instanceRoot, runtimeId) {
  const ready = JSON.parse(await readFile(join(instanceRoot, 'ready.json'), 'utf8'));
  if (
    ready.schema_version !== 1 ||
    ready.runtime_id !== runtimeId ||
    typeof ready.upstream_token !== 'string' ||
    !SAFE_CAPABILITY.test(ready.upstream_token)
  ) {
    throw new Error('invalid_runtime_ready_document');
  }
  const socketPath = join(instanceRoot, 'runtime.sock');
  const info = await lstat(socketPath);
  if (!info.isSocket()) throw new Error('runtime_socket_missing');
  return { runtime_id: runtimeId, socket_path: socketPath, upstream_token: ready.upstream_token };
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function waitReady(config, instanceRoot, runtimeId, name) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await readReady(instanceRoot, runtimeId);
    } catch (error) {
      lastError = error;
    }
    if (!(await containerExists(config, name))) break;
    await delay(250);
  }
  const message = lastError instanceof Error ? lastError.message : 'runtime_start_failed';
  throw new Error(message);
}

async function writeSpec(path, input) {
  const temporary = `${path}.next`;
  await writeFile(
    temporary,
    `${JSON.stringify({
      schema_version: 1,
      runtime_id: input.runtimeId,
      capability: input.capability,
      permission_mode: input.permissionMode,
      gateway_socket: '/gateway/server.sock',
    })}\n`,
    { mode: 0o600 },
  );
  await rename(temporary, path);
}

async function runningContainerCount(config) {
  const { stdout } = await podman(
    config,
    ['ps', '--filter', 'label=io.clklog.runtime=true', '--format', '{{.ID}}'],
    10_000,
  );
  return stdout.split('\n').filter(Boolean).length;
}

async function cleanupOrphanContainers(config) {
  const { stdout } = await podman(
    config,
    ['ps', '--all', '--filter', 'label=io.clklog.runtime=true', '--format', '{{.Names}}'],
    10_000,
  );
  for (const name of stdout.split('\n').filter(Boolean)) {
    if (!/^clklog-ai-air_[a-zA-Z0-9_-]{20,}$/.test(name)) continue;
    await podman(config, ['stop', '--time', '2', name], 10_000).catch(() => undefined);
  }
}

class RuntimeBroker {
  locks = new Map();
  active = new Map();

  constructor(config) {
    this.config = config;
  }

  ensure(raw) {
    const input = validateEnsure(raw);
    const existing = this.locks.get(input.runtimeId);
    if (existing) return existing;
    const task = this.ensureNow(input).finally(() => this.locks.delete(input.runtimeId));
    this.locks.set(input.runtimeId, task);
    return task;
  }

  async ensureNow(input) {
    const config = this.config;
    const userHash = hash('user', input.userId);
    const projectHash = hash('project', input.project);
    const runtimeBase = within(config.root, join(config.root, 'runtimes', userHash, projectHash));
    const dshHome = within(runtimeBase, join(runtimeBase, 'dsh-home'));
    const instanceRoot = within(config.root, join(config.root, 'rt', input.runtimeId));
    const socketPath = join(instanceRoot, 'runtime.sock');
    if (Buffer.byteLength(socketPath) > MAX_UNIX_SOCKET_PATH_BYTES) {
      throw new Error('runtime_socket_path_too_long');
    }
    const workspaceRoot = within(
      config.root,
      join(config.root, 'workspaces', projectHash, userHash, input.kind, input.workspaceId),
    );
    let canonicalWorkspace;
    try {
      canonicalWorkspace = await realpath(workspaceRoot);
    } catch (error) {
      if (error?.code === 'ENOENT') throw new Error('workspace_missing');
      if (error?.code === 'EACCES') throw new Error('workspace_not_readable');
      throw error;
    }
    if (canonicalWorkspace !== workspaceRoot) throw new Error('workspace_path_not_canonical');
    await workspaceUsage(workspaceRoot, config.maxWorkspaceBytes);
    const projectAppDir = input.appDir
      ? await projectAppDirectory(config, input.project, input.appDir)
      : null;
    await mkdir(dshHome, { recursive: true, mode: 0o700 });
    await mkdir(instanceRoot, { recursive: true, mode: 0o700 });
    await mkdir(config.xdgRuntimeDir, { recursive: true, mode: 0o700 });

    const name = `clklog-ai-${input.runtimeId}`;
    if (await containerExists(config, name)) {
      try {
        const ready = await readReady(instanceRoot, input.runtimeId);
        this.active.set(input.runtimeId, { name, workspaceRoot });
        return ready;
      } catch {
        await podman(config, ['stop', '--time', '5', name], 15_000).catch(() => undefined);
      }
    }
    if ((await runningContainerCount(config)) >= config.maxRuntimes) {
      throw new Error('runtime_limit_reached');
    }
    for (const path of ['runtime.sock', 'ready.json', 'runtime-spec.json']) {
      await unlink(join(instanceRoot, path)).catch((error) => {
        if (error?.code !== 'ENOENT') throw error;
      });
    }
    await writeSpec(join(instanceRoot, 'runtime-spec.json'), input);
    const readonlyMounts = await managedMounts(workspaceRoot);
    const controlRoot = await pathWithoutLinks(workspaceRoot, '.clklog');
    const args = [
      'run',
      '--detach',
      '--rm',
      '--name',
      name,
      '--label',
      'io.clklog.runtime=true',
      '--label',
      `io.clklog.runtime_id=${input.runtimeId}`,
      '--network=none',
      '--ipc=private',
      '--uts=private',
      '--cgroupns=private',
      '--http-proxy=false',
      '--read-only',
      '--cap-drop=all',
      '--security-opt=no-new-privileges',
      '--pids-limit=256',
      '--memory=1g',
      '--cpus=2',
      '--ulimit',
      `fsize=${String(config.maxWorkspaceBytes)}:${String(config.maxWorkspaceBytes)}`,
      '--userns=keep-id',
      '--user',
      `${String(config.uid)}:${String(config.gid)}`,
      '--workdir=/workspace',
      '--tmpfs=/tmp:rw,nosuid,nodev,size=268435456',
      '--mount',
      mount(config.harnessHost, '/opt/clklog-harness', true),
      '--mount',
      mount(dshHome, '/dsh-home', false),
      '--mount',
      mount(workspaceRoot, '/workspace', false),
      ...(projectAppDir
        ? ['--mount', mount(projectAppDir, '/workspace/app', false)]
        : []),
      '--mount',
      mount(instanceRoot, '/run/clklog', false),
      '--mount',
      mount(join(config.root, 'gateway', 'runtime'), '/gateway', true),
      '--mount',
      mount(controlRoot, '/workspace/.clklog', true),
      ...readonlyMounts.flatMap(({ source, target }) => ['--mount', mount(source, target, true)]),
      config.image,
      'node',
      '/opt/clklog-harness/runtime-wrapper.mjs',
      '--spec',
      '/run/clklog/runtime-spec.json',
    ];
    try {
      await podman(config, args, 120_000);
      const ready = await waitReady(config, instanceRoot, input.runtimeId, name);
      this.active.set(input.runtimeId, { name, workspaceRoot });
      return ready;
    } catch (error) {
      await podman(config, ['stop', '--time', '2', name], 10_000).catch(() => undefined);
      const code = error instanceof Error && /^[a-z0-9_]{3,80}$/.test(error.message)
        ? error.message
        : 'runtime_start_failed';
      throw new Error(code);
    }
  }

  async stop(runtimeId) {
    if (!SAFE_RUNTIME_ID.test(runtimeId)) throw new Error('invalid_runtime_id');
    const name = `clklog-ai-${runtimeId}`;
    if (await containerExists(this.config, name)) {
      await podman(this.config, ['stop', '--time', '10', name], 20_000);
    }
    this.active.delete(runtimeId);
    return { ok: true };
  }

  async enforceWorkspaceQuotas() {
    for (const [runtimeId, runtime] of this.active) {
      try {
        await workspaceUsage(runtime.workspaceRoot, this.config.maxWorkspaceBytes);
      } catch (error) {
        const code = error instanceof Error ? error.message : 'workspace_quota_scan_failed';
        process.stderr.write(`[clklog-harness-broker] stopping ${runtimeId}: ${code}\n`);
        await podman(this.config, ['stop', '--time', '2', runtime.name], 10_000)
          .catch(() => undefined);
        this.active.delete(runtimeId);
      }
    }
  }
}

async function readJsonBody(request) {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (!Number.isFinite(declared) || declared > MAX_REQUEST_BYTES) throw new Error('request_too_large');
  const chunks = [];
  let received = 0;
  for await (const chunk of request) {
    received += chunk.length;
    if (received > MAX_REQUEST_BYTES) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function send(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(`${JSON.stringify(payload)}\n`);
}

async function main() {
  const config = await loadConfig(argument('--config'));
  await cleanupOrphanContainers(config).catch((error) => {
    process.stderr.write(
      `[clklog-harness-broker] orphan_cleanup_failed ${error instanceof Error ? error.message : 'unknown'}\n`,
    );
  });
  const broker = new RuntimeBroker(config);
  const socketPath = join(config.root, 'gateway', 'control', 'broker.sock');
  await unlink(socketPath).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/v1/health') {
        send(response, 200, { ok: true });
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/runtime/ensure') {
        send(response, 200, await broker.ensure(await readJsonBody(request)));
        return;
      }
      if (request.method === 'POST' && request.url === '/v1/runtime/stop') {
        const body = await readJsonBody(request);
        send(response, 200, await broker.stop(body.runtime_id));
        return;
      }
      send(response, 404, { message: 'not_found' });
    } catch (error) {
      const code = error instanceof Error && /^[a-z0-9_]{3,80}$/.test(error.message)
        ? error.message
        : 'broker_request_failed';
      process.stderr.write(
        `[clklog-harness-broker] ${request.method} ${request.url} ${code}\n`,
      );
      send(response, code === 'runtime_limit_reached' ? 429 : 400, { message: code });
    }
  });
  server.listen(socketPath, async () => {
    await chmod(socketPath, 0o660);
    process.stdout.write(`[clklog-harness-broker] listening (${socketPath})\n`);
  });
  const quotaTimer = setInterval(() => void broker.enforceWorkspaceQuotas(), 30_000);
  quotaTimer.unref();
  const shutdown = () => {
    clearInterval(quotaTimer);
    server.close(() => void unlink(socketPath).finally(() => process.exit(0)));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

export const __test = Object.freeze({ within, validateEnsure, managedMounts, workspaceUsage, projectAppDirectory, hash, PROJECT_NAME });

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main().catch((error) => {
    process.stderr.write(`[clklog-harness-broker] ${error instanceof Error ? error.message : 'startup_failed'}\n`);
    process.exitCode = 1;
  });
}
