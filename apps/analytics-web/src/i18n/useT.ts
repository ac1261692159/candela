/**
 * 组件内取翻译函数。键一律写全限定形式 `t('report:dashboard.create')`，
 * 命名空间参数只用于声明「本组件依赖哪些命名空间」（资源在启动时已全量预载）。
 */
import { useTranslation } from 'react-i18next';
import type { Namespace } from './config';

export function useT(...namespaces: Namespace[]) {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- 包装 useTranslation，调用点仍在组件内
  return useTranslation(namespaces.length ? [...namespaces] : undefined);
}

export type { TFunction } from 'i18next';
