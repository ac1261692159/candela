import {
  HttpStatus,
  Injectable,
  Logger,
  OnModuleDestroy,
  UnauthorizedException,
} from '@nestjs/common';
import { AiWorkspace } from '@prisma/client';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { badRequest, domainError, notFound } from '../../i18n/domain-error';
import { AuthUser } from '../auth/auth.service';
import { HarnessBrokerClientService } from './harness-broker-client.service';
import { HarnessSettingsService } from './harness-settings.service';
import { ModelProviderRegistryService } from './model-provider/model-provider-registry.service';
import { WorkspacePathsService, createOrderedId } from './workspace/workspace-paths.service';
import { WorkspaceService } from './workspace/workspace.service';
import { PrismaService } from '../shared/prisma.service';

const TAB_ID = /^[a-zA-Z0-9_-]{16,128}$/;
const TICKET_ID = /^ait_[a-zA-Z0-9_-]{24,}$/;
const TICKET_TTL_MS = 2 * 60_000;
/** 关闭时等待 broker 回收容器的上限：supervisor 宽限 10s，必须留足余量（2026-09-18 事故） */
const RUNTIME_CLOSE_BUDGET_MS = 4_000;

export interface HarnessRuntimeContext {
  runtimeId: string;
  userId: string;
  project: string;
  tabId: string;
  workspaceId: string;
  workspaceKind: 'persistent' | 'temporary';
  capability: string;
  userToken: string;
  socketPath: string;
  upstreamToken: string;
  upstreamCookie?: string;
  createdAt: number;
  lastUsedAt: number;
  capabilityExpiresAt: number;
  /** 创建时的模型供应商配置版本：与当前快照不一致即视为陈旧，复用前先重建（惰性生效） */
  configRevision: string;
}

interface HostTicket {
  id: string;
  user: AuthUser;
  project: string;
  tabId: string;
  workspace: AiWorkspace;
  userToken: string;
  expiresAt: number;
}

@Injectable()
export class HarnessRuntimeManagerService implements OnModuleDestroy {
  private readonly logger = new Logger(HarnessRuntimeManagerService.name);
  private readonly tickets = new Map<string, HostTicket>();
  private readonly runtimes = new Map<string, HarnessRuntimeContext>();
  private readonly runtimeKeys = new Map<string, string>();
  private readonly capabilities = new Map<string, string>();
  private readonly pending = new Map<string, Promise<HarnessRuntimeContext>>();
  private readonly reviving = new Map<string, Promise<HarnessRuntimeContext>>();
  private readonly touchTimes = new Map<string, number>();
  private readonly revokedTokens = new Set<string>();
  private readonly disabledUsers = new Set<string>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(
    private readonly paths: WorkspacePathsService,
    private readonly workspaces: WorkspaceService,
    private readonly settings: HarnessSettingsService,
    private readonly broker: HarnessBrokerClientService,
    private readonly prisma: PrismaService,
    private readonly providers: ModelProviderRegistryService,
  ) {
    this.cleanupTimer = setInterval(() => void this.closeIdle(), 60_000);
    this.cleanupTimer.unref();
  }

  async issueHostTicket(input: {
    user: AuthUser;
    project: string;
    userToken: string;
    tabId: string;
    workspaceId?: string;
  }): Promise<{ ticket: string; launch_url: string; expires_in_ms: number; peer_sessions: number }> {
    this.assertEnabled();
    this.assertProvidersConfigured();
    if (this.disabledUsers.has(input.user.id) || this.revokedTokens.has(input.userToken)) {
      throw new UnauthorizedException({
        code: 'ai.runtime.tokenRevoked',
        errorCode: 'ai.runtime.tokenRevoked',
        messageKey: 'ai:error.runtime.tokenRevoked',
        message: '登录状态已撤销',
      });
    }
    this.validateTabId(input.tabId);
    const workspace = input.workspaceId
      ? await this.workspaces.getOwned(input.workspaceId, input.user, input.project)
      : await this.workspaces.defaultWorkspace(input.user, input.project);
    const id = `ait_${randomBytes(24).toString('base64url')}`;
    this.tickets.set(id, {
      id,
      user: input.user,
      project: input.project,
      tabId: input.tabId,
      workspace,
      userToken: input.userToken,
      expiresAt: Date.now() + TICKET_TTL_MS,
    });
    return {
      ticket: id,
      launch_url: `/sa/harness/bootstrap?ticket=${encodeURIComponent(id)}`,
      expires_in_ms: TICKET_TTL_MS,
      peer_sessions: this.countPeerSessions(input.user.id, input.project, workspace.id, input.tabId),
    };
  }

  async closeToken(userId: string, userToken: string): Promise<void> {
    this.revokedTokens.add(userToken);
    for (const [id, ticket] of this.tickets) {
      if (ticket.user.id === userId && ticket.userToken === userToken) {
        this.tickets.delete(id);
      }
    }
    await this.settlePending(userId);
    const ids = [...this.runtimes.values()]
      .filter((runtime) => runtime.userId === userId && runtime.userToken === userToken)
      .map((runtime) => runtime.runtimeId);
    await Promise.allSettled(ids.map((id) => this.closeRuntime(id)));
  }

  async closeUser(userId: string): Promise<void> {
    for (const [id, ticket] of this.tickets) {
      if (ticket.user.id === userId) this.tickets.delete(id);
    }
    await this.settlePending(userId);
    const ids = [...this.runtimes.values()]
      .filter((runtime) => runtime.userId === userId)
      .map((runtime) => runtime.runtimeId);
    await Promise.allSettled(ids.map((id) => this.closeRuntime(id)));
  }

  async disableUser(userId: string): Promise<void> {
    this.disabledUsers.add(userId);
    await this.closeUser(userId);
  }

  enableUser(userId: string): void {
    this.disabledUsers.delete(userId);
  }

  async consumeHostTicket(ticketId: string): Promise<HarnessRuntimeContext> {
    if (!TICKET_ID.test(ticketId)) {
      throw badRequest({
        code: 'ai.runtime.ticketInvalid',
        messageKey: 'ai:error.runtime.ticketInvalid',
        message: 'Harness 启动票据无效',
      });
    }
    const ticket = this.tickets.get(ticketId);
    this.tickets.delete(ticketId);
    if (!ticket || ticket.expiresAt < Date.now()) {
      throw notFound({
        code: 'ai.runtime.ticketExpired',
        messageKey: 'ai:error.runtime.ticketExpired',
        message: 'Harness 启动票据不存在或已过期',
      });
    }
    const key = this.runtimeKey(ticket.user.id, ticket.project, ticket.tabId);
    const previous = this.pending.get(key);
    const operation = (async () => {
      if (previous) await previous.catch(() => undefined);
      return this.ensureTicketRuntime(ticket, key);
    })();
    this.pending.set(key, operation);
    return operation.finally(() => {
      if (this.pending.get(key) === operation) this.pending.delete(key);
    });
  }

  private async ensureTicketRuntime(
    ticket: HostTicket,
    key: string,
  ): Promise<HarnessRuntimeContext> {
    const currentId = this.runtimeKeys.get(key);
    const current = currentId ? this.runtimes.get(currentId) : undefined;
    if (
      current &&
      current.workspaceId === ticket.workspace.id &&
      current.capabilityExpiresAt > Date.now() + 60_000 &&
      current.configRevision === this.providers.snapshot().revision
    ) {
      await this.ensureBrokerRuntime(current);
      current.userToken = ticket.userToken;
      return current;
    }
    if (current) await this.closeRuntime(current.runtimeId);
    return this.createRuntime(ticket, key);
  }

  getRuntime(runtimeId: string): HarnessRuntimeContext {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) {
      throw notFound({
        code: 'ai.runtime.notFound',
        messageKey: 'ai:error.runtime.notFound',
        message: 'Harness Runtime 不存在或已回收',
      });
    }
    this.touchRuntime(runtime);
    return runtime;
  }

  async reviveRuntime(runtimeId: string): Promise<HarnessRuntimeContext> {
    const existing = this.reviving.get(runtimeId);
    if (existing) return existing;
    const operation = this.reviveNow(runtimeId).finally(() => {
      if (this.reviving.get(runtimeId) === operation) this.reviving.delete(runtimeId);
    });
    this.reviving.set(runtimeId, operation);
    return operation;
  }

  async getAuthorizedRuntime(runtimeId: string): Promise<HarnessRuntimeContext> {
    const runtime = this.getRuntime(runtimeId);
    const token = await this.prisma.saUserToken.findUnique({
      where: { token: runtime.userToken },
      include: { user: { select: { id: true, status: true } } },
    });
    if (
      !token
      || token.user.id !== runtime.userId
      || token.user.status !== 'active'
      || (token.expires_at && token.expires_at.getTime() < Date.now())
    ) {
      await this.closeRuntime(runtime.runtimeId);
      throw new UnauthorizedException({
        code: 'ai.runtime.tokenInvalid',
        errorCode: 'ai.runtime.tokenInvalid',
        messageKey: 'ai:error.runtime.tokenInvalid',
        message: '登录状态已失效',
      });
    }
    return runtime;
  }

  async authorizeCapability(
    capability: string,
    runtimeId?: string,
  ): Promise<HarnessRuntimeContext> {
    const id = this.capabilities.get(capability);
    const runtime = id ? await this.getAuthorizedRuntime(id) : undefined;
    if (
      !runtime ||
      runtime.capabilityExpiresAt < Date.now() ||
      (runtimeId !== undefined && runtime.runtimeId !== runtimeId)
    ) {
      throw notFound({
        code: 'ai.runtime.capabilityInvalid',
        messageKey: 'ai:error.runtime.capabilityInvalid',
        message: 'Runtime capability 无效或已过期',
      });
    }
    runtime.capabilityExpiresAt =
      Date.now() + this.paths.harnessConfig().runtime.idle_ttl_ms + 5 * 60_000;
    this.touchRuntime(runtime);
    return runtime;
  }

  modelCatalog() {
    const snapshot = this.providers.snapshot();
    return {
      enabled: snapshot.enabled,
      // permission_preset 仍来自部署配置：这里是成员可见目录，保持字段形状不变
      defaults: {
        ...snapshot.defaults,
        permission_preset: this.paths.harnessConfig().defaults.permission_preset,
      },
      providers: Object.fromEntries(
        Object.entries(snapshot.providers).map(([id, provider]) => [
          id,
          {
            display_name: provider.display_name,
            configured: provider.configured,
            available: provider.configured,
            models: provider.models,
          },
        ]),
      ),
    };
  }

  /** 当前运行中的会话数（设置页「立即应用」按钮与提示文案用） */
  countRuntimes(): number {
    return this.runtimes.size;
  }

  /**
   * 立即应用新的供应商配置：回收全部运行中的会话，让它们下次按新配置重建。
   * 逐个容错——单个 broker 停止失败不能挡住其余会话的回收。
   */
  async recycleAll(): Promise<number> {
    const ids = [...this.runtimes.keys()];
    await Promise.allSettled(ids.map((id) => this.closeRuntime(id)));
    return ids.length;
  }

  async closeWorkspace(userId: string, project: string, workspaceId: string): Promise<void> {
    const ids = [...this.runtimes.values()]
      .filter(
        (runtime) =>
          runtime.userId === userId &&
          runtime.project === project &&
          runtime.workspaceId === workspaceId,
      )
      .map((runtime) => runtime.runtimeId);
    // Workspace maintenance must fail closed: replacing or moving files while
    // a bind-mounted Runtime is still alive would violate the isolation model.
    await Promise.all(ids.map((id) => this.closeRuntime(id, true)));
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.cleanupTimer);
    const ids = [...this.runtimes.keys()];
    if (ids.length === 0) return;
    // 关闭时**限时**等待 broker 回收容器：逐台 stop 都走 broker HTTP，容器多或 broker 慢时
    // 会拖过 supervisor 的 10s 宽限而被 SIGKILL（2026-09-18 事故）。超时即放弃等待——
    // 平台重启后运行时本就会按需重建，残留容器由 broker 的空闲回收兜底。
    const startedAt = Date.now();
    let timedOut = false;
    await Promise.race([
      Promise.allSettled(ids.map((id) => this.closeRuntime(id))),
      new Promise<void>((resolvePromise) => {
        const timer = setTimeout(() => {
          timedOut = true;
          resolvePromise();
        }, RUNTIME_CLOSE_BUDGET_MS);
        timer.unref?.();
      }),
    ]);
    this.logger.log(
      `关闭 ${ids.length} 个 Harness Runtime：${timedOut ? `超时 ${RUNTIME_CLOSE_BUDGET_MS}ms，交给 broker 空闲回收` : '已全部回收'}，用时 ${Date.now() - startedAt}ms`,
    );
  }

  private async createRuntime(ticket: HostTicket, key: string): Promise<HarnessRuntimeContext> {
    const config = this.paths.harnessConfig();
    if (this.runtimes.size >= config.runtime.max_runtimes) {
      throw domainError(HttpStatus.SERVICE_UNAVAILABLE, {
        code: 'ai.runtime.capacityFull',
        messageKey: 'ai:error.runtime.capacityFull',
        message: 'Harness Runtime 容量已满，请稍后重试',
      });
    }
    const runtimeId = createOrderedId('air_');
    const capability = randomBytes(32).toString('base64url');
    const capabilityExpiresAt = Date.now() + config.runtime.idle_ttl_ms + 5 * 60_000;
    await this.settings.prepare(ticket.user.id, ticket.project);
    // 项目级 app 目录（同项目共享、跨项目隔离）：由服务端创建后交给 broker 挂到 /workspace/app，
    // 创建失败即失败启动——不允许「没有项目目录也照样跑」的静默降级（隔离设计 §3）
    const appDir = await this.paths.ensureProjectAppDirectory(ticket.project);
    const started = await this.broker.ensure({
      runtime_id: runtimeId,
      user_id: ticket.user.id,
      project_name: ticket.project,
      workspace_id: ticket.workspace.id,
      kind: ticket.workspace.kind as 'persistent' | 'temporary',
      capability,
      permission_mode: this.permissionMode(),
      app_dir: appDir,
    });
    const expectedSocket = join(
      await this.paths.runtimeInstancePath(ticket.user.id, ticket.project, runtimeId),
      'runtime.sock',
    );
    if (started.runtime_id !== runtimeId || started.socket_path !== expectedSocket) {
      await this.broker.stop(runtimeId).catch(() => undefined);
      throw domainError(HttpStatus.SERVICE_UNAVAILABLE, {
        code: 'ai.runtime.brokerIdentityInvalid',
        messageKey: 'ai:error.runtime.brokerIdentityInvalid',
        message: 'Harness Broker 返回的 Runtime 身份无效',
      });
    }
    const now = Date.now();
    const runtime: HarnessRuntimeContext = {
      runtimeId,
      userId: ticket.user.id,
      project: ticket.project,
      tabId: ticket.tabId,
      workspaceId: ticket.workspace.id,
      workspaceKind: ticket.workspace.kind as 'persistent' | 'temporary',
      capability,
      userToken: ticket.userToken,
      socketPath: started.socket_path,
      upstreamToken: started.upstream_token,
      createdAt: now,
      lastUsedAt: now,
      capabilityExpiresAt,
      configRevision: this.providers.snapshot().revision,
    };
    this.runtimes.set(runtimeId, runtime);
    this.runtimeKeys.set(key, runtimeId);
    this.capabilities.set(capability, runtimeId);
    await this.workspaces.touch(ticket.workspace);
    return runtime;
  }

  private async reviveNow(runtimeId: string): Promise<HarnessRuntimeContext> {
    const runtime = await this.getAuthorizedRuntime(runtimeId);
    await this.ensureBrokerRuntime(runtime);
    return runtime;
  }

  private async ensureBrokerRuntime(runtime: HarnessRuntimeContext): Promise<void> {
    // 复活路径（broker 重启后重建容器）同样要带项目 app 目录：目录被人工删掉时这里能自愈
    const appDir = await this.paths.ensureProjectAppDirectory(runtime.project);
    const started = await this.broker.ensure({
      runtime_id: runtime.runtimeId,
      user_id: runtime.userId,
      project_name: runtime.project,
      workspace_id: runtime.workspaceId,
      kind: runtime.workspaceKind,
      capability: runtime.capability,
      permission_mode: this.permissionMode(),
      app_dir: appDir,
    });
    const expectedSocket = join(
      await this.paths.runtimeInstancePath(runtime.userId, runtime.project, runtime.runtimeId),
      'runtime.sock',
    );
    if (started.runtime_id !== runtime.runtimeId || started.socket_path !== expectedSocket) {
      await this.closeRuntime(runtime.runtimeId);
      throw domainError(HttpStatus.SERVICE_UNAVAILABLE, {
        code: 'ai.runtime.brokerIdentityInvalid',
        messageKey: 'ai:error.runtime.brokerIdentityInvalid',
        message: 'Harness Broker 返回的 Runtime 身份无效',
      });
    }
    runtime.socketPath = started.socket_path;
    if (runtime.upstreamToken !== started.upstream_token) {
      runtime.upstreamCookie = undefined;
      runtime.upstreamToken = started.upstream_token;
    }
    this.touchRuntime(runtime);
  }

  private async closeRuntime(runtimeId: string, requireStopped = false): Promise<void> {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) return;
    if (requireStopped) {
      await this.broker.stop(runtimeId);
    }
    this.runtimes.delete(runtimeId);
    this.capabilities.delete(runtime.capability);
    this.runtimeKeys.delete(this.runtimeKey(runtime.userId, runtime.project, runtime.tabId));
    this.touchTimes.delete(runtimeId);
    if (!requireStopped) await this.broker.stop(runtimeId).catch(() => undefined);
  }

  private async settlePending(userId: string): Promise<void> {
    const prefix = `${userId}\0`;
    const pending = [...this.pending.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, promise]) => promise);
    await Promise.allSettled(pending);
  }

  private async closeIdle(): Promise<void> {
    const now = Date.now();
    for (const [id, ticket] of this.tickets) {
      if (ticket.expiresAt < now) this.tickets.delete(id);
    }
    const ttl = this.paths.harnessConfig().runtime.idle_ttl_ms;
    await Promise.allSettled(
      [...this.runtimes.values()]
        .filter((runtime) => now - runtime.lastUsedAt > ttl)
        .map((runtime) => this.closeRuntime(runtime.runtimeId)),
    );
  }

  private touchRuntime(runtime: HarnessRuntimeContext): void {
    runtime.lastUsedAt = Date.now();
    const previous = this.touchTimes.get(runtime.runtimeId) ?? 0;
    if (runtime.lastUsedAt - previous < 60_000) return;
    this.touchTimes.set(runtime.runtimeId, runtime.lastUsedAt);
    void this.workspaces
      .touchOwnedId(runtime.workspaceId, runtime.userId, runtime.project)
      .catch(() => undefined);
  }

  private runtimeKey(userId: string, project: string, tabId: string): string {
    return `${userId}\0${project}\0${tabId}`;
  }

  private countPeerSessions(userId: string, project: string, workspaceId: string, tabId: string): number {
    return [...this.runtimes.values()].filter(
      (runtime) =>
        runtime.userId === userId &&
        runtime.project === project &&
        runtime.workspaceId === workspaceId &&
        runtime.tabId !== tabId,
    ).length;
  }

  private validateTabId(tabId: string): void {
    if (!TAB_ID.test(tabId)) {
      throw badRequest({
        code: 'ai.runtime.tabIdInvalid',
        messageKey: 'ai:error.runtime.tabIdInvalid',
        message: 'tab_id 无效',
      });
    }
  }

  private permissionMode(): 'read-only' | 'workspace-write' | 'danger-full-access' {
    return this.paths.harnessConfig().defaults.permission_preset.replaceAll('_', '-') as
      | 'read-only'
      | 'workspace-write'
      | 'danger-full-access';
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

  /**
   * 一个模型供应商都没配时不给开助手：否则会启动一个没有任何模型的会话，
   * 用户只会看到一堆莫名其妙的失败。指向设置页让管理员先配好。
   */
  private assertProvidersConfigured(): void {
    if (this.providers.snapshot().configured) return;
    throw domainError(HttpStatus.SERVICE_UNAVAILABLE, {
      code: 'ai.provider.noneConfigured',
      messageKey: 'ai:error.provider.noneConfigured',
    });
  }
}
