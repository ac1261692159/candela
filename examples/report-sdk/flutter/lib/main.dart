/// ClkLog 上报演示 —— Flutter App / Flutter Web 共用（三按钮：匿名事件 / 登录 / 购买）。
///
/// 与 `lib/clklog.dart`（纯 Dart 核心）共享同一套编码、批次、重试逻辑；
/// 本页只做交互：token 输入（不硬编码）、run_id 展示、队列长度、运行日志、编码自检。
///
/// 本地跑 Web 版：
///   flutter pub get
///   flutter run -d chrome                    # 开发模式
///   flutter build web --release              # 产物在 build/web，可用静态服务器打开
///
/// 可选：用 `--dart-define=CLKLOG_TOKEN=xxx` 在本机构建时注入 token（只进本地产物，不入库）。
library;

import 'package:flutter/material.dart';

import 'clklog.dart';

void main() {
  runApp(const ClkLogApp());
}

/// 应用根组件。
class ClkLogApp extends StatelessWidget {
  const ClkLogApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'ClkLog 上报演示（Flutter）',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF1664FF)),
        useMaterial3: true,
      ),
      home: const ReportDemoPage(),
    );
  }
}

/// 演示页：三按钮 + run_id + 队列长度 + 日志。
class ReportDemoPage extends StatefulWidget {
  const ReportDemoPage({super.key});

  @override
  State<ReportDemoPage> createState() => _ReportDemoPageState();
}

class _ReportDemoPageState extends State<ReportDemoPage> {
  final TextEditingController _tokenController = TextEditingController(
    // 默认空：token 必须手填（或本机 --dart-define 注入），绝不硬编码入库。
    text: const String.fromEnvironment('CLKLOG_TOKEN'),
  );
  final TextEditingController _projectController = TextEditingController(text: clklogDefaultProject);
  final TextEditingController _endpointController = TextEditingController(text: clklogDefaultEndpoint);
  final ScrollController _logScrollController = ScrollController();
  final List<String> _logs = <String>[];

  late final String _runId;
  late final String _anonId;
  late final String _loginId;

  ClkLogClient? _client;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    final seconds = DateTime.now().millisecondsSinceEpoch ~/ 1000;
    _runId = 'flutter-$seconds';
    _anonId = 'sdk-test-anon-$_runId';
    _loginId = 'uid-flutter-$seconds';
    _appendLog('run_id=$_runId 已生成；填写 token 后点 ① 或「初始化 SDK」');
    _appendLog('说明：三步点完共 5 条事件（匿名 track / track_signup / user_set / 登录后 track ×2）');
  }

  @override
  void dispose() {
    _client?.close();
    _tokenController.dispose();
    _projectController.dispose();
    _endpointController.dispose();
    _logScrollController.dispose();
    super.dispose();
  }

  // ---------------------------------------------------------------- 日志

  void _appendLog(String line) {
    final now = DateTime.now().toIso8601String().substring(11, 19);
    _logs.add('[$now] $line');
    if (_logs.length > 300) {
      _logs.removeRange(0, _logs.length - 300);
    }
  }

  void _logLine(String line) {
    if (!mounted) {
      _appendLog(line);
      return;
    }
    setState(() => _appendLog(line));
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_logScrollController.hasClients) {
        _logScrollController.jumpTo(_logScrollController.position.maxScrollExtent);
      }
    });
  }

  void _sdkLogger(ClkLogLogLevel level, String message) {
    final tag = switch (level) {
      ClkLogLogLevel.debug => '·',
      ClkLogLogLevel.info => '✓',
      ClkLogLogLevel.warn => '!',
      ClkLogLogLevel.error => '✗',
    };
    _logLine('$tag $message');
  }

  // ---------------------------------------------------------------- 交互

  ClkLogClient? _ensureClient() {
    final existing = _client;
    if (existing != null) {
      return existing;
    }
    final token = _tokenController.text.trim();
    if (token.isEmpty) {
      _logLine('✗ 请先填写项目 token（本页不硬编码 token）');
      return null;
    }
    try {
      final client = ClkLogClient(
        token: token,
        project: _projectController.text.trim().isEmpty
            ? clklogDefaultProject
            : _projectController.text.trim(),
        endpoint: _endpointController.text.trim().isEmpty
            ? clklogDefaultEndpoint
            : _endpointController.text.trim(),
        batchSize: 10, // 攒到 10 条自动发；演示里每步手动 flush，保证 5 条分批可控
        appVersion: '1.0.0',
        logger: _sdkLogger,
      );
      _client = client;
      _logLine('SDK 已初始化：project=${client.project} endpoint=${client.endpoint}');
      _logLine('token 仅存在于本页内存（未写入仓库文件、未落 localStorage）');
      return client;
    } on ClkLogException catch (error) {
      _logLine('✗ 初始化失败：${error.message}');
      return null;
    }
  }

  /// 统一动作包装：入队 → flush → 刷新队列长度（与 js 演示页行为一致）。
  Future<void> _run(String label, Future<void> Function(ClkLogClient client) body) async {
    if (_busy) {
      return;
    }
    final client = _ensureClient();
    if (client == null) {
      return;
    }
    setState(() => _busy = true);
    _logLine('▶ $label');
    try {
      await body(client);
      final payload = client.buildPayload();
      _logLine('表单预检：${client.queueLength} 条 / ${payload.byteLength} 字节 / data 段无裸 + 与 =');
      final sent = await client.flush();
      _logLine('✓ $label 完成（本次 flush 发送 $sent 条）');
    } on ClkLogException catch (error) {
      _logLine('✗ $label 失败：$error（事件保留在队列，可点「手动 Flush」重试）');
    } finally {
      if (mounted) {
        setState(() => _busy = false);
      }
    }
  }

  // ① 登录前：匿名事件（不带 identities）
  Future<void> _sendAnonymousEvent() => _run(
        '① 匿名 track $clklogTestEvent',
        (client) async => client.track(_anonId, clklogTestEvent, <String, Object?>{
          'test_run_id': _runId,
          'sdk_lang': 'flutter',
          'step': 'before_login',
        }),
      );

  // ② 登录：track_signup 绑定匿名ID + user_set
  Future<void> _login() => _run(
        '② 登录关联 track_signup + user_set',
        (client) async {
          client.login(_loginId, _anonId);
          client.profileSet(_anonId, <String, Object?>{
            'vip_level': 3,
            'register_channel': 'app_store',
            'sdk_lang': 'flutter',
          });
        },
      );

  // ③ 登录后：distinct_id 仍是匿名ID，登录ID 走 identities.user_key
  Future<void> _purchase() => _run(
        '③ 登录后 track ×2（含 Purchase）',
        (client) async {
          client.track(_anonId, clklogTestEvent, <String, Object?>{
            'test_run_id': _runId,
            'sdk_lang': 'flutter',
            'amount': 99.5,
            'is_new_user': true,
            'product_id': 'P1001',
            'product_name': '测试商品',
          });
          client.track(_anonId, 'Purchase', <String, Object?>{
            'test_run_id': _runId,
            'order_id': 'O$_runId',
            'amount': 99.5,
            'pay_type': 'alipay',
          });
        },
      );

  Future<void> _manualFlush() async {
    final client = _ensureClient();
    if (client == null) {
      return;
    }
    _logLine('▶ 手动 Flush');
    try {
      final sent = await client.flush();
      _logLine('✓ 手动 Flush 完成，共发送 $sent 条');
    } on ClkLogException catch (error) {
      _logLine('✗ 手动 Flush 失败：$error');
    } finally {
      if (mounted) {
        setState(() {});
      }
    }
  }

  void _encodingSelfCheck() {
    _logLine('▶ 表单编码自检');
    final report = runEncodingSelfCheck();
    for (final item in report.items) {
      _logLine(item.toString());
    }
    _logLine(report.passed
        ? '✓ 编码自检通过（${report.items.length} 项）'
        : '✗ 编码自检失败（${report.failed} 项）');
  }

  void _dumpPreview() {
    final client = _client;
    if (client == null) {
      _logLine('· 先初始化或发送一次事件，再看编码预览');
      return;
    }
    final payload = client.buildPayload();
    final preview = payload.encodedData.length <= 80
        ? payload.encodedData
        : '${payload.encodedData.substring(0, 80)}…';
    _logLine('· data 段预览：$preview');
    _logLine('· 请求 body 字节数：${payload.byteLength}（上限 $clklogMaxBodyBytes）');
    _logLine('· Content-Type：$clklogFormContentType');
    _logLine('· 事件条数：${payload.eventCount} / 单批上限 $clklogMaxBatchEvents');
  }

  // ---------------------------------------------------------------- UI

  InputDecoration _decoration(String label) => InputDecoration(
        labelText: label,
        isDense: true,
        border: const OutlineInputBorder(),
      );

  @override
  Widget build(BuildContext context) {
    final queueLength = _client?.queueLength ?? 0;
    return Scaffold(
      appBar: AppBar(title: const Text('ClkLog 上报演示（Flutter Web / 移动端通用）')),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            _section(
              title: '1. 配置（token 不硬编码，只填在本页内存）',
              children: <Widget>[
                TextField(
                  controller: _tokenController,
                  obscureText: true,
                  autocorrect: false,
                  enableSuggestions: false,
                  decoration: _decoration('项目 token（必填，见 HANDOVER 第八节）'),
                ),
                const SizedBox(height: 8),
                TextField(controller: _projectController, decoration: _decoration('项目名 project')),
                const SizedBox(height: 8),
                TextField(controller: _endpointController, decoration: _decoration('上报地址 endpoint')),
                const SizedBox(height: 12),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: <Widget>[
                    ElevatedButton(onPressed: () => _ensureClient(), child: const Text('初始化 SDK')),
                    OutlinedButton(onPressed: _manualFlush, child: const Text('手动 Flush（补发队列）')),
                    OutlinedButton(onPressed: _encodingSelfCheck, child: const Text('表单编码自检')),
                    OutlinedButton(onPressed: _dumpPreview, child: const Text('查看编码预览')),
                  ],
                ),
              ],
            ),
            _section(
              title: '2. 五步事件链（点击顺序：① → ② → ③）',
              children: <Widget>[
                _kv('run_id', _runId),
                _kv('匿名ID（distinct_id，登录后不变）', _anonId),
                _kv('登录ID（identities.user_key）', _loginId),
                _kv('队列待发条数', '$queueLength', highlight: true),
                const SizedBox(height: 12),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: <Widget>[
                    FilledButton(
                      onPressed: _busy ? null : _sendAnonymousEvent,
                      child: const Text('① 发送测试事件（匿名）'),
                    ),
                    FilledButton(
                      onPressed: _busy ? null : _login,
                      child: const Text('② 登录（track_signup + user_set）'),
                    ),
                    FilledButton(
                      onPressed: _busy ? null : _purchase,
                      child: const Text('③ 发送购买（登录后 2 条 track）'),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                const Text(
                  '三步点完 = 5 条事件；仓库里执行：'
                  'cd examples/report-sdk && ./verify.sh <run_id> --wait=400'
                  '（数据链路延迟 1–3 分钟，脚本会轮询）',
                  style: TextStyle(fontSize: 12, color: Color(0xFF646A73)),
                ),
              ],
            ),
            _section(
              title: '3. 运行日志',
              children: <Widget>[
                Container(
                  height: 260,
                  width: double.infinity,
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: const Color(0xFF0F172A),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: ListView.builder(
                    controller: _logScrollController,
                    itemCount: _logs.length,
                    itemBuilder: (context, index) => Text(
                      _logs[index],
                      style: const TextStyle(
                        color: Color(0xFFD5E0F5),
                        fontSize: 12,
                        fontFamily: 'monospace',
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _section({required String title, required List<Widget> children}) => Container(
        width: double.infinity,
        margin: const EdgeInsets.only(bottom: 16),
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: Theme.of(context).colorScheme.surface,
          border: Border.all(color: const Color(0xFFE5E6EB)),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            Text(title, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600)),
            const SizedBox(height: 10),
            ...children,
          ],
        ),
      );

  Widget _kv(String key, String value, {bool highlight = false}) => Padding(
        padding: const EdgeInsets.only(bottom: 4),
        child: Text.rich(
          TextSpan(
            children: <InlineSpan>[
              TextSpan(text: '$key：'),
              TextSpan(
                text: value,
                style: TextStyle(
                  fontFamily: 'monospace',
                  fontWeight: FontWeight.w600,
                  color: highlight ? Theme.of(context).colorScheme.primary : null,
                ),
              ),
            ],
          ),
        ),
      );
}
