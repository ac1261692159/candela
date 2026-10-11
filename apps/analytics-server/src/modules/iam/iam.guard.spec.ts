import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IamGuard } from './iam.guard';
import { IAM_KEY } from './current-iam.decorator';
import { USER_KEY } from '../../common/decorators/current-user.decorator';
import { emptyIam } from './iam.types';
import { REQUIRE_PERMISSION_KEY } from './require-permission';
import { DomainError } from '../../i18n/domain-error';
import type { IamService } from './iam.service';

function mockContext(request: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => request }),
  } as ExecutionContext;
}

describe('IamGuard', () => {
  const iam = {
    evaluate: jest.fn(),
  } as unknown as IamService;

  it('fills empty IAM when auth has not injected a user yet', async () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) } as unknown as Reflector;
    const guard = new IamGuard(reflector, iam);
    const request: Record<string, unknown> = {};
    await expect(guard.canActivate(mockContext(request))).resolves.toBe(true);
    expect(request[IAM_KEY]).toEqual(emptyIam());
    expect(iam.evaluate).not.toHaveBeenCalled();
  });

  it('evaluates after AuthGuard injected the user', async () => {
    const reflector = {
      getAllAndOverride: jest.fn((key: string) => (key === REQUIRE_PERMISSION_KEY ? ['model.card_save'] : undefined)),
    } as unknown as Reflector;
    const ctx = {
      platform_role: 'super_admin',
      member: true,
      role_key: 'project_owner',
      permissions: new Set(['model.card_save', 'dashboard.view']),
      data_scope: emptyIam().data_scope,
      group_ids: [],
    };
    (iam.evaluate as jest.Mock).mockResolvedValue(ctx);
    const guard = new IamGuard(reflector, iam);
    const request: Record<string, unknown> = {
      [USER_KEY]: { id: 'u1', username: 'admin' },
      headers: { 'x-project-name': 'clklogapp' },
      query: {},
    };
    await expect(guard.canActivate(mockContext(request))).resolves.toBe(true);
    expect(iam.evaluate).toHaveBeenCalledWith('u1', 'clklogapp');
    expect(request[IAM_KEY]).toBe(ctx);
  });

  it('rejects missing permission codes', async () => {
    const reflector = {
      getAllAndOverride: jest.fn((key: string) => (key === REQUIRE_PERMISSION_KEY ? ['model.card_save'] : undefined)),
    } as unknown as Reflector;
    (iam.evaluate as jest.Mock).mockResolvedValue({
      ...emptyIam(),
      platform_role: 'super_admin',
      permissions: new Set(['ops.owner.assign']),
    });
    const guard = new IamGuard(reflector, iam);
    const request: Record<string, unknown> = {
      [USER_KEY]: { id: 'u1', username: 'admin' },
      headers: {},
      query: {},
    };
    const rejected = guard.canActivate(mockContext(request));
    await expect(rejected).rejects.toBeInstanceOf(DomainError);
    await expect(rejected).rejects.toMatchObject({ errorCode: 'iam.forbidden', status: 403 });
  });
});
