import { Button, Popconfirm, message } from 'antd';
import { deleteCard } from '../../services/report.service';
import { useT } from '../../i18n';

interface DeleteCardButtonProps {
  cardId: string;
  cardName?: string;
  onDeleted?: () => void;
}

/** 卡片编辑面删除库资产（从所有看板摘引用）。 */
export function DeleteCardButton({ cardId, cardName, onDeleted }: DeleteCardButtonProps) {
  const { t } = useT('report');
  const title = cardName?.trim() || t('report:card.current');
  return (
    <Popconfirm
      title={t('report:card.deleteConfirm', { name: title })}
      description={t('report:card.deleteConfirmBody')}
      okText={t('report:card.delete')}
      cancelText={t('common:action.cancel')}
      okButtonProps={{ danger: true }}
      onConfirm={async () => {
        await deleteCard(cardId);
        message.success(t('report:card.deleted', { name: title }));
        onDeleted?.();
      }}
    >
      <Button danger size="small">
        {t('report:card.delete')}
      </Button>
    </Popconfirm>
  );
}
