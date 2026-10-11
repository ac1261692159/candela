# ClkLog 上报示例 —— Flutter / Dart

协议依据：仓库根目录《数据上报规范与流程》§1（表单 `data = base64(JSON 数组) → urlencode`）、
§2（事件结构，`time` 毫秒）、§3（**ClkLog 口径**：登录ID 走 `identities.user_key`，
登录绑定匿名ID 走 `properties.$track_signup_original_id`，与神策原生 `login_id`/`original_id` 不同）。

本目录有**一份 SDK 实现、三种跑法**：

| 文件 | 作用 |
|------|------|
| `lib/clklog.dart` | SDK 核心（**纯 Dart，不 import flutter**）：`ClkLogClient`（track / login / profileSet / flush）+ 攒批 + 超时 + 0.5s/1s/2s 退避重试 + 预编码表单 + 提交前编码断言 + 编码自检 |
| `lib/main.dart` | Flutter App / Flutter Web 演示页：token 输入框（不硬编码）、`run_id`/队列长度/日志显示、三个按钮（① 匿名事件 ② 登录 ③ 购买）+ 手动 Flush + 编码自检 + 编码预览 |
| `run_dart.dart` | 纯 Dart CLI：复用同一份 `lib/clklog.dart`，跑完整 5 步链并打印 `DONE run_id = flutter-<ts>`；`--self-check` 只跑编码自检（不发网络） |
| `test/widget_test.dart` | `flutter test`：三个按钮/token 框存在 + 编码不变量 + 自检全绿（不打网络） |
| `web/` | `flutter create --platforms=web` 生成的 Web 外壳（`index.html` / `manifest.json` / 图标） |

## 0. 环境

实测环境：`Flutter 3.47.6 stable`（Dart 3.13.5，macOS arm64，`/opt/homebrew/bin/flutter`）。
`pubspec.yaml` 约束：`sdk: ^3.8.0`（`http 1.6.0` 要求 Dart ≥3.4，`flutter_lints 6.0.0` 要求 ≥3.8），
依赖只有 `http: ^1.6.0`（实测解析到 **1.6.0**）。

```bash
export PATH="/opt/homebrew/bin:$PATH"
cd examples/report-sdk/flutter
flutter pub get
```

## 1. 纯 Dart CLI：真实上报 + 落库验收

token 只从环境变量或 `examples/report-sdk/.env` 读取（环境变量优先），**不硬编码、不打印**：

```bash
# 环境变量优先；没有就用 ../.env 里的 CLKLOG_TOKEN / CLKLOG_ENDPOINT / CLKLOG_PROJECT
cd examples/report-sdk/flutter
dart run run_dart.dart                                   # 打印 DONE run_id = flutter-<unix 秒>
dart run run_dart.dart --self-check                      # 编码自检（10 项），不发网络
dart run run_dart.dart --env=/path/to/.env               # 指定 env 文件（可选）

# 数据链路延迟 1–3 分钟，verify.sh 会轮询（6 条断言）
cd examples/report-sdk && ./verify.sh flutter-<ts> --wait=400
```

命令都会打印 `run_id`（`flutter-<ts>`）与 `anon_id` / `login_id`；三步链固定 5 条事件：
匿名 `track` → `track_signup`（`$SignUp`）→ `user_set` → 登录后 `track` ×2。

## 2. Flutter App（浏览器端到端验证）

```bash
cd examples/report-sdk/flutter

# 方式 A：开发模式（自动起 Chrome）
flutter run -d chrome

# 方式 B（推荐，平台级构建验证 + 可在任何浏览器打开）
flutter build web --release                # 本机实测：首次 108.4s / 二次 79.3s / 清空产物后 26.4s
python3 -m http.server 8080 --directory build/web
# 打开 http://localhost:8080 → 填 token → 依次点 ① ② ③ → 复制页面上的 run_id 跑 verify.sh
```

**Flutter Web 产物路径：`examples/report-sdk/flutter/build/web/`**（`build/` 已在 `.gitignore` 中，不入库）。
实测产物：总大小 **40 MB**，`index.html` 1,654 B，`main.dart.js` **2,473,025 B（2.4 MB）**，
`flutter_bootstrap.js` 13,094 B，`canvaskit/` 本地资源，共 38 个文件。
`index.html` 的 `<base href="/">` 是根路径，所以静态服务要挂在**根**（`--directory build/web` 满足）；
起服务后实测 `/`、`/index.html`、`/main.dart.js`、`/flutter_bootstrap.js`、`/manifest.json` 全部 HTTP 200。

> 产物新鲜度核验方法（避免“构建成功但产物是旧的”）：dart2js 会把非 ASCII 字面量转义成 `\uXXXX`，
> 所以要在 `main.dart.js` 里搜**转义形式**。例如 `\u5355\u6279\u4e0a\u9650`（“单批上限”）命中 1 次、
> `\u67e5\u770b\u7f16\u7801\u9884\u89c8`（“查看编码预览”）命中 1 次，即证明当前 `lib/main.dart` 的界面文案确实编译进了产物。

`--dart-define=CLKLOG_TOKEN=xxx` 可在本机构建时预填 token（会进本地产物，**只用于本机验证，不要分发/入库**）。

## 3. 协议实现要点（生产可用骨架）

- **预编码表单**：`project` / `token` / `data` 三个字段值全部经 `percentEncodeStrict()`（只保留
  RFC 3986 unreserved `A-Za-z0-9-_.~`，其余一律 `%XX`），用 `bodyBytes` 原样发送，
  `Content-Type: application/x-www-form-urlencoded`。注意 base64 的 padding `=` 编码后是 `%3D`（保留 padding，不裁）。
- **批次上限**：`≤50 条/批`（`clklogMaxBatchEvents`）且 `body ≤1MB`（`clklogMaxBodyBytes`）；超限自动减半条数重建批次。
- **HTTP 超时**：默认 10s（连接与读取各自计时）。
- **失败退避重试**：默认首次 + 3 次重试，退避 **0.5s / 1s / 2s**；仍失败则抛 `ClkLogException` 且**事件保留在队列**（可稍后 `flush()` 补发）。
- **成功语义**：按 HTTP 200 判定成功，成功一批才出队一批（`track_signup` 与后续事件始终同批，避免身份绑定顺序错乱）。
- **登录口径**：`login(loginId, anonymousId)` 上报 `track_signup`（`distinct_id`=登录ID、`identities.user_key`=登录ID、
  `properties.$track_signup_original_id`=匿名ID）；之后所有事件的 `distinct_id` **仍是匿名ID**，登录ID 只走 `identities.user_key`；
  `logout()` 后停止携带。

## 4. Dart / Flutter 特有坑位（都是实测踩出来的）

1. **base64 里的 `+` / `=` 必须转义，但 Dart 的两个内置函数都不能直接用**：
   - `Uri.encodeFull` 把 `+` `/` `=` 当保留字符**原样保留** → base64 的 `+` 和 padding `=` 裸传进表单；
   - `Uri.encodeQueryComponent` 走 form-urlencoded 语义：**空格被编成 `+`**（`Uri.encodeQueryComponent("a b") == "a+b"`），
     `+` 本身会编成 `%2B`（实测）——即“能编对 `+`，却引入 `+` 的第二种含义”，在 base64 场景语义冲突，故本项目不用它。
   - 结论：自己实现 `percentEncodeStrict()`，空格用 `%20`，`+`→`%2B`、`=`→`%3D`、`/`→`%2F`。
2. **提交前必须断言，否则会静默丢数据**：`assertEncodedDataFieldSafe()` 在每次 `flush()` 前检查
   `data` 字段**无裸 `+`、无裸 `=`**、百分号转义合法、并且 `urlencode → base64 → JSON` 可逆；
   不通过直接抛错（宁可本地失败，也不让 receiver 返回 200 却丢数据）。
3. **纯 ASCII JSON 的 base64 里几乎不会出现 `+`**：`+`（索引 62 = `111110`）只在“某字节低 6 位恰为 `111110`
   且落在 6-bit 分组边界”时才出现（即 `0x3E` `'>'`、`0x7E` `'~'` 这类字符落在正确位置）；
   padding `=` 只在总字节数不是 3 的倍数时才有。自检样例因此是**刻意构造**的
   （`'>' * 3` 保证出现 `+`，长度 1..16 的填充串保证出现 `=`）——第一版自检用“追加 `x`”的笨办法
   跑 512 轮都没命中 `+`，是真实踩到的坑。
4. **`data` 必须是数组**：单条事件也要包成 `[...]`；`properties` 传 `{}` 而不是 `null`。
5. **`time` 必须是毫秒**：`DateTime.now().millisecondsSinceEpoch`（秒级会让事件时间错乱）。
6. 别用 `dart run` 之外的 Dart SDK 混跑：`http` 在 Web 上自动走 `BrowserClient`(fetch/XHR)，
   在 VM/移动端走 `dart:io`（本示例两种环境都实测过：CLI 走 VM，Web 构建走浏览器）。

## 5. 实测层级（诚实口径）

- **已实测（真实落库）**：Dart 语言链路（编码 → 表单 → 批次 → 身份字段 → 重试）经
  `dart run run_dart.dart` 真跑 + `verify.sh` 查 ClickHouse 6 条断言全绿（run_id 见仓库根
  《数据上报规范与流程》§9 记录）。
- **已实测（构建）**：`flutter build web --release` 成功（平台级构建验证），
  `flutter analyze` 无任何 issue，`flutter test` 5/5 通过，`--self-check` 10/10 通过。
- **未实测（需真机/完整 SDK）**：
  - iOS（`flutter build ios` / `flutter run` 到模拟器）——本机只有 Command Line Tools，无 Xcode 完整版，**未打包**；
  - Android（`flutter build apk`）——本机无 Android SDK，**未打包**；
  - macOS/Windows/Linux 桌面端——未创建对应平台目录；
  - 移动端真机网络策略（蜂窝网络、后台挂起时的补发时机）——未验证。
  - Flutter Web 的**真实浏览器点击**验证由使用方按 §2 方式 B 执行（本次仅完成平台级构建 + 产物核验）。

## 6. 常见错误对照

| 现象 | 原因 | 处理 |
|------|------|------|
| HTTP 200 但库里没数据 | 直接 POST 原始 JSON，或 base64 里出现裸 `+`/`=` | 走 `buildFormPayload()`；先跑 `--self-check` |
| `user_key` 为空、`is_logined=0` | 用了神策顶层 `login_id` / `original_id` | 用 `identities.user_key` + `properties.$track_signup_original_id` |
| 时间错乱 | `time` 用了秒 | 用毫秒（`millisecondsSinceEpoch`） |
| 401/403 | token 错 | 核对 `tbl_project` 项目 token（不进仓库） |
| `dart run` 报错找不到 `flutter` SDK 包 | 未先 `flutter pub get` | 先 `flutter pub get` 再 `dart run` |
