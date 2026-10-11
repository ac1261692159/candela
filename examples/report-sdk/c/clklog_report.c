/*
 * ClkLog 神策格式数据上报客户端 —— C11 + libcurl（生产可用骨架）
 *
 * 规范文档：仓库根目录《数据上报规范与流程.md》§1~§3（协议 / 事件 JSON / 用户标识口径）。
 *
 * 编译（macOS：libcurl 头与库在 SDK 内，需显式 -I/-L；本机实测通过）：
 *   SDK=$(xcrun --show-sdk-path)
 *   cc -std=c11 -O2 -Wall -Wextra -I"$SDK/usr/include" -o /tmp/clklog-c/clklog_report \
 *      clklog_report.c -L"$SDK/usr/lib" -lcurl
 *   # Linux: cc -std=c11 -O2 -Wall -Wextra -o /tmp/clklog-c/clklog_report clklog_report.c -lcurl
 *   # 或用 curl-config: cc -std=c11 -O2 -Wall -Wextra -o out clklog_report.c $(curl-config --cflags --libs)
 *
 * 运行（token 只从环境变量或 ../.env 读取，代码内不得出现 token 字面量，AGENTS.md 红线 3）：
 *   /tmp/clklog-c/clklog_report
 *   CLKLOG_DEBUG=1 /tmp/clklog-c/clklog_report   # 打印待发送 JSON（不含 token）
 *
 * 平台移植：本文件依赖 libcurl + 少量 POSIX（setenv / clock_gettime；Windows 可换 _putenv_s /
 * GetSystemTimeAsFileTime）。协议逻辑（事件 JSON / base64 / urlencode / 批次 / 重试退避）与平台无关，
 * 换网络层只需替换 http_post()。示例为可读性让 xmalloc 在 OOM 时直接报错退出；生产可改为错误码。
 *
 * 编码硬要求（见规范 §1.3，最常踩的坑）：
 *   表单 data = JSON 数组 → base64（必须单行）→ urlencode。直接 POST 原始 JSON 会 HTTP 200
 *   但数据静默丢失。base64 内的 '+' '/' '=' 若不做 urlencode，'+' 会被服务端解成空格 → 解析失败。
 */

#define _POSIX_C_SOURCE 200809L

#include <curl/curl.h>

#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#define CLKLOG_LIB              "c"
#define CLKLOG_LIB_VERSION      "1.0.0"
#define CLKLOG_DEFAULT_ENDPOINT "https://receiver-clklog.xyxverse.com/receiver/api/gp"
#define CLKLOG_DEFAULT_PROJECT  "clklogapp"
#define CLKLOG_MAX_BATCH        64
#define CLKLOG_FIELD_MAX        512

/* ================================================================== */
/* 1. 动态字符串缓冲                                                   */
/* ================================================================== */

typedef struct {
    char  *data; /* 始终以 '\0' 结尾，可直接当 C 字符串用 */
    size_t len;
    size_t cap;
} sbuf;

static void *xmalloc(size_t n)
{
    void *p = malloc(n);

    if (!p) {
        fprintf(stderr, "[clklog] out of memory (%zu bytes)\n", n);
        exit(1);
    }
    return p;
}

static void *xrealloc(void *p, size_t n)
{
    void *q = realloc(p, n);

    if (!q) {
        fprintf(stderr, "[clklog] out of memory (%zu bytes)\n", n);
        exit(1);
    }
    return q;
}

static void sb_init(sbuf *b)
{
    b->cap  = 256;
    b->len  = 0;
    b->data = (char *)xmalloc(b->cap);
    b->data[0] = '\0';
}

static void sb_free(sbuf *b)
{
    free(b->data);
    b->data = NULL;
    b->len = b->cap = 0;
}

/** 释放并把所有权交给调用方（返回的指针由调用方 free）。 */
static char *sb_take(sbuf *b)
{
    char *d = b->data;

    b->data = NULL;
    b->len = b->cap = 0;
    return d;
}

static void sb_reserve(sbuf *b, size_t extra)
{
    if (b->len + extra + 1 <= b->cap) {
        return;
    }
    while (b->cap < b->len + extra + 1) {
        b->cap *= 2;
    }
    b->data = (char *)xrealloc(b->data, b->cap);
}

static void sb_put(sbuf *b, const char *s, size_t n)
{
    sb_reserve(b, n);
    memcpy(b->data + b->len, s, n);
    b->len += n;
    b->data[b->len] = '\0';
}

static void sb_puts(sbuf *b, const char *s) { sb_put(b, s, strlen(s)); }
static void sb_putc(sbuf *b, char c)        { sb_put(b, &c, 1); }

static void sb_putf(sbuf *b, const char *fmt, ...)
{
    va_list ap, ap2;
    int     n;

    va_start(ap, fmt);
    va_copy(ap2, ap);
    n = vsnprintf(NULL, 0, fmt, ap);
    va_end(ap);
    if (n < 0) {
        va_end(ap2);
        return;
    }
    sb_reserve(b, (size_t)n);
    vsnprintf(b->data + b->len, (size_t)n + 1, fmt, ap2);
    b->len += (size_t)n;
    va_end(ap2);
}

/* ================================================================== */
/* 2. JSON 转义 / base64 / urlencode                                   */
/* ================================================================== */

/**
 * JSON 字符串转义（不含首尾引号）。
 * 中文等 >= 0x80 的 UTF-8 字节原样透传（JSON 允许直接内嵌 UTF-8），只转义必需字符。
 * 若误把 UTF-8 字节按 %02x 拆开输出，属性值就会变成乱码。
 */
static void json_escape_to(sbuf *b, const char *s)
{
    const unsigned char *p;

    for (p = (const unsigned char *)s; *p; p++) {
        switch (*p) {
        case '"':  sb_puts(b, "\\\""); break;
        case '\\': sb_puts(b, "\\\\"); break;
        case '\n': sb_puts(b, "\\n");  break;
        case '\r': sb_puts(b, "\\r");  break;
        case '\t': sb_puts(b, "\\t");  break;
        case '\b': sb_puts(b, "\\b");  break;
        case '\f': sb_puts(b, "\\f");  break;
        default:
            if (*p < 0x20) {
                sb_putf(b, "\\u%04x", (unsigned)*p);
            } else {
                sb_putc(b, (char)*p);
            }
        }
    }
}

/** 写一个带引号的 JSON 字符串（含转义）。 */
static void json_str_to(sbuf *b, const char *s)
{
    sb_putc(b, '"');
    json_escape_to(b, s);
    sb_putc(b, '"');
}

/**
 * 标准 base64：输出**严格单行**、无任何换行。
 * base64 换行是已知坑——折行会让 data 字段解码/解析异常（规范 §1.3）。
 */
static void base64_to(sbuf *out, const unsigned char *in, size_t n)
{
    static const char tbl[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t i;

    for (i = 0; i < n; i += 3) {
        size_t   rem = n - i;
        unsigned v   = (unsigned)in[i] << 16;

        if (rem > 1) {
            v |= (unsigned)in[i + 1] << 8;
        }
        if (rem > 2) {
            v |= (unsigned)in[i + 2];
        }
        sb_putc(out, tbl[(v >> 18) & 0x3F]);
        sb_putc(out, tbl[(v >> 12) & 0x3F]);
        sb_putc(out, rem > 1 ? tbl[(v >> 6) & 0x3F] : '=');
        sb_putc(out, rem > 2 ? tbl[v & 0x3F] : '=');
    }
}

static int url_is_unreserved(unsigned char c)
{
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
           (c >= '0' && c <= '9') ||
           c == '-' || c == '_' || c == '.' || c == '~';
}

/**
 * application/x-www-form-urlencoded 编码。
 * base64 的 '+' '/' '=' 必须被编码（'+' → %2B），否则服务端把 '+' 解成空格 → 数据损坏。
 */
static void url_encode_to(sbuf *out, const char *s, size_t n)
{
    size_t i;

    for (i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];

        if (url_is_unreserved(c)) {
            sb_putc(out, (char)c);
        } else {
            sb_putf(out, "%%%02X", c);
        }
    }
}

/* ================================================================== */
/* 3. properties 拼装小工具（手写 JSON 时避免漏转义 / 多逗号）          */
/* ================================================================== */

static void props_init(sbuf *p) { sb_init(p); sb_putc(p, '{'); }
static void props_end(sbuf *p)  { sb_putc(p, '}'); }

static void prop_sep(sbuf *p)
{
    if (p->len > 1 && p->data[p->len - 1] != '{') {
        sb_putc(p, ',');
    }
}

static void prop_str(sbuf *p, const char *key, const char *val)
{
    prop_sep(p);
    json_str_to(p, key);
    sb_putc(p, ':');
    json_str_to(p, val);
}

static void prop_int(sbuf *p, const char *key, long long val)
{
    prop_sep(p);
    json_str_to(p, key);
    sb_putf(p, ":%lld", val);
}

static void prop_num(sbuf *p, const char *key, double val)
{
    prop_sep(p);
    json_str_to(p, key);
    sb_putf(p, ":%g", val);
}

static void prop_bool(sbuf *p, const char *key, int val)
{
    prop_sep(p);
    json_str_to(p, key);
    sb_puts(p, val ? ":true" : ":false");
}

/* ================================================================== */
/* 4. 工具：毫秒时间戳 / 环境变量                                      */
/* ================================================================== */

/** 毫秒时间戳（秒级会导致时间错误，规范 §10.2）。 */
static long long clklog_now_ms(void)
{
    struct timespec ts;

    clock_gettime(CLOCK_REALTIME, &ts);
    return (long long)ts.tv_sec * 1000LL + ts.tv_nsec / 1000000LL;
}

static void sleep_ms(int ms)
{
    struct timespec ts;

    ts.tv_sec  = ms / 1000;
    ts.tv_nsec = (long)(ms % 1000) * 1000000L;
    nanosleep(&ts, NULL);
}

/** 加载 ../.env（不覆盖已存在的环境变量；只读、不打印值）。 */
static void load_dotenv(void)
{
    static const char *candidates[] = {
        "../.env",                                                          /* 从 c/ 运行 */
        "examples/report-sdk/.env",                                         /* 从仓库根运行 */
        NULL,
    };
    int i;

    for (i = 0; candidates[i]; i++) {
        FILE *fp = fopen(candidates[i], "r");
        char  line[1024];

        if (!fp) {
            continue;
        }
        while (fgets(line, sizeof(line), fp)) {
            char *eq, *key = line, *val, *end;

            while (*key == ' ' || *key == '\t') {
                key++;
            }
            if (*key == '#' || *key == '\n' || *key == '\0') {
                continue;
            }
            eq = strchr(key, '=');
            if (!eq) {
                continue;
            }
            *eq = '\0';
            val = eq + 1;
            end = val + strlen(val);
            while (end > val && (end[-1] == '\n' || end[-1] == '\r' ||
                                 end[-1] == ' '  || end[-1] == '\t')) {
                *--end = '\0';
            }
            end = key + strlen(key);
            while (end > key && (end[-1] == ' ' || end[-1] == '\t')) {
                *--end = '\0';
            }
            if (*key && *val && getenv(key) == NULL) {
                setenv(key, val, 0); /* 0 = 不覆盖已存在 */
            }
        }
        fclose(fp);
        printf("[clklog] loaded env from %s\n", candidates[i]);
        return;
    }
    printf("[clklog] .env not found, fallback to system env\n");
}

/* ================================================================== */
/* 5. 客户端                                                           */
/*                                                                     */
/* 对外 API（非 static，可直接搬进你的工程、配个头文件复用）：          */
/*   clklog_init / clklog_free / clklog_track / clklog_profile_set /    */
/*   clklog_login / clklog_logout / clklog_flush                       */
/* ================================================================== */

typedef struct {
    char endpoint[CLKLOG_FIELD_MAX];
    char project[CLKLOG_FIELD_MAX];
    char token[CLKLOG_FIELD_MAX];
    char lib[32];
    char lib_version[32];

    char login_id[CLKLOG_FIELD_MAX]; /* 空串 = 未登录；非空自动进 identities.user_key */

    int batch_size;
    int connect_timeout_ms;
    int timeout_ms;
    int max_attempts;
    int debug; /* 1 = 打印待发送 JSON（不含 token） */

    char  *queue[CLKLOG_MAX_BATCH];
    size_t queue_len;

    CURL              *curl;
    struct curl_slist *headers;
} clklog_client;

/** 响应体收集（不设 WRITEFUNCTION 时 libcurl 会把 WRITEDATA 当 FILE*，此处必须显式给回调）。 */
static size_t body_write_cb(char *ptr, size_t size, size_t nmemb, void *userdata)
{
    sbuf  *out = (sbuf *)userdata;
    size_t n   = size * nmemb;

    sb_put(out, ptr, n);
    return n;
}

static int http_post(clklog_client *c, const char *body, size_t body_len,
                     long *http_code, char *errbuf, size_t errbuf_len)
{
    sbuf     resp;
    CURLcode rc;

    sb_init(&resp);
    errbuf[0] = '\0';
    *http_code = 0;

    curl_easy_setopt(c->curl, CURLOPT_URL, c->endpoint);
    curl_easy_setopt(c->curl, CURLOPT_POST, 1L);
    curl_easy_setopt(c->curl, CURLOPT_POSTFIELDS, body);
    curl_easy_setopt(c->curl, CURLOPT_POSTFIELDSIZE_LARGE, (curl_off_t)body_len);
    curl_easy_setopt(c->curl, CURLOPT_HTTPHEADER, c->headers);
    curl_easy_setopt(c->curl, CURLOPT_CONNECTTIMEOUT_MS, (long)c->connect_timeout_ms);
    curl_easy_setopt(c->curl, CURLOPT_TIMEOUT_MS, (long)c->timeout_ms);
    curl_easy_setopt(c->curl, CURLOPT_NOSIGNAL, 1L); /* 宿主多线程时不受信号影响 */
    curl_easy_setopt(c->curl, CURLOPT_ERRORBUFFER, errbuf);
    curl_easy_setopt(c->curl, CURLOPT_WRITEFUNCTION, body_write_cb);
    curl_easy_setopt(c->curl, CURLOPT_WRITEDATA, &resp);

    rc = curl_easy_perform(c->curl);
    curl_easy_getinfo(c->curl, CURLINFO_RESPONSE_CODE, http_code);

    if (rc != CURLE_OK) {
        snprintf(errbuf, errbuf_len, "%s", curl_easy_strerror(rc));
        sb_free(&resp);
        return -1;
    }
    if (*http_code != 200) {
        snprintf(errbuf, errbuf_len, "http %ld body=%.200s", *http_code,
                 resp.data ? resp.data : "");
    }
    sb_free(&resp);
    return 0;
}

/** 发送队列中全部事件：JSON 数组 → base64（单行）→ urlencode 表单 POST，失败重试 3 次。 */
int clklog_flush(clklog_client *c)
{
    sbuf   body, b64, form;
    int    attempt;
    char   errbuf[CURL_ERROR_SIZE];
    long   code = 0;
    size_t i, n;

    if (c->queue_len == 0) {
        return 0;
    }
    n = c->queue_len;

    /* 1) 事件对象数组 */
    sb_init(&body);
    sb_putc(&body, '[');
    for (i = 0; i < n; i++) {
        if (i) {
            sb_putc(&body, ',');
        }
        sb_puts(&body, c->queue[i]);
    }
    sb_putc(&body, ']');

    /* 2) base64（单行） */
    sb_init(&b64);
    base64_to(&b64, (const unsigned char *)body.data, body.len);

    /* 3) 表单 urlencode */
    sb_init(&form);
    sb_puts(&form, "project=");
    url_encode_to(&form, c->project, strlen(c->project));
    sb_puts(&form, "&token=");
    url_encode_to(&form, c->token, strlen(c->token));
    sb_puts(&form, "&data=");
    url_encode_to(&form, b64.data, b64.len);

    if (c->debug) {
        printf("[clklog] payload(%zu events) = %s\n", n, body.data); /* 不含 token */
        printf("[clklog] base64 len=%zu single-line=%s\n",
               b64.len, memchr(b64.data, '\n', b64.len) ? "NO" : "YES");
    }

    errbuf[0] = '\0';
    for (attempt = 1; attempt <= c->max_attempts; attempt++) {
        if (http_post(c, form.data, form.len, &code, errbuf, sizeof(errbuf)) == 0 && code == 200) {
            printf("[clklog] flushed %zu events OK (HTTP 200)\n", n);
            for (i = 0; i < n; i++) {
                free(c->queue[i]);
                c->queue[i] = NULL;
            }
            c->queue_len = 0;
            sb_free(&body);
            sb_free(&b64);
            sb_free(&form);
            return 0;
        }
        fprintf(stderr, "[clklog] attempt %d/%d failed: HTTP %ld %s\n",
                attempt, c->max_attempts, code, errbuf);
        sleep_ms(attempt * 500); /* 线性退避；生产建议指数退避 + 抖动 */
    }
    fprintf(stderr, "[clklog] flush failed after %d attempts; %zu events kept in queue\n",
            c->max_attempts, c->queue_len);
    sb_free(&body);
    sb_free(&b64);
    sb_free(&form);
    return -1;
}

/**
 * 组装单条事件 JSON。
 * identities 只在已登录时携带（规范 §3：登录前不带 identities；登录后 distinct_id 仍为匿名ID）。
 */
static char *build_event(const clklog_client *c, const char *type, const char *event,
                         const char *distinct_id, const char *user_key, const char *props_json)
{
    sbuf b;

    sb_init(&b);
    sb_puts(&b, "{\"type\":");
    json_str_to(&b, type);
    if (event) {
        sb_puts(&b, ",\"event\":");
        json_str_to(&b, event);
    }
    sb_puts(&b, ",\"distinct_id\":");
    json_str_to(&b, distinct_id);
    sb_putf(&b, ",\"time\":%lld", clklog_now_ms());
    if (user_key && *user_key) {
        sb_puts(&b, ",\"identities\":{\"user_key\":");
        json_str_to(&b, user_key);
        sb_puts(&b, "}");
    }
    sb_puts(&b, ",\"lib\":{\"$lib\":");
    json_str_to(&b, c->lib);
    sb_puts(&b, ",\"$lib_version\":");
    json_str_to(&b, c->lib_version);
    sb_puts(&b, "},\"properties\":");
    sb_puts(&b, (props_json && *props_json) ? props_json : "{}");
    sb_putc(&b, '}');
    return sb_take(&b);
}

static int enqueue(clklog_client *c, char *event_json)
{
    if (c->queue_len >= CLKLOG_MAX_BATCH) {
        if (clklog_flush(c) != 0) {
            free(event_json);
            return -1;
        }
    }
    c->queue[c->queue_len++] = event_json;
    if (c->batch_size > 0 && c->queue_len >= (size_t)c->batch_size) {
        return clklog_flush(c);
    }
    return 0;
}

/** 行为事件；登录后自动携带 identities.user_key。 */
int clklog_track(clklog_client *c, const char *distinct_id, const char *event,
                        const char *props_json)
{
    return enqueue(c, build_event(c, "track", event, distinct_id, c->login_id, props_json));
}

/** 用户属性（覆盖写）；登录后自动携带 identities.user_key。 */
int clklog_profile_set(clklog_client *c, const char *distinct_id, const char *props_json)
{
    return enqueue(c, build_event(c, "user_set", NULL, distinct_id, c->login_id, props_json));
}

/**
 * 登录关联：上报 track_signup 绑定匿名ID，之后事件自动带 identities.user_key。
 * ClkLog 口径：identities.user_key=登录ID、properties.$track_signup_original_id=匿名ID
 * （不是神策顶层的 login_id / original_id，规范 §3）。
 */
int clklog_login(clklog_client *c, const char *login_id, const char *anonymous_id)
{
    sbuf  props;
    char *ev;
    int   rc;

    snprintf(c->login_id, sizeof(c->login_id), "%s", login_id);
    props_init(&props);
    prop_str(&props, "$track_signup_original_id", anonymous_id);
    props_end(&props);

    ev = build_event(c, "track_signup", "$SignUp", login_id, login_id, props.data);
    sb_free(&props);
    rc = enqueue(c, ev);
    return rc;
}

/** 退出登录：停止携带 identities.user_key 即可，无需上报事件（规范 §3.4）。 */
void clklog_logout(clklog_client *c)
{
    c->login_id[0] = '\0';
}

int clklog_init(clklog_client *c, const char *endpoint, const char *project,
                       const char *token, int batch_size)
{
    memset(c, 0, sizeof(*c));
    snprintf(c->endpoint, sizeof(c->endpoint), "%s", endpoint);
    snprintf(c->project, sizeof(c->project), "%s", project);
    snprintf(c->token, sizeof(c->token), "%s", token);
    snprintf(c->lib, sizeof(c->lib), "%s", CLKLOG_LIB);
    snprintf(c->lib_version, sizeof(c->lib_version), "%s", CLKLOG_LIB_VERSION);

    c->batch_size         = batch_size > 0 ? batch_size : 10;
    c->connect_timeout_ms = 10000;
    c->timeout_ms         = 15000;
    c->max_attempts       = 3;

    c->curl = curl_easy_init();
    if (!c->curl) {
        fprintf(stderr, "[clklog] curl_easy_init failed\n");
        return -1;
    }
    c->headers = curl_slist_append(NULL, "Content-Type: application/x-www-form-urlencoded");
    curl_easy_setopt(c->curl, CURLOPT_TCP_KEEPALIVE, 1L); /* 复用 handle 时连接保活 */
    return 0;
}

void clklog_free(clklog_client *c)
{
    size_t i;

    for (i = 0; i < c->queue_len; i++) {
        free(c->queue[i]);
    }
    c->queue_len = 0;
    if (c->headers) {
        curl_slist_free_all(c->headers);
    }
    if (c->curl) {
        curl_easy_cleanup(c->curl);
    }
}

/* ================================================================== */
/* 6. 使用示例：匿名事件 → 登录关联 → 用户属性 → 登录后事件 ×2 → Flush */
/* ================================================================== */

int main(void)
{
    clklog_client cli;
    const char   *token, *endpoint, *project, *debug_env;
    char          run_id[128], anon_id[256], login_id[256], order_id[256];
    sbuf          props;
    long long     ts;
    int           rc = 1;

    signal(SIGPIPE, SIG_IGN); /* 网络中断时不因 SIGPIPE 猝死 */
    if (curl_global_init(CURL_GLOBAL_DEFAULT) != CURLE_OK) {
        fprintf(stderr, "[clklog] curl_global_init failed\n");
        return 1;
    }
    load_dotenv();

    /* token 只从环境变量 / ../.env 读，禁止硬编码（AGENTS.md 红线 3） */
    token = getenv("CLKLOG_TOKEN");
    if (!token || !*token) {
        fprintf(stderr, "missing env CLKLOG_TOKEN\n");
        return 1;
    }
    endpoint = getenv("CLKLOG_ENDPOINT");
    if (!endpoint || !*endpoint) {
        endpoint = CLKLOG_DEFAULT_ENDPOINT;
    }
    project = getenv("CLKLOG_PROJECT");
    if (!project || !*project) {
        project = CLKLOG_DEFAULT_PROJECT;
    }

    if (clklog_init(&cli, endpoint, project, token, 10) != 0) {
        return 1;
    }
    debug_env = getenv("CLKLOG_DEBUG");
    cli.debug = debug_env && strcmp(debug_env, "1") == 0;

    ts = clklog_now_ms() / 1000;
    snprintf(run_id, sizeof(run_id), "c-%lld", ts);
    snprintf(anon_id, sizeof(anon_id), "sdk-test-anon-%s", run_id); /* 匿名ID：全程稳定不切换 */
    snprintf(login_id, sizeof(login_id), "uid-c-%s", run_id);       /* 登录ID */
    snprintf(order_id, sizeof(order_id), "O%s", run_id);

    /* 1. 登录前：匿名事件（不带 identities） */
    props_init(&props);
    prop_str(&props, "test_run_id", run_id);
    prop_str(&props, "sdk_lang", "c");
    prop_str(&props, "step", "before_login");
    props_end(&props);
    if (clklog_track(&cli, anon_id, "SdkSpecTest", props.data) != 0) {
        sb_free(&props);
        goto done;
    }
    sb_free(&props);

    /* 2. 登录关联：之后所有事件自动携带 identities.user_key */
    if (clklog_login(&cli, login_id, anon_id) != 0) {
        goto done;
    }

    /* 3. 用户属性（登录态） */
    props_init(&props);
    prop_int(&props, "vip_level", 3);
    prop_str(&props, "register_channel", "app_store");
    prop_str(&props, "sdk_lang", "c");
    props_end(&props);
    if (clklog_profile_set(&cli, anon_id, props.data) != 0) {
        sb_free(&props);
        goto done;
    }
    sb_free(&props);

    /* 4. 登录后行为事件：distinct_id 仍为匿名ID，登录ID 走 identities.user_key */
    props_init(&props);
    prop_str(&props, "test_run_id", run_id);
    prop_str(&props, "sdk_lang", "c");
    prop_num(&props, "amount", 99.5);
    prop_str(&props, "product_id", "P1001");
    prop_str(&props, "product_name", "测试商品"); /* 中文属性值：UTF-8 原样进 JSON，整体 base64 */
    props_end(&props);
    if (clklog_track(&cli, anon_id, "SdkSpecTest", props.data) != 0) {
        sb_free(&props);
        goto done;
    }
    sb_free(&props);

    /* 5. Purchase；附一条自检属性，验证引号/反斜杠/换行/中文的转义与 UTF-8 不变形 */
    props_init(&props);
    prop_str(&props, "test_run_id", run_id);
    prop_str(&props, "order_id", order_id);
    prop_num(&props, "amount", 99.5);
    prop_str(&props, "pay_type", "alipay");
    prop_bool(&props, "is_new_user", 1);
    prop_str(&props, "escape_check", "引号\" 反斜杠\\ 换行\n 中文");
    props_end(&props);
    if (clklog_track(&cli, anon_id, "Purchase", props.data) != 0) {
        sb_free(&props);
        goto done;
    }
    sb_free(&props);

    if (clklog_flush(&cli) != 0) { /* 一个批次 5 条 */
        goto done;
    }
    printf("DONE run_id = %s\n", run_id);
    rc = 0;

done:
    clklog_free(&cli);
    curl_global_cleanup();
    return rc;
}
