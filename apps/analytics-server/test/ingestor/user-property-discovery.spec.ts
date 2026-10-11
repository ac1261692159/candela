/**
 * UserPropertyDiscoveryService 单测。
 *
 * 验证：
 * - 从 user_set 提取属性登记（user_property_created）
 * - 类型变更检测（user_property_type_changed）
 * - user_unset 标记 hidden
 * - 去重窗口生效
 * - 只处理 user_set/set_once/signup，忽略 track 的事件属性
 */
// 顶层加载 YAML 配置的模块（clickhouse/card 服务等）在单测里隔离，CI 无密钥也能跑
jest.mock('../../src/config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    background_workers: true,
    __specConfigMock: true,
  },
}));

import { Test } from '@nestjs/testing';
import { UserPropertyDiscoveryService } from '../../src/modules/ingestor/user-property-discovery.service';
import { PrismaService } from '../../src/modules/shared/prisma.service';
import { RedisService } from '../../src/modules/shared/redis.service';
import { ParsedSensorsMessage, SensorsType } from '../../src/modules/ingestor/ingestor.types';

describe('UserPropertyDiscoveryService', () => {
  let service: UserPropertyDiscoveryService;
  let prisma: {
    metaUserProperty: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
    metaDiscoveryLog: { create: jest.Mock };
  };
  let redis: {
    sismember: jest.Mock;
    sadd: jest.Mock;
    expire: jest.Mock;
  };

  const msg = (
    over: Partial<{ type: SensorsType; project_name: string; properties: Record<string, unknown> }>,
  ): ParsedSensorsMessage =>
    ({
      type: 'user_set',
      project_name: 'clklogapp',
      distinct_id: 'u1',
      user_key: '',
      event: '',
      crc: 'test-crc',
      time: Date.now(),
      properties: {},
      ...over,
    }) as ParsedSensorsMessage;

  beforeEach(async () => {
    prisma = {
      metaUserProperty: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      metaDiscoveryLog: { create: jest.fn().mockResolvedValue({}) },
    };
    redis = {
      sismember: jest.fn().mockResolvedValue(false), // 默认不在去重窗口内
      sadd: jest.fn().mockResolvedValue(undefined),
      expire: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        UserPropertyDiscoveryService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();

    service = moduleRef.get(UserPropertyDiscoveryService);
  });

  it('从 user_set 提取新属性并登记 + 审计', async () => {
    prisma.metaUserProperty.findUnique.mockResolvedValue(null);

    await service.discover(msg({ type: 'user_set', properties: { phone: '13800000000', age: 30 } }));

    expect(prisma.metaUserProperty.create).toHaveBeenCalledTimes(2);
    expect(prisma.metaUserProperty.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ prop_key: 'phone', data_type: 'string', status: 'pending' }),
      }),
    );
    expect(prisma.metaDiscoveryLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ change_type: 'user_property_created', prop_key: 'phone' }),
      }),
    );
    // 去重键写入
    expect(redis.sadd).toHaveBeenCalledWith('discovery:userprop:clklogapp:phone', 'phone');
    expect(redis.expire).toHaveBeenCalled();
  });

  it('类型变更时更新并审计', async () => {
    prisma.metaUserProperty.findUnique.mockResolvedValue({
      id: 'p1',
      data_type: 'string',
      status: 'active',
    });

    await service.discover(msg({ type: 'user_set', properties: { age: 30 } }));

    expect(prisma.metaUserProperty.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'p1' },
        data: expect.objectContaining({ data_type: 'number' }),
      }),
    );
    expect(prisma.metaDiscoveryLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          change_type: 'user_property_type_changed',
          from_value: 'string',
          to_value: 'number',
        }),
      }),
    );
  });

  it('user_unset 标记 hidden', async () => {
    prisma.metaUserProperty.findUnique.mockResolvedValue({
      id: 'p1',
      status: 'active',
    });

    await service.discover(msg({ type: 'user_unset', properties: { phone: null } }));

    expect(prisma.metaUserProperty.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'p1' },
        data: expect.objectContaining({ status: 'hidden' }),
      }),
    );
    expect(prisma.metaDiscoveryLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ change_type: 'user_property_hidden', from_value: 'active', to_value: 'hidden' }),
      }),
    );
  });

  it('去重窗口内不重复登记', async () => {
    redis.sismember.mockResolvedValue(true); // 已在窗口内
    prisma.metaUserProperty.findUnique.mockResolvedValue(null);

    await service.discover(msg({ type: 'user_set', properties: { phone: 'x' } }));

    expect(prisma.metaUserProperty.create).not.toHaveBeenCalled();
    expect(prisma.metaDiscoveryLog.create).not.toHaveBeenCalled();
  });

  it('track 消息不触发用户属性登记', async () => {
    prisma.metaUserProperty.findUnique.mockResolvedValue(null);

    await service.discover(msg({ type: 'track', properties: { page: '/home' } }));

    expect(prisma.metaUserProperty.create).not.toHaveBeenCalled();
  });
});
