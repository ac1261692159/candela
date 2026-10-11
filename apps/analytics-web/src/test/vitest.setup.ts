import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { changeLocale, i18n } from '../i18n';

/**
 * 测试环境同步装载语言资源：源语言是 zh-CN，既有断言按中文书写，
 * 因此直接读磁盘把全部命名空间灌进 i18next（不经懒加载 backend），
 * 并把语言固定为 zh-CN —— jsdom 的 navigator.language 默认为 en-US，不固定会漂。
 */
const LOCALES_DIR = path.resolve(__dirname, '../i18n/locales');

/**
 * 资源解析结果缓存在 **进程** 上（而不是模块作用域）：vitest 每个测试文件都会重新执行本文件，
 * 但同一 worker 线程内 `process` 是共享的，因此整个测试轮次只需读盘 + 解析一次。
 * 不缓存的话：95 个测试文件 × 32 份 JSON 的同步读盘 + parse ≈ 每文件 2s，会把大量用例推过超时线。
 */
const CACHE_KEY = '__clklogI18nTestResources';
type ResourceBundles = Record<string, Record<string, Record<string, unknown>>>;
const proc = process as NodeJS.Process & { [CACHE_KEY]?: ResourceBundles };

function loadBundles(): ResourceBundles {
  const bundles: ResourceBundles = {};
  for (const lng of readdirSync(LOCALES_DIR)) {
    const dir = path.join(LOCALES_DIR, lng);
    bundles[lng] = {};
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const ns = file.replace(/\.json$/, '');
      bundles[lng][ns] = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as Record<string, unknown>;
    }
  }
  return bundles;
}

const bundles = proc[CACHE_KEY] ?? (proc[CACHE_KEY] = loadBundles());
for (const [lng, namespaces] of Object.entries(bundles)) {
  for (const [ns, data] of Object.entries(namespaces)) {
    i18n.addResourceBundle(lng, ns, data, true, true);
    // 标记为已加载：`ensureNamespaces()` 会跳过它们，避免触发 backend 的动态 import
    i18n.services?.resourceStore && (i18n as unknown as { loadedNamespaces?: string[] }).loadedNamespaces;
  }
}
await changeLocale('zh-CN');

afterEach(() => {
  if (typeof document !== 'undefined') cleanup();
});

if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return false;
    },
  });
}

if (typeof window !== 'undefined') {
  const original = window.getComputedStyle.bind(window);
  window.getComputedStyle = ((elt: Element) => original(elt)) as typeof window.getComputedStyle;
}

if (typeof window !== 'undefined' && !window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
}

// jsdom 不实现 scrollIntoView（浏览器都有）：提案条出现时「滚到可见位置」在测试里会抛 TypeError
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}
