import { useEffect, useState } from 'react';
import { Form, Input, Modal, Radio, Select, message } from 'antd';
import { t as i18nT, useT, type TFunction } from '../../i18n';
import { createCard, addCardToDashboard, getDashboards } from '../../services/report.service';
import type { CardType, ChartType, CreateCardDto } from '../../types/report.types';

interface SaveAsCardModalProps {
  type: CardType;
  dsl: unknown;
  /** 表单快照（EventAnalysisFormState / FunnelFormState），点击卡片跳回分析页时还原表单 */
  formSnapshot?: unknown;
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
  defaultName?: string;
}

const chartOptionsFor = (type: CardType, t: TFunction = i18nT): { value: ChartType; label: string }[] => {
  if (type === 'funnel') {
    // 趋势图暂不对漏斗开放：需先支持「按时间分桶」生成多行结果，
    // 否则整体漏斗只有 1 行，会形成单点假趋势（PRD 决策 D1）。
    return [
      { value: 'bar', label: t('analysis:view.bar') },
      { value: 'table', label: t('analysis:view.table') },
    ];
  }
  if (type === 'retention') {
    return [
      { value: 'nth_trend', label: t('analysis:view.nthTrend') },
      { value: 'table', label: t('analysis:view.table') },
    ];
  }
  return [
    { value: 'line', label: t('analysis:view.line') },
    { value: 'trend', label: t('analysis:view.trend') },
    { value: 'bar', label: t('analysis:view.bar') },
    { value: 'stack', label: t('analysis:view.stack') },
    { value: 'cumulative', label: t('analysis:view.cumulative') },
    { value: 'distribution', label: t('analysis:view.distribution') },
    { value: 'pie', label: t('analysis:view.pie') },
    { value: 'number', label: t('analysis:view.number') },
    { value: 'table', label: t('analysis:view.table') },
  ];
};

/**
 * 保存为分析卡片（全局资产）。
 * 保存后卡片进入卡片库；可选同时加入某个看板（不加也可以之后在「分析卡片」页或看板里添加）。
 */
export function SaveAsCardModal({
  type,
  dsl,
  formSnapshot,
  open,
  onClose,
  onSaved,
  defaultName,
}: SaveAsCardModalProps) {
  const { t } = useT('analysis');
  const [form] = Form.useForm();
  const [dashboards, setDashboards] = useState<{ value: string; label: string }[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({ name: defaultName ?? '', description: '' });
    getDashboards()
      .then((res) => setDashboards(res.map((d) => ({ value: d.db_id, label: d.name }))))
      .catch(() => {});
  }, [open, defaultName, form]);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      setSaving(true);
      const dto: CreateCardDto = {
        name: values.name,
        description: values.description?.trim() || null,
        type,
        // _form 为表单快照：点击卡片跳回分析页时还原查询条件并自动执行
        dsl: { ...(dsl as Record<string, unknown>), _form: formSnapshot ?? null },
        chart_type: values.chart_type,
        refresh_policy: 'auto',
      };
      const card = await createCard(dto);
      if (values.db_id) {
        await addCardToDashboard(values.db_id, { card_id: card.card_id, width: 6, height: 4 });
      }
      message.success(
        values.db_id ? t('analysis:card.savedWithDashboard') : t('analysis:card.savedToLibrary'),
      );
      form.resetFields();
      onClose();
      onSaved?.();
    } catch (e) {
      if (e instanceof Error && e.message) message.warning(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={defaultName ? t('analysis:card.saveAs') : t('analysis:card.save')}
      open={open}
      onOk={handleOk}
      onCancel={onClose}
      confirmLoading={saving}
      okText={t('common:action.save')}
      width={480}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          chart_type: type === 'funnel' ? 'bar' : type === 'retention' ? 'nth_trend' : 'line',
        }}
      >
        <Form.Item
          label={t('analysis:card.name')}
          name="name"
          rules={[{ required: true, message: t('analysis:card.nameRequired') }]}
        >
          <Input placeholder={t('analysis:card.namePlaceholder')} maxLength={100} showCount />
        </Form.Item>
        <Form.Item
          label={t('analysis:card.description')}
          name="description"
          tooltip={t('analysis:card.descriptionTip')}
        >
          <Input.TextArea
            placeholder={t('analysis:card.descriptionPlaceholder')}
            maxLength={200}
            showCount
            autoSize={{ minRows: 2, maxRows: 4 }}
          />
        </Form.Item>
        <Form.Item label={t('analysis:view.chartType')} name="chart_type" rules={[{ required: true }]}>
          <Radio.Group options={chartOptionsFor(type, t)} optionType="button" buttonStyle="solid" />
        </Form.Item>
        <Form.Item
          label={t('analysis:card.addToDashboard')}
          name="db_id"
          tooltip={t('analysis:card.addToDashboardTip')}
        >
          <Select placeholder={t('analysis:card.noDashboard')} allowClear options={dashboards} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
