/**
 * SlowQueryController 权限单测（phase: clklog-analytics-ops-console-v1，PRD AC2）。
 *
 * 运维面板仅平台超管可用。这里验证的是第二道闸（isAdmin 身份事实兜底）——
 * 第一道闸（RequirePermission）由 IamGuard 在 HTTP 层执行，单测不覆盖。
 */
jest.mock('../../src/config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
  },
}));

import { Test } from '@nestjs/testing';
import { DomainError } from '../../src/i18n/domain-error';
import { SlowQueryController } from '../../src/modules/ops/slow-query.controller';
import { SlowQueryService } from '../../src/modules/ops/slow-query.service';
import { ClickHouseService } from '../../src/modules/shared/clickhouse.service';
import type { AuthUser } from '../../src/modules/auth/auth.service';

const ADMIN = {
  id: 'admin',
  username: 'admin',
  display_name: null,
  platform_role: 'super_admin',
} as AuthUser;

const ANALYST = {
  id: 'u1',
  username: 'analyst',
  display_name: null,
  platform_role: 'none',
} as AuthUser;

describe('SlowQueryController 权限', () => {
  let controller: SlowQueryController;
  let clickhouse: { querySlowQueries: jest.Mock };

  beforeEach(async () => {
    clickhouse = { querySlowQueries: jest.fn().mockResolvedValue([]) };
    const moduleRef = await Test.createTestingModule({
      controllers: [SlowQueryController],
      providers: [SlowQueryService, { provide: ClickHouseService, useValue: clickhouse }],
    }).compile();
    controller = moduleRef.get(SlowQueryController);
  });

  it('超管可访问（AC1）', async () => {
    await expect(controller.list({}, ADMIN)).resolves.toBeDefined();
    expect(clickhouse.querySlowQueries).toHaveBeenCalled();
  });

  it('非超管一律拒绝（AC2）', () => {
    // controller.list 非 async，权限校验是同步抛出（HTTP 层由 Nest 捕获）
    let thrown: unknown;
    try {
      controller.list({}, ANALYST);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DomainError);
    expect(thrown).toMatchObject({ status: 403, errorCode: 'ops.admin.forbidden' });
    expect(clickhouse.querySlowQueries).not.toHaveBeenCalled();
  });
});
