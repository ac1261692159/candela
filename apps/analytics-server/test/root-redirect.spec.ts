/**
 * 根路径重定向回归（2026-10-10）。
 *
 * 需求：访问后端根路径 `/` 时 302 到平台入口 `/sa/`（前端 base），**不依赖宿主 nginx 的分流配置**——
 * 直连后端端口（:3100）或 web 层不可达时，根路径也能到达正确入口。
 *
 * `src/main.ts` 末尾直接调用 `bootstrap()`，import 它会触发真实启动（连数据库），
 * 因此与 `test/ai-assistant/harness-proxy-order.spec.ts` 一样用**源码不变量**方式锁定：
 * 注册方式或目标地址写错即失败。
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('main.ts 根路径重定向', () => {
  const source = readFileSync(join(__dirname, '../src/main.ts'), 'utf8');

  it('把 GET / 302 到 /sa/（Express 精确路由）', () => {
    expect(source).toMatch(/getHttpAdapter\(\)\.getInstance\(\)\s*as\s+Express/);
    expect(source).toMatch(/\.get\(\s*'\/'\s*,/);
    expect(source).toMatch(/redirect\(\s*302\s*,\s*'\/sa\/'\s*\)/);
  });

  it('不通过 app.use 注册根路径（前缀匹配会拦掉 /sa/api/* 与 /sa/harness）', () => {
    expect(source).not.toMatch(/app\.use\(\s*'\/'\s*,/);
  });
});
