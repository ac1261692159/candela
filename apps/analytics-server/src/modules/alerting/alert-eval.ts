export type Comparator = 'gt' | 'gte' | 'lt' | 'lte';
export type Severity = 'critical' | 'warning' | 'info';

export function compare(value: number, op: Comparator, threshold: number): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(threshold)) return false;
  if (op === 'gt') return value > threshold;
  if (op === 'gte') return value >= threshold;
  if (op === 'lt') return value < threshold;
  return value <= threshold;
}

export function requiredPolls(windowMinutes: number, forWindows: number): number {
  const window = Number.isFinite(windowMinutes) && windowMinutes > 0 ? Math.floor(windowMinutes) : 1;
  const count = Number.isFinite(forWindows) && forWindows > 0 ? Math.floor(forWindows) : 1;
  return Math.max(1, window * count);
}

export function nextStreak(previous: number, hit: boolean): number {
  if (!hit) return 0;
  return (Number.isFinite(previous) && previous > 0 ? previous : 0) + 1;
}

export function opLabel(op: Comparator): string {
  if (op === 'gt') return '>';
  if (op === 'gte') return '>=';
  if (op === 'lt') return '<';
  return '<=';
}

const FEISHU = /^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+$/;
const LARK = /^https:\/\/open\.larksuite\.com\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+$/;

export function isFeishuWebhook(url: string): boolean {
  return FEISHU.test(url) || LARK.test(url);
}

export function maskWebhook(url: string): string {
  return maskUrlTail(url);
}

/** 通用 URL 脱敏：保留 https://host/路径前缀，尾段只留末 4 位（token 大概率在尾段） */
export function maskUrlTail(url: string): string {
  const value = String(url ?? '').trim();
  if (!value) return '';
  const match = value.match(/^(https?:\/\/[^/]+\/)([^?#]*?)([^/?#]+)((?:[?#].*)?)$/);
  if (!match) return 'https://***';
  const [, origin, prefix, tail, suffix] = match;
  const masked = tail.length <= 4 ? '****' : `***${tail.slice(-4)}`;
  return `${origin}${prefix}${masked}${suffix}`;
}

/** 需要按 Webhook URL 脱敏的通道（凭证在 URL 里） */
const URL_KINDS = new Set([
  'feishu_webhook',
  'dingtalk',
  'wecom',
  'webhook',
]);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MOBILE = /^1\d{10}$/;

export function isEmailAddress(value: string): boolean {
  return EMAIL.test(value.trim());
}

export function isMobileNumber(value: string): boolean {
  return MOBILE.test(value.trim());
}

export function maskAddress(kind: string, value: string): string {
  if (URL_KINDS.has(kind)) return maskUrlTail(value);
  if (kind === 'email' || /@/.test(String(value ?? ''))) {
    const [user, domain] = String(value ?? '').split('@');
    if (!domain) return '***';
    const head = user.slice(0, Math.min(2, user.length));
    return `${head}***@${domain}`;
  }
  // 手机号 / chat_id / WhatsApp 号码：保留首尾便于核对
  const digits = String(value ?? '').trim();
  if (!digits) return '';
  if (digits.length <= 4) return '****';
  return `${digits.slice(0, 3)}${'*'.repeat(Math.max(1, digits.length - 7))}${digits.slice(-4)}`;
}

export function resolveMuteWindow(input: {
  duration_hours?: number;
  starts_at?: string;
  ends_at?: string;
  now?: Date;
}): { starts: Date; ends: Date } | null {
  const now = input.now ?? new Date();
  if (input.duration_hours != null) {
    const hours = Math.floor(Number(input.duration_hours));
    if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 30) return null;
    return { starts: now, ends: new Date(now.getTime() + hours * 3600_000) };
  }
  if (!input.starts_at || !input.ends_at) return null;
  const starts = new Date(input.starts_at);
  const ends = new Date(input.ends_at);
  if (!Number.isFinite(starts.getTime()) || !Number.isFinite(ends.getTime()) || ends <= starts) {
    return null;
  }
  return { starts, ends };
}
