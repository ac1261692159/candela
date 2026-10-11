# ClkLog 数据上报 SDK 示例（全语言）

《数据上报规范与流程》（仓库根目录）§1–§3 的配套可运行示例。**每门语言都真实跑通过**：
一条批次 5 条事件（匿名 track → track_signup 绑定 → user_set → 登录后 track ×2），
事件落到 ClickHouse `clklog.log_analysis`，逐行断言见规范 §9 实测记录。

## 快速验收（推荐流程）

```bash
# 1. 配置（token 不进代码库；也可用环境变量覆盖）
#    examples/report-sdk/.env 里放：CLKLOG_TOKEN / CLKLOG_ENDPOINT / CLKLOG_PROJECT
export CLKLOG_TOKEN='<项目token>'      # 见部署初始化后的 MySQL tbl_project（token 不入库）

# 2. 跑任意一门语言（示例会打印 DONE run_id = <lang>-<ts>）
cd go && go run main.go

# 3. 验收：查 ClickHouse 断言 5 步链（数据链路有 1–3 分钟延迟，脚本会轮询）
cd .. && ./verify.sh <run_id>          # 默认最多等 300 秒；可用 --wait=600 加长
```

`verify.sh` 经 2223 SSH 隧道在服务器上执行查询，凭据从**运行中的服务进程环境**读取，
不落盘、不打印；判定标准是 6 条断言（track ≥3、track_signup = 1、user_set ≥1、
登录前匿名事件存在、登录后事件 ≥2 且 `user_key` 非空、track_signup 绑定 `original_id`）。

## 语言矩阵与运行方式

| 端 | 语言 | 目录 | 运行（依赖） | 实测层级 |
|---|---|---|---|---|
| 服务端 | Go | `go/` | `go run main.go`（标准库） | 已实测 |
| 服务端 | PHP | `php/` | `php report.php`（需 curl 扩展） | 已实测 |
| 服务端 | Python | `python/` | `python3 report.py`（标准库） | 已实测 |
| 服务端 | Node.js | `nodejs/` | `node report.mjs`（内置 fetch；Node 18+） | 已实测 |
| 服务端 | Ruby | `ruby/` | `ruby report.rb`（标准库 net/http） | 已实测 |
| 服务端 | Java | `java/` | `javac -encoding UTF-8 -d /tmp/x *.java && java -cp /tmp/x ClkLogReport`（JDK 8+） | 已实测 |
| 服务端 | C# | `csharp/ServerReport/` | `dotnet run`（.NET 6+ / 8+） | 已实测 |
| 服务端 | C | `c/` | `SDK=$(xcrun --show-sdk-path); cc -std=c11 -O2 -I"$SDK/usr/include" clklog_report.c -L"$SDK/usr/lib" -lcurl` | 已实测 |
| 服务端 | C++ | `cpp/` | 同上，`clang++ -std=c++17 … -lcurl` | 已实测（Cocos 语言核心） |
| 服务端 | Lua | `lua/` | `lua report.lua`（`brew install lua luarocks`；`luarocks install luasocket`；`luarocks install luasec OPENSSL_DIR=$(brew --prefix openssl@3)`） | 已实测 |
| 客户端 | Web / H5 | `js/` | 起静态服务打开 `index.html`（或 `node run-on-node.mjs` 自测） | 已实测（真实浏览器） |
| 客户端 | 微信小程序 | `miniprogram/` | `node run-on-node.mjs`（`wx` 垫片）；真机需在开发者工具引入 `clklog.js` | 语言级已实测 |
| 客户端 | React Native | `react-native/` | `node run-on-node.mjs`（注入内存 storage）；RN 壳未打包 | 语言级已实测 |
| 客户端 | Android | `android/` | `javac -encoding UTF-8 -d /tmp/x *.java && java -cp /tmp/x Main`（JVM 运行；APK 未打包） | 语言级已实测 |
| 客户端 | iOS | `ios/` | `swiftc -O ClkLogClient.swift main.swift -o /tmp/ios && /tmp/ios`（Foundation URLSession；App 未打包） | 语言级已实测 |
| 客户端 | Flutter / Dart | `flutter/` | `flutter pub get && dart run run_dart.dart`（CLI）；`flutter build web --release`（Web 平台构建，浏览器点按钮也实测过） | 已实测（Web）；iOS/Android 未打包 |
| 客户端 | Unity(C#) | `csharp/` | `dotnet run`（Unity 工程内直接拷贝 `ClkLogClient.cs`） | 已实测 |
| 其他 | HTTP | 见规范 §1 | `curl` 表单 POST（`data` = base64 + urlencode） | 已实测 |
| 其他 | 批量回补 CLI | `backfill/` | `python3 backfill.py --input history.csv --limit 5 --dry-run`（Python 3 标准库） | 已实测（120 行落库 + 续跑无重无漏） |

> 「语言级已实测」= 该语言的传输/编码/队列实现真实跑通并落库，但目标平台（开发者工具 / 真机 /
> APK / App / 引擎）没有环境做打包验证 —— 各平台**已验证与未验证的边界**见规范 §9.3。

## 各语言实测踩到的坑（照抄时注意）

| 语言 | 坑 |
|---|---|
| 通用 | `data` 必须是 **base64(JSON 数组) → urlencode** 的表单字段；直接 POST 原始 JSON 会 HTTP 200 但静默丢数据。base64 必须**单行**，`+ / =` 必须百分号编码（漏掉 `+` 会被解成空格）。 |
| Ruby | `Base64.encode64` 每 60 字符换行 → 必须 `strict_encode64`；双引号里的 `$SignUp` 会被当全局变量插值成空串 → 用单引号。 |
| Java（含 Android） | `Base64.getMimeEncoder()` 会折行 → 用 `getEncoder()`；JDK 8 没有 `java.net.http` → 用 `HttpURLConnection`；`java.util.Base64` 需 Android API 26+。 |
| C / C++ | libcurl 必须设 `CURLOPT_WRITEFUNCTION`（只设 `WRITEDATA` 会被当 `FILE*`）；头文件在 macOS SDK 里，需 `-I$(xcrun --show-sdk-path)/usr/include -L…/usr/lib -lcurl`；另需 `signal(SIGPIPE, SIG_IGN)`。 |
| C# | 同一仓库里父子两个 SDK 风格工程会互相通配源码（CS8802 / CS0579）→ 用 `Directory.Build.targets` 排除（`.props` 会被默认 Include 覆盖）。 |
| iOS / Swift | `addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)` 不会编码 `+ & =` → 必须自己按 RFC3986 编码；`URLSessionConfiguration` 在创建 session 时被复制，改超时要重建 session；`Data.base64EncodedString(options: [])` 才是单行。 |
| Lua | luasec **默认不校验证书** → 显式 `verify="peer"` + `cafile`；协议名只认带下划线的 `tlsv1_2`（写 `tlsv12` 报 invalid protocol）；毫秒时间用 `socket.gettime()`，`os.time()*1000` 只有秒精度。 |
| Node.js | fetch 的 body 要给 `URLSearchParams` 实例（自动带 urlencoded Content-Type），普通对象会被序列化成 JSON。 |
| React Native | Hermes 无 `btoa` / `Buffer` / `TextEncoder`，`URLSearchParams.toString()` 也不可用 → base64 与 urlencode 自带纯 JS 实现。 |
| 微信小程序 | `wx.getStorageSync` 缺 key 返回空字符串（不是 null）→ storage 适配层要归一；`wx.request` 的 data 传预编码字符串最稳。 |
| Web / H5 | 页面卸载补发用 `navigator.sendBeacon(new URLSearchParams(...))`；传字符串会以 text/plain 发出、解析不到 `data`。 |
| Python | `data` 要 `urlencode` 后再作 body（不能把 dict 直接交给 `urlopen`）；重试要重建 `Request`。 |
| Flutter / Dart | 两个内置编码函数都不能用：`Uri.encodeFull` 保留 `+ / =`，`Uri.encodeQueryComponent` 把空格编成 `+` → 自实现 RFC3986 编码并在提交前断言无裸 `+`/`=`。 |
| Flutter Web 产物核对 | dart2js 把非 ASCII 转义成 `\uXXXX`，grep 中文永远 0 命中（易误判为旧产物）；搜转义形式或比对 `main.dart.js` 大小/时间。 |

## 目录里还有什么

- `verify.sh`：验收器（用法见开头）。改动协议或新增语言时，它是唯一验收口径。
- `.env`：本地配置（**不入库**；token 见部署初始化后的 MySQL tbl_project（token 不入库），泄露须轮换）。
- 各语言目录内文件头的注释：写明了该语言的编译/运行命令、实测层级，以及引擎/平台侧的替换点
  （例如 Cocos 把传输层换成 `cocos2d::network::HttpRequest`、OpenResty 换成 `resty.http`）。

## 演示工程 zip（接入指南的下载按钮）

接入指南页每个已实测卡片在文档抽屉里提供「下载演示工程」按钮，zip 由
`scripts/build-sdk-demos.sh` 从本目录打包到 `apps/analytics-web/public/sdk-demos/`，随前端产物发布
（nginx 从 `/sa/sdk-demos/` 直出）。打包脚本排除 `.env`、构建产物与依赖目录，并在结束时**校验包内不含 token 值**，
校验不通过会直接失败（红线 3）。新增语言目录时，同步改打包脚本的 PACKS 表与前端
`apps/analytics-web/src/features/onboarding/sdk-downloads.ts` 的对应表。
