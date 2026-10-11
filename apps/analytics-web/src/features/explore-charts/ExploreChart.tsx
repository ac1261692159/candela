import { useEffect, useRef } from 'react';
import ReactECharts from 'echarts-for-react';
import { Card, Col, Row, Statistic } from 'antd';
import { EmptyState } from '../../components/EmptyState';
import { useT } from '../../i18n';
import { buildExploreOption, type ExploreChartKind, type ExploreChartModel } from './explore-chart-option';
import { applyLegendIsolate } from './legend-isolate';
import { SeriesStatsTable } from './SeriesStatsTable';
import { reduceSeries, seriesStats, type StatCalc } from './series-stats';
import { formatChartNumber } from '../visualization/metric-units';
import type { MetricUnit } from '../visualization/chart.types';
import './explore-chart.css';

interface ExploreChartProps {
  kind: ExploreChartKind;
  model: ExploreChartModel;
  statCalcs: StatCalc[];
  height?: number;
  yUnit?: MetricUnit;
}

export function ExploreChart({ kind, model, statCalcs, height = 360, yUnit }: ExploreChartProps) {
  const { t } = useT('analysis');
  const chartRef = useRef<ReactECharts>(null);
  const isolatedRef = useRef<string | null>(null);
  const lockRef = useRef(false);
  const unit: MetricUnit = yUnit ?? (model.percent ? 'ratio_0_1' : 'number');

  useEffect(() => {
    isolatedRef.current = null;
  }, [kind, model]);

  if (!model.series.length || !model.categories.length) {
    return <EmptyState variant="analysis" />;
  }

  const stats = seriesStats(model.series, statCalcs);
  const overlay =
    kind === 'bar' || kind === 'stack' || kind === 'pie' || kind === 'distribution';

  if (kind === 'number') {
    const primary = statCalcs[0] ?? 'last';
    return (
      <div>
        <Row gutter={16}>
          {model.series.map((item) => {
            const value = reduceSeries(item.values, primary);
            const display = formatChartNumber(value, unit);
            return (
              <Col key={item.name} xs={24} sm={12} md={8}>
                <Card>
                  <Statistic title={item.name} value={display} />
                </Card>
              </Col>
            );
          })}
        </Row>
        {statCalcs.length > 1 ? <SeriesStatsTable rows={stats} calcs={statCalcs} percent={unit.includes('percent') || unit.includes('ratio')} /> : null}
      </div>
    );
  }

  const chartHeight = overlay ? Math.max(height, 280 + stats.length * 22) : height;
  return (
    <div className="explore-chart" style={{ height: chartHeight }}>
      <ReactECharts
        ref={chartRef}
        className="explore-chart__canvas"
        option={buildExploreOption(kind, model, statCalcs, unit, t)}
        style={{ height: '100%' }}
        notMerge
        onEvents={{
          legendselectchanged: (params: { name?: string }) => {
            applyLegendIsolate(
              chartRef.current?.getEchartsInstance?.(),
              isolatedRef,
              lockRef,
              String(params?.name ?? ''),
            );
          },
        }}
      />
      {overlay ? <SeriesStatsTable rows={stats} calcs={statCalcs} percent={unit.includes('percent') || unit.includes('ratio')} overlay /> : null}
    </div>
  );
}
