import { UnauthorizedException } from '@nestjs/common';
import { HarnessRuntimeManagerService } from './harness-runtime-manager.service';

describe('HarnessRuntimeManagerService access revocation', () => {
  const user = {
    id: 'user-1',
    username: 'analyst',
    display_name: null,
    platform_role: 'none' as const,
  };
  const workspace = {
    id: 'aiw_test',
    kind: 'persistent',
  };
  const config = {
    enabled: true,
    runtime: {
      idle_ttl_ms: 900_000,
      max_runtimes: 8,
    },
    defaults: {
      permission_preset: 'workspace_write',
    },
    providers: {},
  };

  function createService() {
    const paths = {
      harnessConfig: jest.fn(() => config),
      runtimeInstancePath: jest.fn(
        async (_userId: string, _project: string, runtimeId: string) =>
          `/runtime/${runtimeId}`,
      ),
      // 项目 app 目录：容器内挂到 /workspace/app（隔离设计 §3）
      ensureProjectAppDirectory: jest.fn(async (project: string) => `/app/${project}`),
    };
    const workspaces = {
      defaultWorkspace: jest.fn(async () => workspace),
      getOwned: jest.fn(async (id: string) => ({ ...workspace, id })),
      touch: jest.fn(async () => undefined),
      touchOwnedId: jest.fn(async () => undefined),
    };
    const settings = { prepare: jest.fn(async () => undefined) };
    const broker = {
      ensure: jest.fn(async (input: { runtime_id: string }) => ({
        runtime_id: input.runtime_id,
        socket_path: `/runtime/${input.runtime_id}/runtime.sock`,
        upstream_token: 'upstream-token',
      })),
      stop: jest.fn(async () => undefined),
    };
    const prisma = {
      saUserToken: {
        findUnique: jest.fn(async () => ({
          expires_at: new Date(Date.now() + 60_000),
          user: { id: user.id, status: 'active' },
        })),
      },
    };
    const providers = {
      snapshot: jest.fn(() => ({
        enabled: true,
        configured: true,
        revision: 'config',
        defaults: { provider: 'tencent', model: 'deepseek-v4', reasoning_effort: 'high' },
        providers: {},
        unreadable: [],
        broken: [],
      })),
    };
    const service = new HarnessRuntimeManagerService(
      paths as never,
      workspaces as never,
      settings as never,
      broker as never,
      prisma as never,
      providers as never,
    );
    return { service, broker, prisma, providers };
  }

  async function issue(service: HarnessRuntimeManagerService, token = 'user-token') {
    return service.issueHostTicket({
      user,
      project: 'clklogapp',
      userToken: token,
      tabId: 'tab_identifier_01',
    });
  }

  it('invalidates outstanding tickets and future launches for a logged-out token', async () => {
    const { service } = createService();
    const ticket = await issue(service);

    await service.closeToken(user.id, 'user-token');

    await expect(service.consumeHostTicket(ticket.ticket)).rejects.toThrow(
      'Harness 启动票据不存在或已过期',
    );
    await expect(issue(service)).rejects.toBeInstanceOf(UnauthorizedException);
    await service.onModuleDestroy();
  });

  it('blocks disabled users and allows a later explicit re-enable', async () => {
    const { service } = createService();

    await service.disableUser(user.id);
    await expect(issue(service, 'token-a')).rejects.toBeInstanceOf(UnauthorizedException);

    service.enableUser(user.id);
    await expect(issue(service, 'token-b')).resolves.toHaveProperty('ticket');
    await service.onModuleDestroy();
  });

  it('stops a runtime when its persisted login token is no longer valid', async () => {
    const { service, broker, prisma } = createService();
    const ticket = await issue(service);
    const runtime = await service.consumeHostTicket(ticket.ticket);
    prisma.saUserToken.findUnique.mockResolvedValueOnce(null as never);

    await expect(service.getAuthorizedRuntime(runtime.runtimeId)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(broker.stop).toHaveBeenCalledWith(runtime.runtimeId);
    await service.onModuleDestroy();
  });

  it('serializes rapid workspace switches and leaves the last selection active', async () => {
    const { service, broker } = createService();
    const firstTicket = await service.issueHostTicket({
      user,
      project: 'clklogapp',
      userToken: 'user-token',
      tabId: 'tab_identifier_01',
      workspaceId: 'aiw_one',
    });
    const secondTicket = await service.issueHostTicket({
      user,
      project: 'clklogapp',
      userToken: 'user-token',
      tabId: 'tab_identifier_01',
      workspaceId: 'aiw_two',
    });

    const [first, second] = await Promise.all([
      service.consumeHostTicket(firstTicket.ticket),
      service.consumeHostTicket(secondTicket.ticket),
    ]);

    expect(second.workspaceId).toBe('aiw_two');
    expect(second.runtimeId).not.toBe(first.runtimeId);
    expect(() => service.getRuntime(first.runtimeId)).toThrow('Harness Runtime 不存在或已回收');
    expect(broker.stop).toHaveBeenCalledWith(first.runtimeId);
    await service.onModuleDestroy();
  });

  it('fails closed when a mounted Workspace runtime cannot be stopped', async () => {
    const { service, broker } = createService();
    const ticket = await issue(service);
    const runtime = await service.consumeHostTicket(ticket.ticket);
    broker.stop.mockRejectedValueOnce(new Error('broker_stop_failed'));

    await expect(
      service.closeWorkspace(user.id, 'clklogapp', workspace.id),
    ).rejects.toThrow('broker_stop_failed');
    expect(service.getRuntime(runtime.runtimeId)).toBe(runtime);

    await service.onModuleDestroy();
  });

  it('关闭时对容器回收限时：broker.stop 卡住也不会拖过宽限（2026-09-18 事故）', async () => {
    const { service, broker } = createService();
    const ticket = await issue(service);
    await service.consumeHostTicket(ticket.ticket);
    // broker 回收容器永不返回：关闭流程必须在预算内结束，否则 supervisor 会 SIGKILL
    broker.stop.mockImplementation(() => new Promise(() => undefined));

    jest.useFakeTimers();
    try {
      const closing = service.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(4_000);
      await expect(closing).resolves.toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  it('供应商配置变更后复用路径先重建会话：惰性生效不打断旧会话', async () => {
    const { service, broker, providers } = createService();
    const ticket = await issue(service);
    const runtime = await service.consumeHostTicket(ticket.ticket);

    // 同一 tab 再次签发：配置未变 → 复用同一个 runtime（不重建）
    const stable = await service.consumeHostTicket((await issue(service)).ticket);
    expect(stable.runtimeId).toBe(runtime.runtimeId);
    expect(broker.stop).not.toHaveBeenCalled();

    providers.snapshot.mockReturnValue({
      ...providers.snapshot(),
      revision: '2.1700000000000',
    });
    const rebuilt = await service.consumeHostTicket((await issue(service)).ticket);

    expect(rebuilt.runtimeId).not.toBe(runtime.runtimeId);
    expect(rebuilt.configRevision).toBe('2.1700000000000');
    expect(broker.stop).toHaveBeenCalledWith(runtime.runtimeId);
    await service.onModuleDestroy();
  });

  it('立即应用：回收全部运行中会话并返回数量', async () => {
    const { service, broker } = createService();
    await service.consumeHostTicket((await issue(service)).ticket);
    expect(service.countRuntimes()).toBe(1);

    await expect(service.recycleAll()).resolves.toBe(1);

    expect(service.countRuntimes()).toBe(0);
    expect(broker.stop).toHaveBeenCalledTimes(1);
    await service.onModuleDestroy();
  });

  it('revives a dead runtime by calling broker.ensure with the same identity', async () => {
    const { service, broker } = createService();
    const ticket = await issue(service);
    const runtime = await service.consumeHostTicket(ticket.ticket);
    runtime.upstreamCookie = 'dsh-auth=stale';
    broker.ensure.mockClear();
    broker.ensure.mockResolvedValueOnce({
      runtime_id: runtime.runtimeId,
      socket_path: `/runtime/${runtime.runtimeId}/runtime.sock`,
      upstream_token: 'rotated-upstream-token',
    });

    const revived = await service.reviveRuntime(runtime.runtimeId);

    expect(revived.runtimeId).toBe(runtime.runtimeId);
    expect(revived.upstreamToken).toBe('rotated-upstream-token');
    expect(revived.upstreamCookie).toBeUndefined();
    expect(broker.ensure).toHaveBeenCalledTimes(1);
    expect(broker.ensure).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime_id: runtime.runtimeId,
        workspace_id: workspace.id,
        user_id: user.id,
        app_dir: '/app/clklogapp',
      }),
    );
    await service.onModuleDestroy();
  });
});
