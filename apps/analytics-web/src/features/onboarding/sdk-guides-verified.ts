/**
 * 已实测语言的接入文档（phase: clklog-analytics-sdk-verified-v1）。
 *
 * 背景：接入指南里原来只有 http / php / go / unity 四张卡是「已实测」（页面内给完整文档），
 * 其余 12 种语言与 5 个平台入口都是「暂未开发」。本次把各语言**真实跑通**（5 步事件链落
 * ClickHouse）后翻状态，并按页面既有约定给**页面内完整文档**（不指向仓库示例目录，
 * 见 `sdk-guides.spec.ts` 的路径回归防护）。
 *
 * 设计：
 * - 协议五步对所有语言是一样的（编码 → 表单 → 批次 → 身份 → 验证），因此步骤标题与说明放在
 *   `onboarding:guideCommon.*` **只翻译一次**；每张卡只提供四段语言特有内容：
 *   `platform`（端 + 运行时要求 + 实测层级）、`summary`（一句话定位）、
 *   `note1`（该语言实测踩到的坑）、`faq1Q/faq1A`（把这个坑讲清楚）。
 * - 代码片段（运行依赖 + 上报核心）在 `sdk-code-samples.ts`，是各语言示例的**摘录**，
 *   注释统一英文：代码不是散文，翻译 13 份只会让资源漂移。
 * - 卡片名复用 `onboarding:planned.<key>.name`（这些卡原是 planned，名字已翻译好，
 *   不必为同一批名字再翻译一遍）。
 *
 * 状态语义（见 `sdk-types` 旁的 `SdkStatus`）：
 * - `ready`   语言与运行环境都已实测（服务端语言、Web H5 在真实浏览器里跑过）；
 * - `partial` 语言级实现已实测，但目标平台未打包验证（小程序/RN/Android/iOS/Cocos 引擎）。
 */

import { t as translate, type TFunction } from '../../i18n';
import {
  BATCH_IMPORT_CMD,
  BATCH_IMPORT_CSV,
  BATCH_IMPORT_VERIFY,
  SDK_CODE_SAMPLES,
  type SdkCodeKey,
} from './sdk-code-samples';
import type { SdkGroup, SdkGuide, SdkStatus } from './sdk-guides';

type VerifiedStatus = Extract<SdkStatus, 'ready' | 'partial'>;

interface VerifiedSpec {
  /** 卡片 key（与 `onboarding:planned.<key>.name` 一致） */
  key: string;
  /** 代码片段键；Cocos2d-x 复用 C++ 片段 */
  codeKey: SdkCodeKey;
  /** 代码块语言标记 */
  codeLang: string;
  group: SdkGroup;
  status: VerifiedStatus;
}

/** 每张卡的 i18n 键（写成字面量，便于 `scripts/i18n_check.py` 校验键存在） */
interface CardKeys {
  name: string;
  platform: string;
  summary: string;
  note1: string;
  faq1Q: string;
  faq1A: string;
}

const CARD_KEYS: Record<string, CardKeys> = {
  javascript: {
    name: 'onboarding:planned.javascript.name',
    platform: 'onboarding:guide.javascript.platform',
    summary: 'onboarding:guide.javascript.summary',
    note1: 'onboarding:guide.javascript.note1',
    faq1Q: 'onboarding:guide.javascript.faq1Q',
    faq1A: 'onboarding:guide.javascript.faq1A',
  },
  miniprogram: {
    name: 'onboarding:planned.miniprogram.name',
    platform: 'onboarding:guide.miniprogram.platform',
    summary: 'onboarding:guide.miniprogram.summary',
    note1: 'onboarding:guide.miniprogram.note1',
    faq1Q: 'onboarding:guide.miniprogram.faq1Q',
    faq1A: 'onboarding:guide.miniprogram.faq1A',
  },
  'react-native': {
    name: 'onboarding:planned.reactNative.name',
    platform: 'onboarding:guide.reactNative.platform',
    summary: 'onboarding:guide.reactNative.summary',
    note1: 'onboarding:guide.reactNative.note1',
    faq1Q: 'onboarding:guide.reactNative.faq1Q',
    faq1A: 'onboarding:guide.reactNative.faq1A',
  },
  android: {
    name: 'onboarding:planned.android.name',
    platform: 'onboarding:guide.android.platform',
    summary: 'onboarding:guide.android.summary',
    note1: 'onboarding:guide.android.note1',
    faq1Q: 'onboarding:guide.android.faq1Q',
    faq1A: 'onboarding:guide.android.faq1A',
  },
  ios: {
    name: 'onboarding:planned.ios.name',
    platform: 'onboarding:guide.ios.platform',
    summary: 'onboarding:guide.ios.summary',
    note1: 'onboarding:guide.ios.note1',
    faq1Q: 'onboarding:guide.ios.faq1Q',
    faq1A: 'onboarding:guide.ios.faq1A',
  },
  java: {
    name: 'onboarding:planned.java.name',
    platform: 'onboarding:guide.java.platform',
    summary: 'onboarding:guide.java.summary',
    note1: 'onboarding:guide.java.note1',
    faq1Q: 'onboarding:guide.java.faq1Q',
    faq1A: 'onboarding:guide.java.faq1A',
  },
  python: {
    name: 'onboarding:planned.python.name',
    platform: 'onboarding:guide.python.platform',
    summary: 'onboarding:guide.python.summary',
    note1: 'onboarding:guide.python.note1',
    faq1Q: 'onboarding:guide.python.faq1Q',
    faq1A: 'onboarding:guide.python.faq1A',
  },
  nodejs: {
    name: 'onboarding:planned.nodejs.name',
    platform: 'onboarding:guide.nodejs.platform',
    summary: 'onboarding:guide.nodejs.summary',
    note1: 'onboarding:guide.nodejs.note1',
    faq1Q: 'onboarding:guide.nodejs.faq1Q',
    faq1A: 'onboarding:guide.nodejs.faq1A',
  },
  csharp: {
    name: 'onboarding:planned.csharp.name',
    platform: 'onboarding:guide.csharp.platform',
    summary: 'onboarding:guide.csharp.summary',
    note1: 'onboarding:guide.csharp.note1',
    faq1Q: 'onboarding:guide.csharp.faq1Q',
    faq1A: 'onboarding:guide.csharp.faq1A',
  },
  ruby: {
    name: 'onboarding:planned.ruby.name',
    platform: 'onboarding:guide.ruby.platform',
    summary: 'onboarding:guide.ruby.summary',
    note1: 'onboarding:guide.ruby.note1',
    faq1Q: 'onboarding:guide.ruby.faq1Q',
    faq1A: 'onboarding:guide.ruby.faq1A',
  },
  c: {
    name: 'onboarding:planned.c.name',
    platform: 'onboarding:guide.c.platform',
    summary: 'onboarding:guide.c.summary',
    note1: 'onboarding:guide.c.note1',
    faq1Q: 'onboarding:guide.c.faq1Q',
    faq1A: 'onboarding:guide.c.faq1A',
  },
  lua: {
    name: 'onboarding:planned.lua.name',
    platform: 'onboarding:guide.lua.platform',
    summary: 'onboarding:guide.lua.summary',
    note1: 'onboarding:guide.lua.note1',
    faq1Q: 'onboarding:guide.lua.faq1Q',
    faq1A: 'onboarding:guide.lua.faq1A',
  },
  flutter: {
    name: 'onboarding:planned.flutter.name',
    platform: 'onboarding:guide.flutter.platform',
    summary: 'onboarding:guide.flutter.summary',
    note1: 'onboarding:guide.flutter.note1',
    faq1Q: 'onboarding:guide.flutter.faq1Q',
    faq1A: 'onboarding:guide.flutter.faq1A',
  },
  'cocos2d-x': {
    name: 'onboarding:planned.cocos2dX.name',
    platform: 'onboarding:guide.cocos2dX.platform',
    summary: 'onboarding:guide.cocos2dX.summary',
    note1: 'onboarding:guide.cocos2dX.note1',
    faq1Q: 'onboarding:guide.cocos2dX.faq1Q',
    faq1A: 'onboarding:guide.cocos2dX.faq1A',
  },
};

const SPECS: VerifiedSpec[] = [
  { key: 'javascript', codeKey: 'javascript', codeLang: 'javascript', group: 'client', status: 'ready' },
  { key: 'miniprogram', codeKey: 'miniprogram', codeLang: 'javascript', group: 'client', status: 'partial' },
  { key: 'react-native', codeKey: 'react-native', codeLang: 'javascript', group: 'client', status: 'partial' },
  { key: 'android', codeKey: 'android', codeLang: 'java', group: 'client', status: 'partial' },
  { key: 'ios', codeKey: 'ios', codeLang: 'swift', group: 'client', status: 'partial' },
  { key: 'flutter', codeKey: 'flutter', codeLang: 'dart', group: 'client', status: 'ready' },
  { key: 'cocos2d-x', codeKey: 'cpp', codeLang: 'cpp', group: 'client', status: 'partial' },
  { key: 'java', codeKey: 'java', codeLang: 'java', group: 'server', status: 'ready' },
  { key: 'python', codeKey: 'python', codeLang: 'python', group: 'server', status: 'ready' },
  { key: 'nodejs', codeKey: 'nodejs', codeLang: 'javascript', group: 'server', status: 'ready' },
  { key: 'csharp', codeKey: 'csharp', codeLang: 'csharp', group: 'server', status: 'ready' },
  { key: 'ruby', codeKey: 'ruby', codeLang: 'ruby', group: 'server', status: 'ready' },
  { key: 'c', codeKey: 'c', codeLang: 'c', group: 'server', status: 'ready' },
  { key: 'lua', codeKey: 'lua', codeLang: 'lua', group: 'server', status: 'ready' },
];

/** 验证 SQL（与《数据上报规范与流程.md》§10.1 同一口径；页面不写仓库路径） */
const VERIFY_SQL = `SELECT typeContext, event, distinct_id, user_key, is_logined, track_signup_original_id
FROM clklog.log_analysis
WHERE distinct_id LIKE '%<run_id>%'
ORDER BY log_time`;

function buildGuide(spec: VerifiedSpec, t: TFunction): SdkGuide {
  const codes = SDK_CODE_SAMPLES[spec.codeKey];
  const keys = CARD_KEYS[spec.key];
  return {
    key: spec.key,
    name: t(keys.name),
    group: spec.group,
    status: spec.status,
    platform: t(keys.platform),
    summary: t(keys.summary),
    steps: [
      {
        title: t('onboarding:guideCommon.step1Title'),
        body: t('onboarding:guideCommon.step1Body'),
      },
      {
        title: t('onboarding:guideCommon.step2Title'),
        body: t('onboarding:guideCommon.step2Body'),
        codes: [{ lang: 'bash', label: t('onboarding:guideCommon.step2Code1Label'), code: codes.deps }],
      },
      {
        title: t('onboarding:guideCommon.step3Title'),
        body: t('onboarding:guideCommon.step3Body'),
        codes: [{ lang: spec.codeLang, label: t('onboarding:guideCommon.step3Code1Label'), code: codes.core }],
      },
      {
        title: t('onboarding:guideCommon.step4Title'),
        body: t('onboarding:guideCommon.step4Body'),
        notes: [t(keys.note1)],
      },
      {
        title: t('onboarding:guideCommon.step5Title'),
        body: t('onboarding:guideCommon.step5Body'),
        codes: [{ lang: 'sql', label: t('onboarding:guideCommon.step5Code1Label'), code: VERIFY_SQL }],
      },
    ],
    faq: [
      { q: t('onboarding:guideCommon.faq1Q'), a: t('onboarding:guideCommon.faq1A') },
      { q: t('onboarding:guideCommon.faq2Q'), a: t('onboarding:guideCommon.faq2A') },
      { q: t(keys.faq1Q), a: t(keys.faq1A) },
    ],
  };
}


/* ---------------------- 批量回补（文件导入）专用文档 ---------------------- */

/**
 * 批量回补不是「SDK 接入」：它的五步是「准备文件 → 试跑 → 回补 → 断点续跑 → 核对落库」，
 * 与 `guideCommon.*`（协议编码五步）语义不同，所以这里单独一组键，不硬塞公共步骤。
 * 代码样例（CSV 规范 / 命令 / 核对 SQL）在 `sdk-code-samples.ts` 的 `BATCH_IMPORT_*`，
 * CSV 与命令两段都在本机用 `--dry-run` 实跑过。
 */
const BATCH_IMPORT_KEYS = {
  name: 'onboarding:planned.batchImport.name',
  platform: 'onboarding:guide.batchImport.platform',
  summary: 'onboarding:guide.batchImport.summary',
  step1Title: 'onboarding:guide.batchImport.step1Title',
  step1Body: 'onboarding:guide.batchImport.step1Body',
  step1Code1Label: 'onboarding:guide.batchImport.step1Code1Label',
  step2Title: 'onboarding:guide.batchImport.step2Title',
  step2Body: 'onboarding:guide.batchImport.step2Body',
  step2Code1Label: 'onboarding:guide.batchImport.step2Code1Label',
  step3Title: 'onboarding:guide.batchImport.step3Title',
  step3Body: 'onboarding:guide.batchImport.step3Body',
  step3Code1Label: 'onboarding:guide.batchImport.step3Code1Label',
  step4Title: 'onboarding:guide.batchImport.step4Title',
  step4Body: 'onboarding:guide.batchImport.step4Body',
  note1: 'onboarding:guide.batchImport.note1',
  step5Title: 'onboarding:guide.batchImport.step5Title',
  step5Body: 'onboarding:guide.batchImport.step5Body',
  step5Code1Label: 'onboarding:guide.batchImport.step5Code1Label',
  faq1Q: 'onboarding:guide.batchImport.faq1Q',
  faq1A: 'onboarding:guide.batchImport.faq1A',
  faq2Q: 'onboarding:guide.batchImport.faq2Q',
  faq2A: 'onboarding:guide.batchImport.faq2A',
} as const;

function batchImportGuide(t: TFunction): SdkGuide {
  const k = BATCH_IMPORT_KEYS;
  return {
    key: 'batch-import',
    name: t(k.name),
    group: 'other',
    status: 'ready',
    platform: t(k.platform),
    summary: t(k.summary),
    steps: [
      {
        title: t(k.step1Title),
        body: t(k.step1Body),
        codes: [
          { lang: 'csv', label: t(k.step1Code1Label), code: BATCH_IMPORT_CSV },
        ],
      },
      {
        title: t(k.step2Title),
        body: t(k.step2Body),
        codes: [
          { lang: 'bash', label: t(k.step2Code1Label), code: BATCH_IMPORT_CMD },
        ],
      },
      {
        title: t(k.step3Title),
        body: t(k.step3Body),
        codes: [
          { lang: 'bash', label: t(k.step3Code1Label), code: BATCH_IMPORT_CMD },
        ],
      },
      {
        title: t(k.step4Title),
        body: t(k.step4Body),
        notes: [t(k.note1)],
      },
      {
        title: t(k.step5Title),
        body: t(k.step5Body),
        codes: [
          { lang: 'sql', label: t(k.step5Code1Label), code: BATCH_IMPORT_VERIFY },
        ],
      },
    ],
    faq: [
      { q: t(k.faq1Q), a: t(k.faq1A) },
      { q: t(k.faq2Q), a: t(k.faq2A) },
      { q: t('onboarding:guideCommon.faq1Q'), a: t('onboarding:guideCommon.faq1A') },
    ],
  };
}

/** 已实测的卡片（语言 + 批量回补）；组件内传当前语言的 `t` */
export function verifiedGuides(t: TFunction): SdkGuide[] {
  return [...SPECS.map((spec) => buildGuide(spec, t)), batchImportGuide(t)];
}

/** 这些 key 不再出现在「暂未开发」清单里 */
export const VERIFIED_CARD_KEYS = SPECS.map((spec) => spec.key);

/** 兼容导出（默认语言一次性求值，只服务既有内容契约测试） */
export const VERIFIED_GUIDES: SdkGuide[] = verifiedGuides(translate);
