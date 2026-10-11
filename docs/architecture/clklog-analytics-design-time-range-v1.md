# 架构：分析时间范围（静态 / 动态）

> phase: clklog-analytics-time-range-v1
> 帽子：架构（`docs/architecture/`）
> 产品：[PRD](../product/prd-clklog-analytics-time-range-v1.md)
> 既有 DSL 见 `clklog-analytics-design.md` §7；SQL 守卫见 `clklog-analytics-design-sql-report.md`。

---

## 1. 阶段目标、范围与验收

在 `TimeRange` 上增加可选 `relative`。查询与 SQL 执行前按 Asia/Shanghai 解析为 `start/end`，SQL 生成器与 ClickHouse 守卫仍只看日期字符串。前端事件 / 漏斗 / 留存 / 自定义 SQL 共用同一选择器。

验收对齐 PRD SC-1～SC-7。非目标同 PRD（不做 VS 对比）。

## 2. 契约

```ts
type TimeRangeRelativeKind =
  | 'today' | 'yesterday'
  | 'this_week' | 'last_week' | 'this_month' | 'last_month'
  | 'past_n' | 'recent_n'
  | 'from_date_to_yesterday' | 'from_date_to_today'
  | 'custom_offsets';

interface TimeRangeRelative {
  kind: TimeRangeRelativeKind;
  n?: number;              // past_n / recent_n，1..366
  from_offset?: number;    // custom_offsets，0 = 今天
  to_offset?: number;
  anchor_start?: string;   // from_date_*，YYYY-MM-DD
}

interface TimeRange {
  start: string;           // 最近一次解析快照，YYYY-MM-DD
  end: string;
  relative?: TimeRangeRelative; // 缺省 = 静态，旧卡片兼容
  compare?: 'none' | 'last_period' | 'last_year' | 'custom'; // 本期不实现
}
```

缺 `relative`：行为与现在相同，起止日不再滚动。

有 `relative`：服务端在 `DslValidatorService.validateTimeRange` 与 `SqlReportService.normalizeRange` **覆盖** `start/end` 后再生成 SQL / 做 90 天上限。卡片缓存 worker 走同一 `analyze` / `executeFromCardDsl`，故看板刷新会滚动态窗。

默认新查询：`{ relative: { kind: 'past_n', n: 7 } }`，解析后写入快照 `start/end`。

解析表（`today` = 上海当天）：

| kind | start | end |
|------|-------|-----|
| today | today | today |
| yesterday | today-1 | today-1 |
| past_n | today-n | today-1 |
| recent_n | today-(n-1) | today |
| this_week | 本周一 | today |
| last_week | 上周一 | 上周日 |
| this_month | 本月1日 | today |
| last_month | 上月1日 | 上月最后一日 |
| from_date_to_yesterday | anchor_start | today-1 |
| from_date_to_today | anchor_start | today |
| custom_offsets | today-from_offset | today-to_offset |

周一起点按中国习惯（周一=周首）。`n`、偏移上限 366。`from_offset >= to_offset`。解析后 `start > end` 拒绝。

自定义 SQL：解析后跨度沿用现有 `normalizeRange`（日差 > 90 拒绝）。缺省时间范围改为过去 7 天（不再用服务器本地 `Date` 减 7 天，避免 UTC 切日错位）。

## 3. 代码落点

| 层 | 路径 | 职责 |
|----|------|------|
| 解析（服务端） | `apps/analytics-server/src/modules/query/time-range.ts` | 上海日历、resolve、默认过去 7 天 |
| 解析（前端） | `apps/analytics-web/src/features/time-range/resolve.ts` | 同口径副本，禁止抽 `common`/`utils` 杂包 |
| 选择器 | `apps/analytics-web/src/features/time-range/` | 数数风面板；`AnalysisToolbar` 与 SQL 顶栏接入 |
| 校验 | `dsl-validator.service.ts` | 有 `relative` 则先 resolve 再校验日期 |
| SQL | `sql-report.service.ts` + `dto/time-range.dto.ts` | DTO 带 `relative`（ValidationPipe whitelist）；`timeRangeFromDsl` 原样带回 |
| 类型 | 前后端 `dsl.types.ts` 的 `TimeRange` | 增加 `relative?` |

查询 SQL 生成器不改：只消费 resolve 后的 `start/end`。

## 4. 前端行为

- 触发器：有 `relative` 显示预设名（「过去7天」）；静态显示斜杠日期。
- 执行 / 保存前 `materializeTimeRange`，保证过夜未关页时仍按当天解析。
- 打开带 `relative` 的卡片：保留 kind，按当天重算快照再填入工具条。
- 打开无 `relative` 的卡片：日期原样，静态。

## 5. 测试

- 服务端 / 前端 resolve 矩阵：过去 vs 最近、周/月、自某日、静态透传、非法偏移。
- 校验：仅 relative 可解析；非法 kind 400。
- SQL normalize：缺省过去 7 天；超 90 天拒绝。
- 选择器：应用「最近7天」写出 `recent_n`；应用静态后无 `relative`。
