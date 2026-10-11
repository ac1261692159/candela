import type { QueryColumn } from './chart.types';

export function result(
  columns: QueryColumn[],
  rows: Record<string, unknown>[],
): { columns: QueryColumn[]; rows: Record<string, unknown>[] } {
  return { columns, rows };
}

export const fxDayEventCount = result(
  [
    { name: 'day', type: 'DateTime' },
    { name: 'event_count', type: 'UInt64' },
  ],
  [
    { day: '2026-09-01 00:00:00', event_count: 10 },
    { day: '2026-09-03 00:00:00', event_count: 12 },
    { day: '2026-09-02 00:00:00', event_count: null },
  ],
);

export const fxHourCount = result(
  [
    { name: 'hour', type: 'DateTime' },
    { name: 'event_count', type: 'UInt64' },
  ],
  [
    { hour: '2026-09-01 01:00:00', event_count: 4 },
    { hour: '2026-09-01 02:00:00', event_count: 8 },
  ],
);

export const fxChineseMetrics = result(
  [
    { name: '日期', type: 'Date' },
    { name: '活跃用户数', type: 'UInt64' },
    { name: '发布次数', type: 'UInt64' },
    { name: '发布率_%', type: 'Float64' },
  ],
  [{ 日期: '2026-09-01', 活跃用户数: 100, 发布次数: 20, '发布率_%': 20 }],
);

export const fxCountryCount = result(
  [
    { name: 'country', type: 'String' },
    { name: 'event_count', type: 'UInt64' },
  ],
  Array.from({ length: 22 }, (_, index) => ({ country: `c${index}`, event_count: 22 - index })),
);

export const fxSceneUsers = result(
  [
    { name: '场景ID', type: 'String' },
    { name: '用户数', type: 'UInt64' },
  ],
  [
    { 场景ID: 's1', 用户数: 9 },
    { 场景ID: 's2', 用户数: 3 },
  ],
);

export const fxErrorCode = result(
  [
    { name: 'error_code', type: 'UInt32' },
    { name: '次数', type: 'UInt64' },
  ],
  [
    { error_code: 404, 次数: 5 },
    { error_code: 500, 次数: 2 },
  ],
);

export const fxSingleRowMetrics = result(
  [
    { name: 'UV', type: 'UInt64' },
    { name: 'PV', type: 'UInt64' },
    { name: '收入', type: 'Float64' },
  ],
  [{ UV: 10, PV: 40, 收入: 12.5 }],
);

export const fxWideFunnel = result(
  [
    { name: '1.加载开始UV', type: 'UInt64' },
    { name: '1.加载开始PV', type: 'UInt64' },
    { name: '2.加载成功UV', type: 'UInt64' },
    { name: '2.加载成功PV', type: 'UInt64' },
    { name: '3.进入房间UV', type: 'UInt64' },
    { name: '3.进入房间PV', type: 'UInt64' },
    { name: '4.退出房间UV', type: 'UInt64' },
    { name: '4.退出房间PV', type: 'UInt64' },
  ],
  [
    {
      '1.加载开始UV': 100,
      '1.加载开始PV': 200,
      '2.加载成功UV': 80,
      '2.加载成功PV': 160,
      '3.进入房间UV': 60,
      '3.进入房间PV': 120,
      '4.退出房间UV': 40,
      '4.退出房间PV': 80,
    },
  ],
);

export const fxPartyFunnel = result(
  [
    { name: '场景ID', type: 'String' },
    { name: '房间名称', type: 'String' },
    { name: '1.加载开始UV', type: 'UInt64' },
    { name: '2.加载成功UV', type: 'UInt64' },
    { name: '3.进入房间UV', type: 'UInt64' },
    { name: '4.退出房间UV', type: 'UInt64' },
    { name: '1.加载开始PV', type: 'UInt64' },
    { name: '2.加载成功PV', type: 'UInt64' },
    { name: '3.进入房间PV', type: 'UInt64' },
    { name: '4.退出房间PV', type: 'UInt64' },
  ],
  Array.from({ length: 50 }, (_, index) => ({
    场景ID: `scene_${index}`,
    房间名称: `房间${index}`,
    '1.加载开始UV': 100 - index,
    '2.加载成功UV': 80 - index,
    '3.进入房间UV': 60 - index,
    '4.退出房间UV': 40 - index,
    '1.加载开始PV': 200,
    '2.加载成功PV': 160,
    '3.进入房间PV': 120,
    '4.退出房间PV': 80,
  })),
);

export const fxNonMonotonic = result(
  [
    { name: '1.开始UV', type: 'UInt64' },
    { name: '2.中间UV', type: 'UInt64' },
    { name: '3.结束UV', type: 'UInt64' },
  ],
  [{ '1.开始UV': 10, '2.中间UV': 20, '3.结束UV': 5 }],
);

export const fxUnsafeAndNull = result(
  [
    { name: 'day', type: 'Date' },
    { name: 'amount', type: 'Decimal(18, 2)' },
    { name: 'big_id', type: 'UInt64' },
  ],
  [
    { day: '2026-09-01', amount: '12.50', big_id: '9007199254740993' },
    { day: '2026-09-02', amount: null, big_id: '1' },
  ],
);

export const fxDuplicateSeries = result(
  [
    { name: 'day', type: 'Date' },
    { name: 'os', type: 'String' },
    { name: 'event_count', type: 'UInt64' },
  ],
  [
    { day: '2026-09-01', os: 'ios', event_count: 1 },
    { day: '2026-09-01', os: 'ios', event_count: 2 },
  ],
);

export const fxRechargeDailyTrend = result(
  [
    { name: 'd', type: 'Date' },
    { name: '首充曝光UV', type: 'UInt64' },
    { name: '点击充值UV', type: 'UInt64' },
    { name: '支付成功UV', type: 'UInt64' },
    { name: '支付成功次数', type: 'UInt64' },
  ],
  [
    { d: '2026-08-27', 首充曝光UV: 1, 点击充值UV: 0, 支付成功UV: 0, 支付成功次数: 0 },
    { d: '2026-08-28', 首充曝光UV: 101, 点击充值UV: 19, 支付成功UV: 0, 支付成功次数: 0 },
  ],
);

export const fxOsUniq = result(
  [
    { name: 'os', type: 'String' },
    { name: 'uniq_users', type: 'UInt64' },
  ],
  [
    { os: 'ios', uniq_users: 10 },
    { os: 'android', uniq_users: 20 },
  ],
);

export const fxLegacyLine = { chart_type: 'line' };

export function manyRows(count: number) {
  return result(
    [
      { name: 'country', type: 'String' },
      { name: 'event_count', type: 'UInt64' },
    ],
    Array.from({ length: count }, (_, index) => ({ country: `r${index}`, event_count: index })),
  );
}
