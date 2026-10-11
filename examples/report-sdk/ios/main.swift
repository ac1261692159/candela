import Foundation

// ClkLog iOS 客户端 SDK 验证入口：跑完规范 §9 的 5 步事件链并落 ClickHouse。
//
// ⚠️ 验证范围（诚实说明，勿夸大）
//   语言级实现已实测：本机 Swift 6.3.3（Command Line Tools，macOS 26 arm64）编译运行，
//   用与 iOS 同一套 Foundation URLSession API 真实 HTTPS 上报，5 条事件落 ClickHouse。
//   未验证：完整 Xcode 工程编译 / iOS 模拟器或真机打包 / App 生命周期回调 / ATS 实际放行
//   （本机只有 Command Line Tools，无完整 Xcode、无模拟器）。
//
// 编译 + 运行（实测命令，产物落 /tmp 不入库）：
//   cd examples/report-sdk/ios
//   swiftc -O ClkLogClient.swift main.swift -o /tmp/clklog-ios
//   /tmp/clklog-ios
//
// token 从环境变量 CLKLOG_TOKEN 或 ../.env 读取（后者不覆盖已存在环境变量），
// 代码内不存在 token 字面量（AGENTS.md 红线 3），日志只打印 run_id 与事件数。
//
// 5 步事件链（顺序与 ../go/main.go 一致）：
//   1) track 匿名（无 identities，properties 含 test_run_id/sdk_lang/step=before_login）
//   2) track_signup $SignUp（distinct_id=登录ID，identities.user_key=登录ID，
//      properties.$track_signup_original_id=匿名ID）
//   3) user_set（distinct_id=匿名ID，identities.user_key=登录ID，properties 含 vip_level 等）
//   4) track 登录后（distinct_id 仍为匿名ID + identities.user_key=登录ID）
//   5) track "Purchase"（同上身份，properties 含 order_id）
// 末尾打印 DONE run_id = <runID>，供 ../verify.sh 使用。

/// 验证用 UserDefaults suite（独立域，不污染真实 App 的 standard defaults）。
let suiteName = "com.clklog.sdk.example.cli"

func env(_ key: String) -> String? {
    if let value = ProcessInfo.processInfo.environment[key], !value.isEmpty {
        return value
    }
    return nil
}

/// 加载 ../.env（已存在的环境变量优先），仅取用到的键，token 不打印。
func loadDotenv() -> [String: String] {
    var out: [String: String] = [:]
    let candidates = [
        "../.env",                                                                  // 从 examples/report-sdk/ios/ 运行
        "examples/report-sdk/.env",                                                 // 从仓库根目录运行
    ]
    for path in candidates {
        guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { continue }
        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { continue }
            guard let eq = line.firstIndex(of: "=") else { continue }
            let key = String(line[line.startIndex..<eq]).trimmingCharacters(in: .whitespaces)
            let value = String(line[line.index(after: eq)...]).trimmingCharacters(in: .whitespaces)
            out[key] = value
        }
        print("[sdk] loaded env from \(path) (token not printed)")
        return out
    }
    print("[sdk] .env not found, fallback to system env")
    return out
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(("\(message)\n").data(using: .utf8)!)
    exit(1)
}

let dotenv = loadDotenv()
guard let token = env("CLKLOG_TOKEN") ?? dotenv["CLKLOG_TOKEN"] else {
    fail("[sdk] missing CLKLOG_TOKEN (env or ../.env)")
}
let endpoint = env("CLKLOG_ENDPOINT") ?? dotenv["CLKLOG_ENDPOINT"] ?? ClkLogClient.defaultEndpoint
let project = env("CLKLOG_PROJECT") ?? dotenv["CLKLOG_PROJECT"] ?? ClkLogClient.defaultProject

let lang = "ios"
let runID = "\(lang)-\(Int(Date().timeIntervalSince1970))"
let anonID = "sdk-test-anon-\(runID)"     // 匿名ID / 设备ID（登录前后都不变）
let loginID = "uid-\(lang)-\(runID)"

guard let defaults = UserDefaults(suiteName: suiteName) else {
    fail("[sdk] cannot create UserDefaults suite \(suiteName)")
}
let cli = ClkLogClient(endpoint: endpoint, project: project, token: token,
                       storage: UserDefaultsStorage(defaults: defaults))
cli.batchSize = 50      // 验证时 5 条一批一次性发出
cli.debug = true

// 设备ID：真实 App 首次启动自动生成 UUID 并持久化（这里读一次，证明"生成 + 持久化"路径可用）
print("[sdk] auto device_id     = \(cli.deviceId())")
// 本次验收要求 run_id 可检索，故显式覆盖设备ID；等价于 App 用 identifierForVendor 调 setDeviceId()
cli.setDeviceId(anonID)
let persistOk = UserDefaults(suiteName: suiteName)?.string(forKey: "clklog.device_id") == anonID
print("[sdk] distinct_id (anon) = \(cli.deviceId())  (persist ok: \(persistOk))")

// ---- 1. 登录前：匿名事件（无 identities） ----
cli.track("SdkSpecTest", properties: [
    "test_run_id": runID,
    "sdk_lang": lang,
    "step": "before_login",
])

// ---- 2. 登录关联：track_signup 绑定匿名ID → 登录ID ----
cli.login(loginID, anonymousId: anonID)

// ---- 3. 用户属性（登录态；distinct_id 仍为匿名ID） ----
cli.profileSet(distinctId: anonID, properties: [
    "vip_level": 3,
    "register_channel": "app_store",
    "sdk_lang": lang,
])

// ---- 4. 登录后行为事件：distinct_id 仍为匿名ID，登录ID 走 identities.user_key ----
cli.track(distinctId: anonID, event: "SdkSpecTest", properties: [
    "test_run_id": runID,
    "sdk_lang": lang,
    "amount": 99.5,
    "is_new_user": true,
    "product_id": "P1001",
    "product_name": "测试商品",
])

// ---- 5. 登录后第二个事件 ----
cli.track(distinctId: anonID, event: "Purchase", properties: [
    "test_run_id": runID,
    "order_id": "O\(runID)",
    "amount": 99.5,
    "pay_type": "alipay",
])

// 离线队列证据：flush 前队列已持久化在 UserDefaults 上
print("[sdk] pending queue       = \(cli.queueSize()) event(s), persisted "
    + "\(cli.persistedQueueBytes()) bytes @ UserDefaults(\(suiteName))")
print("[sdk] session_id         = \(cli.sessionId())")

let result = cli.flushAndWait(timeout: 60)
if let error = result.error {
    FileHandle.standardError.write("[sdk] FAILED: \(error)\n".data(using: .utf8)!)
    FileHandle.standardError.write("[sdk] queue kept, run_id = \(runID)\n".data(using: .utf8)!)
    cli.close()
    exit(1)
}
print("[sdk] flushed            = \(result.sent) event(s)")

// 模拟进程重启：同一 UserDefaults suite 重新构造客户端，队列应为空、设备ID 不变
let reopened = ClkLogClient(endpoint: endpoint, project: project, token: token,
                            storage: UserDefaultsStorage(defaults: defaults))
print("[sdk] reopen check       : device_id=\(reopened.deviceId()), pending=\(reopened.queueSize())")

// 模拟 App 退到后台：固化队列 + 异步 flush（队列已空则不发请求）
cli.onAppBackground()
print("[sdk] onAppBackground    : queue=\(cli.queueSize())")

cli.close()
reopened.close()
print("DONE run_id = \(runID)")
exit(0)
