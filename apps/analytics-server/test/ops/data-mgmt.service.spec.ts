/**
 * DataMgmtService 纯函数单测（数据管理 V1.1 清理执行防线）。
 */
// data-mgmt.service → clickhouse.service 顶层会加载 YAML 配置（需要 APP_CONFIG_PATH
// 与真实密钥，CI 里都没有），单测里隔离掉——与 test/ops/slow-query.*.spec.ts 同款处理。
jest.mock('../../src/config/configuration', () => ({
  appConfig: {
    query: { maxExecutionTime: 30, maxResultRows: 100_000, defaultGroupLimit: 20 },
    log: { level: 'info', slowQueryThresholdMs: 5000 },
    __specConfigMock: true,
  },
}));

import { filterDropCandidates, parseTtlDays } from '../../src/modules/ops/data-mgmt.service';
import { appConfig } from '../../src/config/configuration';

describe('filterDropCandidates', () => {
  const CURRENT = '202609';

  it('配置模块已隔离（CI 无 APP_CONFIG_PATH 与密钥也能跑）', () => {
    expect((appConfig as unknown as Record<string, unknown>).__specConfigMock).toBe(true);
  });

  it('放行格式正确的过去分区', () => {
    const r = filterDropCandidates(['202608', '202607', '202510'], CURRENT);
    expect(r.accepted).toEqual(['202608', '202607', '202510']);
    expect(r.rejected).toHaveLength(0);
  });

  it('拒绝当前月分区（正在写入）', () => {
    const r = filterDropCandidates(['202609'], CURRENT);
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected[0].reason).toContain('正在写入');
  });

  it('拒绝未来分区', () => {
    const r = filterDropCandidates(['202610', '202701'], CURRENT);
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected.every((x) => x.reason === '未来分区')).toBe(true);
  });

  it('拒绝非 YYYYMM 格式（含恶意/脏值）', () => {
    const r = filterDropCandidates(["202608') --", 'abc', '2026-08', ''], CURRENT);
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected.every((x) => x.reason === '分区名非 YYYYMM 格式')).toBe(true);
  });

  it('混合清单：只放行合法者', () => {
    const r = filterDropCandidates(['202608', '202609', '202612'], CURRENT);
    expect(r.accepted).toEqual(['202608']);
    expect(r.rejected).toHaveLength(2);
  });
});

describe('parseTtlDays', () => {
  it('解析 TTL INTERVAL DAY（数字带引号/不带引号）', () => {
    expect(parseTtlDays("MergeTree TTL log_time + TO INTERVAL '180' DAY")).toBe(180);
    expect(parseTtlDays('MergeTree TTL stat_date + TO INTERVAL 90 DAY')).toBe(90);
  });

  it('无 TTL 返回 null', () => {
    expect(parseTtlDays('MergeTree ORDER BY event')).toBeNull();
    // 非 DAY 单位不误报
    expect(parseTtlDays("MergeTree TTL ts + TO INTERVAL '6' MONTH")).toBeNull();
  });
});
