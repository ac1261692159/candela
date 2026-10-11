import {
  HttpStatus,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { AiWorkspace, Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { conflict, domainError, notFound } from '../../../i18n/domain-error';
import {
  chmod,
  chown,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'fs/promises';
import { dirname, join } from 'path';
import * as yaml from 'js-yaml';
import { AuthUser } from '../../auth/auth.service';
import { PrismaService } from '../../shared/prisma.service';
import { WorkspacePathsService, createOrderedId } from './workspace-paths.service';
import { WorkspaceTemplateService } from './workspace-template.service';
import {
  WorkspaceTemplateEntry,
  WorkspaceTemplateManifest,
} from './workspace-template.types';
import { resolveTemplatePath } from './workspace-template-path';

interface WorkspaceControlDocument {
  schema_version: 1;
  workspace_id: string;
  kind: string;
  owner_hash: string;
  project_hash: string;
  initialized_from: string;
  applied_template_version: number;
}

@Injectable()
export class WorkspaceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkspaceService.name);
  private readonly creationLocks = new Map<string, Promise<AiWorkspace>>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly paths: WorkspacePathsService,
    private readonly templates: WorkspaceTemplateService,
  ) {
    this.cleanupTimer = setInterval(() => void this.runMaintenance(), 60 * 60 * 1_000);
    this.cleanupTimer.unref();
  }

  onModuleInit(): void {
    if (this.paths.harnessConfig().enabled) void this.runMaintenance();
  }

  onModuleDestroy(): void {
    clearInterval(this.cleanupTimer);
  }

  async defaultWorkspace(user: AuthUser, project: string): Promise<AiWorkspace> {
    this.assertEnabled();
    const key = `${user.id}\0${project}\0persistent\0default`;
    const running = this.creationLocks.get(key);
    if (running) return running;
    const creation = this.findOrCreate(user.id, project, 'persistent', 'default').finally(
      () => this.creationLocks.delete(key),
    );
    this.creationLocks.set(key, creation);
    return creation;
  }

  async createPermanent(
    user: AuthUser,
    project: string,
    displayName: string,
  ): Promise<AiWorkspace> {
    this.assertEnabled();
    const name = this.validateDisplayName(displayName);
    return this.findOrCreate(user.id, project, 'persistent', name);
  }

  async createTemporary(
    user: AuthUser,
    project: string,
    sessionId: string,
  ): Promise<AiWorkspace> {
    this.assertEnabled();
    if (!/^ais_[a-zA-Z0-9_-]{12,}$/.test(sessionId)) {
      throw conflict({
        code: 'ai.workspace.sessionIdInvalid',
        messageKey: 'ai:error.workspace.sessionIdInvalid',
        message: '临时 Session ID 无效',
      });
    }
    const existing = await this.prisma.aiWorkspace.findUnique({ where: { id: sessionId } });
    if (existing) {
      if (existing.user_id !== user.id || existing.project_name !== project) {
        throw conflict({
          code: 'ai.workspace.temporaryOccupied',
          messageKey: 'ai:error.workspace.temporaryOccupied',
          message: '临时 Workspace 已被占用',
        });
      }
      return existing;
    }
    return this.createAndInitialize({
      id: sessionId,
      userId: user.id,
      project,
      kind: 'temporary',
      displayName: `temporary-${sessionId.slice(-8)}`,
      expiresAt: new Date(Date.now() + this.paths.harnessConfig().workspace.temporary_ttl_ms),
    });
  }

  async list(user: AuthUser, project: string): Promise<AiWorkspace[]> {
    this.assertEnabled();
    return this.prisma.aiWorkspace.findMany({
      where: { user_id: user.id, project_name: project, status: { not: 'deleted' } },
      orderBy: [{ kind: 'asc' }, { created_at: 'asc' }],
    });
  }

  async listAll(input: {
    project_name?: string;
    user_id?: string;
    kind?: 'persistent' | 'temporary';
  }): Promise<AiWorkspace[]> {
    this.assertEnabled();
    return this.prisma.aiWorkspace.findMany({
      where: {
        status: { not: 'deleted' },
        ...(input.project_name ? { project_name: input.project_name } : {}),
        ...(input.user_id ? { user_id: input.user_id } : {}),
        ...(input.kind ? { kind: input.kind } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: 1_000,
    });
  }

  async getOwned(id: string, user: AuthUser, project: string): Promise<AiWorkspace> {
    this.assertEnabled();
    const workspace = await this.prisma.aiWorkspace.findUnique({ where: { id } });
    if (
      !workspace ||
      workspace.status !== 'active' ||
      workspace.project_name !== project ||
      workspace.user_id !== user.id
    ) {
      throw notFound({
        code: 'ai.workspace.notFound',
        messageKey: 'ai:error.workspace.notFound',
        message: 'Workspace 不存在',
      });
    }
    return workspace;
  }

  async pathFor(workspace: AiWorkspace): Promise<string> {
    return this.paths.workspacePath(
      workspace.user_id,
      workspace.project_name,
      workspace.kind as 'persistent' | 'temporary',
      workspace.id,
    );
  }

  async managedPaths(workspace: AiWorkspace): Promise<string[]> {
    const root = await this.pathFor(workspace);
    const manifest = await this.readManagedManifest(root);
    return manifest.entries
      .filter((entry) => entry.policy === 'managed_readonly')
      .map((entry) => resolveTemplatePath(root, entry.path));
  }

  async touch(workspace: AiWorkspace): Promise<void> {
    const now = new Date();
    const expiresAt =
      workspace.kind === 'temporary'
        ? new Date(now.getTime() + this.paths.harnessConfig().workspace.temporary_ttl_ms)
        : null;
    await this.prisma.aiWorkspace.update({
      where: { id: workspace.id },
      data: { last_access_at: now, expires_at: expiresAt },
    });
  }

  async touchOwnedId(workspaceId: string, userId: string, project: string): Promise<void> {
    const workspace = await this.prisma.aiWorkspace.findFirst({
      where: {
        id: workspaceId,
        user_id: userId,
        project_name: project,
        status: 'active',
      },
    });
    if (workspace) await this.touch(workspace);
  }

  async promoteTemporary(
    workspace: AiWorkspace,
    displayName: string,
  ): Promise<AiWorkspace> {
    if (workspace.kind !== 'temporary') {
      throw conflict({
        code: 'ai.workspace.notTemporary',
        messageKey: 'ai:error.workspace.notTemporary',
        message: 'Workspace 不是临时类型',
      });
    }
    const name = this.validateDisplayName(displayName);
    // Resolve and prepare paths before claiming the row so a filesystem setup
    // error cannot leave the Workspace permanently stuck in `promoting`.
    const destinationId = workspace.id;
    const source = await this.pathFor(workspace);
    const destination = await this.paths.workspacePath(
      workspace.user_id,
      workspace.project_name,
      'persistent',
      destinationId,
    );
    await this.paths.ensureOwnedDirectory(dirname(destination));
    const claimed = await this.prisma.aiWorkspace.updateMany({
      where: { id: workspace.id, status: 'active', kind: 'temporary' },
      data: { status: 'promoting' },
    });
    if (claimed.count !== 1) {
      throw conflict({
        code: 'ai.workspace.busy',
        messageKey: 'ai:error.workspace.busy',
        message: 'Workspace 正在被其他任务处理',
      });
    }
    // 保留 ID，避免历史同步审计外键因主键更新而失效；kind 决定物理目录。
    try {
      await rename(source, destination);
      await this.writeControlDocument(destination, {
        workspace_id: destinationId,
        kind: 'persistent',
      });
      return await this.prisma.aiWorkspace.update({
        where: { id: workspace.id },
        data: {
          kind: 'persistent',
          display_name: name,
          status: 'active',
          expires_at: null,
        },
      });
    } catch (error) {
      await this.writeControlDocument(destination, {
        workspace_id: workspace.id,
        kind: 'temporary',
      }).catch(() => undefined);
      await rename(destination, source).catch(() => undefined);
      await this.prisma.aiWorkspace.updateMany({
        where: { id: workspace.id, status: 'promoting' },
        data: { status: 'active' },
      }).catch(() => undefined);
      throw error;
    }
  }

  async deleteOwned(workspace: AiWorkspace): Promise<{ ok: true }> {
    if (workspace.status !== 'active') {
      throw conflict({
        code: 'ai.workspace.deleteNotAllowed',
        messageKey: 'ai:error.workspace.deleteNotAllowed',
        message: 'Workspace 当前不可删除',
      });
    }
    if (workspace.kind === 'persistent' && workspace.display_name === 'default') {
      throw conflict({
        code: 'ai.workspace.defaultDeleteForbidden',
        messageKey: 'ai:error.workspace.defaultDeleteForbidden',
        message: '默认 Workspace 不可删除',
      });
    }
    const root = await this.pathFor(workspace);
    const deletedPath = `${root}.deleted-${Date.now().toString(36)}`;
    const claimed = await this.prisma.aiWorkspace.updateMany({
      where: { id: workspace.id, status: 'active' },
      data: { status: 'deleting' },
    });
    if (claimed.count !== 1) {
      throw conflict({
        code: 'ai.workspace.busy',
        messageKey: 'ai:error.workspace.busy',
        message: 'Workspace 正在被其他任务处理',
      });
    }
    let moved = false;
    try {
      await rename(root, deletedPath);
      moved = true;
      await this.prisma.aiWorkspace.update({
        where: { id: workspace.id },
        data: { status: 'deleted', expires_at: null },
      });
    } catch (error) {
      if (moved) await rename(deletedPath, root).catch(() => undefined);
      await this.prisma.aiWorkspace
        .updateMany({
          where: { id: workspace.id, status: 'deleting' },
          data: { status: 'active' },
        })
        .catch(() => undefined);
      throw error;
    }
    await rm(deletedPath, { recursive: true, force: true }).catch((error) => {
      this.logger.warn(
        `Workspace 删除后清理失败 (${workspace.id}): ${error instanceof Error ? error.name : 'unknown'}`,
      );
    });
    this.logger.log(`Workspace 已删除 (${workspace.id})`);
    return { ok: true };
  }

  async readManagedManifest(root: string): Promise<WorkspaceTemplateManifest> {
    const path = join(root, '.clklog', 'managed-manifest.json');
    try {
      return JSON.parse(await readFile(path, 'utf8')) as WorkspaceTemplateManifest;
    } catch {
      return { schema_version: 1, template_version: 0, entries: [], content_digest: '' };
    }
  }

  async writeManagedManifest(root: string, manifest: WorkspaceTemplateManifest): Promise<void> {
    const path = join(root, '.clklog', 'managed-manifest.json');
    const temporary = `${path}.next`;
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  }

  private async findOrCreate(
    userId: string,
    project: string,
    kind: 'persistent',
    displayName: string,
  ): Promise<AiWorkspace> {
    const existing = await this.prisma.aiWorkspace.findUnique({
      where: {
        user_id_project_name_kind_display_name: {
          user_id: userId,
          project_name: project,
          kind,
          display_name: displayName,
        },
      },
    });
    if (existing?.status === 'active') {
      await this.touch(existing);
      return existing;
    }
    if (existing) return this.resumeCreation(existing);
    return this.createAndInitialize({
      id: createOrderedId('aiw_'),
      userId,
      project,
      kind,
      displayName,
      expiresAt: null,
    });
  }

  private async createAndInitialize(input: {
    id: string;
    userId: string;
    project: string;
    kind: 'persistent' | 'temporary';
    displayName: string;
    expiresAt: Date | null;
  }): Promise<AiWorkspace> {
    let row: AiWorkspace;
    try {
      row = await this.prisma.aiWorkspace.create({
        data: {
          id: input.id,
          user_id: input.userId,
          project_name: input.project,
          kind: input.kind,
          display_name: input.displayName,
          status: 'creating',
          initialized_from: 'template',
          expires_at: input.expiresAt,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.prisma.aiWorkspace.findFirst({
          where: {
            OR: [
              { id: input.id },
              {
                user_id: input.userId,
                project_name: input.project,
                kind: input.kind,
                display_name: input.displayName,
              },
            ],
          },
        });
        if (!existing) throw error;
        if (existing.user_id !== input.userId || existing.project_name !== input.project) {
          throw conflict({
            code: 'ai.workspace.identifierTaken',
            messageKey: 'ai:error.workspace.identifierTaken',
            message: 'Workspace 标识已被占用',
          });
        }
        return this.resumeCreation(existing);
      }
      throw error;
    }
    return this.initialize(row);
  }

  private async resumeCreation(workspace: AiWorkspace): Promise<AiWorkspace> {
    if (workspace.status === 'failed' || workspace.status === 'creating') {
      return this.initialize(workspace);
    }
    if (workspace.status === 'deleted') {
      throw conflict({
        code: 'ai.workspace.nameTakenByDeleted',
        messageKey: 'ai:error.workspace.nameTakenByDeleted',
        message: 'Workspace 名称已被删除记录占用',
      });
    }
    if (workspace.status !== 'active') {
      throw domainError(HttpStatus.SERVICE_UNAVAILABLE, {
        code: 'ai.workspace.syncPending',
        messageKey: 'ai:error.workspace.syncPending',
        message: 'Workspace 正在同步或等待管理员重试',
      });
    }
    return workspace;
  }

  private async initialize(workspace: AiWorkspace): Promise<AiWorkspace> {
    const template = await this.templates.latestVersion();
    if (!template) {
      throw domainError(HttpStatus.SERVICE_UNAVAILABLE, {
        code: 'ai.workspace.templateNotPublished',
        messageKey: 'ai:error.workspace.templateNotPublished',
        message: '初始化 Workspace 模板尚未发布',
      });
    }
    const manifest = template.manifest_json as unknown as WorkspaceTemplateManifest;
    const templateBytes = manifest.entries.reduce(
      (total, entry) => total + (entry.kind === 'file' ? entry.size ?? 0 : 0),
      0,
    );
    if (templateBytes > this.paths.harnessConfig().workspace.max_bytes) {
      throw domainError(HttpStatus.SERVICE_UNAVAILABLE, {
        code: 'ai.workspace.templateQuotaExceeded',
        messageKey: 'ai:error.workspace.templateQuotaExceeded',
        message: '初始化模板超过 Workspace 配额',
      });
    }
    const source = await this.templates.versionRoot(template.version);
    const destination = await this.pathFor(workspace);
    const staging = `${destination}.staging-${randomBytes(6).toString('hex')}`;
    await this.paths.ensureOwnedDirectory(dirname(destination));
    try {
      try {
        const existing = await lstat(destination);
        if (existing.isDirectory()) {
          await this.verifyExistingInitialization(destination, workspace, manifest, template.version);
          return await this.prisma.aiWorkspace.update({
            where: { id: workspace.id },
            data: { status: 'active', applied_template_version: template.version },
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await mkdir(staging, { recursive: false, mode: 0o700 });
      await this.copyEntries(source, staging, manifest.entries);
      const controlRoot = join(staging, '.clklog');
      await mkdir(join(controlRoot, 'recovery'), { recursive: true, mode: 0o700 });
      const control: WorkspaceControlDocument = {
        schema_version: 1,
        workspace_id: workspace.id,
        kind: workspace.kind,
        owner_hash: this.hash('user', workspace.user_id),
        project_hash: this.hash('project', workspace.project_name),
        initialized_from: workspace.initialized_from,
        applied_template_version: template.version,
      };
      await writeFile(
        join(controlRoot, 'workspace.yaml'),
        yaml.dump(control, { noRefs: true, sortKeys: true }),
        { mode: 0o600 },
      );
      await this.writeManagedManifest(staging, {
        ...manifest,
        entries: manifest.entries.filter((entry) => entry.policy === 'managed_readonly'),
      });
      await this.chownTree(staging);
      await this.verifyEntries(staging, manifest.entries);
      await rename(staging, destination);
      return await this.prisma.aiWorkspace.update({
        where: { id: workspace.id },
        data: {
          status: 'active',
          applied_template_version: template.version,
          last_access_at: new Date(),
        },
      });
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      await this.prisma.aiWorkspace
        .update({ where: { id: workspace.id }, data: { status: 'failed' } })
        .catch(() => undefined);
      throw error;
    }
  }

  private async copyEntries(
    sourceRoot: string,
    targetRoot: string,
    entries: WorkspaceTemplateEntry[],
  ): Promise<void> {
    for (const entry of entries) {
      const source = resolveTemplatePath(sourceRoot, entry.path);
      const target = resolveTemplatePath(targetRoot, entry.path);
      const mode = Number.parseInt(entry.mode, 8);
      if (entry.kind === 'directory') {
        await mkdir(target, { recursive: true, mode: 0o755 });
      } else {
        await mkdir(dirname(target), { recursive: true, mode: 0o755 });
        await copyFile(source, target);
        await chmod(target, mode);
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

  private async chownTree(root: string): Promise<void> {
    if (typeof process.geteuid !== 'function' || process.geteuid() !== 0) return;
    const user = await this.paths.systemUser();
    const visit = async (path: string): Promise<void> => {
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        throw conflict({
          code: 'ai.workspace.initSymlinkRejected',
          messageKey: 'ai:error.workspace.initSymlinkRejected',
          message: 'Workspace 初始化拒绝软链接',
        });
      }
      await chown(path, user.uid, user.gid);
      if (!info.isDirectory()) return;
      const children = await readdir(path);
      for (const name of children) await visit(join(path, name));
    };
    await visit(root);
  }

  private async verifyEntries(
    root: string,
    entries: WorkspaceTemplateEntry[],
  ): Promise<void> {
    const expectedOwner =
      typeof process.geteuid === 'function' && process.geteuid() === 0
        ? await this.paths.systemUser()
        : undefined;
    for (const entry of entries) {
      const target = resolveTemplatePath(root, entry.path);
      const info = await lstat(target);
      if (
        info.isSymbolicLink()
        || (entry.kind === 'file' ? !info.isFile() : !info.isDirectory())
      ) {
        throw conflict({
          code: 'ai.workspace.initTypeMismatch',
          messageKey: 'ai:error.workspace.initTypeMismatch',
          params: { path: entry.path },
          message: `Workspace 初始化文件类型不匹配: ${entry.path}`,
        });
      }
      if ((info.mode & 0o777) !== Number.parseInt(entry.mode, 8)) {
        throw conflict({
          code: 'ai.workspace.initModeMismatch',
          messageKey: 'ai:error.workspace.initModeMismatch',
          params: { path: entry.path },
          message: `Workspace 初始化权限不匹配: ${entry.path}`,
        });
      }
      if (expectedOwner && (info.uid !== expectedOwner.uid || info.gid !== expectedOwner.gid)) {
        throw conflict({
          code: 'ai.workspace.initOwnerMismatch',
          messageKey: 'ai:error.workspace.initOwnerMismatch',
          params: { path: entry.path },
          message: `Workspace 初始化所有者不匹配: ${entry.path}`,
        });
      }
      if (entry.kind === 'file') {
        const digest = createHash('sha256').update(await readFile(target)).digest('hex');
        if (digest !== entry.sha256) {
          throw conflict({
            code: 'ai.workspace.initDigestMismatch',
            messageKey: 'ai:error.workspace.initDigestMismatch',
            params: { path: entry.path },
            message: `Workspace 初始化摘要不匹配: ${entry.path}`,
          });
        }
      }
    }
  }

  private async verifyExistingInitialization(
    root: string,
    workspace: AiWorkspace,
    manifest: WorkspaceTemplateManifest,
    templateVersion: number,
  ): Promise<void> {
    await this.verifyEntries(root, manifest.entries);
    const controlPath = join(root, '.clklog', 'workspace.yaml');
    const controlInfo = await lstat(controlPath);
    if (controlInfo.isSymbolicLink() || !controlInfo.isFile()) {
      throw conflict({
        code: 'ai.workspace.controlTypeInvalid',
        messageKey: 'ai:error.workspace.controlTypeInvalid',
        message: 'Workspace 控制文件类型无效',
      });
    }
    const control = yaml.load(await readFile(controlPath, 'utf8')) as WorkspaceControlDocument;
    if (
      control?.schema_version !== 1
      || control.workspace_id !== workspace.id
      || control.kind !== workspace.kind
      || control.owner_hash !== this.hash('user', workspace.user_id)
      || control.project_hash !== this.hash('project', workspace.project_name)
      || control.applied_template_version !== templateVersion
    ) {
      throw conflict({
        code: 'ai.workspace.controlMismatch',
        messageKey: 'ai:error.workspace.controlMismatch',
        message: 'Workspace 控制文件与元数据不一致',
      });
    }
    const managed = await this.readManagedManifest(root);
    const expectedEntries = manifest.entries.filter(
      (entry) => entry.policy === 'managed_readonly',
    );
    if (
      managed.schema_version !== 1
      || managed.template_version !== templateVersion
      || JSON.stringify(managed.entries) !== JSON.stringify(expectedEntries)
    ) {
      throw conflict({
        code: 'ai.workspace.manifestMismatch',
        messageKey: 'ai:error.workspace.manifestMismatch',
        message: 'Workspace 受管清单与模板不一致',
      });
    }
  }

  async ensureOwnership(root: string): Promise<void> {
    await this.chownTree(root);
  }

  private async writeControlDocument(
    root: string,
    patch: Pick<WorkspaceControlDocument, 'workspace_id' | 'kind'>,
  ): Promise<void> {
    const path = join(root, '.clklog', 'workspace.yaml');
    const current = yaml.load(await readFile(path, 'utf8')) as WorkspaceControlDocument;
    const temporary = `${path}.next`;
    await writeFile(
      temporary,
      yaml.dump({ ...current, ...patch }, { noRefs: true, sortKeys: true }),
      { mode: 0o600 },
    );
    await rename(temporary, path);
  }

  private async cleanupExpiredTemporary(): Promise<void> {
    if (!this.paths.harnessConfig().enabled) return;
    const expired = await this.prisma.aiWorkspace.findMany({
      where: {
        kind: 'temporary',
        status: 'active',
        expires_at: { lt: new Date() },
        sync_items: { none: { state: { in: ['planned', 'snapshotting', 'applying', 'verifying'] } } },
      },
      take: 100,
    });
    for (const workspace of expired) {
      await this.deleteOwned(workspace).catch((error) => {
        this.logger.warn(
          `临时 Workspace 回收失败 (${workspace.id}): ${error instanceof Error ? error.name : 'unknown'}`,
        );
      });
    }
  }

  private async runMaintenance(): Promise<void> {
    await Promise.allSettled([
      this.cleanupExpiredTemporary(),
      this.cleanupRecoveryCopies(),
    ]);
  }

  private async cleanupRecoveryCopies(): Promise<void> {
    if (!this.paths.harnessConfig().enabled) return;
    const cutoff = new Date(
      Date.now() - this.paths.harnessConfig().workspace.recovery_retention_ms,
    );
    const expired = await this.prisma.aiWorkspaceSyncItem.findMany({
      where: {
        state: 'succeeded',
        recovery_path: { not: null },
        finished_at: { lt: cutoff },
      },
      include: { workspace: true },
      take: 100,
    });
    for (const item of expired) {
      if (!item.recovery_path || !/^\.clklog\/recovery\/aiws_[a-zA-Z0-9_-]+$/.test(item.recovery_path)) {
        this.logger.warn(`拒绝清理异常恢复路径 (${item.id})`);
        continue;
      }
      const workspaceRoot = await this.pathFor(item.workspace);
      const recoveryRoot = this.paths.assertWithin(
        workspaceRoot,
        join(workspaceRoot, item.recovery_path),
      );
      try {
        await rm(recoveryRoot, { recursive: true, force: true });
        const previous = item.diff_json && typeof item.diff_json === 'object'
          ? (item.diff_json as Prisma.JsonObject)
          : {};
        await this.prisma.aiWorkspaceSyncItem.update({
          where: { id: item.id },
          data: {
            recovery_path: null,
            diff_json: {
              ...previous,
              recovery_purged_at: new Date().toISOString(),
            } as Prisma.InputJsonValue,
          },
        });
      } catch (error) {
        this.logger.warn(
          `恢复副本清理失败 (${item.id}): ${error instanceof Error ? error.name : 'unknown'}`,
        );
      }
    }
  }

  private validateDisplayName(value: string): string {
    const name = value?.trim();
    if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name)) {
      throw conflict({
        code: 'ai.workspace.nameInvalid',
        messageKey: 'ai:error.workspace.nameInvalid',
        message: 'Workspace 名称无效',
      });
    }
    return name;
  }

  private hash(namespace: 'user' | 'project', value: string): string {
    return createHash('sha256')
      .update(`${namespace}\0${value}`)
      .digest('hex')
      .slice(0, 32);
  }

  private assertEnabled(): void {
    if (!this.paths.harnessConfig().enabled) {
      throw domainError(HttpStatus.SERVICE_UNAVAILABLE, {
        code: 'ai.runtime.disabled',
        messageKey: 'ai:error.runtime.disabled',
        message: 'AI 分析未启用',
      });
    }
  }
}
