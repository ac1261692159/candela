import { useState } from 'react';
import { message } from 'antd';
import { useT } from '../../i18n';
import { updateCard } from '../../services/report.service';
import type { CardType, ChartType } from '../../types/report.types';
import { CardSaveActions } from '../report/CardSaveActions';
import { SaveAsCardModal } from './SaveAsCardModal';

interface AnalysisCardSaveProps {
  type: Extract<CardType, 'event' | 'funnel' | 'retention'>;
  dsl: unknown;
  formSnapshot?: unknown;
  chartType?: ChartType;
  cardId?: string | null;
  cardName?: string | null;
}

export function AnalysisCardSave({
  type,
  dsl,
  formSnapshot,
  chartType,
  cardId,
  cardName,
}: AnalysisCardSaveProps) {
  const { t } = useT('analysis');
  const [saveOpen, setSaveOpen] = useState(false);
  const [overwriting, setOverwriting] = useState(false);
  const bound = Boolean(cardId);

  const handleOverwrite = async () => {
    if (!cardId || !dsl) return;
    setOverwriting(true);
    try {
      await updateCard(cardId, {
        dsl: { ...(dsl as Record<string, unknown>), _form: formSnapshot ?? null },
        ...(chartType ? { chart_type: chartType } : {}),
      });
      message.success(
        cardName
          ? t('analysis:message.cardOverwrittenNamed', { name: cardName })
          : t('analysis:message.cardOverwritten'),
      );
    } catch (e) {
      if (e instanceof Error && e.message) message.warning(e.message);
    } finally {
      setOverwriting(false);
    }
  };

  return (
    <>
      <CardSaveActions
        bound={bound}
        disabled={!dsl}
        overwriting={overwriting}
        onOverwrite={() => void handleOverwrite()}
        onSaveAs={() => setSaveOpen(true)}
      />
      <SaveAsCardModal
        type={type}
        dsl={dsl ?? {}}
        formSnapshot={formSnapshot}
        open={saveOpen}
        defaultName={bound && cardName ? t('analysis:card.copySuffix', { name: cardName }) : undefined}
        onClose={() => setSaveOpen(false)}
      />
    </>
  );
}
