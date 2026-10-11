import { describe, expect, it } from 'vitest';
import { LOCALES, NAMESPACES } from './config';
import { i18n } from './index';

/**
 * 资源一致性（运行期版本）：`scripts/i18n_check.py` 在 CI 做同样的断言，
 * 这里保证「构建产物里真的有这些键」——懒加载 backend 与 glob 路径写错时会被本用例抓住。
 */
describe('locale resources', () => {
  const sourceLocale = LOCALES[0].tag;

  it('loads every namespace for every supported locale', async () => {
    for (const locale of LOCALES) {
      for (const ns of NAMESPACES) {
        const bundle = i18n.getResourceBundle(locale.tag, ns) as Record<string, unknown> | undefined;
        expect(bundle, `${locale.tag}/${ns}`).toBeTruthy();
      }
    }
  });

  it('has identical key sets across locales', () => {
    // 复数变体（_one/_few/_many/_other）允许按语言追加，比较前先剥掉后缀：
    // 基础键是所有语言必须一致的「兜底形态」，变体只影响该语言的复数渲染。
    const stripPlural = (key: string) => key.replace(/_(zero|one|two|few|many|other)$/, '');
    const flatten = (obj: Record<string, unknown>, prefix = ''): string[] =>
      Object.entries(obj).flatMap(([key, value]) =>
        value && typeof value === 'object'
          ? flatten(value as Record<string, unknown>, `${prefix}${key}.`)
          : [stripPlural(`${prefix}${key}`)],
      );
    // 复数变体折叠后会出现同名基础键（ru 的四形态 → 同一基础键），比较前必须去重
    const uniqueKeys = (obj: Record<string, unknown>) => [...new Set(flatten(obj))].sort();

    for (const ns of NAMESPACES) {
      const source = uniqueKeys(i18n.getResourceBundle(sourceLocale, ns) as Record<string, unknown>);
      for (const locale of LOCALES.slice(1)) {
        const other = uniqueKeys(i18n.getResourceBundle(locale.tag, ns) as Record<string, unknown>);
        expect(other, `${locale.tag}/${ns}`).toEqual(source);
      }
    }
  });

  it('renders the shell and error namespaces with the platform default language', () => {
    expect(i18n.t('shell:menu.report', { lng: sourceLocale })).toBe('报表');
    expect(i18n.t('errors:requestFailed', { lng: sourceLocale })).toBe('请求失败');
    expect(i18n.t('shell:menu.report', { lng: 'en-US' })).toBe('Reports');
  });
});
