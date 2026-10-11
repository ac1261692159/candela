/// ClkLog 上报验收 CLI（纯 Dart，复用 lib/clklog.dart 这份唯一实现）。
///
/// 用法：
///   dart run run_dart.dart               # 跑完整 5 步链并打印 `DONE run_id = flutter-<ts>`
///   dart run run_dart.dart --self-check   # 只跑表单编码自检（不发网络请求）
///
/// token 只从环境变量或 `examples/report-sdk/.env` 读取（环境变量优先），**不硬编码、不打印**。
library;

import 'dart:io';

import 'package:clklog_flutter/clklog.dart';

/// `.env` 中允许读取的键（只认白名单，避免把无关变量带进进程）。
const List<String> _envKeys = <String>['CLKLOG_TOKEN', 'CLKLOG_ENDPOINT', 'CLKLOG_PROJECT'];

Future<void> main(List<String> args) async {
  if (args.contains('-h') || args.contains('--help')) {
    _out('用法: dart run run_dart.dart [--self-check] [--env=<path>]');
    return;
  }

  if (args.contains('--self-check')) {
    exitCode = await _runSelfCheck();
    return;
  }

  final env = _loadEnv(args);
  final token = env['CLKLOG_TOKEN'] ?? '';
  if (token.isEmpty) {
    stderr.writeln('缺少 CLKLOG_TOKEN：请设置环境变量，或在 examples/report-sdk/.env 中配置');
    exitCode = 1;
    return;
  }
  final endpoint = env['CLKLOG_ENDPOINT'] ?? clklogDefaultEndpoint;
  final project = env['CLKLOG_PROJECT'] ?? clklogDefaultProject;

  final seconds = DateTime.now().millisecondsSinceEpoch ~/ 1000;
  final runId = 'flutter-$seconds'; // <lang>-<ts>，verify.sh 按它查库
  final anonId = 'sdk-test-anon-$runId'; // 匿名ID（登录前后都不变）
  final loginId = 'uid-flutter-$seconds'; // 登录ID → identities.user_key

  final client = ClkLogClient(
    token: token,
    project: project,
    endpoint: endpoint,
    batchSize: 10, // 演示里手动 flush，保证 5 条都进同一批
    appVersion: '1.0.0',
    logger: _cliLogger,
  );

  _out('run_id  = $runId');
  _out('anon_id = $anonId');
  _out('login_id= $loginId');
  _out('endpoint= $endpoint（project=$project）');
  _out('');

  try {
    // 1. 登录前：匿名事件（不带 identities）
    client.track(anonId, clklogTestEvent, <String, Object?>{
      'test_run_id': runId,
      'sdk_lang': 'flutter',
      'step': 'before_login',
    });
    _out('① 匿名 track $clklogTestEvent 入队（队列 ${client.queueLength}）');

    // 2. 登录关联：track_signup 绑定匿名ID，之后事件自动带 identities.user_key
    client.login(loginId, anonId);
    _out('② track_signup 登录关联入队（队列 ${client.queueLength}）');

    // 3. 用户属性（登录态）
    client.profileSet(anonId, <String, Object?>{
      'vip_level': 3,
      'register_channel': 'app_store',
      'sdk_lang': 'flutter',
    });
    _out('③ user_set 用户属性入队（队列 ${client.queueLength}）');

    // 4. 登录后行为事件：distinct_id 仍是匿名ID，登录ID 走 identities.user_key
    client.track(anonId, clklogTestEvent, <String, Object?>{
      'test_run_id': runId,
      'sdk_lang': 'flutter',
      'amount': 99.5,
      'is_new_user': true,
      'product_id': 'P1001',
      'product_name': '测试商品',
    });
    _out('④ 登录后 track $clklogTestEvent 入队（队列 ${client.queueLength}）');

    // 5. 登录后购买事件
    client.track(anonId, 'Purchase', <String, Object?>{
      'test_run_id': runId,
      'order_id': 'O$runId',
      'amount': 99.5,
      'pay_type': 'alipay',
    });
    _out('⑤ 登录后 track Purchase 入队（队列 ${client.queueLength}）');

    final payload = client.buildPayload();
    _out('表单预检：${payload.eventCount} 条 / ${payload.byteLength} 字节 / data 段无裸 + 与 =');
    assertEncodedDataFieldSafe(payload.encodedData);

    final sent = await client.flush();
    client.close();
    _out('');
    _out('DONE run_id = $runId（已发送 $sent 条）');
    _out('验收：cd examples/report-sdk && ./verify.sh $runId --wait=400');
  } on ClkLogException catch (error) {
    client.close();
    stderr.writeln('上报失败：$error');
    exitCode = 1;
  }
}

Future<int> _runSelfCheck() async {
  final report = runEncodingSelfCheck();
  _out('ClkLog 表单编码自检（Dart ${Platform.version.split(' ').first}）');
  _out('');
  for (final item in report.items) {
    _out(item.toString());
  }
  _out('');
  _out(report.passed
      ? 'SELF-CHECK PASS（${report.items.length} 项全绿）'
      : 'SELF-CHECK FAIL（${report.failed} 项未通过）');
  return report.passed ? 0 : 1;
}

/// 读取 `.env`：环境变量优先，其次 `--env=<path>` 指定的文件，再次 `../.env` / `.env`。
Map<String, String> _loadEnv(List<String> args) {
  final env = <String, String>{...Platform.environment};

  String? explicitPath;
  for (final arg in args) {
    if (arg.startsWith('--env=')) {
      explicitPath = arg.substring('--env='.length);
    }
  }

  final candidates = <String>[
    ?explicitPath,
    '../.env', // examples/report-sdk/.env（与 python 参考实现一致）
    '.env',
  ];

  for (final candidate in candidates) {
    final file = File(candidate);
    if (!file.existsSync()) {
      continue;
    }
    for (final rawLine in file.readAsLinesSync()) {
      final line = rawLine.trim();
      if (line.isEmpty || line.startsWith('#') || !line.contains('=')) {
        continue;
      }
      final index = line.indexOf('=');
      final key = line.substring(0, index).trim();
      final value = line.substring(index + 1).trim();
      // 只认白名单键，且已存在的环境变量优先（不覆盖）
      if (_envKeys.contains(key) && (env[key] ?? '').isEmpty) {
        env[key] = value;
      }
    }
    _out('[clklog] 已加载配置：$candidate（只读取键名，不打印值）');
    break;
  }
  return env;
}

void _cliLogger(ClkLogLogLevel level, String message) {
  final tag = switch (level) {
    ClkLogLogLevel.debug => '·',
    ClkLogLogLevel.info => '✓',
    ClkLogLogLevel.warn => '!',
    ClkLogLogLevel.error => '✗',
  };
  _out('[$tag] $message');
}

void _out(String line) => stdout.writeln(line);
