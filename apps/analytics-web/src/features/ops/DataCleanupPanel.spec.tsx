// @vitest-environment jsdom
/**
 * 定点删除面板（phase: clklog-data-management-v1.2）。
 * 覆盖：未登记事件渲染与「按此事件清理」预填、预演结果展示、执行按钮的二次确认门禁、
 * 清洗账号未配置时的显式提示。
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DataCleanupPanel } from './DataCleanupPanel';

const unregistered = {
  project: 'clklogapp',
  window_days: 30,
  window_from: '2026-09-10',
  data_events: 496,
  registered_events: 498,
  unregistered: [
    { event: '$SignUp', rows: 448923, min_date: '2026-07-28', max_date: '2026-11-08', has_future: true },
    { event: '$undefined', rows: 2, min_date: '2026-07-30', max_date: '2026-07-30', has_future: false },
  ],
  ghost_registered: ['zz_cleanup_probe'],
  truncated: false,
};

const previewOk = {
  table: 'clklog_sa.sa_events',
  plan_summary: 'kind=future|...',
  rows: 448923,
  min_date: '2026-07-28',
  max_date: '2026-11-08',
  samples: [],
  max_rows: 5_000_000,
  max_rows_exceeded: false,
  backup_table: 'clklog_sa_bak.sa_events_20261009140000',
  cleanup_enabled: true,
  preflight: { ok: true, reason: 'ok', required_to: '2026-10-09', snapshot_id: '10', range: { from: '2026-10-08', to: '2026-10-08' }, age_hours: 1 },
  confirm_token: 'token-1',
};

vi.mock('../../services/ops.service', () => ({
  getUnregisteredEvents: vi.fn(async () => unregistered),
  deletePreview: vi.fn(async () => previewOk),
  deleteExecute: vi.fn(async () => ({ table: 'clklog_sa.sa_events', rows_planned: 448923, backup_table: 'clklog_sa_bak.x', mode: 'alter_delete', mutation_id: '99', ledger_id: '7' })),
}));

describe('DataCleanupPanel', () => {
  it('列出未登记事件与幽灵登记，并对含未来日期的事件给出「清理未来日期」', async () => {
    render(<DataCleanupPanel />);
    expect(await screen.findByText('$SignUp')).toBeTruthy();
    expect(screen.getByText('$undefined')).toBeTruthy();
    expect(screen.getByText('清理未来日期')).toBeTruthy(); // has_future → future 条件
    expect(screen.getByText('按此事件清理')).toBeTruthy(); // 非未来 → event 条件
    expect(screen.getByText(/另有 1 个幽灵登记/)).toBeTruthy();
  });

  it('预演后展示影响面与备份表；未输入正确表名时执行按钮禁用', async () => {
    render(<DataCleanupPanel />);
    await screen.findByText('$SignUp');
    // 先点行内动作：$SignUp 含未来日期 → 预填「未来时间戳」条件（此时预演按钮才可用）
    screen.getAllByRole('button', { name: '清理未来日期' })[0].click();
    await waitFor(() => {
      const btn = screen.getAllByRole('button', { name: /预\s*演/ })[0] as HTMLButtonElement;
      expect(btn.disabled).toBe(false); // 行内动作预填条件后，预演才可用
    });
    screen.getAllByRole('button', { name: /预\s*演/ })[0].click();
    // Alert 文案节点可能被拆成多段，用函数匹配（只断言关键片段）
    expect(await screen.findByText((c) => c.includes('预计影响 448923 行'))).toBeTruthy();
    expect(screen.getByText((c) => c.includes('clklog_sa_bak.sa_events_20261009140000'))).toBeTruthy();
    const exec = screen.getByRole('button', { name: /执行删除/ }) as HTMLButtonElement;
    expect(exec.disabled).toBe(true); // 未输入表名 → 禁用
  });

  it('清洗账号未配置时显式提示且不可执行', async () => {
    const svc = await import('../../services/ops.service');
    (svc.deletePreview as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ...previewOk, cleanup_enabled: false });
    render(<DataCleanupPanel />);
    await screen.findByText('$SignUp');
    screen.getAllByRole('button', { name: '清理未来日期' })[0].click();
    await waitFor(() => {
      const btn = screen.getAllByRole('button', { name: /预\s*演/ })[0] as HTMLButtonElement;
      expect(btn.disabled).toBe(false); // 行内动作预填条件后，预演才可用
    });
    screen.getAllByRole('button', { name: /预\s*演/ })[0].click();
    expect(await screen.findByText((c) => c.includes('清洗账号未配置'))).toBeTruthy();
    await waitFor(() => {
      const exec = screen.getByRole('button', { name: /执行删除/ }) as HTMLButtonElement;
      expect(exec.disabled).toBe(true);
    });
  });
});
