import { useCallback, useEffect, useState } from 'react';
import { Button, Drawer, Input, Space, Table, Typography } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { getCohortMembers, type UserCohort } from '../../services/cohort.service';
import { useT } from '../../i18n';

const PREVIEW_LIMIT = 1000;

interface Props {
  cohort: UserCohort | null;
  onClose: () => void;
}

/**
 * 成员抽屉：默认看前 1000 人，可按用户 ID 检索（服务端有界查询，不是在前 1000 行里过滤，
 * 否则「分群里到底有没有这个 ID」会给出错误答案）。
 */
export function CohortMembersDrawer({ cohort, onClose }: Props) {
  const { t } = useT('cohort');
  const [items, setItems] = useState<{ uid: string }[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [searched, setSearched] = useState('');

  const load = useCallback(
    async (cohortId: string, search: string) => {
      setLoading(true);
      try {
        const res = await getCohortMembers(cohortId, {
          limit: PREVIEW_LIMIT,
          keyword: search || undefined,
        });
        setItems(res.items);
        setTotal(res.total);
        setTruncated(res.truncated);
        setSearched(search);
      } catch {
        setItems([]);
        setTruncated(false);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const cohortId = cohort?.cohort_id;
  useEffect(() => {
    if (!cohortId) return;
    setKeyword('');
    void load(cohortId, '');
  }, [cohortId, load]);

  const hint = searched
    ? truncated
      ? t('cohort:member.truncated', { limit: PREVIEW_LIMIT })
      : t('cohort:member.matched', { count: items.length })
    : t('cohort:member.previewHint', { total });

  return (
    <Drawer
      title={t('cohort:member.drawerTitle', { name: cohort?.display_name ?? '' })}
      open={cohort !== null}
      onClose={onClose}
      width={460}
    >
      <Space style={{ marginBottom: 12 }}>
        <Input
          allowClear
          placeholder={t('cohort:member.searchPlaceholder')}
          prefix={<SearchOutlined />}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onPressEnter={() => cohortId && void load(cohortId, keyword.trim())}
          style={{ width: 240 }}
        />
        <Button onClick={() => cohortId && void load(cohortId, keyword.trim())}>
          {t('common:action.search')}
        </Button>
      </Space>
      <Typography.Paragraph type="secondary">{hint}</Typography.Paragraph>
      <Table
        size="small"
        rowKey="uid"
        loading={loading}
        dataSource={items}
        pagination={{ pageSize: 50 }}
        locale={{ emptyText: searched ? t('cohort:member.searchEmpty') : undefined }}
        columns={[{ title: t('cohort:label.userId'), dataIndex: 'uid' }]}
      />
    </Drawer>
  );
}
