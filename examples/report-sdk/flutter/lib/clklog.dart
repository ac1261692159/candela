/// ClkLog 上报 SDK —— 纯 Dart 核心（Flutter App / Flutter Web / Dart CLI 共用同一份实现）。
///
/// 协议依据仓库根目录《数据上报规范与流程.md》：
///  * §1.2 表单字段 `project` / `token` / `data`，`Content-Type: application/x-www-form-urlencoded`；
///  * §1.3 `data` = JSON 数组 → base64 → urlencode；直接 POST 原始 JSON 会 HTTP 200 但**静默丢数据**；
///  * §2.1 事件结构，`time` 必须是**毫秒**时间戳；
///  * §3   ClkLog 口径（与神策原生不同）：登录ID 走顶层 `identities.user_key`，
///        登录绑定匿名ID 走 `properties.$track_signup_original_id`。
///
/// 本文件**不 import `package:flutter/*`**，所以 `dart run run_dart.dart` 可以直接复用；
/// Flutter App（lib/main.dart）与本文件共享同一套编码 / 批次 / 重试逻辑，不存在第二份实现。
library;

import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:http/http.dart' as http;

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/// 默认上报地址（生产）。
const String clklogDefaultEndpoint =
    'https://receiver-clklog.xyxverse.com/receiver/api/gp';

/// 默认项目名。
const String clklogDefaultProject = 'clklogapp';

/// SDK 标识，落 `lib.$lib`。
const String clklogLib = 'flutter';

/// SDK 版本，落 `lib.$lib_version`。
const String clklogLibVersion = '1.0.0';

/// 协议要求的表单 Content-Type（不要带 charset，也不要用 application/json）。
const String clklogFormContentType = 'application/x-www-form-urlencoded';

/// 单批事件数上限（规范 §10.3：单条 data 建议 ≤ 50 事件）。
const int clklogMaxBatchEvents = 50;

/// 单次请求 body 上限（规范 §10.3：body ≤ 1MB）。
const int clklogMaxBodyBytes = 1024 * 1024;

/// 默认失败退避序列：第 1 次重试前 0.5s、第 2 次前 1s、第 3 次前 2s。
///
/// 总尝试次数 = [clklogDefaultRetryDelays].length + 1 = 4（首次 + 3 次重试）。
const List<Duration> clklogDefaultRetryDelays = <Duration>[
  Duration(milliseconds: 500),
  Duration(seconds: 1),
  Duration(seconds: 2),
];

/// 验收链路使用的测试事件名（与其它语言示例一致）。
const String clklogTestEvent = 'SdkSpecTest';

// ---------------------------------------------------------------------------
// 日志 / 异常
// ---------------------------------------------------------------------------

/// 日志级别。
enum ClkLogLogLevel { debug, info, warn, error }

/// 日志回调：Flutter App 把它接到界面日志区，CLI 接到 stdout。
typedef ClkLogLogger = void Function(ClkLogLogLevel level, String message);

/// 上报异常（编码不合规、HTTP 非 200、重试耗尽等）。
class ClkLogException implements Exception {
  ClkLogException(this.message, {this.cause});

  final String message;
  final Object? cause;

  @override
  String toString() =>
      cause == null ? 'ClkLogException: $message' : 'ClkLogException: $message（$cause）';
}

/// 表单编码不合规（如 base64 出现裸 `+` / `=`）。继承 [ClkLogException] 便于统一捕获。
class ClkLogEncodingException extends ClkLogException {
  ClkLogEncodingException(super.message);
}

// ---------------------------------------------------------------------------
// 表单编码（本 SDK 最关键的部分，Dart 坑位集中在这里）
// ---------------------------------------------------------------------------

const String _unreservedExtra = '-_.~';

bool _isUnreservedByte(int byte) {
  final isDigit = byte >= 0x30 && byte <= 0x39; // 0-9
  final isUpper = byte >= 0x41 && byte <= 0x5A; // A-Z
  final isLower = byte >= 0x61 && byte <= 0x7A; // a-z
  return isDigit || isUpper || isLower || _unreservedExtra.codeUnits.contains(byte);
}

/// 严格 RFC 3986 percent-encoding：只保留 unreserved（`A-Za-z0-9-_.~`），其余字节一律 `%XX`。
///
/// 为什么不用 Dart 内置（都实测过，`--self-check` 会打印观察值）：
///  * `Uri.encodeQueryComponent` 走 application/x-www-form-urlencoded 语义，把**空格编成 `+`**，
///    与 base64 里的 `+` 撞车；解码端把 `+` 还原成空格 → base64 损坏；
///  * `Uri.encodeFull` 把 `+` `/` `=` 当作保留字符**原样保留**（`encodeFull` 只转义非保留字符），
///    base64 的 `+` / padding `=` 会裸传进表单。
String percentEncodeStrict(String input) {
  final out = StringBuffer();
  for (final byte in utf8.encode(input)) {
    if (_isUnreservedByte(byte)) {
      out.writeCharCode(byte);
    } else {
      out
        ..write('%')
        ..write(byte.toRadixString(16).toUpperCase().padLeft(2, '0'));
    }
  }
  return out.toString();
}

/// [percentEncodeStrict] 的逆运算（只接受 ASCII 输入，用于自检与排错）。
String percentDecodeStrict(String input) {
  final bytes = <int>[];
  for (var i = 0; i < input.length; i++) {
    final code = input.codeUnitAt(i);
    if (code == 0x25) {
      // '%'
      if (i + 2 >= input.length) {
        throw ClkLogEncodingException('非法百分号转义（截断）: ...${input.substring(math.max(0, i - 8))}');
      }
      final hex = input.substring(i + 1, i + 3);
      final value = int.tryParse(hex, radix: 16);
      if (value == null) {
        throw ClkLogEncodingException('非法百分号转义: %$hex');
      }
      bytes.add(value);
      i += 2;
    } else {
      if (code > 0x7F) {
        throw ClkLogEncodingException('percentDecodeStrict 只接受 ASCII 输入');
      }
      bytes.add(code);
    }
  }
  return utf8.decode(bytes);
}

/// 事件批次 → `data` 字段值：JSON 数组 → UTF-8 → base64 → 严格 urlencode。
String encodeDataField(List<Map<String, Object?>> events) {
  final json = jsonEncode(events);
  final base64Text = base64.encode(utf8.encode(json));
  return percentEncodeStrict(base64Text);
}

/// 提交前的编码断言：`data` 字段（base64 + urlencode 后）**不得出现裸 `+` / `=`**。
///
/// 裸 `+` 会被表单解码还原成空格、裸 `=` 会被部分实现当作键值分隔 → base64 损坏 → 静默丢数据。
/// 每次发送前都会调用本函数（见 [ClkLogClient.flush]）。
void assertEncodedDataFieldSafe(String encodedData) {
  final problems = <String>[];
  if (encodedData.contains('+')) {
    problems.add('出现裸 “+”（表单解码会还原成空格 → base64 损坏）');
  }
  if (encodedData.contains('=')) {
    problems.add('出现裸 “=”（base64 padding 未被转义为 %3D）');
  }
  if (RegExp(r'%(?![0-9A-Fa-f]{2})').hasMatch(encodedData)) {
    problems.add('存在非法百分号转义（% 后不是两位十六进制）');
  }
  if (problems.isNotEmpty) {
    throw ClkLogEncodingException('data 字段编码不合规：${problems.join('；')}');
  }

  final restoredBase64 = percentDecodeStrict(encodedData);
  if (!RegExp(r'^[A-Za-z0-9+/]*={0,2}$').hasMatch(restoredBase64)) {
    throw ClkLogEncodingException('data 字段还原后不是合法 base64: $restoredBase64');
  }
  base64.decode(restoredBase64); // 不可解码会直接抛 FormatException
}

/// 预编码好的表单：可直接作为 POST body 原样发送。
class ClkLogFormPayload {
  const ClkLogFormPayload({
    required this.body,
    required this.encodedData,
    required this.eventCount,
  });

  /// 完整表单 body（`project=..&token=..&data=..`，字段值已预编码）。
  final String body;

  /// `data` 字段值（base64 + urlencode 后）。
  final String encodedData;

  /// 本批事件条数。
  final int eventCount;

  /// body 字节数（预编码后全为 ASCII，长度即字节数）。
  int get byteLength => utf8.encode(body).length;
}

/// 构造预编码表单（字段顺序固定 `project` / `token` / `data`，全部走 [percentEncodeStrict]）。
ClkLogFormPayload buildFormPayload(
  List<Map<String, Object?>> events, {
  required String project,
  required String token,
}) {
  final encodedData = encodeDataField(events);
  assertEncodedDataFieldSafe(encodedData); // 提交前断言，编码坏了宁可本地失败也不静默丢数据
  final body = 'project=${percentEncodeStrict(project)}'
      '&token=${percentEncodeStrict(token)}'
      '&data=$encodedData';
  return ClkLogFormPayload(body: body, encodedData: encodedData, eventCount: events.length);
}

// ---------------------------------------------------------------------------
// 编码自检（`dart run run_dart.dart --self-check` 与 widget 测试共用）
// ---------------------------------------------------------------------------

/// 单条自检结果。
class ClkLogSelfCheckItem {
  const ClkLogSelfCheckItem(this.name, this.ok, this.detail);

  final String name;
  final bool ok;
  final String detail;

  @override
  String toString() => '${ok ? '✓' : '✗'} $name${detail.isEmpty ? '' : ' — $detail'}';
}

/// 自检报告。
class ClkLogSelfCheckReport {
  ClkLogSelfCheckReport(this.items);

  final List<ClkLogSelfCheckItem> items;

  bool get passed => items.every((item) => item.ok);

  int get failed => items.where((item) => !item.ok).length;
}

/// 构造一个「base64 里同时出现 `+` 和 `=`」的样例批次。
///
/// 为什么需要专门构造：base64 的 `+`（索引 62 = `111110`）在纯 ASCII JSON 里**很罕见**——
/// 只有当某个字节的低 6 位恰好等于 `111110` 且落在 6-bit 分组边界上才出现；
/// padding `=` 也只在总字节数不是 3 的倍数时才有。踩不到这两个字符，自检等于没检。
///
/// 构造方式：`'>'` = 0x3E，低 6 位正好是 `111110`；连续 3 个 `0x3E` 的字节里必有一个落在
/// 分组边界上 → 必定产生 `+`。再用长度 1..16 的填充串调整总字节数，必有一档产生 `=`。
List<Map<String, Object?>> sampleBatchWithEscapableBase64() {
  for (var pad = 1; pad <= 16; pad++) {
    final event = <String, Object?>{
      'type': 'track',
      'event': clklogTestEvent,
      'distinct_id': 'sdk-test-anon-selfcheck',
      'time': 1785228036000,
      'properties': <String, Object?>{
        'test_run_id': 'flutter-selfcheck',
        'sdk_lang': 'flutter',
        'product_name': '测试商品',
        'marker': '>>>', // 保证 base64 里出现 '+'（见上方说明）
        'pad': '~' * pad, // 保证总字节数不是 3 的倍数 → 出现 padding '='
      },
    };
    final base64Text = base64.encode(utf8.encode(jsonEncode(<Map<String, Object?>>[event])));
    if (base64Text.contains('+') && base64Text.contains('=')) {
      return <Map<String, Object?>>[event];
    }
  }
  throw ClkLogEncodingException('未能构造出同时含 + 与 = 的 base64 样例（异常情况，请检查 base64 实现）');
}

/// 运行编码自检：证明「base64 + urlencode 表单」在本 Dart 实现上是安全的、可逆的。
ClkLogSelfCheckReport runEncodingSelfCheck() {
  final items = <ClkLogSelfCheckItem>[];

  final sample = sampleBatchWithEscapableBase64();
  final rawBase64 = base64.encode(utf8.encode(jsonEncode(sample)));
  items.add(ClkLogSelfCheckItem(
    '样例载荷的 base64 同时含 + 和 =（证明必须转义）',
    rawBase64.contains('+') && rawBase64.contains('='),
    '含 +：${rawBase64.contains('+')}，含 =：${rawBase64.contains('=')}，长度 ${rawBase64.length}',
  ));

  final encoded = encodeDataField(sample);
  items.add(ClkLogSelfCheckItem(
    'data 字段（base64+urlencode 后）无裸 + / =',
    !encoded.contains('+') && !encoded.contains('='),
    'encodedData 长度 ${encoded.length}，%3D 出现 ${'%3D'.allMatches(encoded).length} 次，'
        '%2B 出现 ${'%2B'.allMatches(encoded).length} 次',
  ));

  final full = Uri.encodeFull(rawBase64);
  items.add(ClkLogSelfCheckItem(
    'Dart 坑位：Uri.encodeFull 会原样保留 base64 的 + / =（因此本 SDK 不用它）',
    full.contains('+') || full.contains('='),
    'encodeFull 后仍含裸 +：${full.contains('+')}、裸 =：${full.contains('=')}',
  ));

  final queryEncodedSpace = Uri.encodeQueryComponent('a b');
  items.add(ClkLogSelfCheckItem(
    'Dart 坑位：Uri.encodeQueryComponent 把空格编成 “+”（base64 场景语义冲突）',
    queryEncodedSpace == 'a+b',
    'Uri.encodeQueryComponent("a b") = "$queryEncodedSpace"；'
        '对 base64 的 + 编码为 ${Uri.encodeQueryComponent(rawBase64).contains('%2B') ? '%2B' : '未转义'}',
  ));

  final strictSpace = percentEncodeStrict('a b');
  items.add(ClkLogSelfCheckItem(
    'percentEncodeStrict 用 %20 表示空格（不是 +），且可逆',
    strictSpace == 'a%20b' && percentDecodeStrict(strictSpace) == 'a b',
    'percentEncodeStrict("a b") = "$strictSpace"',
  ));

  final payload = buildFormPayload(sample, project: clklogDefaultProject, token: 'dummy-token');
  final dataField = payload.body.split('&data=').last;
  items.add(ClkLogSelfCheckItem(
    '表单 body 的 data 段无裸 + / =，且整串无裸 +',
    !dataField.contains('+') &&
        !dataField.contains('=') &&
        !payload.body.contains('+'),
    'body 字节数 ${payload.byteLength}',
  ));

  final roundTripOk = jsonEncode(
        jsonDecode(utf8.decode(base64.decode(percentDecodeStrict(dataField)))),
      ) ==
      jsonEncode(sample);
  items.add(ClkLogSelfCheckItem(
    '可逆性：urlencode → base64 → JSON 与原文逐字节一致',
    roundTripOk,
    roundTripOk ? 'round-trip OK' : 'round-trip 不一致',
  ));

  var negativeOk = false;
  String negativeDetail;
  try {
    assertEncodedDataFieldSafe('YWJj+ZGVm=');
    negativeDetail = '断言未抛错（说明断言是空实现！）';
  } on ClkLogEncodingException catch (err) {
    negativeOk = true;
    negativeDetail = '已按预期抛错：${err.message}';
  }
  items.add(ClkLogSelfCheckItem(
    '负向验证：裸 + / = 会被 assertEncodedDataFieldSafe 拦下',
    negativeOk,
    negativeDetail,
  ));

  items.add(ClkLogSelfCheckItem(
    'Content-Type 固定为 application/x-www-form-urlencoded',
    clklogFormContentType == 'application/x-www-form-urlencoded',
    clklogFormContentType,
  ));

  // 批次上限：50 条事件时 body 仍远小于 1MB，说明上限由条数先触发。
  final fifty = List<Map<String, Object?>>.generate(
    50,
    (index) => <String, Object?>{
      'type': 'track',
      'event': clklogTestEvent,
      'distinct_id': 'sdk-test-anon-selfcheck',
      'time': 1785228036000,
      'properties': <String, Object?>{'seq': index, 'sdk_lang': 'flutter'},
    },
  );
  final fiftyPayload = buildFormPayload(fifty, project: clklogDefaultProject, token: 'dummy-token');
  items.add(ClkLogSelfCheckItem(
    '批次上限：50 条事件 → body ≤ 1MB',
    fiftyPayload.eventCount == clklogMaxBatchEvents &&
        fiftyPayload.byteLength <= clklogMaxBodyBytes,
    '${fiftyPayload.eventCount} 条 / ${fiftyPayload.byteLength} 字节（上限 $clklogMaxBodyBytes）',
  ));

  return ClkLogSelfCheckReport(items);
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

/// ClkLog 上报客户端：攒批 + 预编码表单 + 超时 + 失败退避重试（失败保留队列）。
class ClkLogClient {
  ClkLogClient({
    required this.token,
    this.project = clklogDefaultProject,
    this.endpoint = clklogDefaultEndpoint,
    int batchSize = 10,
    this.maxBatchEvents = clklogMaxBatchEvents,
    this.maxBodyBytes = clklogMaxBodyBytes,
    this.timeout = const Duration(seconds: 10),
    this.retryDelays = clklogDefaultRetryDelays,
    this.appVersion,
    http.Client? httpClient,
    this.logger,
  })  : batchSize = batchSize < 1 ? 10 : batchSize,
        _http = httpClient ?? http.Client() {
    if (token.trim().isEmpty) {
      throw ClkLogException('token 不能为空（禁止硬编码，请从环境变量或界面输入）');
    }
  }

  /// 上报地址。
  final String endpoint;

  /// 项目名。
  final String project;

  /// 项目 token（来自调用方，禁止写进代码库）。
  final String token;

  /// 攒批阈值：队列达到该条数自动 flush（示例默认 10）。
  final int batchSize;

  /// 单批事件条数上限。
  final int maxBatchEvents;

  /// 单次 body 字节上限。
  final int maxBodyBytes;

  /// 单次 HTTP 超时（连接 + 读取各自计时）。
  final Duration timeout;

  /// 失败退避序列；总尝试次数 = length + 1。
  final List<Duration> retryDelays;

  /// App 版本，写入 `lib.$app_version`（可选）。
  final String? appVersion;

  /// 日志回调（可选）。
  final ClkLogLogger? logger;

  final http.Client _http;
  final List<Map<String, Object?>> _queue = <Map<String, Object?>>[];
  String? _loginId;

  /// 当前队列待发条数。
  int get queueLength => _queue.length;

  /// 当前登录ID（非空时所有事件自动携带 `identities.user_key`）。
  String? get loginId => _loginId;

  /// 进入登录态：[login] 的轻量版，只切换身份不再补上报（用于冷启动已有登录态）。
  void setLoginId(String? loginId) => _loginId = (loginId == null || loginId.isEmpty) ? null : loginId;

  /// 退出登录：停止携带 `identities.user_key`（规范 §3.4，无需上报事件）。
  void logout() => _loginId = null;

  /// 行为事件；登录态下自动携带 `identities.user_key`（`distinct_id` 始终传匿名ID）。
  void track(String distinctId, String event, [Map<String, Object?>? properties]) {
    if (event.trim().isEmpty) {
      throw ClkLogException('track 的 event 不能为空');
    }
    _enqueue(_withIdentity(<String, Object?>{
      'type': 'track',
      'event': event,
      'distinct_id': distinctId,
      'time': _nowMillis(),
      'lib': _libInfo(),
      'properties': properties ?? <String, Object?>{},
    }));
  }

  /// 用户属性（覆盖写）；登录态下自动携带 `identities.user_key`。
  void profileSet(String distinctId, Map<String, Object?> properties) {
    _enqueue(_withIdentity(<String, Object?>{
      'type': 'user_set',
      'distinct_id': distinctId,
      'time': _nowMillis(),
      'lib': _libInfo(),
      'properties': properties,
    }));
  }

  /// 登录关联：上报 `track_signup` 绑定匿名ID，之后事件自动带 `user_key`。
  ///
  /// ClkLog 口径：`identities.user_key` = 登录ID，`properties.$track_signup_original_id` = 匿名ID。
  void login(String loginId, String anonymousId) {
    _loginId = loginId;
    _enqueue(<String, Object?>{
      'type': 'track_signup',
      'event': r'$SignUp',
      'distinct_id': loginId,
      'identities': <String, Object?>{'user_key': loginId},
      'time': _nowMillis(),
      'lib': _libInfo(),
      'properties': <String, Object?>{r'$track_signup_original_id': anonymousId},
    });
  }

  /// 发送队列内全部事件（成功一批出队一批；失败则**保留队列**并抛出 [ClkLogException]）。
  ///
  /// 返回本次成功发送的事件条数。
  Future<int> flush() async {
    var sent = 0;
    while (_queue.isNotEmpty) {
      final chunk = _takeChunk();
      await _post(chunk.payload);
      _queue.removeRange(0, chunk.payload.eventCount); // 仅在成功后出队
      sent += chunk.payload.eventCount;
      _log(ClkLogLogLevel.info, 'flush 成功 ${chunk.payload.eventCount} 条');
    }
    return sent;
  }

  /// 为当前队列（或指定事件）构造表单，用于展示编码长度/手动排错，不会发送。
  ClkLogFormPayload buildPayload([List<Map<String, Object?>>? events]) =>
      buildFormPayload(events ?? _queue, project: project, token: token);

  /// 关闭底层 HTTP 连接（Flutter App dispose / CLI 结束时调用）。
  void close() => _http.close();

  // ---------- 内部实现 ----------

  int _nowMillis() => DateTime.now().millisecondsSinceEpoch;

  Map<String, Object?> _libInfo() => <String, Object?>{
        r'$lib': clklogLib,
        r'$lib_method': 'code',
        r'$lib_version': clklogLibVersion,
        if (appVersion != null) r'$app_version': appVersion,
      };

  Map<String, Object?> _withIdentity(Map<String, Object?> event) {
    if (_loginId != null) {
      event['identities'] = <String, Object?>{'user_key': _loginId};
    }
    return event;
  }

  void _enqueue(Map<String, Object?> event) {
    _queue.add(event);
    if (_queue.length >= batchSize) {
      unawaited(flush().then(
        (count) => _log(ClkLogLogLevel.debug, '自动 flush（攒批 $batchSize）$count 条'),
        onError: (Object error) =>
            _log(ClkLogLogLevel.warn, '自动 flush 失败，事件保留在队列：$error'),
      ));
    }
  }

  _Chunk _takeChunk() {
    var take = math.min(maxBatchEvents, _queue.length);
    while (true) {
      final events = _queue.sublist(0, take);
      final payload = buildFormPayload(events, project: project, token: token);
      if (payload.byteLength <= maxBodyBytes) {
        return _Chunk(payload);
      }
      if (take == 1) {
        throw ClkLogException('单条事件编码后 ${payload.byteLength} 字节，超过 body 上限 $maxBodyBytes');
      }
      take = math.max(1, take ~/ 2); // 超限就减半重试，保证 body ≤ 1MB
      _log(ClkLogLogLevel.debug, '本批 body 超过 $maxBodyBytes 字节，条数降为 $take 重试');
    }
  }

  Future<void> _post(ClkLogFormPayload payload) async {
    final attempts = retryDelays.length + 1;
    Object? lastError;
    for (var attempt = 1; attempt <= attempts; attempt++) {
      try {
        final request = http.Request('POST', Uri.parse(endpoint))
          ..headers['Content-Type'] = clklogFormContentType
          ..headers['Accept'] = '*/*'
          // 预编码后的 ASCII body 用 bodyBytes 原样发送，避免 http 包再做一次表单编码。
          ..bodyBytes = utf8.encode(payload.body);
        final streamed = await _http.send(request).timeout(timeout);
        final response = await http.Response.fromStream(streamed).timeout(timeout);
        if (response.statusCode == 200) {
          _log(ClkLogLogLevel.debug, 'HTTP 200（第 $attempt 次尝试，${payload.byteLength} 字节）');
          return;
        }
        lastError = 'http ${response.statusCode} ${_truncate(response.body)}';
      } on TimeoutException catch (error) {
        lastError = 'timeout(${timeout.inMilliseconds}ms): $error';
      } catch (error) {
        lastError = error;
      }
      _log(ClkLogLogLevel.warn, '第 $attempt/$attempts 次发送失败：$lastError');
      final hasNext = attempt < attempts;
      if (hasNext) {
        final delay = retryDelays[math.min(attempt, retryDelays.length) - 1];
        await Future<void>.delayed(delay);
      }
    }
    throw ClkLogException(
      'flush 失败（已尝试 $attempts 次，事件保留在队列，可稍后重试）',
      cause: lastError,
    );
  }

  String _truncate(String text, [int max = 200]) =>
      text.length <= max ? text : '${text.substring(0, max)}…';

  void _log(ClkLogLogLevel level, String message) => logger?.call(level, message);
}

class _Chunk {
  _Chunk(this.payload);

  final ClkLogFormPayload payload;
}
