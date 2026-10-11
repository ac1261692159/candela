import { Typography } from 'antd';
import { t as translate, useT, type TFunction } from '../../i18n';

/** 样例行的业务名（`##name` 行）随语言切换；字段名与数据类型是标识，不翻译 */
export function exampleRows(t: TFunction): string[][] {
  return [
    ['##var', 'item_info', 'quantity', 'quality', 'resource'],
    [
      '##name',
      t('datatable:example.sampleItemId'),
      t('datatable:example.sampleQuantity'),
      t('datatable:example.sampleQuality'),
      t('datatable:example.sampleResource'),
    ],
    ['##type', 'number', 'number', 'string', 'string'],
    ['', '10001', '100', 'Common', 'Iron'],
    ['', '10002', '100', 'Rare', 'Gold'],
  ];
}


export function downloadExampleTemplate(t: TFunction = translate) {
  const blob = new Blob([`\ufeff${exampleRows(t).map((row) => row.join(',')).join('\n')}\n`], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'datatable-template.csv';
  link.click();
  URL.revokeObjectURL(url);
}

/** 对齐数数的「数据表示例」：写清三个 ## 行哪些必须、没有时识别成什么 */

export function DataTableExample() {
  const { t } = useT('datatable');
  const rows = exampleRows(t);
  return (
    <>
      <Typography.Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 8 }}>
        {t('datatable:example.hint')}
        <Typography.Link style={{ marginLeft: 8 }} onClick={() => downloadExampleTemplate(t)}>
          {t('datatable:example.download')}
        </Typography.Link>
      </Typography.Paragraph>
      <Typography.Text strong>{t('datatable:example.title')}</Typography.Text>
      <ol style={{ margin: '8px 0 12px', paddingLeft: 20, color: 'rgba(0, 0, 0, 0.65)' }}>
        <li>
          {t('datatable:example.varRowLead')}{' '}
          <Typography.Text code>##var</Typography.Text>
          {t('datatable:example.openParen')}
          <b>{t('datatable:example.required')}</b>
          {t('datatable:example.varRowTail')}
        </li>
        <li>
          {t('datatable:example.nameRowLead')}{' '}
          <Typography.Text code>##name</Typography.Text>
          {t('datatable:example.openParen')}
          <b>{t('datatable:example.optional')}</b>
          {t('datatable:example.nameRowTail')}
          <b>{t('datatable:example.nameRowStrong')}</b>
        </li>
        <li>
          {t('datatable:example.typeRowLead')}{' '}
          <Typography.Text code>##type</Typography.Text>
          {t('datatable:example.openParen')}
          <b>{t('datatable:example.optional')}</b>
          {t('datatable:example.typeRowTail')}
          <b>{t('datatable:example.typeRowStrong')}</b>
        </li>
        <li>
          {t('datatable:example.plainLead')}{' '}
          <Typography.Text code>##var</Typography.Text>{' '}
          {t('datatable:example.plainMid')}
          <b>{t('datatable:example.plainStrong')}</b>
          {t('datatable:example.plainTail')}
        </li>
        <li>{t('datatable:example.markerRow')}</li>
      </ol>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td
                    key={cellIndex}
                    style={{
                      border: '1px solid #f0f0f0',
                      padding: '6px 8px',
                      whiteSpace: 'nowrap',
                      background: rowIndex === 0 ? '#fafafa' : rowIndex < 3 ? '#fffbe6' : '#fff',
                      fontFamily: rowIndex < 3 || cellIndex === 0 ? 'monospace' : undefined,
                      color: cellIndex === 0 ? '#8c8c8c' : undefined,
                    }}
                  >
                    {cell || (cellIndex === 0 ? t('datatable:example.emptyCell') : '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** 「数据表」卡片标题旁的问号说明：作用 / 用法 / 规则限制 */
