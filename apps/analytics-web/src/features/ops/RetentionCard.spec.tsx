// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RetentionCard } from './RetentionCard';
import type { RetentionOverviewView } from '../../services/ops.service';

/**
 * R2（phase: clklog-data-quality-ops-v1）AC-6：
 * 保留策略区必须能标出「未设置（风险）」、显示 540 天 TTL、并给出对拍可信区间数值。
 */
const overview = (overrides: Partial<RetentionOverviewView> = {}): RetentionOverviewView => ({
  rows: [
    {
      table: 'clklog_sa.sa_events',
      expected_days: 540,
      registered: false,
      mode: 'ttl',
      enabled: true,
      remark: null,
      updated_by: null,
      updated_at: null,
      actual_ttl_days: 540,
      status: 'ok',
      rows: 100,
      compressed_bytes: 1000,
      partitions: 18,
    },
    {
      table: 'clklog.log_analysis',
      expected_days: 180,
      registered: false,
      mode: 'ttl',
      enabled: true,
      remark: null,
      updated_by: null,
      updated_at: null,
      actual_ttl_days: null,
      status: 'unset',
      rows: 900,
      compressed_bytes: 9000,
      partitions: 90,
    },
  ],
  trusted_range: {
    from: '2025-04-14',
    to: '2026-10-08',
    retention_days: 540,
    sa_days: 540,
    raw_days: null,
    bound_by: 'clklog_sa.sa_events',
  },
  summary: { total: 2, unset: 1, deviates: 0, raw_unset: 1, suspicious_partitions: [] },
  ...overrides,
});

vi.mock('../../services/ops.service', () => ({
  getRetentionOverview: vi.fn(async () => overview()),
  saveRetentionPolicy: vi.fn(async () => ({})),
}));

describe('RetentionCard（保留策略总览）', () => {
  it('标出未设置 TTL 的社区版表为风险，并给出可信区间数值', async () => {
    render(<RetentionCard />);

    expect(await screen.findByText('clklog.log_analysis')).toBeTruthy();
    // 未设置（风险）：实际保留列 + 状态列各一处
    expect(screen.getAllByText('未设置（风险）').length).toBeGreaterThanOrEqual(2);
    // 预期列与实际列各一处 540 天
    expect(screen.getAllByText('540 天').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/对拍可信区间：2025-04-14 ~ 2026-10-08/)).toBeTruthy();
    expect(screen.getByText(/两侧保留期的较小者 = 540 天/)).toBeTruthy();
  });

  it('可疑日期分区（未来 / 历史脏数据）单独提示，且不声称会自动清理', async () => {
    const { getRetentionOverview } = await import('../../services/ops.service');
    (getRetentionOverview as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      overview({
        summary: {
          total: 2,
          unset: 1,
          deviates: 0,
          raw_unset: 1,
          suspicious_partitions: [
            { table: 'clklog.log_analysis', partition: '201903', kind: 'ancient', rows: 12 },
            { table: 'clklog.log_analysis', partition: '202709', kind: 'future', rows: 3 },
          ],
        },
      }),
    );
    render(<RetentionCard />);

    expect(await screen.findByText('发现 2 个可疑日期分区（未来分区 / 早于可信区间的历史脏数据）；默认只提示，不自动清理')).toBeTruthy();
    expect(screen.getByText(/201903 历史脏数据/)).toBeTruthy();
    expect(screen.getByText(/202709 未来分区/)).toBeTruthy();
  });
});
