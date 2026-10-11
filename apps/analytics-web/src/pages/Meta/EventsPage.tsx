import { useState, useCallback } from 'react';
import { Card, Typography } from 'antd';
import { EventList } from '../../features/meta/EventList';
import { EventDetailDrawer } from '../../features/meta/EventDetailDrawer';
import { useT } from '../../i18n';
import type { MetaEvent } from '../../types/meta.types';

export function EventsPage() {
  const { t } = useT('meta');
  const [selected, setSelected] = useState<MetaEvent | null>(null);
  const [open, setOpen] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const handleEdit = (event: MetaEvent) => {
    setSelected(event);
    setOpen(true);
  };

  const handleClose = () => {
    setOpen(false);
    setSelected(null);
  };

  const handleChange = useCallback(() => {
    setReloadToken((k) => k + 1);
  }, []);

  return (
    <Card title={t('meta:event.title')}>
      <Typography.Paragraph type="secondary">
        {t('meta:event.hint')}
      </Typography.Paragraph>
      <EventList reloadToken={reloadToken} onEdit={handleEdit} />
      <EventDetailDrawer
        event={selected}
        open={open}
        onClose={handleClose}
        onChange={handleChange}
      />
    </Card>
  );
}
