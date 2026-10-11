#!/usr/bin/env node
/**
 * i18n 待翻译文案提取器（AST 级）。
 *
 * 用 TypeScript 编译器 API 解析源码，找出所有「含中文的字符串字面量 / JSX 文本」，
 * 并标注它们的**上下文**（JSX 属性 / 对象属性 / 调用参数 / 异常）与**作用域**（组件内 / 函数内 / 模块级）。
 * 作用域决定迁移机制：组件内可用 useTranslation 钩子，模块级常量必须改造为函数或在使用处翻译。
 *
 * 用法：
 *   node scripts/i18n_extract.mjs                # 打印统计
 *   node scripts/i18n_extract.mjs --json out.json # 另存明细（供 codemod 使用）
 *   node scripts/i18n_extract.mjs --samples       # 打印各分类样例
 *
 * 口径与 scripts/i18n_scan.py 一致：注释不计；测试文件不计入迁移基数。
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const require = createRequire(path.join(REPO, 'apps/analytics-web/package.json'));
const ts = require('typescript');

const CJK = /[\u4e00-\u9fff]/;

const ROOTS = [
  { dir: 'apps/analytics-web/src', exts: ['.ts', '.tsx'] },
  { dir: 'apps/analytics-server/src', exts: ['.ts'] },
];
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'coverage', 'testdata', 'data',
  'docs', 'export', 'dlq', 'harness', 'public', '.turbo', '.vite',
]);
const TEST_RE = /\.(spec|test)\.(ts|tsx)$/;
const ALLOW_PREFIXES = [
  'apps/analytics-web/src/i18n/locales/',
  'apps/analytics-server/src/i18n/messages/',
];

/** 一眼就是「给人看」的 JSX 属性 */
const DISPLAY_ATTRS = new Set([
  'title', 'label', 'placeholder', 'description', 'tooltip', 'help', 'extra',
  'subTitle', 'okText', 'cancelText', 'emptyText', 'content', 'header', 'footer',
  'text', 'message', 'hint', 'valueEnum', 'name', 'suffix', 'prefix', 'note',
]);
/** 给人看的对象属性名 */
const DISPLAY_PROPS = new Set([
  'label', 'title', 'name', 'placeholder', 'description', 'tooltip', 'help',
  'okText', 'cancelText', 'emptyText', 'subTitle', 'extra', 'content', 'header',
  'footer', 'text', 'message', 'hint', 'note', 'unit', 'suffix', 'prefix',
  'confirmText', 'cancelLabel', 'okLabel', 'aria-label', 'alt',
]);
/** 直接产生用户可见提示的调用 */
const DISPLAY_CALLS = [
  /^message\.(success|error|warning|info|loading|open)$/,
  /^notification\.(success|error|warning|info|open)$/,
  /^(Modal|Popconfirm)\./,
  /^antd\.message\./,
];
const EXCEPTION_RE = /^(BadRequest|NotFound|Conflict|Forbidden|Unauthorized|InternalServerError|Gone|UnprocessableEntity|ServiceUnavailable)Exception$/;

function walkFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

function calleeText(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return `${calleeText(node.expression)}.${node.name.text}`;
  return '';
}

function propName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isStringLiteral(node)) return node.text;
  return '';
}

function enclosingScope(node) {
  let cur = node.parent;
  while (cur) {
    if (
      ts.isFunctionDeclaration(cur) || ts.isFunctionExpression(cur) ||
      ts.isArrowFunction(cur) || ts.isMethodDeclaration(cur) ||
      ts.isGetAccessor(cur) || ts.isSetAccessor(cur)
    ) {
      const name =
        (cur.name && ts.isIdentifier(cur.name) && cur.name.text) ||
        (ts.isVariableDeclaration(cur.parent) && ts.isIdentifier(cur.parent.name) && cur.parent.name.text) ||
        (ts.isPropertyAssignment(cur.parent) && propName(cur.parent.name)) ||
        '';
      const hasJsx = containsJsx(cur);
      const isComponent = /^[A-Z]/.test(name) && hasJsx;
      return { kind: isComponent ? 'component' : 'function', name };
    }
    if (ts.isClassDeclaration(cur)) {
      return { kind: 'class', name: cur.name?.text ?? '' };
    }
    cur = cur.parent;
  }
  return { kind: 'module', name: '' };
}

function containsJsx(node) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

function classify(node) {
  const p = node.parent;
  if (!p) return { kind: 'other', detail: '' };

  if (ts.isJsxExpression(p) && p.parent && ts.isJsxAttribute(p.parent)) {
    const attr = propName(p.parent.name);
    return { kind: DISPLAY_ATTRS.has(attr) ? 'jsx_attr' : 'jsx_attr_other', detail: attr };
  }
  if (ts.isJsxAttribute(p)) {
    const attr = propName(p.name);
    return { kind: DISPLAY_ATTRS.has(attr) ? 'jsx_attr' : 'jsx_attr_other', detail: attr };
  }
  if (ts.isPropertyAssignment(p)) {
    const name = propName(p.name);
    return { kind: DISPLAY_PROPS.has(name) ? 'prop' : 'prop_other', detail: name };
  }
  if (ts.isArrayLiteralExpression(p)) {
    const gp = p.parent;
    if (gp && ts.isPropertyAssignment(gp)) {
      const name = propName(gp.name);
      return { kind: 'array', detail: name };
    }
    return { kind: 'array', detail: '' };
  }
  if (ts.isCallExpression(p)) {
    const callee = calleeText(p.expression);
    if (DISPLAY_CALLS.some((re) => re.test(callee))) return { kind: 'call', detail: callee };
    if (callee === 't' || callee.endsWith('.t')) return { kind: 'other', detail: callee };
    return { kind: 'call_other', detail: callee };
  }
  if (ts.isNewExpression(p)) {
    const callee = calleeText(p.expression);
    if (EXCEPTION_RE.test(callee)) return { kind: 'exception', detail: callee };
    return { kind: 'other', detail: callee };
  }
  if (ts.isVariableDeclaration(p)) return { kind: 'var_init', detail: p.name.getText() };
  if (ts.isBinaryExpression(p)) return { kind: 'expr', detail: '' };
  if (ts.isConditionalExpression(p)) return { kind: 'expr', detail: '' };
  if (ts.isReturnStatement(p)) return { kind: 'return', detail: '' };
  if (ts.isTemplateSpan(p) || ts.isTemplateExpression(p.parent ?? p)) return { kind: 'template', detail: '' };
  return { kind: 'other', detail: ts.SyntaxKind[p.kind] ?? '' };
}

function extract(file, rel) {
  const text = readFileSync(file, 'utf8');
  const isTsx = file.endsWith('.tsx');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out = [];
  const hasUseTranslation = /from ['"][^'"]*i18n['"]|useTranslation/.test(text);

  const push = (node, zh, kind, detail, scope) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    out.push({ line: line + 1, col: character + 1, zh, kind, detail, scope: scope.kind, scopeName: scope.name });
  };

  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const t = node.text.trim();
      if (t && CJK.test(t)) push(node, t, 'jsx_text', '', enclosingScope(node));
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (CJK.test(node.text)) {
        const c = classify(node);
        push(node, node.text, c.kind, c.detail, enclosingScope(node));
      }
    } else if (ts.isTemplateExpression(node)) {
      const head = node.head.text;
      if (CJK.test(head)) push(node, head, 'template_head', '', enclosingScope(node));
      for (const span of node.templateSpans) {
        if (CJK.test(span.literal.text)) push(span.literal, span.literal.text, 'template_tail', '', enclosingScope(span));
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return { rel, hasUseTranslation, entries: out };
}

// ------------------------------------------------------------------ main

const args = process.argv.slice(2);
const jsonIdx = args.indexOf('--json');
const showSamples = args.includes('--samples');

const files = [];
for (const { dir, exts } of ROOTS) {
  for (const f of walkFiles(path.join(REPO, dir))) {
    if (!exts.some((e) => f.endsWith(e))) continue;
    const rel = path.relative(REPO, f).replaceAll(path.sep, '/');
    if (TEST_RE.test(rel)) continue;
    if (ALLOW_PREFIXES.some((p) => rel.startsWith(p))) continue;
    files.push({ full: f, rel });
  }
}

const results = [];
const kindAgg = new Map();
const scopeAgg = new Map();
const textAgg = new Map();

for (const { full, rel } of files) {
  const res = extract(full, rel);
  if (!res.entries.length) continue;
  results.push(res);
  for (const e of res.entries) {
    kindAgg.set(e.kind, (kindAgg.get(e.kind) ?? 0) + 1);
    scopeAgg.set(`${e.kind}@${e.scope}`, (scopeAgg.get(`${e.kind}@${e.scope}`) ?? 0) + 1);
    if (!textAgg.has(e.zh)) textAgg.set(e.zh, { zh: e.zh, count: 0, kinds: new Set() });
    const t = textAgg.get(e.zh);
    t.count += 1;
    t.kinds.add(e.kind);
  }
}

const totalEntries = results.reduce((s, r) => s + r.entries.length, 0);
console.log(`文件：${results.length}（含待翻译文案）  出现处：${totalEntries}  去重文案：${textAgg.size}\n`);

console.log('按上下文分类：');
for (const [k, v] of [...kindAgg.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(18)}${String(v).padStart(6)}`);
}
console.log('\n按「上下文@作用域」：');
for (const [k, v] of [...scopeAgg.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(30)}${String(v).padStart(6)}`);
}

if (showSamples) {
  const byKind = new Map();
  for (const r of results) {
    for (const e of r.entries) {
      if (!byKind.has(e.kind)) byKind.set(e.kind, []);
      if (byKind.get(e.kind).length < 8) byKind.get(e.kind).push(`${r.rel}:${e.line} [${e.scope}] ${JSON.stringify(e.zh)}`);
    }
  }
  for (const [k, arr] of byKind) {
    console.log(`\n--- ${k} ---`);
    for (const s of arr) console.log(`  ${s}`);
  }
}

if (jsonIdx >= 0) {
  const outPath = args[jsonIdx + 1];
  const payload = {
    generatedAt: new Date().toISOString(),
    totals: { files: results.length, entries: totalEntries, unique: textAgg.size },
    files: results,
    unique: [...textAgg.values()].map((t) => ({ zh: t.zh, count: t.count, kinds: [...t.kinds] })).sort((a, b) => b.count - a.count),
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 2));
  console.log(`\n明细已写入 ${outPath}`);
}
