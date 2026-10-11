import { useEffect, useState } from 'react';
import { Button, Modal, Select, message } from 'antd';
import { getSavedMetrics } from '../../services/meta.service';
import type { SavedMetric } from '../../types/meta.types';
import { useT } from '../../i18n';

interface ApplySavedMetricButtonProps {
  kind: 'event' | 'retention';
  label?: string;
  block?: boolean;
  onPick: (metric: SavedMetric) => void;
  /** 受控展开（供 ➕ 菜单触发）；不传则组件内部自管 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 隐藏触发按钮（只留 Modal，配合受控 open） */
  hideTrigger?: boolean;
}

export function ApplySavedMetricButton({
  kind,
  label,
  block,
  onPick,
  open: openProp,
  onOpenChange,
  hideTrigger,
}: ApplySavedMetricButtonProps) {
  const { t } = useT('metrics');
  const title = label ?? t('metrics:apply.trigger');
  const [openInner, setOpenInner] = useState(false);
  const open = openProp ?? openInner;
  const setOpen = (v: boolean) => {
    setOpenInner(v);
    onOpenChange?.(v);
  };
  const [items, setItems] = useState<SavedMetric[]>([]);
  const [selected, setSelected] = useState<string>();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    getSavedMetrics(kind)
      .then((res) => setItems(res.items))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, [open, kind]);

  const handleOk = () => {
    const metric = items.find((item) => item.metric_id === selected);
    if (!metric) {
      message.warning(t('metrics:validation.metricRequired'));
      return;
    }
    onPick(metric);
    setOpen(false);
    setSelected(undefined);
  };

  return (
    <>
      {!hideTrigger ? (
        <Button onClick={() => setOpen(true)} style={{ marginTop: 8 }} block={block}>
          {title}
        </Button>
      ) : null}
      <Modal
        title={title}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={handleOk}
        okText={t('metrics:apply.ok')}
      >
        <Select
          style={{ width: '100%' }}
          loading={loading}
          placeholder={items.length ? t('metrics:apply.placeholder') : t('metrics:apply.empty')}
          value={selected}
          onChange={setSelected}
          options={items.map((item) => ({
            value: item.metric_id,
            label: `${item.display_name} (${item.name})`,
          }))}
        />
      </Modal>
    </>
  );
}
