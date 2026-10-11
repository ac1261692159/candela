import { Table, Typography } from 'antd';
import { useT } from '../../i18n';
import { EXPLORE_COLORS } from './explore-chart-option';
import { statCalcLabels, type SeriesStatRow, type StatCalc } from './series-stats';
import './explore-chart.css';

function formatStat(value: number | null | undefined, percent?: boolean): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (percent) return `${(value * 100).toFixed(1)}%`;
  if (Math.abs(value) >= 1000) return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  return String(Math.round(value * 100) / 100);
}

interface SeriesStatsTableProps {
  rows: SeriesStatRow[];
  calcs: StatCalc[];
  percent?: boolean;
  overlay?: boolean;
  colors?: string[];
}

export function SeriesStatsTable({
  rows,
  calcs,
  percent,
  overlay,
  colors = EXPLORE_COLORS,
}: SeriesStatsTableProps) {
  const { t } = useT('analysis');
  const labels = statCalcLabels(t);
  if (!rows.length || !calcs.length) return null;

  if (overlay) {
    const columns = 1 + calcs.length;
    return (
      <div
        className="explore-chart__stats"
        role="table"
        aria-label={t('analysis:chart.showValues')}
      >
        <div
          className="explore-chart__stats-row explore-chart__stats-row--head"
          role="row"
          style={{ gridTemplateColumns: `minmax(64px, 1.4fr) repeat(${calcs.length}, minmax(52px, 1fr))` }}
        >
          <span>{t('analysis:chart.showValues')}</span>
          {calcs.map((calc) => (
            /* 统计口径名是译文（俄 «Максимум» / 德 «Durchschnitt»），52px 列会被省略号截断——
               截断必须可读，故补原生 title 供悬停看全称 */
            <span key={calc} className="explore-chart__stats-val" title={labels[calc]}>
              {labels[calc]}
            </span>
          ))}
        </div>
        {rows.map((row, index) => (
          <div
            key={row.name}
            className="explore-chart__stats-row"
            role="row"
            style={{ gridTemplateColumns: `minmax(64px, 1.4fr) repeat(${columns - 1}, minmax(52px, 1fr))` }}
          >
            <span className="explore-chart__stats-name">
              <i style={{ background: colors[index % colors.length] }} aria-hidden="true" />
              <span title={row.name}>{row.name}</span>
            </span>
            {calcs.map((calc) => (
              <span key={calc} className="explore-chart__stats-val">
                {formatStat(row[calc], percent)}
              </span>
            ))}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 8 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {t('analysis:chart.showValues')}
      </Typography.Text>
      <Table
        size="small"
        pagination={false}
        rowKey="name"
        columns={[
          { title: t('analysis:chart.series'), dataIndex: 'name', key: 'name', ellipsis: true },
          ...calcs.map((calc) => ({
            title: labels[calc],
            dataIndex: calc,
            key: calc,
            render: (value: number | null) => formatStat(value, percent),
          })),
        ]}
        dataSource={rows}
      />
    </div>
  );
}
