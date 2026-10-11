import { useState } from 'react';
import { Alert, Switch, Table, Button, Space, Tooltip, Typography } from 'antd';
import { QuestionCircleOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { QueryColumn } from '../types/dsl.types';
import { useT } from '../i18n';
import { BRAND_PRIMARY } from '../styles/tokens';
import { formatNumber, formatDateTime, formatDurationSec, formatPercent } from '../i18n/format';
import { mappedText } from '../features/query/result-csv';
import { localizedColumnTitle, localizedStageCellValue } from '../features/query/column-titles';
import { parseWallClock } from '../features/time-range/resolve';

/**
 * 时间列渲染：ClickHouse 的 naïve 墙钟串（'YYYY-MM-DD HH:mm:ss'）按**平台时区**还原成真实时刻
 * 再渲染（与 Debug 页同口径，phase: clklog-analytics-debug-query-v1）；ISO/其它形态保持原行为。
 */
function renderTimeCell(value: string): string {
  const at = parseWallClock(value);
  return at ? formatDateTime(at) : formatDateTime(value);
}

/**
 * 列宽统一策略（AGENTS.md G.29「长语言不得溢出」）：
 *
 * - **只给下限，不给「按中文算」的定宽**：下限按**最长语言**估宽（俄 ≈ 中文 ×2.2、德 ≈ ×2.0、越/泰 ≈ ×2.0），
 *   列可以自适应增长，容器不够时由 `scroll.x` 出横滚，不把译文/用户数据压成一字一列；
 * - 列一律带 `ellipsis: { showTitle: true }`：真被容器夹住时省略号截断 + 悬停看全称，
 *   不会溢出格线、也不会切半个字（红线见 AGENTS_front.md）；
 * - 表头额外由 `onHeaderCell` 补 `title`：表头是 ReactNode（含小问号提示），
 *   rc-table 无法自动推导标题串，长语言下必须自己兜底，否则截断了没法看全称。
 */
function minWidthForColumn(col: QueryColumn): number {
  // 时间列判定与下方单元格渲染同一启发式（'时间'），此处不改该判定，只复用其口径
  if (col.title.includes('时间')) return 176;
  if (col.unit === 'duration_sec' || col.unit === 'percent') return 112;
  if (col.value_map && Object.keys(col.value_map).length > 0) return 160;
  // 维度列 / 用户数据列（事件名、属性值、阶段汇总）：留够俄/德标签与长标识
  return 144;
}

interface DataTableProps {
  columns: QueryColumn[];
  rows: Record<string, unknown>[];
  durationPlain?: boolean;
  userCountKeys?: string[];
  onUserCountClick?: (columnKey: string, row: Record<string, unknown>) => void;
}

export function DataTable({
  columns,
  rows,
  durationPlain = false,
  userCountKeys = [],
  onUserCountClick,
}: DataTableProps) {
  const { t } = useT();
  const [showRaw, setShowRaw] = useState(false);
  const countKeys = new Set(userCountKeys);
  const hasMap = columns.some((col) => col.value_map && Object.keys(col.value_map).length > 0);
  const truncated = columns.some((col) => col.value_map_stats?.truncated);
  const tableColumns: ColumnsType<Record<string, unknown>> = columns.map((col) => {
    // 表头按查看者语言渲染（服务端固定文案列名带 title_key）；
    // 下面的时间列启发式仍读 col.title 的**服务端中文原值**，故不在此处改写 col。
    const displayTitle = localizedColumnTitle(col, t);
    const sampled = col.value_map_stats?.sampled ?? 0;
    const matched = col.value_map_stats?.matched ?? 0;
    const percent = sampled > 0 ? Math.round((matched / sampled) * 100) : 0;
    const hint =
      matched > 0
        ? t('common:dataTable.mappedHint', {
            title: col.value_map_title ?? '',
            matched,
            sampled,
            percent,
          })
        : t('common:dataTable.mappedMissHint', { title: col.value_map_title ?? '', sampled });
    const hasHint = sampled > 0 || Boolean(col.value_map_title);
    // 表头纯文本：既用于渲染，也用于 onHeaderCell 的 title（长语言被夹住时悬停看全称）
    const headerText =
      matched > 0 && col.value_map_title && !showRaw
        ? t('common:dataTable.mappedColumn', { column: displayTitle, title: col.value_map_title })
        : displayTitle;
    return {
      title: hasHint ? (
        <Space size={4}>
          {/* 标题文字自身可省略（悬停由 th 的 title 兜底），但小问号提示必须留在格里不被裁掉 */}
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{headerText}</span>
          <Tooltip title={hint}>
            <QuestionCircleOutlined
              style={{
                color: matched > 0 ? 'rgba(0, 0, 0, 0.45)' : '#faad14',
                cursor: 'help',
                flexShrink: 0,
              }}
            />
          </Tooltip>
        </Space>
      ) : (
        displayTitle
      ),
      dataIndex: col.key,
      key: col.key,
      minWidth: minWidthForColumn(col),
      ellipsis: { showTitle: true },
      onHeaderCell: () => ({ title: headerText }),
      sorter: (a, b) => {
      if (col.value_map && !showRaw) {
        const al = mappedText(col, a[col.key]);
        const bl = mappedText(col, b[col.key]);
        return al.localeCompare(bl, 'zh-CN');
      }
      const av = Number(a[col.key] ?? 0);
      const bv = Number(b[col.key] ?? 0);
      if (!Number.isNaN(av) && !Number.isNaN(bv)) return av - bv;
      return String(a[col.key]).localeCompare(String(b[col.key]));
    },
    render: (v: unknown, row) => {
      if (v === null || v === undefined) return '—';
      const mapped = showRaw ? undefined : col.value_map?.[String(v)];
      if (mapped !== undefined) {
        return (
          <Tooltip title={t('common:dataTable.rawValueTooltip', { value: String(v) })}>
            <span style={{ color: BRAND_PRIMARY }}>{mapped}</span>
          </Tooltip>
        );
      }
      // 阶段汇总行：分组单元格按查看者语言渲染服务端固定文案「阶段汇总」（i18n 收口）
      const stageText = localizedStageCellValue(col.key, v, row, t);
      if (stageText !== null) return stageText;
      if (col.unit === 'duration_sec' && typeof v === 'number') return formatDurationSec(v, durationPlain);
      if (col.unit === 'percent' && typeof v === 'number') return formatPercent(v);
      const text =
        typeof v === 'number'
          ? Number.isFinite(v)
            ? formatNumber(v)
            : '—'
          : col.title.includes('时间')
            ? renderTimeCell(String(v))
            : String(v ?? '—');
      if (countKeys.has(col.key) && onUserCountClick && typeof v === 'number') {
        return (
          <Button type="link" size="small" onClick={() => onUserCountClick(col.key, row)} style={{ padding: 0 }}>
            {text}
          </Button>
        );
      }
      return text;
      },
    };
  });

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      {truncated ? (
        <Alert
          type="warning"
          showIcon
          message={t('common:dataTable.truncated')}
        />
      ) : null}
      {hasMap ? (
        <Space size={8}>
          <Switch size="small" checked={showRaw} onChange={setShowRaw} />
          <Typography.Text type="secondary">{t('common:dataTable.showRaw')}</Typography.Text>
        </Space>
      ) : null}
      <Table
        columns={tableColumns}
        dataSource={rows.map((row, index) => ({ ...row, key: index }))}
        pagination={{ pageSize: 50 }}
        size="small"
        scroll={{ x: 'max-content' }}
      />
    </Space>
  );
}
