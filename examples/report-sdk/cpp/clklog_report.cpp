// ClkLog 神策格式数据上报客户端 —— C++17 + libcurl（生产可用骨架）
//
// 规范文档：仓库根目录《数据上报规范与流程.md》§1~§3（协议 / 事件 JSON / 用户标识口径）。
//
// ---------------------------------------------------------------------------
// 为什么这个示例同时也是 Cocos2d-x（C++）的接入样本
//
// Cocos2d-x 的游戏逻辑层就是 C++17（引擎自带 cocos2d::network::HttpClient / HttpRequest），
// 但**协议逻辑与引擎无关**：事件 JSON、base64、urlencode、批次、重试退避完全一样。
// 引擎侧接入只需替换本文件的网络层（Client::postForm 这一个方法）：
//
//   auto *req = new cocos2d::network::HttpRequest();
//   req->setUrl(endpoint);
//   req->setRequestType(cocos2d::network::HttpRequest::Type::POST);
//   req->setRequestData(formBody.data(), formBody.size());
//   std::vector<std::string> headers{"Content-Type: application/x-www-form-urlencoded"};
//   req->setHeaders(headers);
//   req->setResponseCallback(...);   // 在回调里判定 code==200，否则按 attempts 重试
//   cocos2d::network::HttpClient::getInstance()->send(req);   // 异步，需自己桥接等待/重试
//
// 即：本文件 4.~6. 节（编码/事件/客户端）可原样拷进 Cocos 工程；只有 5. 节的 postForm 换成引擎
// 的 HttpClient（异步回调版）即可。Unity 版见 examples/report-sdk/csharp/，口径一致。
// ---------------------------------------------------------------------------
//
// 编译（macOS：libcurl 头与库在 SDK 内，需显式 -I/-L；本机实测通过）：
//   SDK=$(xcrun --show-sdk-path)
//   clang++ -std=c++17 -O2 -Wall -Wextra -I"$SDK/usr/include" -o /tmp/clklog-cpp/clklog_report \
//      clklog_report.cpp -L"$SDK/usr/lib" -lcurl
//   # Linux: clang++ -std=c++17 -O2 -Wall -Wextra -o /tmp/clklog-cpp/clklog_report clklog_report.cpp -lcurl
//
// 运行（token 只从环境变量或 ../.env 读取，代码内不得出现 token 字面量，AGENTS.md 红线 3）：
//   /tmp/clklog-cpp/clklog_report
//   CLKLOG_DEBUG=1 /tmp/clklog-cpp/clklog_report    # 打印待发送 JSON（不含 token）
//
// 编码硬要求（见规范 §1.3）：表单 data = JSON 数组 → base64（必须单行）→ urlencode；
// 直接 POST 原始 JSON 会 HTTP 200 但数据静默丢失；base64 的 '+' '/' '=' 必须 urlencode。

#include <curl/curl.h>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

namespace clklog {

constexpr const char *kDefaultEndpoint = "https://receiver-clklog.xyxverse.com/receiver/api/gp";
constexpr const char *kDefaultProject  = "clklogapp";
constexpr const char *kLib            = "cpp";
constexpr const char *kLibVersion     = "1.0.0";

// ===========================================================================
// 1. JSON 转义 / base64 / urlencode
// ===========================================================================

/** JSON 字符串转义（不含首尾引号）；中文等 UTF-8 字节原样透传，只转义必需字符。 */
std::string jsonEscape(const std::string &s)
{
    std::string out;
    out.reserve(s.size() + 8);

    for (unsigned char c : s) {
        switch (c) {
        case '"':  out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n";  break;
        case '\r': out += "\\r";  break;
        case '\t': out += "\\t";  break;
        case '\b': out += "\\b";  break;
        case '\f': out += "\\f";  break;
        default:
            if (c < 0x20) {
                char buf[8];
                std::snprintf(buf, sizeof(buf), "\\u%04x", c);
                out += buf;
            } else {
                out += static_cast<char>(c); // >=0x80 的 UTF-8 字节原样拷贝
            }
        }
    }
    return out;
}

/** 带引号的 JSON 字符串。 */
std::string jsonString(const std::string &s)
{
    return "\"" + jsonEscape(s) + "\"";
}

/**
 * 标准 base64，**严格单行输出**（base64 折行是已知坑，规范 §1.3）。
 */
std::string base64(const std::string &in)
{
    static const char tbl[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const auto *p = reinterpret_cast<const unsigned char *>(in.data());
    std::size_t n = in.size();
    std::string out;
    out.reserve(((n + 2) / 3) * 4);

    for (std::size_t i = 0; i < n; i += 3) {
        std::size_t rem = n - i;
        unsigned v = static_cast<unsigned>(p[i]) << 16;
        if (rem > 1) {
            v |= static_cast<unsigned>(p[i + 1]) << 8;
        }
        if (rem > 2) {
            v |= static_cast<unsigned>(p[i + 2]);
        }
        out += tbl[(v >> 18) & 0x3F];
        out += tbl[(v >> 12) & 0x3F];
        out += rem > 1 ? tbl[(v >> 6) & 0x3F] : '=';
        out += rem > 2 ? tbl[v & 0x3F] : '=';
    }
    return out;
}

/**
 * application/x-www-form-urlencoded 编码。
 * 注意 base64 的 '+' '/' '=' 必须编码（'+' → %2B），否则服务端把 '+' 解成空格 → 数据损坏。
 */
std::string urlEncode(const std::string &s)
{
    static const char *hex = "0123456789ABCDEF";
    std::string out;
    out.reserve(s.size() * 3);

    for (unsigned char c : s) {
        bool unreserved = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                          (c >= '0' && c <= '9') || c == '-' || c == '_' ||
                          c == '.' || c == '~';
        if (unreserved) {
            out += static_cast<char>(c);
        } else {
            out += '%';
            out += hex[(c >> 4) & 0x0F];
            out += hex[c & 0x0F];
        }
    }
    return out;
}

/** 毫秒时间戳（秒级会导致时间错误，规范 §10.2）。 */
long long nowMs()
{
    using namespace std::chrono;
    return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

// ===========================================================================
// 2. properties 拼装：手写 JSON 时统一走这里，避免漏转义 / 多逗号
// ===========================================================================

class Props {
public:
    Props() { buf_ = "{"; }

    Props &str(const std::string &key, const std::string &val)
    {
        sep();
        buf_ += jsonString(key) + ":" + jsonString(val);
        return *this;
    }

    Props &num(const std::string &key, double val)
    {
        sep();
        std::ostringstream os;
        os << val;
        buf_ += jsonString(key) + ":" + os.str();
        return *this;
    }

    Props &integer(const std::string &key, long long val)
    {
        sep();
        buf_ += jsonString(key) + ":" + std::to_string(val);
        return *this;
    }

    Props &boolean(const std::string &key, bool val)
    {
        sep();
        buf_ += jsonString(key) + ":" + (val ? "true" : "false");
        return *this;
    }

    /** 已序列化的 JSON 对象字符串（按值返回，勿存引用）。 */
    std::string json() const { return buf_ + "}"; }

private:
    void sep()
    {
        if (buf_.size() > 1) {
            buf_ += ',';
        }
    }

    std::string buf_;
};

// ===========================================================================
// 3. 事件（神策格式 + ClkLog identities 身份扩展）
// ===========================================================================

struct Event {
    std::string type;                    // track / track_signup / user_set
    std::string event;                   // 事件名（track 必填，其余留空）
    std::string distinctId;              // 访客ID（匿名ID，全程稳定不切换）
    long long   timeMs = 0;              // 毫秒时间戳
    std::string userKey;                 // 非空 → identities.user_key（登录ID）
    std::string properties = "{}";       // 已序列化的 JSON 对象；空传 {}，不要传 null
    std::string lib = kLib;              // $lib
    std::string libVersion = kLibVersion;// $lib_version

    std::string toJson() const
    {
        std::string j = "{\"type\":" + jsonString(type);
        if (!event.empty()) {
            j += ",\"event\":" + jsonString(event);
        }
        j += ",\"distinct_id\":" + jsonString(distinctId);
        j += ",\"time\":" + std::to_string(timeMs);
        if (!userKey.empty()) {
            j += ",\"identities\":{\"user_key\":" + jsonString(userKey) + "}";
        }
        j += ",\"lib\":{\"$lib\":" + jsonString(lib) +
             ",\"$lib_version\":" + jsonString(libVersion) + "}";
        j += ",\"properties\":" + (properties.empty() ? "{}" : properties);
        j += "}";
        return j;
    }
};

// ===========================================================================
// 4. 网络层（Cocos2d-x 接入时只需替换 Client::postForm，见文件头）
// ===========================================================================

struct HttpResponse {
    long        status = 0;
    std::string body;
    std::string error;
};

class HttpTransport {
public:
    HttpTransport()
    {
        curl_ = curl_easy_init();
        if (curl_ == nullptr) {
            throw std::runtime_error("curl_easy_init failed");
        }
        headers_ = curl_slist_append(nullptr, "Content-Type: application/x-www-form-urlencoded");
        curl_easy_setopt(curl_, CURLOPT_HTTPHEADER, headers_);
        curl_easy_setopt(curl_, CURLOPT_NOSIGNAL, 1L);   // 宿主多线程时不受信号影响
        curl_easy_setopt(curl_, CURLOPT_TCP_KEEPALIVE, 1L);
        curl_easy_setopt(curl_, CURLOPT_WRITEFUNCTION, &HttpTransport::writeCb);
    }

    ~HttpTransport()
    {
        if (headers_ != nullptr) {
            curl_slist_free_all(headers_);
        }
        if (curl_ != nullptr) {
            curl_easy_cleanup(curl_);
        }
    }

    HttpTransport(const HttpTransport &) = delete;
    HttpTransport &operator=(const HttpTransport &) = delete;

    HttpResponse post(const std::string &url, const std::string &body,
                      long connectTimeoutMs, long timeoutMs)
    {
        HttpResponse resp;
        char errbuf[CURL_ERROR_SIZE] = {0};

        curl_easy_setopt(curl_, CURLOPT_URL, url.c_str());
        curl_easy_setopt(curl_, CURLOPT_POST, 1L);
        curl_easy_setopt(curl_, CURLOPT_POSTFIELDS, body.data());
        curl_easy_setopt(curl_, CURLOPT_POSTFIELDSIZE_LARGE, static_cast<curl_off_t>(body.size()));
        curl_easy_setopt(curl_, CURLOPT_CONNECTTIMEOUT_MS, connectTimeoutMs);
        curl_easy_setopt(curl_, CURLOPT_TIMEOUT_MS, timeoutMs);
        curl_easy_setopt(curl_, CURLOPT_ERRORBUFFER, errbuf);
        curl_easy_setopt(curl_, CURLOPT_WRITEDATA, &resp.body);

        CURLcode rc = curl_easy_perform(curl_); // 同步；Cocos 侧换异步 HttpClient 后走回调判定
        curl_easy_getinfo(curl_, CURLINFO_RESPONSE_CODE, &resp.status);
        if (rc != CURLE_OK) {
            resp.error = errbuf[0] != '\0' ? errbuf : curl_easy_strerror(rc);
        }
        return resp;
    }

private:
    static std::size_t writeCb(char *ptr, std::size_t size, std::size_t nmemb, void *userdata)
    {
        auto *out = static_cast<std::string *>(userdata);
        out->append(ptr, size * nmemb);
        return size * nmemb;
    }

    CURL              *curl_ = nullptr;
    struct curl_slist *headers_ = nullptr;
};

// ===========================================================================
// 5. 客户端（Track / Login / ProfileSet / Flush + 批次 + 超时 + 重试退避）
// ===========================================================================

class Client {
public:
    Client(std::string endpoint, std::string project, std::string token,
           int batchSize = 10, std::string lib = kLib, std::string libVersion = kLibVersion)
        : endpoint_(std::move(endpoint)),
          project_(std::move(project)),
          token_(std::move(token)),
          batchSize_(batchSize > 0 ? batchSize : 10),
          lib_(std::move(lib)),
          libVersion_(std::move(libVersion))
    {
    }

    ~Client()
    {
        try {
            flush(); // 进程退出前兜底发送；异常不外抛（析构中不宜抛）
        } catch (...) {
        }
    }

    Client(const Client &) = delete;
    Client &operator=(const Client &) = delete;

    /** 行为事件；登录后自动携带 identities.user_key。 */
    void track(const std::string &distinctId, const std::string &event, const Props &props)
    {
        Event e;
        e.type = "track";
        e.event = event;
        e.distinctId = distinctId;
        e.timeMs = nowMs();
        e.userKey = loginId_; // 登录后自动带上
        e.properties = props.json();
        e.lib = lib_;
        e.libVersion = libVersion_;
        enqueue(std::move(e));
    }

    /** 用户属性（覆盖写）；登录后自动携带 identities.user_key。 */
    void profileSet(const std::string &distinctId, const Props &props)
    {
        Event e;
        e.type = "user_set";
        e.distinctId = distinctId;
        e.timeMs = nowMs();
        e.userKey = loginId_;
        e.properties = props.json();
        e.lib = lib_;
        e.libVersion = libVersion_;
        enqueue(std::move(e));
    }

    /**
     * 登录关联：上报 track_signup 绑定匿名ID，之后事件自动带 identities.user_key。
     * ClkLog 口径：identities.user_key=登录ID、properties.$track_signup_original_id=匿名ID
     * （不是神策顶层的 login_id / original_id，规范 §3）。
     */
    void login(const std::string &loginId, const std::string &anonymousId)
    {
        loginId_ = loginId;
        Props props;
        props.str("$track_signup_original_id", anonymousId);

        Event e;
        e.type = "track_signup";
        e.event = "$SignUp";
        e.distinctId = loginId;
        e.timeMs = nowMs();
        e.userKey = loginId;
        e.properties = props.json();
        e.lib = lib_;
        e.libVersion = libVersion_;
        enqueue(std::move(e));
    }

    /** 退出登录：停止携带 identities.user_key 即可，无需上报事件（规范 §3.4）。 */
    void logout() { loginId_.clear(); }

    /** debug 打开后打印待发送 JSON（**不含 token**）。 */
    void setDebug(bool on) { debug_ = on; }

    void setRetry(int maxAttempts, int backoffMs)
    {
        maxAttempts_ = maxAttempts > 0 ? maxAttempts : 1;
        backoffMs_ = backoffMs;
    }

    /**
     * 发送队列中全部事件：JSON 数组 → base64（单行）→ urlencode 表单 POST，失败重试退避。
     * @return 本次发送的事件条数
     */
    int flush()
    {
        if (queue_.empty()) {
            return 0;
        }
        const std::size_t n = queue_.size();

        std::string json = "[";
        for (std::size_t i = 0; i < n; i++) {
            if (i != 0) {
                json += ',';
            }
            json += queue_[i].toJson();
        }
        json += ']';

        const std::string payload = base64(json);
        const std::string form = "project=" + urlEncode(project_) +
                                 "&token=" + urlEncode(token_) +
                                 "&data=" + urlEncode(payload);

        if (debug_) {
            std::cout << "[clklog] payload(" << n << " events) = " << json << '\n'; // 不含 token
            std::cout << "[clklog] base64 len=" << payload.size()
                      << " single-line=" << (payload.find('\n') == std::string::npos ? "YES" : "NO")
                      << '\n';
        }

        std::string lastError;
        for (int attempt = 1; attempt <= maxAttempts_; attempt++) {
            HttpResponse resp = postForm(form);
            if (resp.error.empty() && resp.status == 200) {
                queue_.clear();
                std::cout << "[clklog] flushed " << n << " events OK (HTTP 200)\n";
                return static_cast<int>(n);
            }
            lastError = resp.error.empty()
                            ? ("HTTP " + std::to_string(resp.status) + " body=" + trim(resp.body))
                            : resp.error;
            std::cerr << "[clklog] attempt " << attempt << '/' << maxAttempts_
                      << " failed: " << lastError << '\n';
            if (attempt < maxAttempts_) {
                std::this_thread::sleep_for(
                    std::chrono::milliseconds(static_cast<long long>(attempt) * backoffMs_));
            }
        }
        throw std::runtime_error("flush failed after " + std::to_string(maxAttempts_) +
                                 " attempts: " + lastError);
    }

protected:
    /** 网络层：唯一需要为 Cocos2d-x / 其他 C++ HTTP 客户端替换的方法。 */
    virtual HttpResponse postForm(const std::string &formBody) const
    {
        HttpTransport &t = transport(); // 懒初始化：Cocos 侧替换后此处不再用 libcurl
        return t.post(endpoint_, formBody, connectTimeoutMs_, timeoutMs_);
    }

private:
    /** libcurl 需要 curl_global_init；放在首次使用时做一次。 */
    static HttpTransport &transport()
    {
        static HttpTransport instance;
        return instance;
    }

    static std::string trim(const std::string &s)
    {
        std::string t = s;
        for (char &c : t) {
            if (c == '\n' || c == '\r') {
                c = ' ';
            }
        }
        return t.size() > 200 ? t.substr(0, 200) + "..." : t;
    }

    void enqueue(Event &&e)
    {
        queue_.push_back(std::move(e));
        if (static_cast<int>(queue_.size()) >= batchSize_) {
            flush();
        }
    }

    std::string endpoint_;
    std::string project_;
    std::string token_;   // 只从环境变量 / ../.env 取，禁止硬编码（AGENTS.md 红线 3）
    int         batchSize_;
    std::string lib_;
    std::string libVersion_;
    std::string loginId_; // 非空 = 已登录，自动进 identities.user_key

    std::vector<Event> queue_;
    int                maxAttempts_    = 3;
    int                backoffMs_      = 500;   // 线性退避：attempt * backoffMs
    long               connectTimeoutMs_ = 10000;
    long               timeoutMs_      = 15000;
    bool               debug_          = false;
};

// ===========================================================================
// 6. 配置读取（环境变量优先，其次 ../.env；只读不打印值）
// ===========================================================================

void loadDotenv()
{
    const char *candidates[] = {
        "../.env",                                                          // 从 cpp/ 运行
        "examples/report-sdk/.env",                                         // 从仓库根运行
    };

    for (const char *path : candidates) {
        std::ifstream in(path);
        if (!in) {
            continue;
        }
        std::string line;
        while (std::getline(in, line)) {
            while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) {
                line.pop_back();
            }
            if (line.empty() || line[0] == '#') {
                continue;
            }
            auto eq = line.find('=');
            if (eq == std::string::npos || eq == 0) {
                continue;
            }
            std::string key = line.substr(0, eq);
            std::string val = line.substr(eq + 1);
            if (std::getenv(key.c_str()) == nullptr) {
                setenv(key.c_str(), val.c_str(), 0); // 0 = 不覆盖已存在
            }
        }
        std::cout << "[clklog] loaded env from " << path << '\n';
        return;
    }
    std::cout << "[clklog] .env not found, fallback to system env\n";
}

std::string envOr(const char *key, const char *fallback)
{
    const char *v = std::getenv(key);
    return (v != nullptr && *v != '\0') ? std::string(v) : std::string(fallback);
}

} // namespace clklog

// ===========================================================================
// 7. 使用示例：匿名事件 → 登录关联 → 用户属性 → 登录后事件 ×2 → Flush
// ===========================================================================

int main()
{
    using namespace clklog;

    curl_global_init(CURL_GLOBAL_DEFAULT);
    loadDotenv();

    // token 只从环境变量 / ../.env 读，禁止硬编码（AGENTS.md 红线 3）
    const char *tokenEnv = std::getenv("CLKLOG_TOKEN");
    if (tokenEnv == nullptr || *tokenEnv == '\0') {
        std::cerr << "missing env CLKLOG_TOKEN\n";
        return 1;
    }
    const std::string token = tokenEnv;

    Client cli(envOr("CLKLOG_ENDPOINT", kDefaultEndpoint),
               envOr("CLKLOG_PROJECT", kDefaultProject),
               token, /*batchSize=*/10, "cpp", "1.0.0");
    cli.setDebug(envOr("CLKLOG_DEBUG", "") == "1");

    const long long ts = nowMs() / 1000;
    const std::string runId   = "cpp-" + std::to_string(ts);
    const std::string anonId  = "sdk-test-anon-" + runId; // 匿名ID：全程稳定不切换
    const std::string loginId = "uid-cpp-" + runId;       // 登录ID

    try {
        // 1. 登录前：匿名事件（不带 identities）
        cli.track(anonId, "SdkSpecTest",
                  Props().str("test_run_id", runId).str("sdk_lang", "cpp").str("step", "before_login"));

        // 2. 登录关联：之后所有事件自动携带 identities.user_key
        cli.login(loginId, anonId);

        // 3. 用户属性（登录态）
        cli.profileSet(anonId,
                       Props().integer("vip_level", 3)
                           .str("register_channel", "app_store")
                           .str("sdk_lang", "cpp"));

        // 4. 登录后行为事件：distinct_id 仍为匿名ID，登录ID 走 identities.user_key
        cli.track(anonId, "SdkSpecTest",
                  Props().str("test_run_id", runId)
                      .str("sdk_lang", "cpp")
                      .num("amount", 99.5)
                      .str("product_id", "P1001")
                      .str("product_name", "测试商品")); // 中文属性值：UTF-8 原样进 JSON

        // 5. Purchase；附一条自检属性，验证引号/反斜杠/换行/中文的转义与 UTF-8 不变形
        cli.track(anonId, "Purchase",
                  Props().str("test_run_id", runId)
                      .str("order_id", "O" + runId)
                      .num("amount", 99.5)
                      .str("pay_type", "alipay")
                      .boolean("is_new_user", true)
                      .str("escape_check", "引号\" 反斜杠\\ 换行\n 中文"));

        cli.flush(); // 一个批次 5 条（生产建议定时 / 进程退出前兜底 Flush）
        std::cout << "DONE run_id = " << runId << std::endl;
    } catch (const std::exception &ex) {
        std::cerr << "[clklog] fatal: " << ex.what() << std::endl;
        curl_global_cleanup();
        return 1;
    }

    curl_global_cleanup();
    return 0;
}
