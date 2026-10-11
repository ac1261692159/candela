import { useEffect, useMemo, useRef, useState } from 'react';
import { Typography } from 'antd';
import ReactECharts from 'echarts-for-react';
import { useT } from '../../i18n';
import { EmptyState } from '../../components/EmptyState';
import {
  buildFunnelChartOption,
  funnelChartPixelHeight,
  nextFunnelBaseIndex,
  rebaseFunnelSeries,
  type FunnelColorConfig,
  type FunnelLayout,
  type FunnelRateMode,
} from './funnel-display';

interface FunnelBarPoint {
  name: string;
  value: number;
  stepNo: number;
}

interface FunnelExploreChartProps {
  series: FunnelBarPoint[];
  rateMode: FunnelRateMode;
  layout: FunnelLayout;
  color: FunnelColorConfig;
  frameHeight?: number;
}

interface ChartZr {
  on: (event: string, handler: (event: { target?: unknown }) => void) => void;
  off: (event: string, handler: (event: { target?: unknown }) => void) => void;
}

export function FunnelExploreChart({
  series,
  rateMode,
  layout,
  color,
  frameHeight,
}: FunnelExploreChartProps) {
  const { t } = useT('analysis');
  const [baseIndex, setBaseIndex] = useState(0);
  const resetRef = useRef(() => {
    setBaseIndex(0);
  });
  resetRef.current = () => setBaseIndex(0);
  const onBlankRef = useRef((event: { target?: unknown }) => {
    if (!event.target) resetRef.current();
  });

  const seriesKey = series.map((item) => `${item.stepNo}:${item.value}`).join('|');
  useEffect(() => {
    setBaseIndex(0);
  }, [seriesKey]);

  const visible = useMemo(() => rebaseFunnelSeries(series, baseIndex), [series, baseIndex]);
  const option = useMemo(
    () => buildFunnelChartOption(visible, rateMode, layout, color, t),
    [visible, rateMode, layout, color, t],
  );
  const height = funnelChartPixelHeight(layout, visible.length, frameHeight);
  const baseStep = visible[0];

  if (series.length === 0) return <EmptyState variant="analysis" />;

  return (
    <div>
      {baseIndex > 0 && baseStep ? (
        <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8, fontSize: 12 }}>
          {t('analysis:funnel.baseFromStep', { step: baseStep.stepNo, name: baseStep.name })}
        </Typography.Text>
      ) : null}
      <ReactECharts
        option={option}
        style={{ height }}
        notMerge
        onEvents={{
          click: (params: { componentType?: string; dataIndex?: number }) => {
            if (params.componentType !== 'series' || typeof params.dataIndex !== 'number') return;
            setBaseIndex((current) => nextFunnelBaseIndex(current, params.dataIndex ?? 0));
          },
        }}
        onChartReady={(chart: { getZr: () => ChartZr }) => {
          const zr = chart.getZr();
          zr.off('click', onBlankRef.current);
          zr.on('click', onBlankRef.current);
        }}
      />
    </div>
  );
}
