/**
 * i18n 实例与对外 API（前端唯一入口）。
 *
 * 用法：
 * - 组件内：`const { t } = useT('report')`，键写全限定形式 `t('report:dashboard.create')`。
 * - 组件外（service / store / toast）：`import { t } from '../i18n'` 取当前语言的文案（不订阅变化，
 *   适合一次性提示；需要随语言刷新的内容必须在组件内用 useT）。
 * - 应用启动：`await initI18n()` 之后再 render，保证首屏没有「键闪烁」。
 */
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { DEFAULT_LOCALE, NAMESPACES, resolveLocale } from './config';
import { i18nBackend } from './backend';
import { detectInitialLocale, writeStoredLocale } from './detect';

export const i18n = i18next;

const initPromise = i18n
  .use(i18nBackend)
  .use(initReactI18next)
  .init({
    lng: detectInitialLocale(),
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: undefined,
    defaultNS: 'common',
    ns: [...NAMESPACES],
    backend: {},
    interpolation: { escapeValue: false },
    returnNull: false,
    // 资源全部经 backend 懒加载，启动时统一预载（见 initI18n），组件内不需要 Suspense 边界
    react: { useSuspense: false },
    saveMissing: false,
  });

/**
 * 预载命名空间：只加载**尚未就绪**的那些。
 *
 * 为什么要判 `hasLoadedNamespace`：测试环境（`vitest.setup.ts`）会先把资源直接灌进实例，
 * 若无条件 `loadNamespaces` 会触发 backend 的 `import.meta.glob` 动态导入，
 * 在 95 个测试文件里各跑一遍，把整轮测试拖慢数十倍（实测 setup 从 11s 涨到 640s）。
 */
async function ensureNamespaces(): Promise<void> {
  const pending = NAMESPACES.filter((ns) => !i18n.hasLoadedNamespace(ns));
  if (pending.length) await i18n.loadNamespaces([...pending]);
}

/** 应用启动调用：等实例就绪 + 预载当前语言的全部命名空间，避免键闪烁 */
export async function initI18n(): Promise<void> {
  await initPromise;
  await ensureNamespaces();
}

/** 当前语言（已支持的语言标签） */
export function currentLocale(): string {
  return resolveLocale(i18n.language) ?? DEFAULT_LOCALE;
}

/**
 * 切换语言：落本地偏好 → 切换 → 预载目标语言资源。
 * 服务端偏好同步由调用方负责（登录用户走 `PUT /auth/preferences`），保持本包不依赖 service。
 */
export async function changeLocale(tag: string): Promise<string> {
  const target = resolveLocale(tag) ?? DEFAULT_LOCALE;
  writeStoredLocale(target);
  if (target !== i18n.language) {
    await i18n.changeLanguage(target);
  }
  await ensureNamespaces();
  return target;
}

/**
 * 应用登录用户的语言偏好（登录成功后调用）。
 * 用户显式选过语言（本地偏好与服务端一致或用户本次刚改）时不会被覆盖——
 * 服务端偏好是账号权威值，登录/换设备时应当生效，故这里以服务端值为准。
 */
export async function applyUserLocale(tag: string | null | undefined): Promise<void> {
  const target = resolveLocale(tag);
  if (!target) return;
  if (target === currentLocale()) {
    writeStoredLocale(target);
    return;
  }
  await changeLocale(target);
}

/** 组件外用：取当前语言文案（不订阅语言变化） */
export const t = i18next.t.bind(i18next);

export { useT } from './useT';
// 注意：LocaleBridge / LocaleSelect 不在这里再导出——它们依赖 antd，
// 一旦从本入口导出，任何 `import { i18n } from '../i18n'` 都会把 antd 拉进模块图
// （实测让每个测试文件的 setup 从 0.1s 涨到 1.5s）。UI 组件请从各自路径导入。
export type { TFunction } from 'i18next';
export type { Namespace } from './config';
export { LOCALES, DEFAULT_LOCALE, NAMESPACES, LOCALE_TAGS, resolveLocale, localeDef, isSupportedLocale } from './config';
export { detectLocale, browserLocales, readStoredLocale, writeStoredLocale, LOCALE_STORAGE_KEY } from './detect';
