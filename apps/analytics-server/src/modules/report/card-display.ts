import { badRequest } from '../../i18n/domain-error';

export const CARD_DISPLAY_VIEWS: Record<string, readonly string[]> = {
  retention: ['nth_trend', 'people_table', 'rate_table'],
  event: ['line', 'trend', 'bar', 'stack', 'cumulative', 'distribution', 'pie', 'number', 'table'],
  funnel: ['chart', 'table'],
  sql: ['line', 'trend', 'bar', 'pie', 'number', 'table'],
};

export interface CardDisplay {
  view: string;
}

export function parseStoredDisplay(raw: string | null | undefined): CardDisplay | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const view = (parsed as { view?: unknown }).view;
    if (typeof view !== 'string' || !view) return null;
    return { view };
  } catch {
    return null;
  }
}

export function assertCardDisplay(type: string, input: unknown): CardDisplay {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw badRequest({
      code: 'report.card.displayNotObject',
      messageKey: 'report:error.card.displayNotObject',
      message: 'display 必须是对象',
    });
  }
  const rec = input as Record<string, unknown>;
  const extra = Object.keys(rec).filter((key) => key !== 'view');
  if (extra.length) {
    throw badRequest({
      code: 'report.card.displayExtraKeys',
      messageKey: 'report:error.card.displayExtraKeys',
      params: { keys: extra.join(',') },
      message: `display 含非法键: ${extra.join(',')}`,
    });
  }
  const allowed = CARD_DISPLAY_VIEWS[type];
  if (!allowed) {
    throw badRequest({
      code: 'report.card.displayUnsupported',
      messageKey: 'report:error.card.displayUnsupported',
      params: { type },
      message: `${type} 卡片不支持展示设置`,
    });
  }
  if (typeof rec.view !== 'string' || !allowed.includes(rec.view)) {
    throw badRequest({
      code: 'report.card.displayViewInvalid',
      messageKey: 'report:error.card.displayViewInvalid',
      message: 'display.view 不合法',
    });
  }
  return { view: rec.view };
}
