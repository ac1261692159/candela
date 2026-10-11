import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * ClkLog 神策格式数据上报客户端（Java / Android 生产可用骨架，JDK 8+）。
 *
 * <p>规范文档：仓库根目录《数据上报规范与流程.md》§1~§3、§6（PHP 骨架）、§7（Go 骨架）。
 *
 * <h2>编译 / 运行（本机 JDK 1.8.0_412 实测通过）</h2>
 * <pre>
 *   cd examples/report-sdk/java
 *   javac -encoding UTF-8 -d /tmp/clklog-java ClkLogReport.java
 *   java -cp /tmp/clklog-java ClkLogReport
 * </pre>
 * 编译产物（*.class）输出到 /tmp，不落仓库。
 *
 * <h2>为什么用 HttpURLConnection</h2>
 * JDK 8 没有 {@code java.net.http.HttpClient}（JDK 11+ 才有）。因此网络层用 JDK 8 内置的
 * {@link HttpURLConnection}，零第三方依赖，服务端 JDK 8 可直接运行。
 *
 * <h2>Android / 第三方 HTTP 客户端如何接入</h2>
 * <b>调用形状不变</b>：只需要替换本类的网络层方法 {@link ClkLogClient#postForm(String, long, long)}
 * （Android 常用 OkHttp：{@code new FormBody.Builder().add("project",..).add("token",..).add("data",..)}
 * 配合 {@code Request.Builder().url(endpoint).post(form).build()}，执行
 * {@code client.newCall(req).execute()}），
 * {@code track / login / profileSet / flush} 的协议逻辑（事件 JSON、批次、base64+urlencode、重试退避）
 * 一字不改。这是把示例接进 App 工程量最小的方式。
 *
 * <h2>编码硬要求（踩坑点，见规范 §1.3）</h2>
 * 表单字段 data = JSON 数组 → base64（<b>必须单行</b>）→ urlencode。直接 POST 原始 JSON 会 HTTP 200
 * 但数据静默丢失。{@link Base64#getEncoder()} 输出天然无换行（{@code getMimeEncoder} 才会折行，勿用）。
 *
 * <p>token 只从环境变量 / ../.env 读取，代码内不得出现 token 字面量（AGENTS.md 红线 3）。
 */
public final class ClkLogReport {

    /** 神策格式 + ClkLog identities 身份扩展的上报客户端。 */
    public static final class ClkLogClient {

        private final String endpoint;   // 上报地址
        private final String project;    // 项目名
        private final String token;      // 项目 token
        private final int batchSize;     // 攒批条数，达到即自动发送
        private final String lib;        // SDK 标识 $lib
        private final String libVersion; // SDK 版本 $lib_version

        private final List<Map<String, Object>> queue = new ArrayList<Map<String, Object>>();

        /** 登录ID；login() 后自动携带到 identities.user_key（ClkLog 口径见规范 §3）。 */
        private volatile String loginId;

        private int connectTimeoutMs = 10_000;
        private int readTimeoutMs = 15_000;
        private int maxAttempts = 3;
        private boolean debug = false;

        /** 打开后打印待发送 JSON（<b>不含 token</b>），用于本地排错。 */
        public ClkLogClient setDebug(boolean debug) {
            this.debug = debug;
            return this;
        }

        public ClkLogClient(String endpoint, String project, String token, int batchSize) {
            this(endpoint, project, token, batchSize, "java", "1.0.0");
        }

        public ClkLogClient(String endpoint, String project, String token, int batchSize,
                            String lib, String libVersion) {
            this.endpoint = endpoint;
            this.project = project;
            this.token = token;
            this.batchSize = batchSize > 0 ? batchSize : 10;
            this.lib = lib;
            this.libVersion = libVersion;
        }

        /** 行为事件；登录后自动携带 identities.user_key。 */
        public void track(String distinctId, String event, Map<String, Object> properties) {
            Map<String, Object> e = new LinkedHashMap<String, Object>();
            e.put("type", "track");
            e.put("event", event);
            e.put("distinct_id", distinctId);
            e.put("time", System.currentTimeMillis()); // 毫秒时间戳，秒级会导致时间错误
            if (loginId != null) {
                e.put("identities", identities(loginId));
            }
            e.put("lib", libIdent());
            e.put("properties", properties != null ? properties : new LinkedHashMap<String, Object>());
            enqueue(e);
        }

        /** 用户属性（覆盖写）；登录后自动携带 identities.user_key。 */
        public void profileSet(String distinctId, Map<String, Object> properties) {
            Map<String, Object> e = new LinkedHashMap<String, Object>();
            e.put("type", "user_set");
            e.put("distinct_id", distinctId);
            e.put("time", System.currentTimeMillis());
            if (loginId != null) {
                e.put("identities", identities(loginId));
            }
            e.put("lib", libIdent());
            e.put("properties", properties != null ? properties : new LinkedHashMap<String, Object>());
            enqueue(e);
        }

        /**
         * 登录关联：上报 track_signup 绑定匿名ID，之后事件自动带 identities.user_key。
         * ClkLog 口径：identities.user_key=登录ID、properties.$track_signup_original_id=匿名ID
         * （<b>不是</b>神策顶层的 login_id / original_id，规范 §3）。
         */
        public void login(String loginId, String anonymousId) {
            this.loginId = loginId;
            Map<String, Object> props = new LinkedHashMap<String, Object>();
            props.put("$track_signup_original_id", anonymousId);
            Map<String, Object> e = new LinkedHashMap<String, Object>();
            e.put("type", "track_signup");
            e.put("event", "$SignUp");
            e.put("distinct_id", loginId);
            e.put("time", System.currentTimeMillis());
            e.put("identities", identities(loginId));
            e.put("lib", libIdent());
            e.put("properties", props);
            enqueue(e);
        }

        /** 退出登录：停止携带 identities.user_key 即可，无需上报事件（规范 §3.4）。 */
        public void logout() {
            this.loginId = null;
        }

        /**
         * 发送队列中全部事件：JSON 数组 → base64（单行）→ urlencode 表单 POST，失败重试 3 次。
         *
         * @return 本次发送的事件条数
         */
        public int flush() throws IOException {
            final int size = queue.size();
            if (size == 0) {
                return 0;
            }
            String body = json(queue);
            if (debug) {
                System.out.println("[clklog] payload(" + size + " events) = " + body); // 不含 token
            }
            String payload = Base64.getEncoder().encodeToString(body.getBytes(StandardCharsets.UTF_8));

            String form = "project=" + urlEncode(project)
                    + "&token=" + urlEncode(token)
                    + "&data=" + urlEncode(payload);

            IOException lastError = null;
            for (int attempt = 1; attempt <= maxAttempts; attempt++) {
                try {
                    int code = postForm(form, connectTimeoutMs, readTimeoutMs);
                    if (code == 200) {
                        queue.clear();
                        System.out.println("[clklog] flushed " + size + " events OK (HTTP 200)");
                        return size;
                    }
                    lastError = new IOException("unexpected HTTP status " + code);
                } catch (IOException ex) {
                    lastError = ex;
                }
                sleep(attempt * 500L); // 线性退避，生产环境建议指数退避 + 抖动
            }
            throw new IOException("flush failed after " + maxAttempts + " attempts: " + lastError, lastError);
        }

        private void enqueue(Map<String, Object> event) {
            queue.add(event); // 攒 Map 对象，flush 时整体序列化成 JSON 数组
            if (queue.size() >= batchSize) {
                try {
                    flush();
                } catch (IOException ex) {
                    // 示例场景直接暴露错误；生产环境应转交异步队列/本地持久化兜底
                    throw new IllegalStateException(ex);
                }
            }
        }

        private static Map<String, Object> identities(String userKey) {
            Map<String, Object> m = new LinkedHashMap<String, Object>();
            m.put("user_key", userKey);
            return m;
        }

        private Map<String, Object> libIdent() {
            Map<String, Object> m = new LinkedHashMap<String, Object>();
            m.put("$lib", lib);
            m.put("$lib_version", libVersion);
            return m;
        }

        /** 网络层：唯一需要为 OkHttp 等客户端替换的方法（Android 侧改这里的实现即可）。 */
        protected int postForm(String formBody, int connectTimeoutMs, int readTimeoutMs) throws IOException {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(endpoint).openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                conn.setConnectTimeout(connectTimeoutMs);
                conn.setReadTimeout(readTimeoutMs);
                conn.setDoOutput(true);
                byte[] body = formBody.getBytes(StandardCharsets.UTF_8);
                conn.setFixedLengthStreamingMode(body.length);
                OutputStream out = conn.getOutputStream();
                try {
                    out.write(body);
                } finally {
                    out.close();
                }
                int code = conn.getResponseCode();
                String resp = readAll(code == 200 ? conn.getInputStream() : conn.getErrorStream());
                if (code != 200 || (resp != null && resp.contains("data") && resp.contains("空"))) {
                    System.err.println("[clklog] HTTP " + code + " body=" + trim(resp));
                }
                return code;
            } finally {
                if (conn != null) {
                    conn.disconnect();
                }
            }
        }
    }

    // ======================= JSON 序列化（无第三方依赖） =======================

    /** 极简 JSON 序列化：Map / List / String / Number / Boolean / null。 */
    @SuppressWarnings("unchecked")
    private static String json(Object value) {
        StringBuilder sb = new StringBuilder();
        writeJson(sb, value);
        return sb.toString();
    }

    @SuppressWarnings("unchecked")
    private static void writeJson(StringBuilder sb, Object value) {
        if (value == null) {
            sb.append("null");
        } else if (value instanceof Map) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<Object, Object> e : ((Map<Object, Object>) value).entrySet()) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                writeString(sb, String.valueOf(e.getKey()));
                sb.append(':');
                writeJson(sb, e.getValue());
            }
            sb.append('}');
        } else if (value instanceof Iterable) {
            sb.append('[');
            boolean first = true;
            for (Object item : (Iterable<Object>) value) {
                if (!first) {
                    sb.append(',');
                }
                first = false;
                writeJson(sb, item);
            }
            sb.append(']');
        } else if (value instanceof Boolean) {
            sb.append(value.toString());
        } else if (value instanceof Number) {
            sb.append(number((Number) value));
        } else {
            writeString(sb, value.toString());
        }
    }

    private static String number(Number n) {
        if (n instanceof Double || n instanceof Float) {
            double d = n.doubleValue();
            if (d == Math.rint(d) && !Double.isInfinite(d)) {
                return Long.toString((long) d);
            }
            return Double.toString(d);
        }
        return n.toString();
    }

    /** JSON 字符串转义：中文等非 ASCII 原样输出 UTF-8（JSON 允许），仅转义必需字符。 */
    private static void writeString(StringBuilder sb, String s) {
        sb.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                case '\b': sb.append("\\b"); break;
                case '\f': sb.append("\\f"); break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append('"');
    }

    // ======================= 工具方法 =======================

    /** application/x-www-form-urlencoded 编码：base64 里的 + / = 必须被编码（'+' 否则被解成空格）。 */
    private static String urlEncode(String s) {
        try {
            return URLEncoder.encode(s, "UTF-8");
        } catch (IOException ex) {
            throw new IllegalStateException(ex);
        }
    }

    private static String readAll(InputStream in) throws IOException {
        if (in == null) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
        try {
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line).append('\n');
            }
        } finally {
            reader.close();
        }
        return sb.toString();
    }

    private static String trim(String s) {
        if (s == null) {
            return "";
        }
        s = s.replace('\n', ' ');
        return s.length() > 200 ? s.substring(0, 200) + "..." : s;
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
        }
    }

    /**
     * 加载 ../.env 到内存 Map（环境变量优先，不覆盖已存在的值；只读不落盘、不打印值）。
     * 进程环境本身不改写——JDK 8 无法 setenv，读进 Map 更干净。
     */
    private static Map<String, String> loadDotenv() {
        Map<String, String> dotenv = new LinkedHashMap<String, String>();
        String[] candidates = {
            "../.env",                                                          // 从 java/ 运行
            "examples/report-sdk/.env",                                         // 从仓库根运行
        };
        for (String path : candidates) {
            Path p = Paths.get(path);
            if (!Files.isReadable(p)) {
                continue;
            }
            try {
                for (String raw : Files.readAllLines(p, StandardCharsets.UTF_8)) {
                    String line = raw.trim();
                    int eq = line.indexOf('=');
                    if (line.isEmpty() || line.startsWith("#") || eq <= 0) {
                        continue;
                    }
                    dotenv.put(line.substring(0, eq).trim(), line.substring(eq + 1).trim());
                }
                System.out.println("[clklog] loaded env from " + path);
                return dotenv;
            } catch (IOException ex) {
                System.err.println("[clklog] read " + path + " failed: " + ex.getMessage());
            }
        }
        System.out.println("[clklog] .env not found, fallback to system env");
        return dotenv;
    }

    /** 取值优先级：进程环境变量 → .env → JVM 属性 → 默认值。 */
    private static String env(Map<String, String> dotenv, String key, String def) {
        String v = System.getenv(key);
        if (v == null || v.isEmpty()) {
            v = dotenv.get(key);
        }
        if (v == null || v.isEmpty()) {
            v = System.getProperty(key);
        }
        return (v == null || v.isEmpty()) ? def : v;
    }

    // ======================= 使用示例 =======================

    public static void main(String[] args) throws Exception {
        Map<String, String> dotenv = loadDotenv();

        // token 只从环境变量 / ../.env 读，禁止硬编码（AGENTS.md 红线 3）
        String token = env(dotenv, "CLKLOG_TOKEN", null);
        if (token == null) {
            System.err.println("missing env CLKLOG_TOKEN");
            System.exit(1);
        }
        String endpoint = env(dotenv, "CLKLOG_ENDPOINT", "https://receiver-clklog.xyxverse.com/receiver/api/gp");
        String project = env(dotenv, "CLKLOG_PROJECT", "clklogapp");

        ClkLogClient cli = new ClkLogClient(endpoint, project, token, 10, "java", "1.0.0")
                .setDebug("1".equals(env(dotenv, "CLKLOG_DEBUG", "")));

        String runId = "java-" + (System.currentTimeMillis() / 1000);
        String anonId = "sdk-test-anon-" + runId; // 匿名ID（设备/访客ID，全程稳定不切换）
        String loginId = "uid-java-" + runId;     // 登录ID

        // 1. 登录前：匿名事件（不带 identities）
        Map<String, Object> p1 = new LinkedHashMap<String, Object>();
        p1.put("test_run_id", runId);
        p1.put("sdk_lang", "java");
        p1.put("step", "before_login");
        cli.track(anonId, "SdkSpecTest", p1);

        // 2. 登录关联：之后所有事件自动携带 identities.user_key
        cli.login(loginId, anonId);

        // 3. 用户属性（登录态）
        Map<String, Object> p3 = new LinkedHashMap<String, Object>();
        p3.put("vip_level", 3);
        p3.put("register_channel", "app_store");
        p3.put("sdk_lang", "java");
        cli.profileSet(anonId, p3);

        // 4. 登录后行为事件：distinct_id 仍为匿名ID，登录ID 走 identities.user_key
        Map<String, Object> p4 = new LinkedHashMap<String, Object>();
        p4.put("test_run_id", runId);
        p4.put("sdk_lang", "java");
        p4.put("amount", 99.5);
        p4.put("product_id", "P1001");
        p4.put("product_name", "测试商品"); // 中文属性值：UTF-8 原样进 JSON，再整体 base64
        cli.track(anonId, "SdkSpecTest", p4);

        // 5. Purchase；附一条自检属性，验证引号/反斜杠/换行/中文的转义与 UTF-8 不变形
        Map<String, Object> p5 = new LinkedHashMap<String, Object>();
        p5.put("test_run_id", runId);
        p5.put("order_id", "O" + runId);
        p5.put("amount", 99.5);
        p5.put("pay_type", "alipay");
        p5.put("is_new_user", Boolean.TRUE);
        p5.put("escape_check", "引号\" 反斜杠\\ 换行\n 中文");
        cli.track(anonId, "Purchase", p5);

        cli.flush(); // 一个批次 5 条；生产建议定时 / 进程退出前兜底 Flush
        System.out.println("DONE run_id = " + runId);
    }

    private ClkLogReport() {
    }
}
