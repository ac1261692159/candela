import { useState } from 'react';
import { ColorPicker, Form, Input, InputNumber, Modal, Typography } from 'antd';
import { createCard, updateCard } from '../../services/report.service';
import { DeleteCardButton } from './DeleteCardButton';
import { useT } from '../../i18n';
import type { AnalysisCard, TextCardDsl } from '../../types/report.types';

const DEFAULT_DSL: TextCardDsl = {
  body: '',
  text_color: '#AD4E00',
  background_color: '#FFF7E6',
  font_size: 14,
};

interface TextCardEditorModalProps {
  open: boolean;
  card?: Pick<AnalysisCard, 'card_id' | 'name' | 'dsl'> | null;
  onClose: () => void;
  onSaved: (card: AnalysisCard) => void;
  onDeleted?: () => void;
}

export function TextCardEditorModal({ open, card, onClose, onSaved, onDeleted }: TextCardEditorModalProps) {
  const { t } = useT('report');
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const editing = Boolean(card?.card_id);
  const dsl = { ...DEFAULT_DSL, ...(card?.dsl && typeof card.dsl === 'object' ? (card.dsl as TextCardDsl) : {}) };

  return (
    <Modal
      title={editing ? t('report:text.editTitle') : t('report:text.addTitle')}
      open={open}
      onCancel={onClose}
      onOk={() => void form.submit()}
      confirmLoading={saving}
      okText={editing ? t('common:action.save') : t('common:action.add')}
      destroyOnClose
      afterOpenChange={(visible) => {
        if (visible) {
          form.setFieldsValue({
            name: card?.name ?? t('report:text.defaultName'),
            body: dsl.body,
            text_color: dsl.text_color,
            background_color: dsl.background_color,
            font_size: dsl.font_size ?? 14,
          });
        }
      }}
      footer={(_, { OkBtn, CancelBtn }) => (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          {editing && card ? (
            <DeleteCardButton
              cardId={card.card_id}
              cardName={card.name}
              onDeleted={() => {
                onClose();
                onDeleted?.();
              }}
            />
          ) : (
            <span />
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <CancelBtn />
            <OkBtn />
          </div>
        </div>
      )}
    >
      <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
        {t('report:text.hint')}
      </Typography.Paragraph>
      <Form
        form={form}
        layout="vertical"
        onFinish={async (values: {
          name: string;
          body: string;
          text_color: unknown;
          background_color: unknown;
          font_size: number;
        }) => {
          setSaving(true);
          try {
            const payload = {
              name: values.name.trim() || t('report:text.defaultName'),
              dsl: {
                body: values.body,
                text_color: toCssHex(values.text_color, DEFAULT_DSL.text_color!),
                background_color: toCssHex(values.background_color, DEFAULT_DSL.background_color!),
                font_size: Number(values.font_size) || 14,
              } satisfies TextCardDsl,
            };
            const saved = editing && card
              ? await updateCard(card.card_id, payload)
              : await createCard({ ...payload, type: 'text' });
            onSaved(saved);
            onClose();
          } finally {
            setSaving(false);
          }
        }}
      >
        <Form.Item name="name" label={t('report:text.title')} rules={[{ required: true, message: t('report:text.titleRequired') }]}>
          <Input maxLength={100} />
        </Form.Item>
        <Form.Item name="body" label={t('report:text.body')} rules={[{ required: true, message: t('report:text.bodyRequired') }]}>
          <Input.TextArea rows={4} maxLength={4000} />
        </Form.Item>
        <Form.Item name="text_color" label={t('report:text.textColor')} rules={[{ required: true }]}>
          <HexColorField />
        </Form.Item>
        <Form.Item name="background_color" label={t('report:text.backgroundColor')} rules={[{ required: true }]}>
          <HexColorField />
        </Form.Item>
        <Form.Item name="font_size" label={t('report:text.fontSize')}>
          <InputNumber min={12} max={24} step={2} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function toCssHex(value: unknown, fallback: string): string {
  if (typeof value === 'string') {
    const hex = value.startsWith('#') ? value.slice(1) : value;
    if (/^[0-9a-fA-F]{6}/.test(hex)) return `#${hex.slice(0, 6).toUpperCase()}`;
  }
  if (value && typeof value === 'object') {
    const obj = value as { toHexString?: () => string; toHex?: () => string };
    const hex = obj.toHexString?.() ?? obj.toHex?.();
    if (hex) return toCssHex(hex, fallback);
  }
  return fallback;
}

function HexColorField({ value, onChange }: { value?: string; onChange?: (v: string) => void }) {
  return (
    <ColorPicker
      value={value}
      format="hex"
      onChange={(_, hex) => onChange?.(hex.slice(0, 7).toUpperCase())}
      showText
    />
  );
}

export function TextPanelView({ dsl }: { name?: string; dsl: TextCardDsl }) {
  const { t } = useT('report');
  const bg = dsl.background_color || DEFAULT_DSL.background_color!;
  const color = dsl.text_color || DEFAULT_DSL.text_color!;
  return (
    <div
      style={{
        height: '100%',
        background: bg,
        color,
        padding: '12px 14px',
        overflow: 'auto',
        fontSize: dsl.font_size ?? 14,
        lineHeight: 1.55,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {dsl.body?.trim() ? dsl.body : <Typography.Text type="secondary">{t('report:text.emptyView')}</Typography.Text>}
    </div>
  );
}
