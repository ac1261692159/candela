/**
 * SDK 演示工程下载（phase: clklog-analytics-onboarding-v2 扩展）。
 *
 * 约定：
 * - 每个「已实测 / 语言级已实测」的卡片可以在抽屉里一键下载对应的**可运行示例工程**（zip）。
 * - zip 由 `scripts/build-sdk-demos.sh` 从 `examples/report-sdk/<dir>/` 打包到
 *   `apps/analytics-web/public/sdk-demos/<file>`，随前端产物发布（nginx 从 `/sa/sdk-demos/` 直接给文件）。
 * - **包里不含 token**：打包脚本排除 `.env`, 构建产物与依赖目录。
 * - 维护提示：新增语言卡或在 examples 里改目录名时，同步改这张表，否则按钮不会出现（缺文件时按钮自动隐藏）。
 */

export type DemoDownloadKey =
  | 'php'
  | 'go'
  | 'unity'
  | 'javascript'
  | 'miniprogram'
  | 'react-native'
  | 'android'
  | 'ios'
  | 'cocos2d-x'
  | 'flutter'
  | 'java'
  | 'python'
  | 'nodejs'
  | 'csharp'
  | 'ruby'
  | 'c'
  | 'lua'
  | 'batch-import';

interface DemoArchive {
  /** 放在 public/sdk-demos/ 下的文件名 */
  file: string;
  /** 包内主要文件（展示用，取自打包脚本的 include 清单） */
  contents: string;
}

export const DEMO_ARCHIVES: Record<DemoDownloadKey, DemoArchive> = {
  php: { file: 'php.zip', contents: 'report.php' },
  go: { file: 'go.zip', contents: 'main.go' },
  unity: { file: 'unity-csharp-client.zip', contents: 'ClkLogClient.cs, Program.cs, ClkLogDemo.csproj' },
  javascript: { file: 'javascript-h5.zip', contents: 'clklog.js, index.html, run-on-node.mjs' },
  miniprogram: { file: 'miniprogram.zip', contents: 'clklog.js, run-on-node.mjs' },
  'react-native': { file: 'react-native.zip', contents: 'clklog.js, run-on-node.mjs' },
  android: { file: 'android-java.zip', contents: 'ClkLogClient.java, Main.java' },
  ios: { file: 'ios-swift.zip', contents: 'ClkLogClient.swift, main.swift' },
  'cocos2d-x': { file: 'cocos2d-x-cpp.zip', contents: 'clklog_report.cpp' },
  flutter: { file: 'flutter.zip', contents: 'lib/clklog.dart, lib/main.dart, run_dart.dart, pubspec.yaml' },
  java: { file: 'java.zip', contents: 'ClkLogReport.java' },
  python: { file: 'python.zip', contents: 'report.py' },
  nodejs: { file: 'nodejs.zip', contents: 'report.mjs' },
  csharp: { file: 'csharp-server.zip', contents: 'ServerReport/ClkLogClient.cs, Program.cs, ServerReport.csproj' },
  ruby: { file: 'ruby.zip', contents: 'report.rb' },
  c: { file: 'c.zip', contents: 'clklog_report.c' },
  lua: { file: 'lua.zip', contents: 'clklog.lua, report.lua' },
  'batch-import': { file: 'backfill-cli.zip', contents: 'backfill.py' },
};

/** 前端静态资源基址（vite base 为 `/sa/`） */
export function demoArchiveUrl(file: string): string {
  const base = import.meta.env.BASE_URL || '/';
  return `${base.replace(/\/$/, '')}/sdk-demos/${file}`;
}

export function demoArchiveFor(cardKey: string): DemoArchive | undefined {
  return DEMO_ARCHIVES[cardKey as DemoDownloadKey];
}
