import { ColorPicker, InputNumber, Radio, Typography } from 'antd';
import { useT } from '../../i18n';
import type { FunnelColorConfig, FunnelLayout, FunnelRateMode } from './funnel-display';
import {
  churnBandLabel,
  MAX_FUNNEL_TABLE_COL_CHARS,
  MIN_FUNNEL_TABLE_COL_CHARS,
  parseFunnelTableColChars,
  parseHexColor,
} from './funnel-display';
import './analysis-workbench.css';

interface FunnelViewSettingsProps {
  rateMode: FunnelRateMode;
  layout: FunnelLayout;
  color: FunnelColorConfig;
  tableColChars: number;
  onRateModeChange: (mode: FunnelRateMode) => void;
  onLayoutChange: (layout: FunnelLayout) => void;
  onColorChange: (color: FunnelColorConfig) => void;
  onTableColCharsChange: (chars: number) => void;
}

function pickerContainer() {
  return (
    (document.querySelector('.analysis-result-settings-overlay') as HTMLElement | null) ??
    document.body
  );
}

function HexSwatch({
  value,
  onChange,
}: {
  value: string;
  onChange: (hex: string) => void;
}) {
  return (
    <ColorPicker
      size="small"
      value={value}
      format="hex"
      showText
      getPopupContainer={pickerContainer}
      onChange={(_, hex) => onChange(parseHexColor(hex.slice(0, 7), value))}
    />
  );
}

export function FunnelViewSettings({
  rateMode,
  layout,
  color,
  tableColChars,
  onRateModeChange,
  onLayoutChange,
  onColorChange,
  onTableColCharsChange,
}: FunnelViewSettingsProps) {
  const { t } = useT('analysis');
  const patchLevel = (index: number, patch: Partial<{ gte: number; lt: number; color: string }>) => {
    onColorChange({
      ...color,
      levels: color.levels.map((level, i) => (i === index ? { ...level, ...patch } : level)),
    });
  };

  const rateWord = rateMode === 'conversion' ? t('analysis:funnel.conversion') : t('analysis:funnel.churn');

  return (
    <div className="funnel-view-settings">
      <Typography.Text strong className="funnel-view-settings__label">
        {t('analysis:funnel.rateMode')}
      </Typography.Text>
      <Radio.Group
        value={rateMode}
        onChange={(e) => onRateModeChange(e.target.value)}
        optionType="button"
        buttonStyle="solid"
        size="small"
        className="chrome-chip-group"
        options={[
          { label: t('analysis:funnel.conversion'), value: 'conversion' },
          { label: t('analysis:funnel.churn'), value: 'churn' },
        ]}
      />

      <Typography.Text strong className="funnel-view-settings__label">
        {t('analysis:funnel.direction')}
      </Typography.Text>
      <Radio.Group
        value={layout}
        onChange={(e) => onLayoutChange(e.target.value)}
        optionType="button"
        buttonStyle="solid"
        size="small"
        className="chrome-chip-group"
        options={[
          { label: t('analysis:funnel.horizontal'), value: 'horizontal' },
          { label: t('analysis:funnel.vertical'), value: 'vertical' },
        ]}
      />

      <Typography.Text strong className="funnel-view-settings__label">
        {t('analysis:funnel.tableColWidth')}
      </Typography.Text>
      <div className="funnel-view-settings-row">
        <InputNumber
          size="small"
          min={MIN_FUNNEL_TABLE_COL_CHARS}
          max={MAX_FUNNEL_TABLE_COL_CHARS}
          value={tableColChars}
          onChange={(v) => {
            if (v == null) return;
            onTableColCharsChange(parseFunnelTableColChars(v));
          }}
        />
        <span className="funnel-view-settings-row__text">
          {t('analysis:funnel.tableColChars', { min: MIN_FUNNEL_TABLE_COL_CHARS })}
        </span>
      </div>

      <Typography.Text strong className="funnel-view-settings__label">
        {t('analysis:funnel.defaultColor')}
      </Typography.Text>
      <HexSwatch value={color.default} onChange={(hex) => onColorChange({ ...color, default: hex })} />

      <Typography.Text strong className="funnel-view-settings__label">
        {t('analysis:funnel.rateBandsTitle', { rate: rateWord })}
      </Typography.Text>
      <Typography.Text type="secondary" className="funnel-view-settings__hint">
        {t('analysis:funnel.rateBandsHint')}
      </Typography.Text>

      {color.levels.map((level, index) => {
        const isTail = level.gte <= 0;
        const conversionMax = level.lt - 1;
        const showChurn = rateMode === 'churn';
        return (
          <div key={`${level.gte}-${level.lt}-${index}`} className="funnel-view-settings-row">
            {isTail ? (
              <>
                <span className="funnel-view-settings-row__text">
                  {showChurn ? t('analysis:funnel.above') : t('analysis:funnel.below')}
                </span>
                <InputNumber
                  size="small"
                  min={1}
                  max={99}
                  value={showChurn ? 100 - level.lt : level.lt}
                  onChange={(v) => {
                    if (v == null) return;
                    const nextLt = showChurn ? 100 - Number(v) : Number(v);
                    if (nextLt > 0 && nextLt <= 100) patchLevel(index, { lt: nextLt });
                  }}
                />
                <span className="funnel-view-settings-row__text">%</span>
              </>
            ) : (
              <>
                <InputNumber
                  size="small"
                  min={0}
                  max={99}
                  value={showChurn ? 101 - level.lt : level.gte}
                  onChange={(v) => {
                    if (v == null) return;
                    if (showChurn) {
                      const nextLt = 101 - Number(v);
                      if (nextLt > level.gte && nextLt <= 100) patchLevel(index, { lt: nextLt });
                    } else if (Number(v) < level.lt) {
                      patchLevel(index, { gte: Number(v) });
                    }
                  }}
                />
                <span className="funnel-view-settings-row__text">%</span>
                <span className="funnel-view-settings-row__text">~</span>
                <InputNumber
                  size="small"
                  min={0}
                  max={99}
                  value={showChurn ? 100 - level.gte : conversionMax}
                  onChange={(v) => {
                    if (v == null) return;
                    if (showChurn) {
                      const nextGte = 100 - Number(v);
                      if (nextGte >= 0 && nextGte < level.lt) patchLevel(index, { gte: nextGte });
                    } else {
                      const nextLt = Number(v) + 1;
                      if (nextLt > level.gte && nextLt <= 100) patchLevel(index, { lt: nextLt });
                    }
                  }}
                />
                <span className="funnel-view-settings-row__text">%</span>
              </>
            )}
            <HexSwatch value={level.color} onChange={(hex) => patchLevel(index, { color: hex })} />
            {rateMode === 'conversion' ? (
              <Typography.Text type="secondary" className="funnel-view-settings-row__eq">
                {t('analysis:funnel.churnBand', { band: churnBandLabel(level) })}
              </Typography.Text>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
