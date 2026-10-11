/**
 * 接入指南内容契约测试（phase: clklog-analytics-onboarding-v2，PRD O-1~O-7）。
 *
 * 这些断言是**防回归的护栏**：内容从「指向仓库示例目录」改成「页面内自包含文档」之后，
 * 不能再退回去；未适配的 SDK 也不能悄悄长出半截文档。
 */
import { describe, expect, it } from 'vitest';
import {
  ENCODING_SAMPLE,
  PROTOCOL_FIELDS,
  SDK_GUIDES,
  guidesByGroup,
  type SdkGuide,
} from './sdk-guides';

/** 全部可见正文（含代码、常见问题），用来做跨条目的内容断言 */
function allText(guides: SdkGuide[] = SDK_GUIDES): string {
  return guides
    .map((guide) => {
      const steps = (guide.steps ?? []).map((step) => {
        const codes = (step.codes ?? []).map((sample) => sample.code).join('\n');
        return `${step.title}\n${step.body ?? ''}\n${(step.notes ?? []).join('\n')}\n${codes}`;
      });
      const faq = (guide.faq ?? []).map((item) => `${item.q}\n${item.a}`);
      return [guide.name, guide.platform, guide.summary, ...steps, ...faq].join('\n');
    })
    .join('\n');
}

const READY = SDK_GUIDES.filter((guide) => guide.status === 'ready');
const PARTIAL = SDK_GUIDES.filter((guide) => guide.status === 'partial');
const PLANNED = SDK_GUIDES.filter((guide) => guide.status === 'planned');

describe('SDK 入口清单（O-1）', () => {
  it('三组入口都存在，且客户端/服务端各不少于 9 个', () => {
    const client = guidesByGroup('client');
    const server = guidesByGroup('server');
    const other = guidesByGroup('other');

    expect(client.length).toBeGreaterThanOrEqual(9);
    expect(server.length).toBeGreaterThanOrEqual(9);
    expect(other.length).toBeGreaterThanOrEqual(2);
  });

  it('key 唯一，且每个条目都有名称/定位/摘要', () => {
    const keys = SDK_GUIDES.map((guide) => guide.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const guide of SDK_GUIDES) {
      expect(guide.name.length).toBeGreaterThan(0);
      expect(guide.platform.length).toBeGreaterThan(0);
      expect(guide.summary.length).toBeGreaterThan(0);
      expect(guide.group).toMatch(/^(client|server|other)$/);
    }
  });

  it('已实测条目正好是语言与运行环境都跑通过的那些接入方式', () => {
    // 2026-10-08：各语言示例真实跑通（5 步事件链落 ClickHouse）后由 planned 翻为 ready，
    // 清单在这里钉死，避免「代码里加了文档但状态没翻」或反过来。
    expect(READY.map((guide) => guide.key).sort()).toEqual([
      'batch-import',
      'c',
      'csharp',
      'flutter',
      'go',
      'http',
      'java',
      'javascript',
      'lua',
      'nodejs',
      'php',
      'python',
      'ruby',
      'unity',
    ]);
  });

  it('语言级已实测（平台未打包验证）的条目正好是这五个', () => {
    // 小程序 / RN / Android / iOS / Cocos 引擎：语言级实现实测通过，但目标平台没有环境打包验证，
    // 状态用 partial 而不是 ready，避免把「语言级」说成「已实测」。
    expect(PARTIAL.map((guide) => guide.key).sort()).toEqual([
      'android',
      'cocos2d-x',
      'ios',
      'miniprogram',
      'react-native',
    ]);
    for (const guide of PARTIAL) {
      expect(guide.steps?.length ?? 0).toBeGreaterThanOrEqual(5);
      expect(guide.summary.length).toBeGreaterThan(0);
    }
  });
});

describe('已实测条目必须有完整文档（O-2/O-6）', () => {
  it('每份文档至少 5 个步骤、至少 2 段可复制代码', () => {
    for (const guide of READY) {
      expect(guide.steps?.length ?? 0).toBeGreaterThanOrEqual(5);
      const codes = (guide.steps ?? []).flatMap((step) => step.codes ?? []);
      expect(codes.length).toBeGreaterThanOrEqual(2);
      for (const sample of codes) {
        expect(sample.code.trim().length).toBeGreaterThan(20);
        expect(sample.lang.length).toBeGreaterThan(0);
      }
    }
  });

  it('每份文档的常见问题不少于 3 条', () => {
    for (const guide of READY) {
      expect(guide.faq?.length ?? 0).toBeGreaterThanOrEqual(3);
    }
  });

  it('覆盖接入闭环的要点：编码规则、身份口径、验证方法、200 陷阱、毫秒时间戳', () => {
    const text = `${allText(READY)}\n${ENCODING_SAMPLE}`;
    for (const keyword of [
      'base64',
      'urlencode',
      'project',
      'token',
      'data',
      'identities.user_key',
      '$track_signup_original_id',
      '毫秒',
    ]) {
      expect(text).toContain(keyword);
    }
    // 「HTTP 200 但没数据」与「怎么验证」必须被讲到
    expect(text).toContain('200');
    expect(text).toContain('Debug');
  });

  it('协议三要素在页面级说明里也有一份（字段名 + 说明）', () => {
    expect(PROTOCOL_FIELDS.map((item) => item.field)).toEqual(['project', 'token', 'data']);
  });
});

describe('未适配条目只保留入口（O-3）', () => {
  it('planned 条目没有任何步骤或常见问题', () => {
    // 未适配的只剩 Unreal 引擎本体（引擎无环境）；Flutter 与批量回补 CLI 都已实测翻牌
    expect(PLANNED.map((guide) => guide.key).sort()).toEqual(['unreal']);
    for (const guide of PLANNED) {
      expect(guide.steps).toBeUndefined();
      expect(guide.faq).toBeUndefined();
    }
  });
});

describe('内容安全与可维护性（O-4/O-7）', () => {
  it('全量正文不引用仓库路径（回归防护）', () => {
    const text = allText();
    expect(text).not.toMatch(/examples\//);
    expect(text).not.toMatch(/report-sdk/);
    expect(text).not.toMatch(/\.env/);
  });

  it('不出现真实令牌值（只说明获取方式）', () => {
    const text = allText();
    expect(text).not.toMatch(/token['"]?\s*[:=]\s*['"][A-Za-z0-9]{8,}/);
    // 示例里只允许占位符
    expect(text).toContain('<项目 token>');
  });
});
