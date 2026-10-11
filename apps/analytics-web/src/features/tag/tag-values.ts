import { type TFunction } from '../../i18n';

export function tagValueOptions(definition: Record<string, unknown> | undefined): string[] {
  if (!definition) return [];
  const rules = Array.isArray(definition.rules) ? definition.rules : [];
  const values: string[] = [];
  const seen = new Set<string>();
  const push = (value: unknown) => {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    values.push(trimmed);
  };
  for (const rule of rules) {
    if (rule && typeof rule === 'object' && !Array.isArray(rule)) {
      push((rule as { value?: unknown }).value);
    }
  }
  push(definition.default_value);
  return values;
}

export function stampTagNames(t: TFunction) {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return { display_name: t('cohort:defaultName.tag', { stamp }), name: `tag_${stamp}` };
}
