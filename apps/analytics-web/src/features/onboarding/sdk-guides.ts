/**
 * 接入指南内容真源（phase: clklog-analytics-onboarding-v2）。
 *
 * 约定：
 * - 已实测（ready）的 SDK 在页面内给**完整文档**（步骤 + 可复制代码 + 验证 + 常见问题），
 *   不指向仓库里的示例目录；未适配（planned）的只保留入口，点击提示「暂未开发」。
 * - 上报地址、表单字段、编码口径以《数据上报规范与流程.md》为准；项目 token 不在页面展示。
 * - 代码片段是**给接入方照抄用的**（与仓库内的测试骨架刻意解耦），但不得与协议冲突。
 *
 * i18n（phase: clklog-analytics-i18n-v1）：
 * - 正文（标题 / 步骤 / 提示 / 常见问题 / 含中文注释的代码块）全部落在 `onboarding` 命名空间。
 * - 组件内用工厂函数取值：`buildSdkGuides(t)`、`groupLabels(t)`、`statusLabels(t)`、
 *   `protocolFields(t)`、`encodingSample(t)`、`guidesByGroup(group, t)`——传当前语言的 `t`，
 *   语言切换后随重渲染刷新。
 * - 文件末尾的常量导出（`SDK_GUIDES` 等）按默认语言**一次性求值**，只服务既有内容契约测试与
 *   尚未迁移的调用方；新代码不要再引用它们。
 */

import { t as translate, type TFunction } from '../../i18n';
import { verifiedGuides } from './sdk-guides-verified';

export type SdkGroup = 'client' | 'server' | 'other';
/**
 * 卡片状态：
 * - `ready`   已实测（语言与运行环境都跑通过，页面内给完整文档）；
 * - `partial` 语言级已实测、目标平台未打包验证（小程序 / RN / Android / iOS / Cocos 引擎）；
 * - `planned` 未适配，只保留入口并提示「暂未开发」。
 */
export type SdkStatus = 'ready' | 'partial' | 'planned';

export interface CodeSample {
  lang: string;
  label?: string;
  code: string;
}

export interface GuideStep {
  title: string;
  body?: string;
  notes?: string[];
  codes?: CodeSample[];
}

export interface SdkGuide {
  key: string;
  name: string;
  group: SdkGroup;
  status: SdkStatus;
  /** 一句话定位：服务端 / 客户端 + 版本要求 */
  platform: string;
  summary: string;
  steps?: GuideStep[];
  faq?: { q: string; a: string }[];
}

/** 与平台同主机部署时，上报走当前站点的 /receiver/api/gp。示例工程里的默认地址另见 examples/report-sdk。 */
export function reportEndpoint(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}/receiver/api/gp`;
  }
  return 'https://example.com/receiver/api/gp';
}

/* ------------------------------ 页面级文案 ------------------------------ */

export function groupLabels(t: TFunction): Record<SdkGroup, string> {
  return {
    client: t('onboarding:group.client'),
    server: t('onboarding:group.server'),
    other: t('onboarding:group.other'),
  };
}

export function groupHints(t: TFunction): Record<SdkGroup, string> {
  return {
    client: t('onboarding:groupHint.client'),
    server: t('onboarding:groupHint.server'),
    other: t('onboarding:groupHint.other'),
  };
}

/** 状态徽标配色：已实测=绿；语言级已实测（平台未打包）=金；暂未开发=灰 */
export const STATUS_TAG_COLOR: Record<SdkStatus, string> = {
  ready: 'green',
  partial: 'gold',
  planned: 'default',
};

export function statusLabels(t: TFunction): Record<SdkStatus, string> {
  return {
    ready: t('onboarding:status.ready'),
    partial: t('onboarding:status.partial'),
    planned: t('onboarding:status.planned'),
  };
}

/** 协议三要素说明（页面顶部与各文档共用同一份口径） */
export function protocolFields(t: TFunction): { field: string; desc: string }[] {
  return [
    { field: 'project', desc: t('onboarding:protocol.project') },
    { field: 'token', desc: t('onboarding:protocol.token') },
    { field: 'data', desc: t('onboarding:protocol.data') },
  ];
}

export function encodingSample(t: TFunction): string {
  return t('onboarding:encodingSample');
}

/* ------------------------------ 文档内容 ------------------------------ */

function httpGuide(t: TFunction): SdkGuide {
  return {
    key: 'http',
    name: t('onboarding:guide.http.name'),
    group: 'other',
    status: 'ready',
    platform: t('onboarding:guide.http.platform'),
    summary: t('onboarding:guide.http.summary'),
    steps: [
      {
        title: t('onboarding:guide.http.step1Title'),
        body: t('onboarding:guide.http.step1Body'),
        codes: [
          {
            lang: 'bash',
            label: t('onboarding:guide.http.step1Code1Label'),
            code: t('onboarding:guide.http.step1Code1'),
          },
        ],
        notes: [t('onboarding:guide.http.step1Note1'), t('onboarding:guide.http.step1Note2')],
      },
      {
        title: t('onboarding:guide.http.step2Title'),
        body: t('onboarding:guide.http.step2Body'),
        codes: [
          {
            lang: 'json',
            label: t('onboarding:guide.http.step2Code1Label'),
            code: `{
  "type": "track",
  "event": "Purchase",
  "distinct_id": "u_1001",
  "time": 1785228036000,
  "identities": { "user_key": "user_9527" },
  "properties": {
    "order_id": "O20260915001",
    "amount": 99.5,
    "pay_type": "alipay"
  }
}`,
          },
        ],
      },
      {
        title: t('onboarding:guide.http.step3Title'),
        body: t('onboarding:guide.http.step3Body'),
        codes: [
          { lang: 'text', label: t('onboarding:guide.http.step3Code1Label'), code: encodingSample(t) },
        ],
        notes: [t('onboarding:guide.http.step3Note1'), t('onboarding:guide.http.step3Note2')],
      },
      {
        title: t('onboarding:guide.http.step4Title'),
        body: t('onboarding:guide.http.step4Body'),
        codes: [
          {
            lang: 'json',
            label: t('onboarding:guide.http.step4Code1Label'),
            code: `{
  "type": "track_signup",
  "event": "$SignUp",
  "distinct_id": "user_9527",
  "identities": { "user_key": "user_9527" },
  "properties": { "$track_signup_original_id": "u_1001" },
  "time": 1785228036000
}`,
          },
        ],
      },
      {
        title: t('onboarding:guide.http.step5Title'),
        body: t('onboarding:guide.http.step5Body'),
      },
      {
        title: t('onboarding:guide.http.step6Title'),
        body: t('onboarding:guide.http.step6Body'),
      },
    ],
    faq: [
      { q: t('onboarding:guide.http.faq1Q'), a: t('onboarding:guide.http.faq1A') },
      { q: t('onboarding:guide.http.faq2Q'), a: t('onboarding:guide.http.faq2A') },
      { q: t('onboarding:guide.http.faq3Q'), a: t('onboarding:guide.http.faq3A') },
      { q: t('onboarding:guide.http.faq4Q'), a: t('onboarding:guide.http.faq4A') },
    ],
  };
}

function phpGuide(t: TFunction): SdkGuide {
  return {
    key: 'php',
    name: t('onboarding:guide.php.name'),
    group: 'server',
    status: 'ready',
    platform: t('onboarding:guide.php.platform'),
    summary: t('onboarding:guide.php.summary'),
    steps: [
      {
        title: t('onboarding:guide.php.step1Title'),
        body: t('onboarding:guide.php.step1Body'),
        codes: [
          {
            lang: 'bash',
            label: t('onboarding:guide.php.step1Code1Label'),
            code: `php -v
php -m | grep curl`,
          },
        ],
      },
      {
        title: t('onboarding:guide.php.step2Title'),
        body: t('onboarding:guide.php.step2Body'),
        codes: [
          {
            lang: 'php',
            label: t('onboarding:guide.php.step2Code1Label'),
            code: t('onboarding:guide.php.step2Code1'),
          },
        ],
      },
      {
        title: t('onboarding:guide.php.step3Title'),
        body: t('onboarding:guide.php.step3Body'),
        codes: [
          {
            lang: 'php',
            label: t('onboarding:guide.php.step3Code1Label'),
            code: t('onboarding:guide.php.step3Code1'),
          },
        ],
      },
      {
        title: t('onboarding:guide.php.step4Title'),
        body: t('onboarding:guide.php.step4Body'),
        codes: [
          {
            lang: 'php',
            label: t('onboarding:guide.php.step4Code1Label'),
            code: t('onboarding:guide.php.step4Code1'),
          },
        ],
      },
      {
        title: t('onboarding:guide.php.step5Title'),
        body: t('onboarding:guide.php.step5Body'),
        codes: [
          {
            lang: 'php',
            label: t('onboarding:guide.php.step5Code1Label'),
            code: t('onboarding:guide.php.step5Code1'),
          },
        ],
        notes: [t('onboarding:guide.php.step5Note1'), t('onboarding:guide.php.step5Note2')],
      },
      {
        title: t('onboarding:guide.php.step6Title'),
        body: t('onboarding:guide.php.step6Body'),
      },
    ],
    faq: [
      { q: t('onboarding:guide.php.faq1Q'), a: t('onboarding:guide.php.faq1A') },
      { q: t('onboarding:guide.php.faq2Q'), a: t('onboarding:guide.php.faq2A') },
      { q: t('onboarding:guide.php.faq3Q'), a: t('onboarding:guide.php.faq3A') },
      { q: t('onboarding:guide.php.faq4Q'), a: t('onboarding:guide.php.faq4A') },
    ],
  };
}

function goGuide(t: TFunction): SdkGuide {
  return {
    key: 'go',
    name: t('onboarding:guide.go.name'),
    group: 'server',
    status: 'ready',
    platform: t('onboarding:guide.go.platform'),
    summary: t('onboarding:guide.go.summary'),
    steps: [
      {
        title: t('onboarding:guide.go.step1Title'),
        body: t('onboarding:guide.go.step1Body'),
        codes: [
          {
            lang: 'bash',
            label: t('onboarding:guide.go.step1Code1Label'),
            code: `go mod init your-service`,
          },
        ],
      },
      {
        title: t('onboarding:guide.go.step2Title'),
        body: t('onboarding:guide.go.step2Body'),
        codes: [
          {
            lang: 'go',
            label: t('onboarding:guide.go.step2Code1Label'),
            code: t('onboarding:guide.go.step2Code1'),
          },
        ],
      },
      {
        title: t('onboarding:guide.go.step3Title'),
        body: t('onboarding:guide.go.step3Body'),
        codes: [
          {
            lang: 'go',
            label: t('onboarding:guide.go.step3Code1Label'),
            code: t('onboarding:guide.go.step3Code1'),
          },
        ],
      },
      {
        title: t('onboarding:guide.go.step4Title'),
        body: t('onboarding:guide.go.step4Body'),
        codes: [
          {
            lang: 'go',
            label: t('onboarding:guide.go.step4Code1Label'),
            code: t('onboarding:guide.go.step4Code1'),
          },
        ],
      },
      {
        title: t('onboarding:guide.go.step5Title'),
        body: t('onboarding:guide.go.step5Body'),
        codes: [
          {
            lang: 'go',
            label: t('onboarding:guide.go.step5Code1Label'),
            code: t('onboarding:guide.go.step5Code1'),
          },
        ],
        notes: [t('onboarding:guide.go.step5Note1'), t('onboarding:guide.go.step5Note2')],
      },
      {
        title: t('onboarding:guide.go.step6Title'),
        body: t('onboarding:guide.go.step6Body'),
      },
    ],
    faq: [
      { q: t('onboarding:guide.go.faq1Q'), a: t('onboarding:guide.go.faq1A') },
      { q: t('onboarding:guide.go.faq2Q'), a: t('onboarding:guide.go.faq2A') },
      { q: t('onboarding:guide.go.faq3Q'), a: t('onboarding:guide.go.faq3A') },
      { q: t('onboarding:guide.go.faq4Q'), a: t('onboarding:guide.go.faq4A') },
    ],
  };
}

function unityGuide(t: TFunction): SdkGuide {
  return {
    key: 'unity',
    name: t('onboarding:guide.unity.name'),
    group: 'client',
    status: 'ready',
    platform: t('onboarding:guide.unity.platform'),
    summary: t('onboarding:guide.unity.summary'),
    steps: [
      {
        title: t('onboarding:guide.unity.step1Title'),
        body: t('onboarding:guide.unity.step1Body'),
        codes: [
          {
            lang: 'csharp',
            label: t('onboarding:guide.unity.step1Code1Label'),
            code: t('onboarding:guide.unity.step1Code1'),
          },
        ],
      },
      {
        title: t('onboarding:guide.unity.step2Title'),
        body: t('onboarding:guide.unity.step2Body'),
        codes: [
          {
            lang: 'csharp',
            label: t('onboarding:guide.unity.step2Code1Label'),
            code: t('onboarding:guide.unity.step2Code1'),
          },
        ],
      },
      {
        title: t('onboarding:guide.unity.step3Title'),
        body: t('onboarding:guide.unity.step3Body'),
        codes: [
          {
            lang: 'csharp',
            label: t('onboarding:guide.unity.step3Code1Label'),
            code: t('onboarding:guide.unity.step3Code1'),
          },
        ],
      },
      {
        title: t('onboarding:guide.unity.step4Title'),
        body: t('onboarding:guide.unity.step4Body'),
        codes: [
          {
            lang: 'csharp',
            label: t('onboarding:guide.unity.step4Code1Label'),
            code: t('onboarding:guide.unity.step4Code1'),
          },
        ],
      },
      {
        title: t('onboarding:guide.unity.step5Title'),
        body: t('onboarding:guide.unity.step5Body'),
        codes: [
          {
            lang: 'csharp',
            label: t('onboarding:guide.unity.step5Code1Label'),
            code: t('onboarding:guide.unity.step5Code1'),
          },
        ],
        notes: [t('onboarding:guide.unity.step5Note1'), t('onboarding:guide.unity.step5Note2')],
      },
      {
        title: t('onboarding:guide.unity.step6Title'),
        body: t('onboarding:guide.unity.step6Body'),
      },
    ],
    faq: [
      { q: t('onboarding:guide.unity.faq1Q'), a: t('onboarding:guide.unity.faq1A') },
      { q: t('onboarding:guide.unity.faq2Q'), a: t('onboarding:guide.unity.faq2A') },
      { q: t('onboarding:guide.unity.faq3Q'), a: t('onboarding:guide.unity.faq3A') },
      { q: t('onboarding:guide.unity.faq4Q'), a: t('onboarding:guide.unity.faq4A') },
    ],
  };
}

/* ------------------------------ 入口清单 ------------------------------ */

function plannedGuides(t: TFunction): SdkGuide[] {
  // 2026-10-08：各语言卡（含 Flutter，已实测语言 + Web 平台构建）与批量回补 CLI 都已实测，
  // 内容在 `sdk-guides-verified.ts`；这里只剩引擎本体未适配的 Unreal。
  return [
    {
      key: 'unreal',
      name: t('onboarding:planned.unreal.name'),
      group: 'client',
      status: 'planned',
      platform: t('onboarding:planned.unreal.platform'),
      summary: t('onboarding:planned.unreal.summary'),
    },
  ];
}

/** 全部入口（已实测 + 未适配）；组件内传当前语言的 `t` */
export function buildSdkGuides(t: TFunction): SdkGuide[] {
  return [
    httpGuide(t),
    phpGuide(t),
    goGuide(t),
    unityGuide(t),
    ...verifiedGuides(t),
    ...plannedGuides(t),
  ];
}

export function guidesByGroup(group: SdkGroup, t: TFunction = translate): SdkGuide[] {
  return buildSdkGuides(t).filter((guide) => guide.group === group);
}

export function findGuide(key: string, t: TFunction = translate): SdkGuide | undefined {
  return buildSdkGuides(t).find((guide) => guide.key === key);
}

/* ------------------------------ 兼容导出 ------------------------------ */

/**
 * 以下常量按默认语言一次性求值（模块在 i18n 初始化之后才被懒加载的路由引入）。
 * 只服务既有内容契约测试（`sdk-guides.spec.ts` 按 zh-CN 断言）与尚未迁移的调用方；
 * 组件内请改用上面的工厂函数，语言切换后不会刷新这些常量。
 */
export const GROUP_LABEL: Record<SdkGroup, string> = groupLabels(translate);
export const GROUP_HINT: Record<SdkGroup, string> = groupHints(translate);
export const STATUS_LABEL: Record<SdkStatus, string> = statusLabels(translate);
export const PROTOCOL_FIELDS: { field: string; desc: string }[] = protocolFields(translate);
export const ENCODING_SAMPLE: string = encodingSample(translate);
export const SDK_GUIDES: SdkGuide[] = buildSdkGuides(translate);
