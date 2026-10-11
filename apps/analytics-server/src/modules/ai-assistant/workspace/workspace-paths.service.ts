import {
  HttpStatus,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { domainError } from '../../../i18n/domain-error';
import { createHash, randomBytes } from 'crypto';
import { execFile } from 'child_process';
import { chmod, chown, lstat, mkdir, realpath, writeFile } from 'fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import { promisify } from 'util';
import type {
  DeepseekHarnessConfig,
  HarnessWorkspaceKind,
} from '../../../config/deepseek-harness-config';

const execFileAsync = promisify(execFile);
const SAFE_PATH_ID = /^[a-zA-Z0-9_-]+$/;

/** AI 工作区内容根（与仓库 ai_workspace/ 同构；phase: clklog-ai-workspace-sync-v1） */
export const AI_WORKSPACE_DIR = 'ai_workspace';
/** 项目空间子目录：`ai_workspace/app/<项目名>`，容器内挂到 /workspace/app */
export const PROJECT_APP_DIR_NAME = 'app';
/**
 * 项目名会进入文件路径（可读、可 rsync 对拷），因此必须严格校验：
 * 小写字母/数字开头，允许 `-` `_`，最长 64；禁止 `..`、`/`、空白与点开头。
 */
export const PROJECT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function assertProjectName(project: string): string {
  if (typeof project !== 'string' || !PROJECT_NAME_PATTERN.test(project)) {
    throw new Error(`项目名不适用于路径: ${String(project)}`);
  }
  return project;
}
/** 项目哈希目录保持 0700（与根一致），app 本身 0750：只有 harness 运行用户可以真正打开 */
export const PROJECT_APP_DIR_MODE = 0o750;
const PROJECT_APP_FILE_MODE = 0o640;

export const PROJECT_APP_README = `# 项目工作目录（app）

本目录属于**当前项目**，同一项目的成员共享，切换项目后看到的是另一个项目的 \`app\`。

- 放这里：跨会话要保留的项目资料（分析笔记、SQL 片段、交付物、口径说明）。
- 不放这里：登录 token、数据库口令、供应商密钥、未脱敏身份明细，以及平台模板文件。
- 目录归属与清理由平台运维负责；不要删除 \`project.json\`（它标识本目录属于哪个项目）。
`;

/**
 * 项目空间在 Harness 管理根下的相对分层：`ai_workspace/app/<项目名>`。
 * 与仓库 `ai_workspace/` 同构（同步脚本不需要复刻哈希）；隔离由项目名校验 + broker 形状校验保证。
 */
export function projectAppSegments(project: string): string[] {
  return [AI_WORKSPACE_DIR, PROJECT_APP_DIR_NAME, assertProjectName(project)];
}

/**
 * 在指定根下创建/校正项目 app 目录（导出以便单测；服务内经 ensureProjectAppDirectory 调用）。
 *
 * 幂等：已存在只做校验与权限校正，不覆盖内容；首次创建写入 project.json 与 README.md 做租户标识。
 * 安全：拒绝符号链接与非常规路径（挂载源必须是真实目录，否则容器内可越权访问其他项目）。
 */
export async function ensureProjectAppDirectoryAt(args: {
  root: string;
  project: string;
  owner: { uid: number; gid: number };
  /** 仅 root 可改属主；测试与非 root 部署传 false */
  applyOwnership: boolean;
}): Promise<{ path: string; created: boolean }> {
  const { root, project, owner, applyOwnership } = args;
  // 以规范化后的根为基准：根本身可能是符号链接（macOS 的 /tmp、被软链的 home），
  // 直接拼原串比较会在这种环境下误判「不是规范路径」
  let base: string;
  try {
    base = await realpath(root);
  } catch {
    throw new Error('Harness 管理根不存在');
  }
  // 父链（ai_workspace、ai_workspace/app）保持 0700；项目目录本身 0750
  const aiRoot = resolve(base, AI_WORKSPACE_DIR);
  const appParent = resolve(aiRoot, PROJECT_APP_DIR_NAME);
  const app = resolve(appParent, assertProjectName(project));
  const child = relative(base, app);
  if (child === '' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error('路径越过 Harness 管理根目录');
  }

  let existed = true;
  try {
    const info = await lstat(app);
    if (info.isSymbolicLink()) throw new Error('项目 app 目录是符号链接，拒绝使用');
    if (!info.isDirectory()) throw new Error('项目 app 路径不是目录');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    existed = false;
  }

  await mkdir(app, { recursive: true, mode: PROJECT_APP_DIR_MODE });
  // 只校正 ai_workspace 两级父目录与项目目录本身；管理根与其它运行时目录保持 0700
  await chmod(aiRoot, 0o700);
  await chmod(appParent, 0o700);
  await chmod(app, PROJECT_APP_DIR_MODE);
  if (applyOwnership) {
    await chown(aiRoot, owner.uid, owner.gid);
    await chown(appParent, owner.uid, owner.gid);
    await chown(app, owner.uid, owner.gid);
  }

  const canonical = await realpath(app);
  if (canonical !== app) throw new Error('项目 app 目录不是规范路径');

  if (!existed) {
    const files: [string, string][] = [
      [
        'project.json',
        `${JSON.stringify({ project, created_at: new Date().toISOString(), visibility: 'project members' }, null, 2)}\n`,
      ],
      ['README.md', PROJECT_APP_README],
    ];
    for (const [name, content] of files) {
      const target = join(app, name);
      try {
        await writeFile(target, content, { mode: PROJECT_APP_FILE_MODE, flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      if (applyOwnership) await chown(target, owner.uid, owner.gid);
    }
  }
  return { path: app, created: !existed };
}

export interface HarnessSystemUser {
  username: string;
  uid: number;
  gid: number;
  home: string;
}

export interface HarnessRuntimePaths {
  base: string;
  dshHome: string;
  instances: string;
}

/** Linux `sockaddr_un.sun_path` is 108 bytes including the trailing NUL. */
export const MAX_UNIX_SOCKET_PATH_BYTES = 107;

function hashPathKey(namespace: 'user' | 'project', value: string): string {
  return createHash('sha256')
    .update(`${namespace}\0${value}`)
    .digest('hex')
    .slice(0, 32);
}

export function ownedDirectoryChain(root: string, target: string): string[] {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  const child = relative(normalizedRoot, normalizedTarget);
  if (child === '') return [normalizedRoot];
  if (child.startsWith(`..${sep}`) || child === '..' || isAbsolute(child)) {
    throw new Error('路径越过 Harness 管理根目录');
  }
  const chain = [normalizedRoot];
  let current = normalizedRoot;
  for (const segment of child.split(sep)) {
    if (!segment) continue;
    current = join(current, segment);
    chain.push(current);
  }
  return chain;
}

export function createOrderedId(prefix: 'aiw_' | 'aiws_' | 'air_' | 'ais_'): string {
  const timestamp = Date.now().toString(16).padStart(12, '0');
  return `${prefix}${timestamp}${randomBytes(10).toString('hex')}`;
}

export function parsePasswdRecord(line: string, expectedUser: string): HarnessSystemUser {
  const fields = line.trim().split(':');
  if (fields.length < 7 || fields[0] !== expectedUser) {
    throw new Error('系统用户查询返回无效记录');
  }
  const uid = Number(fields[2]);
  const gid = Number(fields[3]);
  if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid <= 0 || gid <= 0) {
    throw new Error('Harness 系统用户必须是非 root 用户');
  }
  const home = fields[5];
  if (!isAbsolute(home) || home === '/') throw new Error('Harness 系统用户 home 无效');
  return { username: expectedUser, uid, gid, home };
}

@Injectable()
export class WorkspacePathsService implements OnModuleInit {
  private readonly logger = new Logger(WorkspacePathsService.name);
  private identity?: Promise<HarnessSystemUser>;
  private rootPath?: string;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    if (!this.harnessConfig().enabled) return;
    try {
      await this.ensureRoot();
    } catch (error) {
      this.logger.error(
        `Harness 文件系统暂不可用，分析主服务继续启动: ${
          error instanceof Error ? error.message : 'unknown'
        }`,
      );
    }
  }

  harnessConfig(): DeepseekHarnessConfig {
    const value = this.config.get<DeepseekHarnessConfig>('deepseek_harness');
    if (!value) {
      throw domainError(HttpStatus.SERVICE_UNAVAILABLE, {
        code: 'ai.runtime.configMissing',
        messageKey: 'ai:error.runtime.configMissing',
        message: 'DeepSeek Harness 配置不存在',
      });
    }
    return value;
  }

  async systemUser(): Promise<HarnessSystemUser> {
    this.identity ??= this.resolveSystemUser();
    return this.identity;
  }

  async root(): Promise<string> {
    if (!this.rootPath) await this.ensureRoot();
    return this.rootPath as string;
  }

  async initializationRoot(): Promise<string> {
    return join(await this.root(), 'initialization');
  }

  /** AI 工作区内容根（= 仓库 ai_workspace/ 在运行时的对应物） */
  async aiWorkspaceRoot(): Promise<string> {
    return join(await this.root(), AI_WORKSPACE_DIR);
  }

  /**
   * 模板草稿根：`ai_workspace/default`。
   * 平台「AI Workspace 模板」编辑的就是它，仓库里同路径目录是它的 git 版本（双向同步）。
   */
  async templateDraftRoot(): Promise<string> {
    return join(await this.aiWorkspaceRoot(), 'default');
  }

  async runtimePaths(userId: string, project: string): Promise<HarnessRuntimePaths> {
    const base = this.withinRoot(
      await this.root(),
      'runtimes',
      hashPathKey('user', userId),
      hashPathKey('project', project),
    );
    return {
      base,
      dshHome: join(base, 'dsh-home'),
      instances: join(base, 'instances'),
    };
  }

  async runtimeInstancePath(
    _userId: string,
    _project: string,
    runtimeId: string,
  ): Promise<string> {
    this.assertPathId(runtimeId, 'runtime_id');
    const path = this.withinRoot(await this.root(), 'rt', runtimeId);
    const socketPath = join(path, 'runtime.sock');
    if (Buffer.byteLength(socketPath) > MAX_UNIX_SOCKET_PATH_BYTES) {
      throw domainError(HttpStatus.SERVICE_UNAVAILABLE, {
        code: 'ai.runtime.socketPathTooLong',
        messageKey: 'ai:error.runtime.socketPathTooLong',
        message: 'Harness Runtime socket 路径过长',
      });
    }
    return path;
  }

  async workspacePath(
    userId: string,
    project: string,
    kind: HarnessWorkspaceKind,
    workspaceId: string,
  ): Promise<string> {
    this.assertPathId(workspaceId, 'workspace_id');
    return this.withinRoot(
      await this.root(),
      'workspaces',
      hashPathKey('project', project),
      hashPathKey('user', userId),
      kind,
      workspaceId,
    );
  }

  /** 项目 app 目录的 host 绝对路径（不存在时不创建） */
  async projectAppPath(project: string): Promise<string> {
    return this.withinRoot(await this.root(), ...projectAppSegments(project));
  }

  /**
   * 创建/校正项目 app 目录并返回其 host 路径（供 broker 挂载到 /workspace/app）。
   * 失败直接抛错：宁可不启动 runtime，也不让「项目隔离目录缺失」被静默降级。
   */
  async ensureProjectAppDirectory(project: string): Promise<string> {
    const root = await this.root();
    const user = await this.systemUser();
    const { path } = await ensureProjectAppDirectoryAt({
      root,
      project,
      owner: { uid: user.uid, gid: user.gid },
      applyOwnership: typeof process.geteuid === 'function' && process.geteuid() === 0,
    });
    return path;
  }

  async ensureOwnedDirectory(target: string, mode = 0o700): Promise<string> {
    const root = await this.root();
    const path = this.assertWithin(root, target);
    const user = await this.systemUser();
    await mkdir(path, { recursive: true, mode });
    const chain = ownedDirectoryChain(root, path);
    if (typeof process.geteuid === 'function' && process.geteuid() === 0) {
      for (const directory of chain) {
        await chmod(directory, mode);
        await chown(directory, user.uid, user.gid);
      }
    } else {
      await chmod(path, mode);
    }
    return path;
  }

  assertWithin(parent: string, candidate: string): string {
    const normalizedParent = resolve(parent);
    const normalizedCandidate = resolve(candidate);
    const child = relative(normalizedParent, normalizedCandidate);
    if (child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))) {
      return normalizedCandidate;
    }
    throw new Error('路径越过 Harness 管理根目录');
  }

  private withinRoot(parent: string, ...segments: string[]): string {
    return this.assertWithin(parent, join(parent, ...segments));
  }

  private assertPathId(value: string, field: string): void {
    if (!SAFE_PATH_ID.test(value)) throw new Error(`${field} 格式无效`);
  }

  private async resolveSystemUser(): Promise<HarnessSystemUser> {
    const username = this.harnessConfig().runtime.linux_user;
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync('getent', ['passwd', username], {
        env: { PATH: '/usr/bin:/bin', LANG: 'C' },
        timeout: 5_000,
        maxBuffer: 8_192,
      }));
    } catch {
      throw domainError(HttpStatus.SERVICE_UNAVAILABLE, {
        code: 'ai.runtime.linuxUserMissing',
        messageKey: 'ai:error.runtime.linuxUserMissing',
        params: { username },
        message: `Harness Linux 用户不存在或不可查询: ${username}`,
      });
    }
    const user = parsePasswdRecord(stdout, username);
    let canonicalHome: string;
    try {
      canonicalHome = await realpath(user.home);
    } catch {
      throw domainError(HttpStatus.SERVICE_UNAVAILABLE, {
        code: 'ai.runtime.linuxHomeMissing',
        messageKey: 'ai:error.runtime.linuxHomeMissing',
        params: { username },
        message: `Harness Linux 用户 home 不存在: ${username}`,
      });
    }
    if (!isAbsolute(canonicalHome) || canonicalHome === '/') {
      throw domainError(HttpStatus.SERVICE_UNAVAILABLE, {
        code: 'ai.runtime.linuxHomeInvalid',
        messageKey: 'ai:error.runtime.linuxHomeInvalid',
        params: { username },
        message: `Harness Linux 用户 home 无效: ${username}`,
      });
    }
    return { ...user, home: canonicalHome };
  }

  private async ensureRoot(): Promise<void> {
    const user = await this.systemUser();
    const root = this.assertWithin(
      user.home,
      join(user.home, this.harnessConfig().runtime.home_subdir),
    );
    const directories = [
      root,
      join(root, 'initialization'),
      join(root, 'runtimes'),
      join(root, 'workspaces'),
      join(root, 'rt'),
      join(root, 'gateway'),
      join(root, 'gateway', 'control'),
      join(root, 'gateway', 'runtime'),
      // AI 工作区内容（与仓库 ai_workspace/ 同构）：模板草稿 default/ 与项目空间 app/
      join(root, AI_WORKSPACE_DIR),
      join(root, AI_WORKSPACE_DIR, PROJECT_APP_DIR_NAME),
    ];
    for (const directory of directories) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
      if (typeof process.geteuid === 'function' && process.geteuid() === 0) {
        await chown(directory, user.uid, user.gid);
      }
    }
    this.rootPath = root;
    this.logger.log(`Harness 管理根已就绪 (${user.username}, uid=${user.uid})`);
  }
}
