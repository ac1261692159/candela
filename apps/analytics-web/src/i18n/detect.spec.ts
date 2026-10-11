// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  LOCALE_SESSION_KEY,
  LOCALE_STORAGE_KEY,
  captureUrlLocale,
  detectLocale,
  detectInitialLocale,
  readSessionOverride,
  readStoredLocale,
  writeStoredLocale,
} from './detect';
import { DEFAULT_LOCALE, isSupportedLocale, resolveLocale } from './config';

describe('language resolution chain', () => {
  afterEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('prioritises url > session > stored > browser > default', () => {
    const input = {
      url: 'en-US',
      session: 'zh-CN',
      stored: 'zh-CN',
      browser: ['zh-CN'],
    };
    expect(detectLocale(input)).toBe('en-US');
    expect(detectLocale({ ...input, url: null })).toBe('zh-CN');
  });

  it('falls back to browser languages in order, then the platform default', () => {
    expect(detectLocale({ browser: ['xx-XX', 'en-GB'] })).toBe('en-US'); // 未上线语言被跳过，落到同基语言
    expect(detectLocale({ browser: ['fr-FR'] })).toBe('fr-FR');
    expect(detectLocale({ browser: ['xx-XX', 'yy-YY'] })).toBe(DEFAULT_LOCALE);
    expect(detectLocale({})).toBe(DEFAULT_LOCALE);
  });

  it('ignores unsupported or malformed tags instead of failing', () => {
    expect(detectLocale({ url: 'xx-YY', browser: ['en-US'] })).toBe('en-US');
    expect(detectLocale({ stored: 'not-a-tag', browser: [] })).toBe(DEFAULT_LOCALE);
  });

  it('resolves regional variants to a supported locale', () => {
    expect(resolveLocale('en-GB')).toBe('en-US');
    expect(resolveLocale('en')).toBe('en-US');
    expect(resolveLocale('zh_CN')).toBe('zh-CN');
    // 繁体区（含港澳）归到繁中，简体区归到简中
    expect(resolveLocale('zh-TW')).toBe('zh-TW');
    expect(resolveLocale('zh-Hant')).toBe('zh-TW');
    expect(resolveLocale('zh-HK')).toBe('zh-TW');
    expect(resolveLocale('zh-Hans')).toBe('zh-CN');
    // 第二梯队语言按同基语言归位
    expect(resolveLocale('ja')).toBe('ja-JP');
    expect(resolveLocale('ja-JP')).toBe('ja-JP');
    expect(resolveLocale('ko-KR')).toBe('ko-KR');
    // 未上线语言仍返回 null（由调用方回退平台默认）
    // 未上线语言用保留标签（真实语言会随语言集扩张而变成「已支持」）
    expect(resolveLocale('xx-XX')).toBeNull();
    expect(isSupportedLocale('en-US')).toBe(true);
    expect(isSupportedLocale('ja-JP')).toBe(true);
    expect(isSupportedLocale('fr-FR')).toBe(true); // 五常语言已上线
    expect(isSupportedLocale('xx-XX')).toBe(false);
  });

  it('captures ?lang= as a session override and persists local preference separately', () => {
    expect(captureUrlLocale('?lang=en-US')).toBe('en-US');
    expect(readSessionOverride()).toBe('en-US');
    expect(readStoredLocale()).toBeNull();

    writeStoredLocale('en-US');
    expect(readStoredLocale()).toBe('en-US');
    writeStoredLocale(null);
    expect(readStoredLocale()).toBeNull();

    expect(captureUrlLocale('?lang=xx-XX')).toBeNull();
    expect(window.sessionStorage.getItem(LOCALE_SESSION_KEY)).toBe('en-US');
  });

  it('detects the initial locale from the browser when nothing is stored', () => {
    // jsdom 的 navigator.language 是 en-US，未存偏好时按浏览器语言解析
    expect(detectInitialLocale()).toBe('en-US');
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'zh-CN');
    expect(detectInitialLocale()).toBe('zh-CN');
  });
});
