/**
 * i18next 资源后端：按 `locales/<语言>/<命名空间>.json` 懒加载（Vite 按文件切 chunk）。
 *
 * 不用 fetch 而是 `import.meta.glob`：资源随构建产物打包，离线私有化环境同样可用，
 * 不依赖运行时静态文件服务路径（`/sa/assets/` 由 nginx 决定）。
 */
import { DEFAULT_LOCALE } from './config';

type JsonModule = { default: Record<string, unknown> };

const lazyLoaders = import.meta.glob<JsonModule>('./locales/*/*.json');

const cache = new Map<string, Record<string, unknown>>();

export const i18nBackend = {
  type: 'backend' as const,

  init(): void {
    /* 无初始化参数 */
  },

  read(
    language: string,
    namespace: string,
    callback: (error: unknown, data: Record<string, unknown> | false) => void,
  ): void {
    const loaderFor = (lng: string) => lazyLoaders[`./locales/${lng}/${namespace}.json`];

    const loader = loaderFor(language) ?? loaderFor(DEFAULT_LOCALE);
    if (!loader) {
      // 该语言与该命名空间都没有资源：交给 i18next 的回退链处理（显示 key）
      callback(null, false);
      return;
    }

    const cacheKey = `${language}/${namespace}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      callback(null, cached);
      return;
    }

    loader()
      .then((mod) => {
        const data = (mod.default ?? mod) as Record<string, unknown>;
        cache.set(cacheKey, data);
        callback(null, data);
      })
      .catch((error) => callback(error, false));
  },
};
