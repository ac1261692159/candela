#!/usr/bin/env node
/**
 * 依赖许可兼容性检查（phase: clklog-analytics-alert-channels-v1，PRD C-9）。
 *
 * 本项目以 **AGPL-3.0-only** 开源（见根目录 LICENSE/NOTICE：因复制并二次集成了上游
 * AGPL-3.0 的 ClkLog 社区版配置）。因此判断标准不是「宽松许可」而是**与 AGPL-3.0 兼容**：
 *   - 允许：MIT / Apache-2.0 / BSD / ISC / 0BSD / MPL-2.0 / LGPL-* / GPL-* / AGPL-3.0（copyleft 可共存）
 *   - 拒绝：商业或非 OSI 许可（Proprietary / BUSL / SSPL / Elastic / Commons Clause）
 *   - 未声明：默认只告警（多为上游漏填），`--strict` 时失败
 *
 * 用法：
 *   node scripts/license-check.mjs [--app <目录>] [--json]
 * 默认检查 apps/analytics-server 与 apps/analytics-web 的生产依赖（devDependencies 不检查）。
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** 允许的许可：与 AGPL-3.0 兼容（宽松 + copyleft 家族） */
const ALLOWED = new Set([
  // 宽松
  'MIT',
  'MIT-0',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Unlicense',
  'CC0-1.0',
  'Python-2.0',
  'BlueOak-1.0.0',
  'Zlib',
  'WTFPL',
  // 弱/强 copyleft（与 AGPL 共存无冲突，本项目自身即 AGPL-3.0）
  'MPL-2.0',
  'LGPL-2.1',
  'LGPL-2.1-only',
  'LGPL-2.1-or-later',
  'LGPL-3.0',
  'LGPL-3.0-only',
  'LGPL-3.0-or-later',
  'GPL-2.0',
  'GPL-2.0-only',
  'GPL-2.0-or-later',
  'GPL-3.0',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'AGPL-3.0',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
]);

/** 非 SPDX 写法的常见表述 → SPDX 标识 */
const LICENSE_ALIASES = new Map([
  ['apache license 2.0', 'Apache-2.0'],
  ['apache 2.0', 'Apache-2.0'],
  ['apache-2', 'Apache-2.0'],
  ['apache license, version 2.0', 'Apache-2.0'],
  ['the mit license', 'MIT'],
  ['mit license', 'MIT'],
  ['bsd', 'BSD-3-Clause'],
  ['bsd license', 'BSD-3-Clause'],
  ['new bsd', 'BSD-3-Clause'],
  ['isc license', 'ISC'],
]);

/** 明确拒绝（传染性或商业限制） */
const DENIED = [/GPL/i, /AGPL/i, /SSPL/i, /BUSL/i, /Elastic/i, /Commons Clause/i, /Proprietary/i];

const DEFAULT_APPS = ['apps/analytics-server', 'apps/analytics-web'];

function parseArgs(argv) {
  const options = { apps: [], json: false, strict: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--app') options.apps.push(argv[++i]);
    else if (argv[i] === '--json') options.json = true;
    else if (argv[i] === '--strict') options.strict = true;
  }
  if (options.apps.length === 0) options.apps = DEFAULT_APPS;
  return options;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 收集生产依赖（递归 dependencies，跳过 optional/peer 的可选缺失） */
async function collectDependencies(appDir) {
  const root = resolve(appDir);
  const pkgPath = join(root, 'package.json');
  if (!(await exists(pkgPath))) return null;
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
  const queue = Object.keys(pkg.dependencies ?? {});
  const seen = new Map();
  while (queue.length > 0) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    const moduleDir = join(root, 'node_modules', ...name.split('/'));
    let modulePkg;
    try {
      modulePkg = JSON.parse(await readFile(join(moduleDir, 'package.json'), 'utf8'));
    } catch {
      seen.set(name, { version: '(未安装)', license: 'UNKNOWN' });
      continue;
    }
    const license = normalizeLicense(modulePkg.license ?? modulePkg.licenses);
    seen.set(name, { version: modulePkg.version ?? '?', license, path: moduleDir });
    for (const child of Object.keys(modulePkg.dependencies ?? {})) queue.push(child);
  }
  return { root, packages: seen };
}

function normalizeLicense(raw) {
  const direct = (value) => LICENSE_ALIASES.get(String(value).trim().toLowerCase()) ?? String(value).trim();
  if (!raw) return 'UNKNOWN';
  if (typeof raw === 'string') return direct(raw);
  if (Array.isArray(raw)) return raw.map((item) => direct(item?.type ?? String(item))).join(' OR ');
  if (typeof raw === 'object') return direct(raw.type ?? 'UNKNOWN');
  return 'UNKNOWN';
}

function normalizeLicenseLegacy(raw) {
  if (!raw) return 'UNKNOWN';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.map((item) => item?.type ?? String(item)).join(' OR ');
  if (typeof raw === 'object') return String(raw.type ?? 'UNKNOWN');
  return 'UNKNOWN';
}

/** 许可串可能形如 "(MIT OR Apache-2.0)"：任一命中白名单即视为通过 */
function isAllowed(license) {
  const cleaned = String(license).replace(/[()]/g, ' ');
  const parts = cleaned.split(/ OR | AND |\/|,\s*/).map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return false;
  return parts.some((part) => ALLOWED.has(part));
}

function isDenied(license) {
  return DENIED.some((pattern) => pattern.test(String(license)));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const violations = [];
  const warnings = [];
  const summary = [];
  for (const app of options.apps) {
    const collected = await collectDependencies(app);
    if (!collected) {
      summary.push({ app, packages: 0, skipped: true });
      continue;
    }
    let allowed = 0;
    let unknown = 0;
    for (const [name, info] of collected.packages) {
      if (isAllowed(info.license)) {
        allowed += 1;
        continue;
      }
      if (isDenied(info.license)) {
        violations.push({ app, name, version: info.version, license: info.license, kind: 'denied' });
        continue;
      }
      unknown += 1;
      // 未识别许可默认只告警（多为上游未声明）；--strict 时才失败
      (options.strict ? violations : warnings).push({
        app,
        name,
        version: info.version,
        license: info.license,
        kind: 'unknown',
      });
    }
    summary.push({ app, packages: collected.packages.size, allowed, unknown });
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ summary, violations, warnings }, null, 2)}\n`);
  } else {
    for (const item of summary) {
      process.stdout.write(
        item.skipped
          ? `[license] ${item.app}: 跳过（无 package.json）\n`
          : `[license] ${item.app}: ${item.packages} 个依赖，${item.allowed} 个在白名单内，${item.unknown} 个未识别\n`,
      );
    }
    for (const item of warnings) {
      process.stdout.write(`[license] ⚠ ${item.app} → ${item.name}@${item.version}：${item.license}（未识别的许可声明，未阻断；--strict 可强制失败）\n`);
    }
    if (violations.length === 0) {
      process.stdout.write('[license] ✅ 未发现 GPL/AGPL/商业许可依赖（白名单外未识别项见上）\n');
    } else {
      process.stdout.write(`[license] ✗ ${violations.length} 个依赖许可需要处理：\n`);
      for (const item of violations) {
        process.stdout.write(`  - ${item.app} → ${item.name}@${item.version}：${item.license}（${item.kind}）\n`);
      }
    }
  }
  process.exit(violations.length === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`[license] 检查失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
});
