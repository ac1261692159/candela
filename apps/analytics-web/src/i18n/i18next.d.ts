/**
 * i18next 模块增强。
 *
 * 说明（与架构文档 §5.3 的差异，已登记）：i18next v23 的 `CustomTypeOptions.resources`
 * 在「多命名空间 + 全限定键（`ns:key`）」组合下不生成带命名空间前缀的键类型，
 * 强行开启会导致 `t('shell:document.title')` 全部报类型错。因此本项目**不启用键的编译期类型**，
 * 改用 `scripts/i18n_check.py` 做键存在性 / 语言一致性校验（更贴近运行时真相）。
 *
 * 保留本文件用于模块增强（命名空间类型导出），便于后续按需补回类型能力。
 */
import 'i18next';
import type { Namespace } from './config';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    returnNull: false;
    ns: Namespace;
  }
}
