import { useMemo, useState } from 'react';
import { Empty, Input, Tabs, Typography } from 'antd';
import { useT } from '../../i18n';

export interface GrantCandidate {
  /** `group:<id>` / `user:<id>`，与 ACL 的 subject 表示一致 */
  key: string;
  label: string;
  kind: 'group' | 'member';
}

const LIST_HEIGHT = 220;

/**
 * 授权用的双栏选择器（rbac-v6 增补）。
 *
 * 多选下拉在「成员可能上百」的场景不可用：候选全平铺、选中态难核对。改为
 * 左「未添加」/ 右「已添加」两栏，各自固定高度内部滚动；左栏顶部用标签页切换
 * 「成员组 / 成员」两个类别；点左栏项加入、点右栏项移出。
 */
export function GrantTransfer(props: {
  candidates: GrantCandidate[];
  selected: string[];
  onChange: (keys: string[]) => void;
  /** 供用例定位两块（编辑 / 查看）面板 */
  testId?: string;
}) {
  const { t } = useT('report');
  const [tab, setTab] = useState<'group' | 'member'>('group');
  const [leftKeyword, setLeftKeyword] = useState('');
  const [rightKeyword, setRightKeyword] = useState('');

  const selectedSet = useMemo(() => new Set(props.selected), [props.selected]);
  const filter = (list: GrantCandidate[], keyword: string) => {
    const kw = keyword.trim().toLowerCase();
    return kw ? list.filter((item) => item.label.toLowerCase().includes(kw)) : list;
  };
  const leftItems = filter(
    props.candidates.filter((item) => item.kind === tab && !selectedSet.has(item.key)),
    leftKeyword,
  );
  const rightItems = filter(
    props.candidates.filter((item) => selectedSet.has(item.key)),
    rightKeyword,
  );

  const add = (key: string) => props.onChange([...props.selected, key]);
  const remove = (key: string) => props.onChange(props.selected.filter((k) => k !== key));

  const list = (items: GrantCandidate[], onPick: (key: string) => void) =>
    items.length ? (
      items.map((item) => (
        <div
          key={item.key}
          onClick={() => onPick(item.key)}
          style={{ padding: '4px 6px', cursor: 'pointer', borderRadius: 4 }}
        >
          {/* 候选名是译后长串（俄「Аналитик · Иван Иванов」）：窄栏里截断时必须悬停可看全称（G.29） */}
          <Typography.Text ellipsis={{ tooltip: item.label }} style={{ fontSize: 13, maxWidth: '100%', minWidth: 0 }}>
            {item.label}
          </Typography.Text>
        </div>
      ))
    ) : (
      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('common:state.empty')} />
    );

  const paneStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    border: '1px solid #f0f0f0',
    borderRadius: 6,
    display: 'flex',
    flexDirection: 'column',
  };

  return (
    <div data-testid={props.testId} style={{ display: 'flex', gap: 12 }}>
      <div data-testid={props.testId ? `${props.testId}-left` : undefined} style={paneStyle}>
        <div style={{ padding: '6px 8px', borderBottom: '1px solid #f0f0f0', background: '#fafafa' }}>
          {t('report:grant.notAdded')}
          <Typography.Text type="secondary" style={{ marginLeft: 6 }}>
            {leftItems.length}
          </Typography.Text>
        </div>
        <Tabs
          size="small"
          activeKey={tab}
          onChange={(key) => setTab(key as 'group' | 'member')}
          style={{ margin: '0 8px' }}
          items={[
            { key: 'group', label: t('report:grant.groupSection') },
            { key: 'member', label: t('report:grant.memberSection') },
          ]}
        />
        <div style={{ padding: '0 8px 8px' }}>
          <Input
            allowClear
            size="small"
            placeholder={t('common:action.search')}
            value={leftKeyword}
            onChange={(e) => setLeftKeyword(e.target.value)}
          />
        </div>
        <div style={{ height: LIST_HEIGHT, overflowY: 'auto', padding: '0 8px 8px' }}>
          {list(leftItems, add)}
        </div>
      </div>
      <div data-testid={props.testId ? `${props.testId}-right` : undefined} style={paneStyle}>
        <div style={{ padding: '6px 8px', borderBottom: '1px solid #f0f0f0', background: '#fafafa' }}>
          {t('report:grant.added')}
          <Typography.Text type="secondary" style={{ marginLeft: 6 }}>
            {rightItems.length}
          </Typography.Text>
        </div>
        <div style={{ padding: '8px 8px 4px' }}>
          <Input
            allowClear
            size="small"
            placeholder={t('common:action.search')}
            value={rightKeyword}
            onChange={(e) => setRightKeyword(e.target.value)}
          />
        </div>
        <div style={{ height: LIST_HEIGHT, overflowY: 'auto', padding: '0 8px 8px' }}>
          {list(rightItems, remove)}
        </div>
      </div>
    </div>
  );
}
