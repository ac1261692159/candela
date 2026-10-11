// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { QualityReport } from './QualityReport';
import type { ReconcileReport } from '../../types/meta.types';

/** R1（phase: clklog-data-quality-ops-v1）：快照直读的事件级差异 / 已清理区间 / key 化展示名 */
function baseReport(overrides: Partial<ReconcileReport> = {}): ReconcileReport {
  return {
    range: { from: '2026-08-26', to: '2026-08-26' },
    threshold_pct: 3,
    trigger: 'auto',
    summary: {
      has_alert: false,
      total_days: 1,
      alert_days: 0,
      skipped_days: 0,
      dup_crc_rows: 0,
      crc_pass: true,
      recent_changes: 0,
      ignored_events: 0,
      skip_empty_event: true,
    },
    daily: {
      items: [
        {
          date: '2026-08-26',
          sa_cnt: 100,
          sa_uniq: 100,
          raw_cnt: 100,
          deviation_pct: 0,
          status: 'ok',
        },
      ],
      has_alert: false,
    },
    crc: { total: 100, uniq: 100, dup_rows: 0, pass: true },
    events: {
      sa_events: [],
      log_analysis: [],
      diffs: [],
      diff_total: 0,
      only_in_one: [],
      ignored_events: [],
    },
    skipped: [],
    discovery_logs: [],
    ...overrides,
  } as ReconcileReport;
}

describe('QualityReport（数据质量报告）', () => {
  it('已清理日：偏差列显示原因、状态列显示已跳过，且不显示为异常', () => {
    const report = baseReport({
      summary: { ...baseReport().summary, skipped_days: 1 },
      daily: {
        has_alert: false,
        items: [
          {
            date: '2026-08-26',
            sa_cnt: 0,
            sa_uniq: 0,
            raw_cnt: 100,
            deviation_pct: -100,
            status: 'skipped',
            skipped_reason: 'cleaned',
            skipped_source: 'drop_partition@2026-09-01T00:00:00',
          },
        ],
      },
      skipped: [
        {
          from: '2026-08-26',
          to: '2026-08-26',
          reason: 'cleaned',
          source: 'drop_partition@2026-09-01T00:00:00',
        },
      ],
    });
    render(<QualityReport report={report} loading={false} />);

    expect(screen.getByText('已跳过')).toBeTruthy();
    expect(screen.getByText('已清理天数')).toBeTruthy();
    // 已清理区间表：原因按 key 翻译，来源保留原始动作串
    expect(screen.getByText('已清理区间（不参与告警）')).toBeTruthy();
    expect(screen.getByText('drop_partition@2026-09-01T00:00:00')).toBeTruthy();
    expect(screen.queryByText('异常')).toBeNull();
  });

  it('事件级差异：Top 表带总数提示，仅一侧存在单独成表，忽略清单给提示', () => {
    const report = baseReport({
      events: {
        sa_events: [],
        log_analysis: [],
        diffs: [
          { event: 'android_gateway_error', sa_cnt: 38500, raw_cnt: 5813, diff: 32687, deviation_pct: 562.31 },
        ],
        diff_total: 12,
        only_in_one: [{ event: 'OnlyRaw', side: 'log_analysis', cnt: 7 }],
        ignored_events: ['base_network_socket_reconnect_start'],
      },
    });
    render(<QualityReport report={report} loading={false} />);

    expect(screen.getByText(/共 12 个事件计数不一致/)).toBeTruthy();
    expect(screen.getByText('android_gateway_error')).toBeTruthy();
    expect(screen.getByText('+32687')).toBeTruthy();
    expect(screen.getByText('仅一侧存在（对侧计数为 0）')).toBeTruthy();
    expect(screen.getByText('OnlyRaw')).toBeTruthy();
    expect(screen.getByText('已按忽略清单排除 1 个事件')).toBeTruthy();
    // 快照模式两侧全量清单为空：不渲染该表
    expect(screen.queryByText('事件级计数对照（sa_events vs log_analysis）')).toBeNull();
  });

  it('发现日志的变化类型走 change_key 翻译（服务端不再下发中文展示名）', () => {
    const report = baseReport({
      discovery_logs: [
        {
          id: '1',
          event: 'Buy',
          prop: 'amount',
          change_type: 'property_type_changed',
          change_key: 'propertyTypeChanged',
          from_value: 'string',
          to_value: 'number',
          created_at: '2026-08-26T10:00:00.000Z',
        },
      ],
    });
    render(<QualityReport report={report} loading={false} />);

    expect(screen.getByText('属性类型变更')).toBeTruthy();
    expect(screen.getByText('string → number')).toBeTruthy();
  });

  it('用户属性类变化：标签按白名单翻译，未知类型显示原始标识而不是键路径（生产缺陷回归）', () => {
    const report = baseReport({
      discovery_logs: [
        {
          id: '1',
          event: '__user_profile__',
          prop: 'mass_version',
          change_type: 'user_property_type_changed',
          change_key: 'userPropertyTypeChanged',
          from_value: 'string',
          to_value: 'number',
          created_at: '2026-10-09T02:17:40.000Z',
        },
        {
          id: '2',
          event: '__user_profile__',
          prop: 'funs_num',
          change_type: 'user_property_created',
          change_key: 'userPropertyCreated',
          from_value: null,
          to_value: 'number',
          created_at: '2026-10-09T02:17:40.000Z',
        },
        {
          id: '3',
          event: '__user_profile__',
          prop: 'legacy_flag',
          change_type: 'some_future_type',
          change_key: 'someFutureType',
          from_value: null,
          to_value: null,
          created_at: '2026-10-09T02:17:40.000Z',
        },
      ],
    });
    render(<QualityReport report={report} loading={false} />);

    expect(screen.getByText('用户属性类型变更')).toBeTruthy();
    expect(screen.getByText('string → number')).toBeTruthy();
    expect(screen.getByText('新增用户属性')).toBeTruthy();
    expect(screen.getByText('新用户属性 (number)')).toBeTruthy();
    // 未知类型：显示原始标识（不得出现 quality.changeType.* 这类原始键路径）
    // 标签列与内容列都会显示原始标识（各一处），不是键路径
    expect(screen.getAllByText('some_future_type').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/quality\.changeType\./)).toBeNull();
  });

  it('阈值按百分比单一语义展示（3% 而不是 300%）', () => {
    render(<QualityReport report={baseReport()} loading={false} />);
    expect(screen.getByText('3%')).toBeTruthy();
    expect(screen.getByText('偏差阈值')).toBeTruthy();
  });
});
