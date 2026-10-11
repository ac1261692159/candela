import {
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { badRequest, notFound } from '../../../i18n/domain-error';
import { createHash } from 'crypto';
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { PrismaService } from '../../shared/prisma.service';
import { WorkspacePathsService } from './workspace-paths.service';
import {
  WorkspaceTemplateEntry,
  WorkspaceTemplateDraftEntry,
  WorkspaceTemplateManifest,
  WorkspaceTemplatePolicies,
  WorkspaceTemplatePolicy,
} from './workspace-template.types';
import {
  normalizeTemplatePath,
  resolveTemplatePath,
} from './workspace-template-path';

const POLICY_FILE = 'draft-policies.json';
const VERSION_MANIFEST_FILE = '.clklog-template-manifest.json';
const MAX_TEMPLATE_FILES = 2_000;
const MAX_TEMPLATE_BYTES = 32 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES = 4 * 1024 * 1024;

const DEFAULT_POLICIES: WorkspaceTemplatePolicies = {
  schema_version: 1,
  entries: {
    '.dsh-root': 'managed_readonly',
    'AGENTS.md': 'managed_readonly',
    tools: 'managed_readonly',
  },
};

@Injectable()
export class WorkspaceTemplateService implements OnModuleInit {
  private readonly logger = new Logger(WorkspaceTemplateService.name);
  private publishTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly paths: WorkspacePathsService,
    private readonly prisma: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.paths.harnessConfig().enabled) return;
    try {
      await this.bootstrap();
    } catch (error) {
      this.logger.error(
        `初始化 Workspace 模板暂不可用: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }

  async draftTree(): Promise<{ entries: WorkspaceTemplateDraftEntry[] }> {
    const draft = await this.draftRoot();
    const policies = await this.readPolicies();
    const manifest = await this.scan(draft, policies, 0);
    const entries: WorkspaceTemplateDraftEntry[] = [];
    for (const entry of manifest.entries) {
      if (entry.kind === 'directory') {
        entries.push(entry);
        continue;
      }
      const data = await readFile(resolveTemplatePath(draft, entry.path));
      const isText = !data.includes(0);
      entries.push({
        ...entry,
        content: data.toString(isText ? 'utf8' : 'base64'),
        encoding: isText ? 'utf8' : 'base64',
      });
    }
    return { entries };
  }

  async putFile(input: {
    path: string;
    content: string;
    encoding?: 'utf8' | 'base64';
    executable?: boolean;
  }): Promise<{ ok: true }> {
    const draft = await this.draftRoot();
    const normalized = normalizeTemplatePath(input.path);
    const target = resolveTemplatePath(draft, normalized);
    const data = Buffer.from(input.content ?? '', input.encoding === 'base64' ? 'base64' : 'utf8');
    if (data.byteLength > MAX_SINGLE_FILE_BYTES) {
      throw badRequest({
        code: 'ai.template.fileTooLarge',
        messageKey: 'ai:error.template.fileTooLarge',
        message: '单个模板文件不能超过 4 MiB',
      });
    }
    await this.assertNoSymlinkParents(draft, normalized);
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    const temporary = `${target}.upload-${Date.now().toString(36)}`;
    await writeFile(temporary, data, { mode: input.executable ? 0o755 : 0o644 });
    await rename(temporary, target);
    await chmod(target, input.executable ? 0o755 : 0o644);
    return { ok: true };
  }

  async createDirectory(path: string): Promise<{ ok: true }> {
    const draft = await this.draftRoot();
    const normalized = normalizeTemplatePath(path);
    await this.assertNoSymlinkParents(draft, normalized);
    await mkdir(resolveTemplatePath(draft, normalized), { recursive: false, mode: 0o755 });
    return { ok: true };
  }

  async patchEntry(input: {
    path: string;
    new_path?: string;
    policy?: WorkspaceTemplatePolicy;
    executable?: boolean;
  }): Promise<{ ok: true }> {
    const draft = await this.draftRoot();
    const currentPath = normalizeTemplatePath(input.path);
    let resultingPath = currentPath;
    const source = resolveTemplatePath(draft, currentPath);
    const sourceStat = await this.requiredLstat(source);
    if (sourceStat.isSymbolicLink()) {
      throw badRequest({
        code: 'ai.template.symlinkForbidden',
        messageKey: 'ai:error.template.symlinkForbidden',
        message: '模板不允许软链接',
      });
    }

    if (input.new_path && input.new_path !== currentPath) {
      resultingPath = normalizeTemplatePath(input.new_path);
      await this.assertNoSymlinkParents(draft, resultingPath);
      const target = resolveTemplatePath(draft, resultingPath);
      await mkdir(dirname(target), { recursive: true, mode: 0o755 });
      await this.assertMissing(target);
      await rename(source, target);
      await this.rewritePolicyPrefix(currentPath, resultingPath);
    }

    if (input.executable !== undefined) {
      const target = resolveTemplatePath(draft, resultingPath);
      const targetStat = await this.requiredLstat(target);
      if (!targetStat.isFile()) {
        throw badRequest({
          code: 'ai.template.executableOnlyFiles',
          messageKey: 'ai:error.template.executableOnlyFiles',
          message: '只有文件可设置执行位',
        });
      }
      await chmod(target, input.executable ? 0o755 : 0o644);
    }
    if (input.policy) {
      if (!['managed_readonly', 'seed_once'].includes(input.policy)) {
        throw badRequest({
          code: 'ai.template.unknownPolicy',
          messageKey: 'ai:error.template.unknownPolicy',
          message: '未知模板文件策略',
        });
      }
      const policies = await this.readPolicies();
      if (sourceStat.isDirectory() && input.policy === 'managed_readonly') {
        for (const path of Object.keys(policies.entries)) {
          if (path.startsWith(`${resultingPath}/`)) delete policies.entries[path];
        }
      }
      policies.entries[resultingPath] = input.policy;
      await this.writePolicies(policies);
    }
    return { ok: true };
  }

  async deleteEntry(path: string): Promise<{ ok: true }> {
    const draft = await this.draftRoot();
    const normalized = normalizeTemplatePath(path);
    const target = resolveTemplatePath(draft, normalized);
    await this.requiredLstat(target);
    await rm(target, { recursive: true, force: false });
    const policies = await this.readPolicies();
    for (const key of Object.keys(policies.entries)) {
      if (key === normalized || key.startsWith(`${normalized}/`)) {
        delete policies.entries[key];
      }
    }
    await this.writePolicies(policies);
    return { ok: true };
  }

  async preview(): Promise<{
    next_version: number;
    manifest: WorkspaceTemplateManifest;
    diff: { added: string[]; modified: string[]; deleted: string[] };
  }> {
    const latest = await this.latestVersion();
    const nextVersion = (latest?.version ?? 0) + 1;
    const manifest = await this.scan(
      await this.draftRoot(),
      await this.readPolicies(),
      nextVersion,
    );
    this.assertRequiredLayout(manifest);
    const previous = latest?.manifest_json as unknown as WorkspaceTemplateManifest | undefined;
    return { next_version: nextVersion, manifest, diff: this.diff(previous, manifest) };
  }

  async publish(publishedBy: string): Promise<WorkspaceTemplateManifest> {
    const queued = this.publishTail.then(() => this.publishNow(publishedBy));
    this.publishTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  async versions() {
    return this.prisma.aiWorkspaceTemplateVersion.findMany({
      orderBy: { version: 'desc' },
      select: {
        version: true,
        state: true,
        content_digest: true,
        published_by: true,
        published_at: true,
      },
    });
  }

  async restoreVersionToDraft(version: number): Promise<{ ok: true; restored_version: number }> {
    const record = await this.prisma.aiWorkspaceTemplateVersion.findUnique({ where: { version } });
    if (!record || record.state !== 'published') {
      throw notFound({
        code: 'ai.template.versionNotFound',
        messageKey: 'ai:error.template.versionNotFound',
        message: '模板版本不存在',
      });
    }
    const manifest = record.manifest_json as unknown as WorkspaceTemplateManifest;
    const source = await this.versionRoot(version);
    const current = await this.draftRoot();
    // 暂存与备份放在草稿的同级目录（rename 需同文件系统；不再依赖 initialization/）
    const draftParent = dirname(current);
    const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const staging = join(draftParent, `.draft-restore-${suffix}`);
    const backup = join(draftParent, `default-backup-${suffix}`);
    await mkdir(staging, { recursive: false, mode: 0o755 });
    try {
      await this.copyManifestEntries(source, staging, manifest.entries);
      await rename(current, backup);
      await rename(staging, current);
      await this.writePolicies({
        schema_version: 1,
        entries: Object.fromEntries(
          manifest.entries.map((entry) => [entry.path, entry.policy]),
        ),
      });
      return { ok: true, restored_version: version };
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      try {
        await access(backup);
        await rm(current, { recursive: true, force: true }).catch(() => undefined);
        await rename(backup, current);
      } catch {
        // 保留恢复目录供管理员人工排查，避免继续覆盖。
      }
      throw error;
    }
  }

  async latestVersion() {
    return this.prisma.aiWorkspaceTemplateVersion.findFirst({
      where: { state: 'published' },
      orderBy: { version: 'desc' },
    });
  }

  async versionRoot(version: number): Promise<string> {
    if (!Number.isSafeInteger(version) || version <= 0) {
      throw badRequest({
        code: 'ai.template.versionInvalid',
        messageKey: 'ai:error.template.versionInvalid',
        message: '模板版本无效',
      });
    }
    const root = join(await this.paths.initializationRoot(), 'versions', String(version));
    try {
      await access(root);
    } catch {
      throw notFound({
        code: 'ai.template.versionNotFound',
        messageKey: 'ai:error.template.versionNotFound',
        message: '模板版本不存在',
      });
    }
    return root;
  }

  private async bootstrap(): Promise<void> {
    const initialization = await this.paths.initializationRoot();
    await this.draftRoot(); // ai_workspace/default
    await mkdir(join(initialization, 'versions'), { recursive: true, mode: 0o755 });
    const policiesPath = join(initialization, POLICY_FILE);
    try {
      await access(policiesPath);
    } catch {
      await this.writePolicies(DEFAULT_POLICIES);
    }

    const existing = await this.latestVersion();
    if (existing) return;
    const draft = await this.draftRoot();
    if ((await readdir(draft)).length === 0) {
      await this.copyCodeTemplate(draft);
    }
    await this.ensureRequiredDirectories(draft);
    const administrator = await this.prisma.saUser.findFirst({
      where: { platform_role: 'super_admin', status: 'active' },
      orderBy: { created_at: 'asc' },
    });
    if (!administrator) {
      this.logger.warn('尚无 active admin，初始化 Workspace 草稿已创建但未发布');
      return;
    }
    await this.publish(administrator.id);
    this.logger.log('初始化 Workspace 模板版本 1 已发布');
  }

  private async publishNow(publishedBy: string): Promise<WorkspaceTemplateManifest> {
    const latest = await this.latestVersion();
    const version = (latest?.version ?? 0) + 1;
    const draft = await this.draftRoot();
    const manifest = await this.scan(draft, await this.readPolicies(), version);
    this.assertRequiredLayout(manifest);
    const versionsRoot = join(await this.paths.initializationRoot(), 'versions');
    const staging = join(versionsRoot, `.staging-${version}-${Date.now().toString(36)}`);
    const target = join(versionsRoot, String(version));
    await this.preserveOrphanedVersion(target, version);
    await mkdir(staging, { recursive: false, mode: 0o755 });
    let installed = false;
    let recorded = false;
    try {
      await this.copyManifestEntries(draft, staging, manifest.entries);
      await writeFile(
        join(staging, VERSION_MANIFEST_FILE),
        `${JSON.stringify(manifest, null, 2)}\n`,
        { mode: 0o444 },
      );
      await rename(staging, target);
      installed = true;
      await this.prisma.aiWorkspaceTemplateVersion.create({
        data: {
          version,
          state: 'published',
          manifest_json: manifest as unknown as Prisma.InputJsonValue,
          content_digest: manifest.content_digest,
          published_by: publishedBy,
        },
      });
      recorded = true;
      const currentPath = join(await this.paths.initializationRoot(), 'current');
      const temporary = `${currentPath}.next`;
      await writeFile(temporary, `${version}\n`, { mode: 0o644 })
        .then(() => rename(temporary, currentPath))
        .catch((error) => {
          this.logger.warn(
            `模板版本 ${version} 已发布，但 current 指针更新失败: ${error instanceof Error ? error.name : 'unknown'}`,
          );
        });
      return manifest;
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if (installed && !recorded) {
        await rm(target, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    }
  }

  private async scan(
    root: string,
    policies: WorkspaceTemplatePolicies,
    version: number,
  ): Promise<WorkspaceTemplateManifest> {
    const entries: WorkspaceTemplateEntry[] = [];
    let totalBytes = 0;
    const walk = async (directory: string, prefix: string): Promise<void> => {
      const children = await readdir(directory, { withFileTypes: true });
      children.sort((left, right) => left.name.localeCompare(right.name));
      for (const child of children) {
        const relativePath = prefix ? `${prefix}/${child.name}` : child.name;
        normalizeTemplatePath(relativePath);
        const absolutePath = resolveTemplatePath(root, relativePath);
        const info = await lstat(absolutePath);
        if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
          throw badRequest({
            code: 'ai.template.entryTypeForbidden',
            messageKey: 'ai:error.template.entryTypeForbidden',
            params: { path: relativePath },
            message: `模板只允许普通文件和目录: ${relativePath}`,
          });
        }
        if (info.isFile() && info.nlink > 1) {
          throw badRequest({
            code: 'ai.template.hardLinkForbidden',
            messageKey: 'ai:error.template.hardLinkForbidden',
            params: { path: relativePath },
            message: `模板不允许硬链接: ${relativePath}`,
          });
        }
        const policy = this.policyFor(relativePath, policies);
        const executable = (info.mode & 0o111) !== 0;
        if (info.isDirectory()) {
          entries.push({
            path: relativePath,
            kind: 'directory',
            policy,
            mode: policy === 'managed_readonly' ? '0555' : '0755',
            sha256: this.sha256(`directory\0${relativePath}\0${policy}`),
          });
          await walk(absolutePath, relativePath);
        } else {
          if (info.size > MAX_SINGLE_FILE_BYTES) {
            throw badRequest({
              code: 'ai.template.entryTooLarge',
              messageKey: 'ai:error.template.entryTooLarge',
              params: { path: relativePath },
              message: `模板文件超过 4 MiB: ${relativePath}`,
            });
          }
          totalBytes += info.size;
          const data = await readFile(absolutePath);
          entries.push({
            path: relativePath,
            kind: 'file',
            policy,
            mode:
              policy === 'managed_readonly'
                ? executable
                  ? '0555'
                  : '0444'
                : executable
                  ? '0755'
                  : '0644',
            sha256: this.sha256(data),
            size: info.size,
          });
        }
        if (entries.length > MAX_TEMPLATE_FILES || totalBytes > MAX_TEMPLATE_BYTES) {
          throw badRequest({
            code: 'ai.template.totalTooLarge',
            messageKey: 'ai:error.template.totalTooLarge',
            message: '模板超过文件数或总大小限制',
          });
        }
      }
    };
    await walk(root, '');
    const digest = this.sha256(JSON.stringify(entries));
    return {
      schema_version: 1,
      template_version: version,
      entries,
      content_digest: digest,
    };
  }

  private policyFor(path: string, policies: WorkspaceTemplatePolicies): WorkspaceTemplatePolicy {
    const parts = path.split('/');
    let inheritedManaged = false;
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join('/');
      if (policies.entries[parent] === 'managed_readonly') inheritedManaged = true;
    }
    const exact = policies.entries[path];
    if (inheritedManaged && exact === 'seed_once') {
      throw badRequest({
        code: 'ai.template.seedOnceBelowManaged',
        messageKey: 'ai:error.template.seedOnceBelowManaged',
        params: { path },
        message: `只读目录的后代不能改为 seed_once: ${path}`,
      });
    }
    return inheritedManaged ? 'managed_readonly' : exact ?? 'seed_once';
  }

  private async copyManifestEntries(
    sourceRoot: string,
    targetRoot: string,
    entries: WorkspaceTemplateEntry[],
  ): Promise<void> {
    for (const entry of entries) {
      const source = resolveTemplatePath(sourceRoot, entry.path);
      const target = resolveTemplatePath(targetRoot, entry.path);
      if (entry.kind === 'directory') {
        await mkdir(target, { recursive: true, mode: 0o755 });
      } else {
        await mkdir(dirname(target), { recursive: true, mode: 0o755 });
        await copyFile(source, target);
        await chmod(target, Number.parseInt(entry.mode, 8));
      }
    }
    for (const entry of [...entries]
      .filter((candidate) => candidate.kind === 'directory')
      .sort((left, right) => right.path.split('/').length - left.path.split('/').length)) {
      await chmod(
        resolveTemplatePath(targetRoot, entry.path),
        Number.parseInt(entry.mode, 8),
      );
    }
  }

  private async copyCodeTemplate(draft: string): Promise<void> {
    // 代码内模板内容真源：发布产物根下的 ai_workspace/default（phase: clklog-ai-workspace-sync-v1）；
    // 旧路径保留在末尾，便于灰度期间的过渡副本
    const candidates = [
      resolve(process.cwd(), '../ai_workspace/default'),
      resolve(process.cwd(), '../../ai_workspace/default'),
      resolve(__dirname, '../../../../../../../ai_workspace/default'),
      resolve(process.cwd(), '../harness-host/workspace-template'),
    ];
    const source = await this.firstExisting(candidates);
    if (!source) throw new Error('代码内初始化 Workspace 模板不存在');
    const copy = async (directory: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        const sourcePath = join(directory, entry.name);
        const targetPath = resolveTemplatePath(draft, relativePath);
        if (entry.isDirectory()) {
          await mkdir(targetPath, { recursive: true, mode: 0o755 });
          await copy(sourcePath, relativePath);
        } else if (entry.isFile()) {
          await mkdir(dirname(targetPath), { recursive: true, mode: 0o755 });
          await copyFile(sourcePath, targetPath);
        } else {
          throw new Error(`代码模板包含不支持的文件类型: ${relativePath}`);
        }
      }
    };
    await copy(source, '');
  }

  private async ensureRequiredDirectories(draft: string): Promise<void> {
    for (const path of [
      'files/sql',
      'files/notes',
      'files/exports',
      'files/artifacts',
      'tools',
    ]) {
      await mkdir(resolveTemplatePath(draft, path), { recursive: true, mode: 0o755 });
    }
  }

  private assertRequiredLayout(manifest: WorkspaceTemplateManifest): void {
    const entries = new Map(manifest.entries.map((entry) => [entry.path, entry.kind]));
    const required: Array<[string, 'file' | 'directory']> = [
      ['.dsh-root', 'file'],
      ['AGENTS.md', 'file'],
      ['AGENTS.local.md', 'file'],
      ['files', 'directory'],
      ['files/sql', 'directory'],
      ['files/notes', 'directory'],
      ['files/exports', 'directory'],
      ['files/artifacts', 'directory'],
      ['tools', 'directory'],
    ];
    for (const [path, kind] of required) {
      if (entries.get(path) !== kind) {
        throw badRequest({
          code: 'ai.template.requiredEntryMissing',
          messageKey:
            kind === 'file'
              ? 'ai:error.template.requiredFileMissing'
              : 'ai:error.template.requiredDirectoryMissing',
          params: { path },
          message: `初始化模板缺少必要${kind === 'file' ? '文件' : '目录'}: ${path}`,
        });
      }
    }
  }

  /**
   * 草稿根 = `<harness root>/ai_workspace/default`（phase: clklog-ai-workspace-sync-v1）。
   * 与仓库 `ai_workspace/default/` 同构，由 `scripts/ai-workspace-sync.sh` 双向同步；
   * 平台在此编辑、发布时快照到 `initialization/versions/<n>`。
   */
  private async draftRoot(): Promise<string> {
    const root = await this.paths.templateDraftRoot();
    await mkdir(root, { recursive: true, mode: 0o755 });
    return root;
  }

  private async readPolicies(): Promise<WorkspaceTemplatePolicies> {
    const path = join(await this.paths.initializationRoot(), POLICY_FILE);
    try {
      const value = JSON.parse(await readFile(path, 'utf8')) as WorkspaceTemplatePolicies;
      if (value.schema_version !== 1 || !value.entries || typeof value.entries !== 'object') {
        throw new Error('invalid policy document');
      }
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(DEFAULT_POLICIES);
      throw badRequest({
        code: 'ai.template.policyInvalid',
        messageKey: 'ai:error.template.policyInvalid',
        message: '模板策略文件无效',
      });
    }
  }

  private async writePolicies(policies: WorkspaceTemplatePolicies): Promise<void> {
    const path = join(await this.paths.initializationRoot(), POLICY_FILE);
    const temporary = `${path}.next`;
    const sorted = Object.fromEntries(
      Object.entries(policies.entries).sort(([left], [right]) => left.localeCompare(right)),
    );
    await writeFile(
      temporary,
      `${JSON.stringify({ schema_version: 1, entries: sorted }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await rename(temporary, path);
  }

  private async rewritePolicyPrefix(from: string, to: string): Promise<void> {
    const policies = await this.readPolicies();
    const next: Record<string, WorkspaceTemplatePolicy> = {};
    for (const [path, policy] of Object.entries(policies.entries)) {
      const renamed = path === from ? to : path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path;
      next[renamed] = policy;
    }
    await this.writePolicies({ schema_version: 1, entries: next });
  }

  private async assertNoSymlinkParents(root: string, path: string): Promise<void> {
    const parts = normalizeTemplatePath(path).split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const parent = resolveTemplatePath(root, parts.slice(0, index).join('/'));
      try {
        const info = await lstat(parent);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw badRequest({
            code: 'ai.template.parentNotDirectory',
            messageKey: 'ai:error.template.parentNotDirectory',
            message: '模板路径父级不是普通目录',
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }

  private async requiredLstat(path: string) {
    try {
      return await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw notFound({
          code: 'ai.template.pathNotFound',
          messageKey: 'ai:error.template.pathNotFound',
          message: '模板路径不存在',
        });
      }
      throw error;
    }
  }

  private async assertMissing(path: string): Promise<void> {
    try {
      await access(path);
      throw badRequest({
        code: 'ai.template.targetExists',
        messageKey: 'ai:error.template.targetExists',
        message: '目标路径已存在',
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }

  private async preserveOrphanedVersion(target: string, version: number): Promise<void> {
    try {
      await access(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const recovery = `${target}.orphan-${Date.now().toString(36)}`;
    await rename(target, recovery);
    this.logger.warn(`保留未登记的模板版本目录 (${version})`);
  }

  private async firstExisting(paths: string[]): Promise<string | undefined> {
    for (const path of paths) {
      try {
        await access(path);
        return path;
      } catch {
        // Try the next deployment layout.
      }
    }
    return undefined;
  }

  private diff(
    previous: WorkspaceTemplateManifest | undefined,
    next: WorkspaceTemplateManifest,
  ) {
    const before = new Map((previous?.entries ?? []).map((entry) => [entry.path, entry]));
    const after = new Map(next.entries.map((entry) => [entry.path, entry]));
    return {
      added: [...after.keys()].filter((path) => !before.has(path)),
      modified: [...after.entries()]
        .filter(([path, entry]) => {
          const old = before.get(path);
          return old && JSON.stringify(old) !== JSON.stringify(entry);
        })
        .map(([path]) => path),
      deleted: [...before.keys()].filter((path) => !after.has(path)),
    };
  }

  private sha256(value: string | Buffer): string {
    return createHash('sha256').update(value).digest('hex');
  }
}
