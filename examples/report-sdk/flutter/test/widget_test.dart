/// Widget 测试 + 编码单测（不打网络：只验证 UI 元素与表单编码不变量）。
///
/// 运行：`flutter test`
library;

import 'package:clklog_flutter/clklog.dart';
import 'package:clklog_flutter/main.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('演示页含三个按钮 + token 输入框 + run_id 展示', (WidgetTester tester) async {
    await tester.pumpWidget(const ClkLogApp());

    expect(find.text('① 发送测试事件（匿名）'), findsOneWidget);
    expect(find.text('② 登录（track_signup + user_set）'), findsOneWidget);
    expect(find.text('③ 发送购买（登录后 2 条 track）'), findsOneWidget);

    // token / project / endpoint 三个输入框，且 token 框没有硬编码默认值
    final fields = tester.widgetList<TextField>(find.byType(TextField)).toList();
    expect(fields.length, 3);
    expect(fields.first.controller?.text, isEmpty);

    expect(find.textContaining('run_id：flutter-'), findsOneWidget);
    expect(find.textContaining('sdk-test-anon-flutter-'), findsOneWidget);
  });

  test('表单编码：base64 的 + / = 必须被转义，且可逆', () {
    final sample = sampleBatchWithEscapableBase64();
    final encoded = encodeDataField(sample);

    // Dart 坑位的两条真实证据（写进断言，避免 README 说法与实现漂移）
    expect(Uri.encodeQueryComponent('a b'), 'a+b', reason: '空格被编成 +（与 base64 的 + 冲突）');
    expect(Uri.encodeQueryComponent(sampleBatchWithEscapableBase64().toString()), contains('+'));

    expect(encoded.contains('+'), isFalse, reason: 'data 字段不得出现裸 +');
    expect(encoded.contains('='), isFalse, reason: 'data 字段不得出现裸 =');

    // 可逆
    final restored = percentDecodeStrict(encoded);
    expect(restored.contains('+') || restored.contains('='), isTrue, reason: '还原后应恢复 base64 的 + / =');
    expect(encoded.startsWith(percentEncodeStrict(restored)), isTrue);
  });

  test('编码自检：全部通过', () {
    final report = runEncodingSelfCheck();
    expect(report.passed, isTrue, reason: report.items.join('\n'));
  });

  test('预编码表单：字段齐全 + Content-Type 固定', () {
    final body = buildFormPayload(
      <Map<String, Object?>>[
        <String, Object?>{'type': 'user_set', 'distinct_id': 'anon-1', 'time': 1785228036000},
      ],
      project: clklogDefaultProject,
      token: 'dummy-token',
    ).body;

    expect(body.startsWith('project=$clklogDefaultProject&token=dummy-token&data='), isTrue);
    expect(body.contains('+'), isFalse);
    expect(clklogFormContentType, 'application/x-www-form-urlencoded');
  });

  test('client 空 token 直接拒绝（防止硬编码空值上线）', () {
    expect(() => ClkLogClient(token: '  '), throwsA(isA<ClkLogException>()));
  });
}
