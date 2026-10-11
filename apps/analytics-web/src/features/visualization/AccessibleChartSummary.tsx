import { Typography } from 'antd';
import type { ChartIssue } from './chart.types';
import { formatIssue } from './chart-issues';
import { useT } from '../../i18n';

interface AccessibleChartSummaryProps {
  summary: string;
  issues: ChartIssue[];
  reveal?: boolean;
}

export function AccessibleChartSummary({ summary, issues, reveal = true }: AccessibleChartSummaryProps) {
  const { t } = useT('sql');
  const warnings = issues
    .filter((issue) => issue.severity !== 'error')
    .map((issue) => formatIssue(issue, t));
  const text = [summary, ...warnings].filter(Boolean).join(' ');
  return (
    <>
      <p
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: 'hidden',
          clip: 'rect(0, 0, 0, 0)',
          whiteSpace: 'nowrap',
          border: 0,
        }}
      >
        {text}
      </p>
      {reveal ? (
        <details style={{ margin: '0 12px 8px' }}>
          <summary>
            <Typography.Text type="secondary">{t('sql:chart.summaryTitle')}</Typography.Text>
          </summary>
          <Typography.Paragraph style={{ margin: '8px 0 0' }}>{text}</Typography.Paragraph>
        </details>
      ) : null}
    </>
  );
}
