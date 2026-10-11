import Foundation

/// ClkLog **iOS 客户端**上报 SDK 骨架（Swift + Foundation `URLSession`，零第三方依赖）。
///
/// ## ⚠️ 验证范围（诚实说明，勿夸大）
/// - **① 语言级实现已实测**：本文件在 **Swift 6.3.3（Command Line Tools，macOS 26，arm64）** 下
///   编译运行通过（`swiftc -O ClkLogClient.swift main.swift -o /tmp/clklog-ios`），
///   用**与 iOS 上同一套 Foundation `URLSession` API** 真实 HTTPS 上报，5 条事件落 ClickHouse。
/// - **② App / 真机打包未验证**：本机**只有 Command Line Tools，没有完整 Xcode / 模拟器**，
///   因此**未**做 Xcode 工程编译、未 `xcodebuild` 打包、未在 iOS 模拟器/真机（arm64 iOS 运行时）上跑过；
///   未验证 App 生命周期回调（`applicationDidEnterBackground`）、后台任务（`beginBackgroundTask`）、
///   UserDefaults 沙箱行为、以及 ATS（App Transport Security）在本域名下的实际放行情况。
/// - **③ 接入点（生产做法）**：把 `ClkLogClient.swift` 拖进 Xcode 工程（或做成 Swift Package 的
///   `Sources/ClkLogSDK`），在 App 启动时构造客户端，在下列时机调 `flush()`：
///   ```swift
///   // AppDelegate.swift
///   func applicationDidEnterBackground(_ app: UIApplication) {
///       let task = app.beginBackgroundTask(withName: "clklog.flush") { app.endBackgroundTask($0) }
///       DispatchQueue.global(qos: .utility).async {
///           _ = clk.flushAndWait(timeout: 5)   // 同步版，只在后台线程用
///           app.endBackgroundTask(task)
///       }
///   }
///   // 或 SwiftUI: @Environment(\.scenePhase) 里 case .background: clk.onAppBackground()
///   ```
///   注意 iOS 的后台时间以秒计，`flushAndWait(timeout:)` 必须给短超时（3~5s），
///   超时后事件仍在持久化队列里，下次启动自动补发。
/// - **④ 需要真机才能定的细节**：设备标识口径（本骨架用「持久化 UUID」；
///   iOS 上更常见的是 `UIDevice.current.identifierForVendor`（无需授权），
///   `ASIdentifierManager.advertisingIdentifier`（IDFA）需 ATT 授权，日活统计不建议）；
///   以及网络切换（蜂窝 ⇄ WiFi）、低电量模式对 `URLSession` 超时的影响。
///
/// ## 协议要点（规范《数据上报规范与流程.md》§1~§3）
/// - POST `/receiver/api/gp`，`Content-Type: application/x-www-form-urlencoded`；
/// - 表单字段 `project` / `token` / `data`；
/// - **编码硬要求**：`data` = 事件 JSON 数组 → base64（**必须单行**）→ urlencode。
///   直接 POST 原始 JSON 会 HTTP 200 但**静默丢数据**（§1.3）。本文件用
///   `Data.base64EncodedString(options: [])`（**不要**传 `.lineLength76Characters`，那会折行）
///   + 自写 RFC3986 percent-encoding；
/// - **用户标识口径与神策原生不同**（§3）：登录ID 走顶层 `identities.user_key`，
///   绑定匿名ID 走 `properties.$track_signup_original_id`；登录后 `distinct_id` **仍为匿名ID**。
/// - 事件字段与 §2.1 一致：`type / event / distinct_id / time(毫秒) / identities / lib / properties`
///   （JSON 对象键序无语义，receiver 按名取值）。
///
/// ## 客户端能力
/// - **匿名ID / 设备ID**：`deviceId()` 首次生成 UUID 存 `UserDefaults`，App 重启不变；
/// - **队列持久化**：入队即写 `UserDefaults`（键 `clklog.queue`），发送成功才删除 → 进程被杀/离线不丢数据；
/// - **会话**：`track` 自动附 `$event_session_id`，超过 `sessionTimeout` 无事件即换新会话；
/// - **批量上限**：单请求 ≤ `maxEventsPerRequest`(50) 条事件，且表单体 ≤ `maxBodyBytes`(1MB)，超限自动折半切分；
/// - **超时与退避重试**：连接/资源超时可配（默认 15s/30s），失败默认重试 3 次，间隔 500ms / 1s / 2s；
/// - **退后台 flush**：`onAppBackground()`（幂等、非阻塞）。
///
/// token 只从环境变量 / `../.env` 读取（见 `main.swift`），代码内不得出现 token 字面量（AGENTS.md 红线 3）。

// MARK: - 错误与结果

/// SDK 错误（`code` 稳定可判，`message` 供日志）。
public struct ClkLogError: Error, CustomStringConvertible {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }

    public var description: String { "\(code): \(message)" }
}

/// flush 结果：成功发送条数 + 错误（`error == nil` 即成功）。
public struct FlushResult {
    public let sent: Int
    public let error: ClkLogError?

    public init(sent: Int, error: ClkLogError?) {
        self.sent = sent
        self.error = error
    }

    public var isSuccess: Bool { error == nil }
}

// MARK: - 持久化

/// 客户端持久化接口（键值对，值为 String/JSON 文本）。
///
/// 默认实现 `UserDefaultsStorage` 即 iOS 上的常见做法（小体积 KV）；
/// 事件量大或要求加密时可换 MMKV / Keychain / 沙箱文件（实现本协议即可，见 `InMemoryStorage` 示例）。
public protocol ClkLogStorage: AnyObject {
    func string(forKey key: String) -> String?
    func set(_ value: String, forKey key: String)
    func removeValue(forKey key: String)
}

/// `UserDefaults` 实现（iOS 默认；`UserDefaults` 本身线程安全，这里再加锁保证读改写原子）。
public final class UserDefaultsStorage: ClkLogStorage {
    private let defaults: UserDefaults
    private let lock = NSLock()

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public convenience init?(suiteName: String) {
        guard let defaults = UserDefaults(suiteName: suiteName) else { return nil }
        self.init(defaults: defaults)
    }

    public func string(forKey key: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return defaults.string(forKey: key)
    }

    public func set(_ value: String, forKey key: String) {
        lock.lock()
        defaults.set(value, forKey: key)
        lock.unlock()
    }

    public func removeValue(forKey key: String) {
        lock.lock()
        defaults.removeObject(forKey: key)
        lock.unlock()
    }
}

/// 内存实现（单元测试 / 无持久化场景）。
public final class InMemoryStorage: ClkLogStorage {
    private var map: [String: String] = [:]
    private let lock = NSLock()

    public init() {}

    public func string(forKey key: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return map[key]
    }

    public func set(_ value: String, forKey key: String) {
        lock.lock()
        map[key] = value
        lock.unlock()
    }

    public func removeValue(forKey key: String) {
        lock.lock()
        map.removeValue(forKey: key)
        lock.unlock()
    }
}

// MARK: - 客户端

public final class ClkLogClient: @unchecked Sendable {

    public static let defaultEndpoint = "https://receiver-clklog.xyxverse.com/receiver/api/gp"
    public static let defaultProject = "clklogapp"
    /// SDK 标识，落 `lib.$lib`。
    public static let lib = "ios"
    /// SDK 版本，落 `lib.$lib_version`。
    public static let libVersion = "1.0.0"
    /// 单请求最多事件数（receiver 上限 50 条/次）。
    public static let maxEventsPerRequest = 50
    /// 单请求表单体字节上限（1MB）。
    public static let maxBodyBytes = 1024 * 1024
    /// 默认会话超时：30 分钟无事件即视为新会话。
    public static let defaultSessionTimeout: TimeInterval = 30 * 60

    private static let keyDeviceId = "clklog.device_id"
    private static let keyUserKey = "clklog.user_key"
    private static let keyQueue = "clklog.queue"
    private static let keySessionId = "clklog.session_id"
    private static let keySessionTs = "clklog.session_last_ts"
    private static let queueKey = DispatchSpecificKey<String>()

    private let endpoint: String
    private let project: String
    private let token: String
    private let storage: ClkLogStorage
    private let config: URLSessionConfiguration
    private var session: URLSession

    /// 串行 IO 队列：保证「队列读写 + 网络发送」不并发（`track` 永不阻塞调用方）。
    private let ioQueue = DispatchQueue(label: "com.clklog.sdk.io")
    private let lock = NSLock()
    private var events: [[String: Any]] = []

    // 可配参数
    public var batchSize = 20                     // 攒批条数，达到即异步 flush
    public var sessionAutoTrack = true            // 自动附 $event_session_id
    public var sessionTimeout: TimeInterval = ClkLogClient.defaultSessionTimeout
    public var maxAttempts = 3                    // 失败重试次数（含首次）
    public var retryBaseDelay: TimeInterval = 0.5 // 退避基数：0.5s / 1s / 2s
    public var debug = false                      // 打印诊断（**不含 token**）

    private var connectTimeout: TimeInterval = 15
    private var resourceTimeout: TimeInterval = 30
    private var userKey: String?

    public init(endpoint: String? = nil,
                project: String? = nil,
                token: String,
                storage: ClkLogStorage = UserDefaultsStorage()) {
        precondition(!token.isEmpty, "token is empty（从环境变量/配置注入，禁止硬编码）")
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 30
        config.httpMaximumConnectionsPerHost = 2
        config.waitsForConnectivity = false        // 后台/CLI 场景希望快速失败后走本地队列重试
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.config = config
        self.session = URLSession(configuration: config)

        self.endpoint = (endpoint?.isEmpty == false) ? endpoint! : ClkLogClient.defaultEndpoint
        self.project = (project?.isEmpty == false) ? project! : ClkLogClient.defaultProject
        self.token = token
        self.storage = storage
        self.userKey = Self.nonEmpty(storage.string(forKey: Self.keyUserKey))
        // 标记内部串行队列，flushAndWait 在队列内被调用时可识别并直接执行（防死锁）
        ioQueue.setSpecific(key: ClkLogClient.queueKey, value: "clklog.io")
        restoreQueue()
    }

    /// HTTP 超时（连接 / 资源），默认 15s / 30s。
    /// 注意：`URLSession` 在创建时拷贝配置，因此这里会重建 session —— 请在初始化后立即调用，不要与 flush 并发。
    public func setTimeout(connect: TimeInterval, resource: TimeInterval) {
        connectTimeout = connect
        resourceTimeout = resource
        config.timeoutIntervalForRequest = connect
        config.timeoutIntervalForResource = resource
        let old = session
        session = URLSession(configuration: config)
        old.invalidateAndCancel()
    }

    // MARK: 设备 / 用户 / 会话

    /// 设备ID（= 所有事件的 `distinct_id`，即匿名ID）。
    /// 首次调用生成 UUID 并持久化，App 重启后保持稳定（§3：全程稳定不切换）。
    public func deviceId() -> String {
        lock.lock()
        defer { lock.unlock() }
        return deviceIdLocked()
    }

    /// 调用方须已持有 `lock`（`NSLock` 不可重入：持锁时只能调 *Locked 版本，否则自死锁）。
    private func deviceIdLocked() -> String {
        if let id = Self.nonEmpty(storage.string(forKey: Self.keyDeviceId)) {
            return id
        }
        let id = ClkLogClient.lib + "-" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        storage.set(id, forKey: Self.keyDeviceId)
        if debug { print("[clklog] new device_id = \(id)") }
        return id
    }

    /// 覆盖设备ID（App 已有自己的标识：`identifierForVendor`、厂商 OAID 等）。
    /// 传 `nil` 则清空，下次 `deviceId()` 重新生成。
    public func setDeviceId(_ deviceId: String?) {
        lock.lock()
        defer { lock.unlock() }
        if let id = Self.nonEmpty(deviceId) {
            storage.set(id, forKey: Self.keyDeviceId)
        } else {
            storage.removeValue(forKey: Self.keyDeviceId)
        }
    }

    /// 当前登录ID（`identities.user_key`）；未登录返回 `nil`。
    public func currentUserKey() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return userKey
    }

    /// 手动设置登录ID（一般用 `login(_:)`，它会顺带上报 `track_signup` 完成绑定）。
    /// 传 `nil` = 退出登录：之后事件不再携带 `identities.user_key`（§3 规则 4）。
    public func setUserKey(_ userKey: String?) {
        lock.lock()
        defer { lock.unlock() }
        let value = Self.nonEmpty(userKey)
        self.userKey = value
        if let value = value {
            storage.set(value, forKey: Self.keyUserKey)
        } else {
            storage.removeValue(forKey: Self.keyUserKey)
        }
    }

    /// 当前会话ID（`$event_session_id`）。
    public func sessionId() -> String {
        currentSessionID()
    }

    // MARK: 上报 API

    /// 行为事件：`distinct_id` 用当前设备ID（匿名ID），登录后自动带 `identities.user_key`。
    public func track(_ event: String, properties: [String: Any] = [:]) {
        track(distinctId: deviceId(), event: event, properties: properties)
    }

    /// 行为事件（显式 `distinct_id`；登录后仍应传匿名ID，见 §3 规则 3）。
    public func track(distinctId: String, event: String, properties: [String: Any] = [:]) {
        var props = properties
        if sessionAutoTrack {
            props["$event_session_id"] = currentSessionID()   // 预置属性，自动落列（§4.3）
        }
        enqueue(makeEvent(type: "track", event: event, distinctId: distinctId, properties: props))
    }

    /// 登录关联：上报 `track_signup`（`event=$SignUp`，`distinct_id`=登录ID，
    /// `identities.user_key`=登录ID，`properties.$track_signup_original_id`=匿名ID），
    /// 之后所有事件自动携带 `identities.user_key`（§3 规则 2/3）。
    public func login(_ loginId: String, anonymousId: String? = nil) {
        precondition(!loginId.isEmpty, "loginId is empty")
        let anon = anonymousId ?? deviceId()
        setUserKey(loginId)
        enqueue(makeEvent(type: "track_signup",
                          event: "$SignUp",
                          distinctId: loginId,
                          properties: ["$track_signup_original_id": anon]))
    }

    /// 用户属性（覆盖写）：`distinct_id` 用当前设备ID。
    public func profileSet(_ properties: [String: Any]) {
        profileSet(distinctId: deviceId(), properties: properties)
    }

    /// 用户属性（覆盖写，显式 `distinct_id`）。
    public func profileSet(distinctId: String, properties: [String: Any]) {
        enqueue(makeEvent(type: "user_set", event: nil, distinctId: distinctId, properties: properties))
    }

    // MARK: 队列 / 发送

    /// 待发送事件数。
    public func queueSize() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return events.count
    }

    /// 已持久化的队列 JSON 字节数（离线队列确实落盘的证据）。
    public func persistedQueueBytes() -> Int {
        return storage.string(forKey: Self.keyQueue)?.utf8.count ?? 0
    }

    /// 丢弃待发送队列（仅在明确要放弃离线数据时调用）。
    public func clearQueue() {
        lock.lock()
        events.removeAll()
        storage.removeValue(forKey: Self.keyQueue)
        lock.unlock()
    }

    /// 异步 flush（**不阻塞调用方**）。回调在 SDK 内部串行队列上执行，
    /// 需要回主线程请自行 `DispatchQueue.main.async`。
    public func flush(completion: ((FlushResult) -> Void)? = nil) {
        ioQueue.async {
            let result = self.flushInternal()
            completion?(result)
        }
    }

    /// 同步 flush（阻塞）。**仅用于 CLI 验证 / 后台线程**（如 `beginBackgroundTask` 内），
    /// 不要在 iOS 主线程调用。
    public func flushAndWait(timeout: TimeInterval = 60) -> FlushResult {
        if DispatchQueue.getSpecific(key: ClkLogClient.queueKey) != nil {
            return flushInternal()   // 已在内部队列（例如 completion 回调里），直接跑，避免死锁
        }
        let box = ResultBox()
        ioQueue.async {
            box.value = self.flushInternal()
        }
        let semaphore = DispatchSemaphore(value: 0)
        ioQueue.async { semaphore.signal() }
        if semaphore.wait(timeout: .now() + timeout) == .timedOut {
            return FlushResult(sent: 0, error: ClkLogError(code: "timeout",
                                                           message: "flush did not finish in \(timeout)s"))
        }
        return box.value ?? FlushResult(sent: 0,
                                        error: ClkLogError(code: "timeout", message: "no result"))
    }

    /// App 退到后台（SwiftUI `scenePhase == .background` / AppDelegate `applicationDidEnterBackground`）：
    /// 固化队列 + 尝试发送，**非阻塞**；发送失败数据仍在队列里，下次启动/回前台补发。
    public func onAppBackground() {
        lock.lock()
        persistQueueLocked()
        lock.unlock()
        flush()
    }

    /// App 回到前台：补发上次残留的离线队列。
    public func onAppForeground() {
        flush()
    }

    /// 结束 SDK（App 退出时调用）：取消失效请求并释放 `URLSession`。
    public func close() {
        session.invalidateAndCancel()
    }

    // MARK: 内部实现

    private func makeEvent(type: String, event: String?, distinctId: String,
                           properties: [String: Any]) -> [String: Any] {
        var payload: [String: Any] = [
            "type": type,
            "distinct_id": distinctId,
            "time": Int(Date().timeIntervalSince1970 * 1000),   // 毫秒（秒级会导致时间错误）
            "lib": [
                "$lib": ClkLogClient.lib,
                "$lib_method": "code",
                "$lib_version": ClkLogClient.libVersion
            ],
            "properties": properties.isEmpty ? [:] as [String: Any] : properties
        ]
        if let event = event {
            payload["event"] = event
        }
        if let uk = currentUserKey() {
            payload["identities"] = ["user_key": uk]
        }
        return payload
    }

    private func enqueue(_ payload: [String: Any]) {
        // properties 只支持 JSON 类型（String / Number / Bool / Array / Dictionary / NSNull）
        guard JSONSerialization.isValidJSONObject(payload) else {
            if debug { print("[clklog] dropped invalid event (properties must be JSON types)") }
            return
        }
        lock.lock()
        events.append(payload)
        persistQueueLocked()
        let shouldFlush = events.count >= max(1, min(batchSize, ClkLogClient.maxEventsPerRequest))
        lock.unlock()
        if shouldFlush {
            flush()   // 攒批触发（异步）
        }
    }

    private func currentSessionID() -> String {
        let now = Date()
        lock.lock()
        defer { lock.unlock() }
        let last = Double(storage.string(forKey: Self.keySessionTs) ?? "") ?? 0
        var sid = Self.nonEmpty(storage.string(forKey: Self.keySessionId))
        if sid == nil || now.timeIntervalSince1970 - last > sessionTimeout {
            let millis = Int(now.timeIntervalSince1970 * 1000)
            sid = "\(deviceIdLocked())-\(millis)-\(Int.random(in: 0..<100000))"
            storage.set(sid!, forKey: Self.keySessionId)
        }
        storage.set(String(Int(now.timeIntervalSince1970)), forKey: Self.keySessionTs)
        return sid!
    }

    /// 队列 → JSON 落盘（调用方须持有 `lock`）。
    private func persistQueueLocked() {
        if events.isEmpty {
            storage.removeValue(forKey: Self.keyQueue)
            return
        }
        if let data = try? JSONSerialization.data(withJSONObject: events, options: []),
           let json = String(data: data, encoding: .utf8) {
            storage.set(json, forKey: Self.keyQueue)
        }
    }

    /// 启动时恢复残留队列（离线补发）。
    private func restoreQueue() {
        guard let json = Self.nonEmpty(storage.string(forKey: Self.keyQueue)),
              let data = json.data(using: .utf8),
              let parsed = try? JSONSerialization.jsonObject(with: data, options: []),
              let list = parsed as? [[String: Any]] else {
            storage.removeValue(forKey: Self.keyQueue)
            return
        }
        events = list
        if debug { print("[clklog] restored \(events.count) offline event(s)") }
    }

    /// 串行发送：分片（≤50 条 / ≤1MB）→ 退避重试 → 成功后从队列移除。
    private func flushInternal() -> FlushResult {
        var sent = 0
        while true {
            var chunk: [[String: Any]] = []
            var form = ""
            lock.lock()
            if events.isEmpty {
                lock.unlock()
                return FlushResult(sent: sent, error: nil)
            }
            var size = min(events.count, ClkLogClient.maxEventsPerRequest)
            while true {
                chunk = Array(events[0..<size])
                guard let data = try? JSONSerialization.data(withJSONObject: chunk, options: []) else {
                    lock.unlock()
                    return FlushResult(sent: sent, error: ClkLogError(code: "encode_failed",
                                                                     message: "JSONSerialization failed"))
                }
                // base64 单行（options 为空 = 不折行；不要用 .lineLength76Characters）
                form = buildForm(encodedData: data.base64EncodedString(options: []))
                if form.utf8.count <= ClkLogClient.maxBodyBytes { break }
                if size == 1 {
                    lock.unlock()
                    return FlushResult(sent: sent, error: ClkLogError(
                        code: "payload_too_large",
                        message: "single event body exceeds \(ClkLogClient.maxBodyBytes) bytes; queue kept"))
                }
                size = max(1, size / 2)
            }
            lock.unlock()

            if debug {
                print("[clklog] flush \(chunk.count) event(s), body \(form.utf8.count) bytes")
            }
            if let error = postFormWithRetry(form) {   // 失败：队列保留，返回错误
                return FlushResult(sent: sent, error: error)
            }
            lock.lock()
            events.removeFirst(min(chunk.count, events.count))
            persistQueueLocked()
            lock.unlock()
            sent += chunk.count
        }
    }

    /// 表单体：project / token / data（data 已是 urlencode 过的单行 base64）。
    private func buildForm(encodedData: String) -> String {
        return "project=" + Self.urlEncode(project)
            + "&token=" + Self.urlEncode(token)
            + "&data=" + Self.urlEncode(encodedData)
    }

    private func postFormWithRetry(_ form: String) -> ClkLogError? {
        var lastError: ClkLogError?
        let attempts = max(1, maxAttempts)
        for attempt in 1...attempts {
            if let error = postForm(form) {
                lastError = error
            } else {
                return nil
            }
            if debug {
                print("[clklog] attempt \(attempt)/\(attempts) failed: \(lastError?.description ?? "")")
            }
            if attempt < attempts {
                Thread.sleep(forTimeInterval: retryBaseDelay * pow(2, Double(attempt - 1)))
            }
        }
        return lastError ?? ClkLogError(code: "unknown", message: "flush failed")
    }

    /// 单次 HTTPS 表单 POST（用信号量把 `URLSession` 的异步回调转成同步，便于串行队列调用）。
    private func postForm(_ form: String) -> ClkLogError? {
        guard let url = URL(string: endpoint) else {
            return ClkLogError(code: "bad_endpoint", message: "invalid endpoint")
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = form.data(using: .utf8)
        request.timeoutInterval = connectTimeout

        let outcome = HttpOutcome()
        let semaphore = DispatchSemaphore(value: 0)
        let task = session.dataTask(with: request) { data, response, error in
            outcome.set(error: error,
                        status: (response as? HTTPURLResponse)?.statusCode,
                        body: data.flatMap { String(data: $0, encoding: .utf8) })
            semaphore.signal()
        }
        task.resume()
        if semaphore.wait(timeout: .now() + connectTimeout + resourceTimeout) == .timedOut {
            task.cancel()
            return ClkLogError(code: "timeout", message: "request timed out")
        }
        if let error = outcome.error {
            return ClkLogError(code: "transport", message: error.localizedDescription)
        }
        if outcome.status != 200 {
            return ClkLogError(code: "http", message: "status=\(outcome.status ?? -1) body=\(outcome.body ?? "")")
        }
        return nil
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value = value, !value.isEmpty else { return nil }
        return value
    }

    /// RFC3986 percent-encoding：只保留 `A-Za-z0-9-._~`。
    ///
    /// **为什么不用 `addingPercentEncoding(withAllowedCharacters:)`**：常用写法
    /// `CharacterSet.urlQueryAllowed` **不会**转义 `+`、`&`、`=`，base64 里的 `+` 到了服务端
    /// 会被 form 解码成空格、`=` 会被当成分隔符 → `data` 静默损坏（§1.3）。
    /// 这里按 UTF-8 字节逐字节编码，hex 大写，与 `encodeURIComponent` 行为一致（空格编码为 `%20`）。
    private static func urlEncode(_ value: String) -> String {
        var out = ""
        out.reserveCapacity(value.utf8.count)
        let hex = Array("0123456789ABCDEF".utf8)
        for byte in value.utf8 {
            let unreserved = (byte >= 0x41 && byte <= 0x5A)   // A-Z
                || (byte >= 0x61 && byte <= 0x7A)             // a-z
                || (byte >= 0x30 && byte <= 0x39)             // 0-9
                || byte == 0x2D || byte == 0x2E || byte == 0x5F || byte == 0x7E  // - . _ ~
            if unreserved {
                out.append(Character(UnicodeScalar(byte)))
            } else {
                out.append("%")
                out.append(Character(UnicodeScalar(hex[Int(byte >> 4)])))
                out.append(Character(UnicodeScalar(hex[Int(byte & 0x0F)])))
            }
        }
        return out
    }
}

// MARK: - 回调结果传递（URLSession 回调在后台队列，用锁保证可见性）

private final class HttpOutcome: @unchecked Sendable {
    private let lock = NSLock()
    private var _error: Error?
    private var _status: Int?
    private var _body: String?

    func set(error: Error?, status: Int?, body: String?) {
        lock.lock()
        _error = error
        _status = status
        _body = body
        lock.unlock()
    }

    var error: Error? {
        lock.lock()
        defer { lock.unlock() }
        return _error
    }

    var status: Int? {
        lock.lock()
        defer { lock.unlock() }
        return _status
    }

    var body: String? {
        lock.lock()
        defer { lock.unlock() }
        return _body
    }
}

private final class ResultBox: @unchecked Sendable {
    private let lock = NSLock()
    private var _value: FlushResult?

    var value: FlushResult? {
        get {
            lock.lock()
            defer { lock.unlock() }
            return _value
        }
        set {
            lock.lock()
            _value = newValue
            lock.unlock()
        }
    }
}
