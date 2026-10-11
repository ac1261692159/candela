import { useEffect, useMemo, useState } from 'react';
import { Checkbox, Empty, Input, Modal, Tabs, Tag, Typography, message } from 'antd';
import { addCardToDashboard, getCards, listCards } from '../../services/report.service';
import { TextCardEditorModal } from './TextPanel';
import { t, type TFunction, useT } from '../../i18n';
import type { AnalysisCard } from '../../types/report.types';

interface CardConfigModalProps {
  dbId: string;
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}

const cardTypeLabels = (t: TFunction): Record<string, string> => ({
  event: t('report:cardType.event'),
  funnel: t('report:cardType.funnel'),
  retention: t('report:cardType.retention'),
  sql: t('report:cardType.sql'),
  text: t('report:cardType.text'),
});

const typeColors: Record<string, string> = {
  event: 'blue',
  funnel: 'purple',
  retention: 'cyan',
  sql: 'geekblue',
  text: 'gold',
};

/** 按名称 / 类型中文名 / 类型 id 过滤卡片库（不依赖 ReactNode label）。 */
export function matchesCardSearch(
  card: { name: string; type: string },
  query: string,
  labels: Record<string, string> = cardTypeLabels(t),
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${card.name} ${labels[card.type] ?? ''} ${card.type}`.toLowerCase().includes(q);
}

export function CardConfigModal({ dbId, open, onClose, onCreated }: CardConfigModalProps) {
  const { t } = useT('report');
  const [library, setLibrary] = useState<AnalysisCard[]>([]);
  const [existing, setExisting] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState('library');
  const [textOpen, setTextOpen] = useState(false);

  useEffect(() => {
    if (open) {
      setTab('library');
      setQuery('');
      setSelected([]);
      setLoading(true);
      Promise.all([listCards(), getCards(dbId)])
        .then(([lib, linked]) => {
          setLibrary(lib);
          setExisting(new Set(linked.map((c) => c.card_id)));
        })
        .catch(() => {})
        .finally(() => setLoading(false));
    }
  }, [open, dbId]);

  const typeLabelsOf = useMemo(() => cardTypeLabels(t), [t]);
  const filtered = useMemo(
    () => library.filter((c) => matchesCardSearch(c, query, typeLabelsOf)),
    [library, query, typeLabelsOf],
  );

  const toggle = (cardId: string, checked: boolean) => {
    setSelected((prev) => (checked ? [...prev, cardId] : prev.filter((id) => id !== cardId)));
  };

  const handleOk = async () => {
    if (tab === 'text') {
      setTextOpen(true);
      return;
    }
    if (selected.length === 0) {
      message.warning(t('report:card.selectRequired'));
      return;
    }
    setSaving(true);
    try {
      for (const cardId of selected) {
        await addCardToDashboard(dbId, { card_id: cardId });
      }
      message.success(t('report:card.addedCount', { count: selected.length }));
      setSelected([]);
      onClose();
      onCreated();
    } catch (e) {
      if (e instanceof Error) message.warning(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Modal
        title={t('report:card.add')}
        open={open}
        onOk={() => void handleOk()}
        onCancel={() => {
          setSelected([]);
          setQuery('');
          onClose();
        }}
        confirmLoading={saving}
        okText={
          tab === 'text'
            ? t('report:card.writeTag')
            : selected.length
              ? t('report:card.addCount', { count: selected.length })
              : t('common:action.add')
        }
        width={560}
      >
        <Tabs
          activeKey={tab}
          onChange={setTab}
          items={[
            {
              key: 'library',
              label: t('report:card.fromLibrary'),
              children: (
                <>
                  <Typography.Paragraph type="secondary" style={{ marginTop: 0, marginBottom: 8 }}>
                    {t('report:card.libraryHint')}
                  </Typography.Paragraph>
                  <Input.Search
                    allowClear
                    aria-label={t('report:card.searchLibrary')}
                    placeholder={loading ? t('report:card.libraryLoading') : t('report:card.searchPlaceholder')}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    style={{ marginBottom: 8 }}
                  />
                  <div
                    style={{
                      maxHeight: 320,
                      overflow: 'auto',
                      border: '1px solid #f0f0f0',
                      borderRadius: 4,
                      padding: '4px 8px',
                    }}
                  >
                    {filtered.length === 0 && !loading ? (
                      <Empty
                        image={Empty.PRESENTED_IMAGE_SIMPLE}
                        description={
                          query.trim()
                            ? t('report:card.noMatch', { query: query.trim() })
                            : t('report:card.libraryEmpty')
                        }
                      />
                    ) : (
                      filtered.map((c) => {
                        const onBoard = existing.has(c.card_id);
                        return (
                          <div key={c.card_id} style={{ padding: '6px 0' }}>
                            <Checkbox
                              checked={onBoard || selected.includes(c.card_id)}
                              disabled={onBoard}
                              onChange={(e) => toggle(c.card_id, e.target.checked)}
                            >
                              <Tag color={typeColors[c.type] ?? 'default'} style={{ marginRight: 8 }}>
                                {typeLabelsOf[c.type] ?? c.type}
                              </Tag>
                              {c.name}
                              {onBoard ? (
                                <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                                  {t('report:card.onBoard')}
                                </Typography.Text>
                              ) : null}
                            </Checkbox>
                          </div>
                        );
                      })
                    )}
                  </div>
                </>
              ),
            },
            {
              key: 'text',
              label: t('report:card.textTab'),
              children: (
                <Typography.Paragraph type="secondary">
                  {t('report:card.textTabHint')}
                </Typography.Paragraph>
              ),
            },
          ]}
        />
      </Modal>
      <TextCardEditorModal
        open={textOpen}
        onClose={() => setTextOpen(false)}
        onSaved={async (card) => {
          await addCardToDashboard(dbId, { card_id: card.card_id });
          message.success(t('report:card.textAdded'));
          setTextOpen(false);
          onClose();
          onCreated();
        }}
      />
    </>
  );
}
