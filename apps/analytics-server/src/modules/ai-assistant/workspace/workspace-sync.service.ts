import {
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { AiWorkspace, Prisma } from '@prisma/client';
import { badRequest, conflict, notFound } from '../../../i18n/domain-error';
import { createHash } from 'crypto';
import {
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
import { dirname, join } from 'path';
import { PrismaService } from '../../shared/prisma.service';
import { HarnessRuntimeManagerService } from '../harness-runtime-manager.service';
import { WorkspacePathsService, createOrderedId } from './workspace-paths.service';
import { WorkspaceService } from './workspace.service';
import { WorkspaceTemplateService } from './workspace-template.service';
import {
  WorkspaceSyncScope,
  WorkspaceTemplateEntry,
  WorkspaceTemplateManifest,
} from './workspace-template.types';
import { resolveTemplatePath } from './workspace-template-path';

interface SyncDiff {
  added: string[];
  replaced: string[];
  deleted: string[];
  released: string[];
  recovered: string[];
}

@Injectable()
export class WorkspaceSyncService implements OnModuleInit {
  private readonly logger = new Logger(WorkspaceSyncService.name);
  private readonly workspaceLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly paths: WorkspacePathsService,
    private readonly workspaces: WorkspaceService,
    private readonly templates: WorkspaceTemplateService,
    private readonly runtimes: HarnessRuntimeManagerService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.paths.harnessConfig().enabled) return;
    const interrupted = await this.prisma.aiWorkspaceSyncJob.findMany({
      where: { state: { in: ['planned', 'running'] } },
      include: { items: { select: { workspace_id: true, state: true } } },
    });
    for (const job of interrupted) {
      const failedWorkspaceIds = job.items
        .filter((item) => item.state !== 'succeeded')
        .map((item) => item.workspace_id);
      const successCount = job.items.length - failedWorkspaceIds.length;
      await this.prisma.$transaction([
        this.prisma.aiWorkspaceSyncItem.updateMany({
          where: { job_id: job.id, state: { not: 'succeeded' } },
          data: { state: 'failed', error_code: 'server_restarted', finished_at: new Date() },
        }),
        this.prisma.aiWorkspace.updateMany({
          where: { id: { in: failedWorkspaceIds }, status: 'syncing' },
          data: { status: 'sync_failed' },
        }),
        this.prisma.aiWorkspaceSyncJob.update({
          where: { id: job.id },
          data: {
            state: 'failed',
            success_count: successCount,
            failed_count: failedWorkspaceIds.length,
            finished_at: new Date(),
          },
        }),
      ]);
    }
  }

  async start(scope: WorkspaceSyncScope, requestedBy: string) {
    this.validateScope(scope);
    const template = await this.templates.latestVersion();
    if (!template) {
      throw notFound({
        code: 'ai.sync.templateMissing',
        messageKey: 'ai:error.sync.templateMissing',
        message: '没有可同步的模板版本',
      });
    }
    const targets = await this.prisma.aiWorkspace.findMany({
      where: {
        status: scope.workspace_ids?.length
          ? { in: ['active', 'sync_failed'] }
          : 'active',
        ...(scope.project_name ? { project_name: scope.project_name } : {}),
        ...(scope.user_id ? { user_id: scope.user_id } : {}),
        ...(scope.kind ? { kind: scope.kind } : {}),
        ...(scope.workspace_ids?.length ? { id: { in: scope.workspace_ids } } : {}),
      },
      orderBy: { created_at: 'asc' },
    });
    const id = createOrderedId('aiws_');
    const job = await this.prisma.aiWorkspaceSyncJob.create({
      data: {
        id,
        template_version: template.version,
        scope_json: scope as Prisma.InputJsonValue,
        state: 'planned',
        requested_by: requestedBy,
        planned_count: targets.length,
        items: {
          create: targets.map((workspace) => ({ workspace_id: workspace.id })),
        },
      },
    });
    void this.runJob(id).catch((error) => {
      this.logger.error(`Workspace 同步任务失败 (${id}): ${this.errorCode(error)}`);
    });
    return job;
  }

  async get(id: string) {
    const job = await this.prisma.aiWorkspaceSyncJob.findUnique({
      where: { id },
      include: { items: { orderBy: { workspace_id: 'asc' } } },
    });
    if (!job) {
      throw notFound({
        code: 'ai.sync.jobNotFound',
        messageKey: 'ai:error.sync.jobNotFound',
        message: '同步任务不存在',
      });
    }
    return job;
  }

  async retry(id: string, requestedBy: string) {
    const job = await this.prisma.aiWorkspaceSyncJob.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!job) {
      throw notFound({
        code: 'ai.sync.jobNotFound',
        messageKey: 'ai:error.sync.jobNotFound',
        message: '同步任务不存在',
      });
    }
    const workspaceIds = job.items
      .filter((item) => item.state !== 'succeeded')
      .map((item) => item.workspace_id);
    if (workspaceIds.length === 0) {
      throw badRequest({
        code: 'ai.sync.noFailedItems',
        messageKey: 'ai:error.sync.noFailedItems',
        message: '同步任务没有失败项',
      });
    }
    return this.start({ workspace_ids: workspaceIds }, requestedBy);
  }

  async initializeLegacy(
    workspaceId: string,
    requestedBy: string,
  ): Promise<{ ok: true; job_id: string }> {
    const workspace = await this.prisma.aiWorkspace.findUnique({ where: { id: workspaceId } });
    if (!workspace || workspace.status === 'deleted') {
      throw notFound({
        code: 'ai.workspace.notFound',
        messageKey: 'ai:error.workspace.notFound',
        message: 'Workspace 不存在',
      });
    }
    if (!['legacy', 'legacy_uninitialized'].includes(workspace.initialized_from)) {
      throw badRequest({
        code: 'ai.sync.notLegacyWorkspace',
        messageKey: 'ai:error.sync.notLegacyWorkspace',
        message: 'Workspace 不是待初始化的遗留空间',
      });
    }
    const latest = await this.templates.latestVersion();
    if (!latest) {
      throw notFound({
        code: 'ai.template.notPublished',
        messageKey: 'ai:error.template.notPublished',
        message: '模板尚未发布',
      });
    }
    const sourceRoot = await this.templates.versionRoot(latest.version);
    const jobId = createOrderedId('aiws_');
    const job = await this.prisma.aiWorkspaceSyncJob.create({
      data: {
        id: jobId,
        template_version: latest.version,
        scope_json: { workspace_ids: [workspace.id], initialize_legacy: true },
        state: 'running',
        requested_by: requestedBy,
        planned_count: 1,
        items: { create: [{ workspace_id: workspace.id }] },
      },
      include: { items: true },
    });
    const item = job.items[0];
    try {
      await this.withWorkspaceLock(workspace.id, () =>
        this.syncWorkspace(
          jobId,
          item.id,
          workspace,
          sourceRoot,
          latest.manifest_json as unknown as WorkspaceTemplateManifest,
          true,
        ),
      );
      await this.prisma.aiWorkspaceSyncJob.update({
        where: { id: jobId },
        data: { state: 'succeeded', success_count: 1, finished_at: new Date() },
      });
      return { ok: true, job_id: jobId };
    } catch (error) {
      await this.failItem(item.id, this.errorCode(error));
      await this.prisma.aiWorkspaceSyncJob.update({
        where: { id: jobId },
        data: { state: 'failed', failed_count: 1, finished_at: new Date() },
      });
      throw error;
    }
  }

  private async runJob(jobId: string): Promise<void> {
    const job = await this.prisma.aiWorkspaceSyncJob.findUnique({
      where: { id: jobId },
      include: { items: true, template: true },
    });
    if (!job) return;
    await this.prisma.aiWorkspaceSyncJob.update({
      where: { id: jobId },
      data: { state: 'running' },
    });
    let successCount = 0;
    let failedCount = 0;
    const manifest = job.template.manifest_json as unknown as WorkspaceTemplateManifest;
    const sourceRoot = await this.templates.versionRoot(job.template_version);
    for (const item of job.items) {
      const workspace = await this.prisma.aiWorkspace.findUnique({
        where: { id: item.workspace_id },
      });
      if (!workspace) {
        failedCount += 1;
        await this.failItem(item.id, 'workspace_not_found');
        continue;
      }
      try {
        await this.withWorkspaceLock(workspace.id, () =>
          this.syncWorkspace(jobId, item.id, workspace, sourceRoot, manifest),
        );
        successCount += 1;
      } catch (error) {
        failedCount += 1;
        await this.failItem(item.id, this.errorCode(error));
      }
    }
    await this.prisma.aiWorkspaceSyncJob.update({
      where: { id: jobId },
      data: {
        state: failedCount > 0 ? (successCount > 0 ? 'partial' : 'failed') : 'succeeded',
        success_count: successCount,
        failed_count: failedCount,
        finished_at: new Date(),
      },
    });
  }

  private async syncWorkspace(
    jobId: string,
    itemId: string,
    workspace: AiWorkspace,
    sourceRoot: string,
    nextManifest: WorkspaceTemplateManifest,
    initializeLegacy = false,
  ): Promise<void> {
    const claimed = await this.prisma.$transaction(async (transaction) => {
      const result = await transaction.aiWorkspace.updateMany({
        where: {
          id: workspace.id,
          status: { in: ['active', 'sync_failed'] },
        },
        data: { status: 'syncing' },
      });
      if (result.count !== 1) return false;
      await transaction.aiWorkspaceSyncItem.update({
        where: { id: itemId },
        data: { state: 'snapshotting', started_at: new Date() },
      });
      return true;
    });
    if (!claimed) {
      throw conflict({
        code: 'ai.sync.workspaceNotAvailable',
        messageKey: 'ai:error.sync.workspaceNotAvailable',
        message: 'workspace_not_available_for_sync',
      });
    }
    // Stop the mounted Runtime before replacing managed paths. The official
    // session log remains in DSH Home and is available again after reconnect.
    let workspaceRoot: string;
    let oldManifest: WorkspaceTemplateManifest;
    let recoveryRoot: string;
    const recoveryRelative = `.clklog/recovery/${jobId}`;
    try {
      await this.runtimes.closeWorkspace(
        workspace.user_id,
        workspace.project_name,
        workspace.id,
      );
      workspaceRoot = await this.workspaces.pathFor(workspace);
      oldManifest = await this.workspaces.readManagedManifest(workspaceRoot);
      recoveryRoot = join(workspaceRoot, recoveryRelative);
      await mkdir(recoveryRoot, { recursive: true, mode: 0o700 });
    } catch (error) {
      await this.markWorkspaceSyncFailed(workspace.id);
      throw error;
    }
    const nextByPath = new Map(nextManifest.entries.map((entry) => [entry.path, entry]));
    const nextManaged = nextManifest.entries.filter(
      (entry) => entry.policy === 'managed_readonly',
    );
    const nextManagedByPath = new Map(nextManaged.map((entry) => [entry.path, entry]));
    const initializedSeedEntries: WorkspaceTemplateEntry[] = [];
    const oldManaged = [...oldManifest.entries].sort(
      (left, right) => right.path.split('/').length - left.path.split('/').length,
    );
    const diff: SyncDiff = {
      added: [],
      replaced: [],
      deleted: [],
      released: [],
      recovered: [],
    };

    try {
      for (const entry of [...oldManaged]
        .filter((candidate) => candidate.kind === 'directory')
        .sort((left, right) => left.path.split('/').length - right.path.split('/').length)) {
        const target = resolveTemplatePath(workspaceRoot, entry.path);
        if (!(await this.exists(target))) continue;
        const info = await lstat(target);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw badRequest({
            code: 'ai.sync.managedDirectoryInvalid',
            messageKey: 'ai:error.sync.managedDirectoryInvalid',
            message: '受管目录类型无效',
          });
        }
        await chmod(target, 0o755);
      }
      for (const oldEntry of oldManaged) {
        const nextEntry = nextByPath.get(oldEntry.path);
        if (!nextManagedByPath.has(oldEntry.path)) {
          const target = resolveTemplatePath(workspaceRoot, oldEntry.path);
          if (nextEntry?.policy === 'seed_once') {
            if (await this.exists(target)) {
              await chmod(target, Number.parseInt(nextEntry.mode, 8));
              diff.released.push(oldEntry.path);
            }
            continue;
          }
          if (await this.backup(target, recoveryRoot, oldEntry.path)) {
            diff.recovered.push(oldEntry.path);
            await rm(target, { recursive: true, force: false });
            diff.deleted.push(oldEntry.path);
          }
        }
      }

      await this.prisma.aiWorkspaceSyncItem.update({
        where: { id: itemId },
        data: { state: 'applying' },
      });
      for (const entry of nextManaged) {
        const previous = oldManifest.entries.find((item) => item.path === entry.path);
        const target = resolveTemplatePath(workspaceRoot, entry.path);
        if (
          previous &&
          previous.kind === entry.kind &&
          previous.sha256 === entry.sha256 &&
          previous.mode === entry.mode &&
          (await this.exists(target))
        ) {
          await chmod(
            target,
            entry.kind === 'directory' ? 0o755 : Number.parseInt(entry.mode, 8),
          );
          continue;
        }
        const existed = await this.backup(target, recoveryRoot, entry.path);
        if (existed) diff.recovered.push(entry.path);
        await this.replaceFromTemplate(sourceRoot, workspaceRoot, entry);
        (existed ? diff.replaced : diff.added).push(entry.path);
      }

      if (initializeLegacy) {
        for (const entry of nextManifest.entries.filter(
          (candidate) => candidate.policy === 'seed_once',
        )) {
          const target = resolveTemplatePath(workspaceRoot, entry.path);
          if (await this.exists(target)) continue;
          await this.replaceFromTemplate(sourceRoot, workspaceRoot, entry);
          initializedSeedEntries.push(entry);
          diff.added.push(entry.path);
        }
      }

      const finalizedDirectories = [
        ...nextManaged,
        ...initializedSeedEntries,
      ]
        .filter((entry) => entry.kind === 'directory')
        .sort((left, right) => right.path.split('/').length - left.path.split('/').length);
      for (const entry of finalizedDirectories) {
        await chmod(
          resolveTemplatePath(workspaceRoot, entry.path),
          Number.parseInt(entry.mode, 8),
        );
      }

      await this.prisma.aiWorkspaceSyncItem.update({
        where: { id: itemId },
        data: { state: 'verifying' },
      });
      await this.verifyManaged(workspaceRoot, [...nextManaged, ...initializedSeedEntries]);
      await this.workspaces.writeManagedManifest(
        workspaceRoot,
        this.managedManifest(nextManifest),
      );
      await writeFile(
        join(recoveryRoot, 'recovery-manifest.json'),
        `${JSON.stringify({ schema_version: 1, job_id: jobId, diff }, null, 2)}\n`,
        { mode: 0o600 },
      );
      await this.workspaces.ensureOwnership(workspaceRoot);
      await this.prisma.$transaction([
        this.prisma.aiWorkspace.update({
          where: { id: workspace.id },
          data: {
            status: 'active',
            applied_template_version: nextManifest.template_version,
            ...(initializeLegacy ? { initialized_from: 'legacy_initialized' } : {}),
          },
        }),
        this.prisma.aiWorkspaceSyncItem.update({
          where: { id: itemId },
          data: {
            state: 'succeeded',
            diff_json: diff as unknown as Prisma.InputJsonValue,
            recovery_path: recoveryRelative,
            finished_at: new Date(),
          },
        }),
      ]);
    } catch (error) {
      const errorCode = this.errorCode(error);
      await writeFile(
        join(recoveryRoot, 'recovery-manifest.json'),
        `${JSON.stringify({
          schema_version: 1,
          job_id: jobId,
          state: 'failed',
          error_code: errorCode,
          diff,
        }, null, 2)}\n`,
        { mode: 0o600 },
      ).catch(() => undefined);
      await this.prisma.aiWorkspaceSyncItem.update({
        where: { id: itemId },
        data: {
          diff_json: diff as unknown as Prisma.InputJsonValue,
          recovery_path: recoveryRelative,
        },
      }).catch(() => undefined);
      await this.markWorkspaceSyncFailed(workspace.id);
      throw error;
    }
  }

  private async markWorkspaceSyncFailed(workspaceId: string): Promise<void> {
    await this.prisma.aiWorkspace.updateMany({
      where: { id: workspaceId, status: 'syncing' },
      data: { status: 'sync_failed' },
    }).catch(() => undefined);
  }

  private async replaceFromTemplate(
    sourceRoot: string,
    workspaceRoot: string,
    entry: WorkspaceTemplateEntry,
  ): Promise<void> {
    const source = resolveTemplatePath(sourceRoot, entry.path);
    const target = resolveTemplatePath(workspaceRoot, entry.path);
    const mode = Number.parseInt(entry.mode, 8);
    if (await this.exists(target)) await rm(target, { recursive: true, force: false });
    if (entry.kind === 'directory') {
      await mkdir(target, { recursive: true, mode: 0o755 });
      await chmod(target, 0o755);
      return;
    }
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    const temporary = `${target}.sync-${Date.now().toString(36)}`;
    await copyFile(source, temporary);
    await chmod(temporary, mode);
    await rename(temporary, target);
  }

  private async backup(
    source: string,
    recoveryRoot: string,
    relativePath: string,
  ): Promise<boolean> {
    let info;
    try {
      info = await lstat(source);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw badRequest({
        code: 'ai.sync.symlinkTarget',
        messageKey: 'ai:error.sync.symlinkTarget',
        message: '同步目标包含软链接',
      });
    }
    const destination = resolveTemplatePath(recoveryRoot, relativePath);
    await this.copyWithoutLinks(source, destination);
    return true;
  }

  private async copyWithoutLinks(source: string, destination: string): Promise<void> {
    const info = await lstat(source);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
      throw badRequest({
        code: 'ai.sync.recoveryRejectsLinks',
        messageKey: 'ai:error.sync.recoveryRejectsLinks',
        message: '恢复副本拒绝链接或特殊文件',
      });
    }
    if (info.isDirectory()) {
      await mkdir(destination, { recursive: true, mode: 0o700 });
      await chmod(destination, 0o700);
      for (const child of await readdir(source)) {
        await this.copyWithoutLinks(join(source, child), join(destination, child));
      }
      await chmod(destination, info.mode & 0o777);
      return;
    }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await copyFile(source, destination);
    await chmod(destination, info.mode & 0o777);
  }

  private async verifyManaged(
    workspaceRoot: string,
    entries: WorkspaceTemplateEntry[],
  ): Promise<void> {
    for (const entry of entries) {
      const target = resolveTemplatePath(workspaceRoot, entry.path);
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error('managed_symlink');
      if (entry.kind === 'file' ? !info.isFile() : !info.isDirectory()) {
        throw new Error('managed_type_mismatch');
      }
      if ((info.mode & 0o777) !== Number.parseInt(entry.mode, 8)) {
        throw new Error('managed_mode_mismatch');
      }
      if (entry.kind === 'file') {
        const digest = createHash('sha256').update(await readFile(target)).digest('hex');
        if (digest !== entry.sha256) throw new Error('managed_digest_mismatch');
      }
    }
  }

  private managedManifest(manifest: WorkspaceTemplateManifest): WorkspaceTemplateManifest {
    const entries = manifest.entries.filter((entry) => entry.policy === 'managed_readonly');
    return {
      ...manifest,
      entries,
      content_digest: createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
    };
  }

  private async withWorkspaceLock<T>(workspaceId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.workspaceLocks.get(workspaceId) ?? Promise.resolve();
    let release: () => void;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const tail = previous.then(() => current);
    this.workspaceLocks.set(workspaceId, tail);
    await previous;
    try {
      return await task();
    } finally {
      release!();
      if (this.workspaceLocks.get(workspaceId) === tail) {
        this.workspaceLocks.delete(workspaceId);
      }
    }
  }

  private async failItem(itemId: string, errorCode: string): Promise<void> {
    await this.prisma.aiWorkspaceSyncItem.update({
      where: { id: itemId },
      data: { state: 'failed', error_code: errorCode.slice(0, 180), finished_at: new Date() },
    });
  }

  private validateScope(scope: WorkspaceSyncScope): void {
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
      throw badRequest({
        code: 'ai.sync.scopeInvalid',
        messageKey: 'ai:error.sync.scopeInvalid',
        message: '同步范围无效',
      });
    }
    const allowed = new Set(['project_name', 'user_id', 'kind', 'workspace_ids']);
    if (Object.keys(scope).some((key) => !allowed.has(key))) {
      throw badRequest({
        code: 'ai.sync.scopeUnknownField',
        messageKey: 'ai:error.sync.scopeUnknownField',
        message: '同步范围包含未知字段',
      });
    }
    for (const [field, value] of [
      ['project_name', scope.project_name],
      ['user_id', scope.user_id],
    ] as const) {
      if (value !== undefined && (typeof value !== 'string' || !value || value.length > 191)) {
        throw badRequest({
          code: 'ai.sync.fieldInvalid',
          messageKey: 'ai:error.sync.fieldInvalid',
          params: { field },
          message: `${field} 无效`,
        });
      }
    }
    if (scope.workspace_ids !== undefined) {
      if (
        !Array.isArray(scope.workspace_ids)
        || scope.workspace_ids.length > 500
        || scope.workspace_ids.some((id) => !/^[a-zA-Z0-9_-]+$/.test(id))
      ) {
        throw badRequest({
          code: 'ai.sync.workspaceIdsInvalid',
          messageKey: 'ai:error.sync.workspaceIdsInvalid',
          message: 'Workspace ID 范围无效或超过 500 个',
        });
      }
    }
    if (scope.kind && !['persistent', 'temporary'].includes(scope.kind)) {
      throw badRequest({
        code: 'ai.sync.workspaceKindInvalid',
        messageKey: 'ai:error.sync.workspaceKindInvalid',
        message: 'Workspace 类型无效',
      });
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private errorCode(error: unknown): string {
    if (error instanceof Error && /^[a-z0-9_]{3,80}$/.test(error.message)) {
      return error.message;
    }
    return 'workspace_sync_failed';
  }
}
