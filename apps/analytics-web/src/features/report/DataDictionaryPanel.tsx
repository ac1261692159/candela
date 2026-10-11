import { useEffect, useMemo, useState } from 'react';
import { Collapse, Empty, Input, Tag, Tooltip, Tree, Typography } from 'antd';
import { FieldTimeOutlined, NumberOutlined, FontSizeOutlined, CheckSquareOutlined } from '@ant-design/icons';
import { EntityIcon } from '../../components/EntityIcon';
import { useT } from '../../i18n';
import type { SqlSchema } from '../../types/report.types';

interface DataDictionaryPanelProps {
  schema: SqlSchema | null;
  loading: boolean;
  onInsert: (sql: string) => void;
}

const typeIcon = (t: string) => {
  if (t === 'number') return <NumberOutlined style={{ color: '#1677ff' }} />;
  if (t === 'boolean') return <CheckSquareOutlined style={{ color: '#fa8c16' }} />;
  if (t === 'datetime') return <FieldTimeOutlined style={{ color: '#13c2c2' }} />;
  return <FontSizeOutlined style={{ color: '#52c41a' }} />;
};

const typeColor = (t: string) =>
  ({ number: 'blue', boolean: 'orange', datetime: 'cyan', list: 'purple', object: 'purple', string: 'green' }[t] ?? 'default');

// 属性 → SQL 表达式（ClickHouse 23.2 支持的函数，无 ...OrNull 系列）
function propExpression(prop: string, type: string, scope: 'event' | 'user'): string {
  const jsonKey = scope === 'event' ? 'properties' : 'p.properties';
  if (type === 'number') return `JSONExtractFloat(${jsonKey}, '${prop}')`;
  if (type === 'boolean') return `JSONExtractBool(${jsonKey}, '${prop}')`;
  if (type === 'datetime') return `parseDateTime64BestEffort(JSONExtractString(${jsonKey}, '${prop}'))`;
  if (type === 'list' || type === 'object') return `JSONExtractRaw(${jsonKey}, '${prop}')`;
  return `JSONExtractString(${jsonKey}, '${prop}')`;
}

/**
 * 面板布局 CSS：
 * - 搜索栏固定在顶部（不随内容滚动）
 * - 四个分组标题全部常驻可见（任何时刻都能折叠/展开；Collapse 为手风琴模式，同一时刻只展开一个）
 * - 展开的分组内容区独占剩余高度并内部滚动（滚动条在分组内部，不共用）
 * 实现：Collapse 为纵向 flex 容器；active 分组撑满剩余高度，其 content-box 内部滚动。
 */
const PANEL_CSS = `
.dd-dict-collapse{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;background:#fff;}
.dd-dict-collapse .ant-collapse-item{flex:0 0 auto;min-height:0;display:flex;flex-direction:column;overflow:hidden;}
.dd-dict-collapse .ant-collapse-item-active{flex:1 1 0;}
.dd-dict-collapse .ant-collapse-item-active .ant-collapse-content{
  display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;}
.dd-dict-collapse .ant-collapse-item-active .ant-collapse-content-box{
  flex:1;min-height:0;overflow-y:auto;padding:0 4px 8px 4px !important;}
.dd-dict-collapse .ant-collapse-header{padding-inline:8px 8px !important;}
.dd-dict-tree .ant-tree-indent{width:0 !important;}
.dd-dict-tree .ant-tree-switcher{width:0 !important;display:none;}
.dd-dict-tree .ant-tree-node-content-wrapper{padding-inline:4px;}
.dd-dict-tree.ant-tree-block-node .ant-tree-list-holder-inner{align-items:stretch;}
`;

export function DataDictionaryPanel({ schema, loading, onInsert }: DataDictionaryPanelProps) {
  const { t } = useT('report');
  const [keyword, setKeyword] = useState('');
  // 手风琴：同一时刻只展开一个分组，默认全折叠
  const [openKey, setOpenKey] = useState<string | undefined>(undefined);

  const kw = keyword.trim().toLowerCase();

  // 搜索时自动展开第一个有匹配结果的分组
  useEffect(() => {
    if (!kw) {
      setOpenKey(undefined);
      return;
    }
    const anyEvent = (schema?.events ?? []).some(
      (e) => e.event_key.toLowerCase().includes(kw) || (e.display_name ?? '').toLowerCase().includes(kw),
    );
    const anyEventProp = (schema?.event_properties ?? []).some((p) => p.prop_key.toLowerCase().includes(kw));
    const anyUserProp = (schema?.user_properties ?? []).some((p) => p.prop_key.toLowerCase().includes(kw));
    const anySys = (schema?.system_columns ?? []).some((c) => c.name.toLowerCase().includes(kw));
    const anyCohort = (schema?.cohorts ?? []).some(
      (c) => c.name.toLowerCase().includes(kw) || c.display_name.toLowerCase().includes(kw),
    );
    if (anyEvent) setOpenKey('events');
    else if (anyEventProp) setOpenKey('event_props');
    else if (anyUserProp) setOpenKey('user_props');
    else if (anySys) setOpenKey('sys_cols');
    else if (anyCohort) setOpenKey('cohorts');
    else setOpenKey(undefined);
  }, [kw, schema]);

  const eventNodes = useMemo(
    () =>
      (schema?.events ?? [])
        .filter((e) => !kw || e.event_key.toLowerCase().includes(kw) || (e.display_name ?? '').toLowerCase().includes(kw))
        .map((e) => {
          const showAlias = !!e.display_name && e.display_name !== e.event_key;
          return {
            key: `event:${e.event_key}`,
            title: (
              <Tooltip
                title={
                  <span>
                    {showAlias ? `${e.display_name}（${e.event_key}）` : e.event_key}
                    <br />
                    {t('report:dict.insertWhereHint')}
                  </span>
                }
              >
                <span
                  onClick={() => onInsert(`WHERE event = '${e.event_key}'`)}
                  style={{ display: 'flex', alignItems: 'baseline', gap: 6, width: '100%', minWidth: 0 }}
                >
                  <EntityIcon type="event" style={{ alignSelf: 'center' }} />
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      // 有显示名时限制宽度给灰色 key 留空间；无显示名时独占整行
                      ...(showAlias ? { flexShrink: 0, maxWidth: '60%' } : { flex: '1 1 auto', minWidth: 0 }),
                    }}
                  >
                    {showAlias ? e.display_name : e.event_key}
                  </span>
                  {showAlias && (
                    <span
                      style={{
                        color: '#8c8c8c',
                        fontSize: 11,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        flex: '1 1 auto',
                        minWidth: 0,
                      }}
                    >
                      {e.event_key}
                    </span>
                  )}
                </span>
              </Tooltip>
            ),
            isLeaf: true,
          };
        }),
    [schema, kw, onInsert, t],
  );

  const propNode = (list: Array<{ prop_key: string; data_type: string; sample_value: string | null; materialized: string | null }>, scope: 'event' | 'user') =>
    (list ?? [])
      .filter((p) => !kw || p.prop_key.toLowerCase().includes(kw))
      .map((p) => ({
        key: `prop:${scope}:${p.prop_key}`,
        title: (
          <Tooltip
            title={
              <span>
                {t('report:dict.propType', { type: p.data_type })}
                {p.sample_value ? t('report:dict.propSample', { value: p.sample_value }) : ''}
                {p.materialized ? t('report:dict.propMaterialized', { value: p.materialized }) : ''}
                <br />
                {t('report:dict.insertExpressionHint')}
              </span>
            }
          >
            {/* flex 布局保证属性名与类型徽章同行：名称过长时自身截断，徽章不换行 */}
            <span
              onClick={() => onInsert(propExpression(p.prop_key, p.data_type, scope))}
              style={{ display: 'flex', alignItems: 'center', gap: 4, width: '100%', minWidth: 0 }}
            >
              <EntityIcon type={scope === 'event' ? 'event-property' : 'user-property'} style={{ marginRight: 2 }} />
              {typeIcon(p.data_type)}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: '0 1 auto', minWidth: 0 }}>
                {p.prop_key}
              </span>
              <Tag
                color={typeColor(p.data_type)}
                style={{ fontSize: 10, lineHeight: '16px', paddingInline: 4, marginInlineEnd: 0, flexShrink: 0 }}
              >
                {p.data_type}
              </Tag>
            </span>
          </Tooltip>
        ),
        isLeaf: true,
      }));

  const eventPropNodes = propNode(schema?.event_properties ?? [], 'event');
  const userPropNodes = propNode(schema?.user_properties ?? [], 'user');
  const sysNodes = (schema?.system_columns ?? []).filter((c) => !kw || c.name.toLowerCase().includes(kw));
  const cohortNodes = (schema?.cohorts ?? []).filter(
    (c) => !kw || c.name.toLowerCase().includes(kw) || c.display_name.toLowerCase().includes(kw),
  );

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <style>{PANEL_CSS}</style>
      {/* 搜索栏固定在顶部，不随内容滚动 */}
      <div style={{ flexShrink: 0, padding: 8, borderBottom: '1px solid #f0f0f0' }}>
        <Input.Search
          placeholder={t('report:dict.searchPlaceholder')}
          allowClear
          size="small"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
      </div>
      {loading ? (
        <div style={{ padding: 12 }}>
          <Typography.Text type="secondary">{t('report:dict.loading')}</Typography.Text>
        </div>
      ) : !schema ? (
        <Empty description={t('report:dict.empty')} style={{ marginTop: 40 }} />
      ) : (
        <Collapse
          accordion
          className="dd-dict-collapse"
          size="small"
          activeKey={openKey}
          onChange={(k) => setOpenKey(Array.isArray(k) ? k[0] : k)}
          items={[
            {
              key: 'events',
              label: t('report:dict.groupEvents', { count: schema.events.length }),
              children: eventNodes.length ? (
                <Tree className="dd-dict-tree" blockNode treeData={eventNodes} selectable={false} />
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('report:dict.noMatch')} />
              ),
            },
            {
              key: 'event_props',
              label: t('report:dict.groupEventProps', { count: schema.event_properties.length }),
              children: eventPropNodes.length ? (
                <Tree className="dd-dict-tree" showLine={false} blockNode treeData={eventPropNodes} selectable={false} />
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('report:dict.noMatch')} />
              ),
            },
            {
              key: 'user_props',
              label: t('report:dict.groupUserProps', { count: schema.user_properties.length }),
              children: userPropNodes.length ? (
                <Tree className="dd-dict-tree" showLine={false} blockNode treeData={userPropNodes} selectable={false} />
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('report:dict.noMatch')} />
              ),
            },
            {
              key: 'sys_cols',
              label: t('report:dict.groupSystemColumns', { count: schema.system_columns.length }),
              children: sysNodes.length ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {sysNodes.map((c) => (
                    <Tooltip key={c.name} title={`${c.type} · ${c.desc_key ? t(c.desc_key) : c.desc}`}>
                      <Tag onClick={() => onInsert(c.name)} style={{ cursor: 'pointer' }}>
                        {c.name}
                      </Tag>
                    </Tooltip>
                  ))}
                </div>
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('report:dict.noMatch')} />
              ),
            },
            {
              key: 'cohorts',
              label: t('report:dict.groupCohorts', { count: schema.cohorts?.length ?? 0 }),
              children: cohortNodes.length ? (
                <Tree
                  className="dd-dict-tree"
                  blockNode
                  selectable={false}
                  treeData={cohortNodes.map((c) => ({
                    key: `cohort:${c.cohort_id}`,
                    isLeaf: true,
                    title: (
                      <Tooltip title={t('report:dict.cohortInsertHint')}>
                        <span
                          onClick={() =>
                            onInsert(`-- cohort: ${c.display_name} (${c.cohort_id})\nsa_in_cohort('${c.cohort_id}')`)
                          }
                        >
                          {c.display_name}
                          <span style={{ color: '#8c8c8c', marginLeft: 6, fontSize: 11 }}>{c.name}</span>
                        </span>
                      </Tooltip>
                    ),
                  }))}
                />
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('report:dict.noMatch')} />
              ),
            },
          ]}
        />
      )}
    </div>
  );
}
