import { Typography } from 'antd';
import { useT } from '../../i18n';

interface DiffLine {
  kind: 'same' | 'removed' | 'added';
  text: string;
}

function lineDiff(before: string, after: string): DiffLine[] {
  const left = before.split('\n');
  const right = after.split('\n');
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return [
    ...left.slice(0, prefix).map((text) => ({ kind: 'same' as const, text })),
    ...left
      .slice(prefix, left.length - suffix)
      .map((text) => ({ kind: 'removed' as const, text })),
    ...right
      .slice(prefix, right.length - suffix)
      .map((text) => ({ kind: 'added' as const, text })),
    ...left
      .slice(left.length - suffix)
      .map((text) => ({ kind: 'same' as const, text })),
  ];
}

export function SqlProposalDiff({ before, after }: { before: string; after: string }) {
  const { t } = useT('ai');
  const lines = lineDiff(before, after);
  return (
    <div>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
        {t('ai:diff.hint')}
      </Typography.Paragraph>
      <pre
        style={{
          maxHeight: 360,
          overflow: 'auto',
          margin: 0,
          padding: 8,
          border: '1px solid #d9d9d9',
          borderRadius: 4,
          fontSize: 12,
          lineHeight: 1.6,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {lines.map((line, index) => (
          <div
            key={`${index}-${line.kind}`}
            style={{
              background:
                line.kind === 'removed'
                  ? '#fff1f0'
                  : line.kind === 'added'
                    ? '#f6ffed'
                    : 'transparent',
              color:
                line.kind === 'removed'
                  ? '#a8071a'
                  : line.kind === 'added'
                    ? '#237804'
                    : 'inherit',
            }}
          >
            {line.kind === 'removed' ? '- ' : line.kind === 'added' ? '+ ' : '  '}
            {line.text || ' '}
          </div>
        ))}
      </pre>
    </div>
  );
}
