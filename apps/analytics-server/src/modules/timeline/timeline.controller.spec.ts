/**
 * 用户行为序列控制器：两段式（快路径 / 超预算转后台）与留档开关（phase: clklog-analytics-user-timeline-v1）。
 *
 * 顶部 mock appConfig：import 链会拉到 clickhouse.service → configuration（CI 空环境会抛）。
 */
jest.mock('../../config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    background_workers: true,
    __specConfigMock: true,
  },
}));

import { TimelineController } from './timeline.controller';
import { DomainError } from '../../i18n/domain-error';
import type { AuthUser } from '../auth/auth.service';
import { emptyIam } from '../iam/iam.types';

const USER = { id: 'u-1', username: 'analyst1', display_name: null, platform_role: 'none' } as AuthUser;
const DTO = { value: '1_13543144', from: '2026-10-08 12:00', to: '2026-10-08 18:00' };
const SPEC = { value: '1_13543144', from: DTO.from, to: DTO.to, order: 'desc' as const, limit: 500 };
const SUMMARY = {
  matched_total: 18489,
  shown_total: 2,
  event_kinds: 23,
  first_log_time: 'a',
  last_log_time: 'b',
  truncated: false,
};

function build() {
  const overview = { daily: [{ date: '2026-10-08', count: 3 }], events: [{ event: 'open_ui2', count: 3 }] };
  const service = {
    normalize: jest.fn().mockReturnValue(SPEC),
    query: jest.fn().mockResolvedValue({ items: [{ log_time: 'x' }], summary: SUMMARY }),
    overview: jest.fn().mockResolvedValue(overview),
    profile: jest.fn(),
  };
  const records = {
    archiveSuccess: jest.fn().mockResolvedValue({ archived: true, record_id: 'rec-1' }),
    enqueue: jest.fn().mockResolvedValue({ record_id: 'rec-job', reused: false }),
    list: jest.fn(),
    detail: jest.fn(),
    remove: jest.fn(),
  };
  const archiveSwitch = { isEnabled: jest.fn().mockResolvedValue(true) };
  const controller = new TimelineController(service as never, records as never, archiveSwitch as never);
  return { controller, service, records, archiveSwitch };
}

describe('TimelineController 快路径', () => {
  it('查询成功 → 返回明细 + 汇总 + 留档，且带同步预算', async () => {
    const { controller, service, records } = build();

    const response = await controller.query('clklogapp', USER, DTO);

    expect(service.query).toHaveBeenCalledWith(SPEC, 'clklogapp', { maxExecutionTime: expect.any(Number) });
    expect(records.archiveSuccess).toHaveBeenCalledWith(
      expect.objectContaining({ project: 'clklogapp', user: USER, spec: SPEC, summary: SUMMARY }),
    );
    expect(response).toMatchObject({
      overview: { daily: [{ date: '2026-10-08', count: 3 }] },
      items: [{ log_time: 'x' }],
      matched_total: 18489,
      archived: true,
      record_id: 'rec-1',
    });
  });

  it('项目关闭留档 → 不落档但结果照常返回', async () => {
    const { controller, records, archiveSwitch } = build();
    archiveSwitch.isEnabled.mockResolvedValue(false);

    const response = await controller.query('clklogapp', USER, DTO);

    expect(records.archiveSuccess).not.toHaveBeenCalled();
    expect(response).toMatchObject({ archived: false, archive_disabled: true, matched_total: 18489 });
  });
});

describe('TimelineController 超预算转后台', () => {
  const timeout = () =>
    new DomainError(504 as never, { code: 'timeline.queryTimeout', messageKey: 'analysis:error.timeline.queryTimeout' });

  it('超时 → 登记任务并返回 running', async () => {
    const { controller, service, records } = build();
    service.query.mockRejectedValue(timeout());

    await expect(controller.query('clklogapp', USER, DTO)).resolves.toMatchObject({
      // 概览先行：转后台也先给图
      overview: { daily: [{ date: '2026-10-08', count: 3 }], events: [{ event: 'open_ui2', count: 3 }] },
      status: 'running',
      record_id: 'rec-job',
      reused: false,
    });
    expect(records.enqueue).toHaveBeenCalledWith({ project: 'clklogapp', user: USER, spec: SPEC });
  });

  it('关闭留档时不转后台（任务本身就是记录，关了不留痕）', async () => {
    const { controller, service, records, archiveSwitch } = build();
    service.query.mockRejectedValue(timeout());
    archiveSwitch.isEnabled.mockResolvedValue(false);

    await expect(controller.query('clklogapp', USER, DTO)).rejects.toMatchObject({ errorCode: 'timeline.queryTimeout' });
    expect(records.enqueue).not.toHaveBeenCalled();
  });

  it('非超时错误照旧抛出（不转后台）', async () => {
    const { controller, service, records } = build();
    service.query.mockRejectedValue(
      new DomainError(500 as never, { code: 'timeline.queryFailed', messageKey: 'analysis:error.timeline.queryFailed' }),
    );

    await expect(controller.query('clklogapp', USER, DTO)).rejects.toMatchObject({ errorCode: 'timeline.queryFailed' });
    expect(records.enqueue).not.toHaveBeenCalled();
  });
});

describe('TimelineController 记录接口', () => {
  it('画像端点转发到 service.profile（带标识口径，供按属性查时回报解析结果）', async () => {
    const { controller, service } = build();
    service.profile.mockResolvedValue({ attributes: {}, tags: [] });

    await expect(controller.profile('clklogapp', '1_1', undefined, undefined)).resolves.toEqual({
      attributes: {},
      tags: [],
    });
    expect(service.profile).toHaveBeenCalledWith({ value: '1_1', id_kind: undefined, id_key: undefined }, 'clklogapp');

    await controller.profile('clklogapp', 'YYZ000014552557', 'user_property', 'massid');
    expect(service.profile).toHaveBeenLastCalledWith(
      { value: 'YYZ000014552557', id_kind: 'user_property', id_key: 'massid' },
      'clklogapp',
    );
  });

  it('列表 / 详情 / 删除转发到记录服务', async () => {
    const { controller, records } = build();

    await controller.list('clklogapp', '2', '50');
    await controller.detail('clklogapp', 'rec-1');
    await controller.remove('clklogapp', USER, emptyIam(), 'rec-1');

    expect(records.list).toHaveBeenCalledWith('clklogapp', 2, 50);
    expect(records.detail).toHaveBeenCalledWith('clklogapp', 'rec-1');
    expect(records.remove).toHaveBeenCalledWith('clklogapp', 'rec-1', USER, expect.anything());
  });
});
