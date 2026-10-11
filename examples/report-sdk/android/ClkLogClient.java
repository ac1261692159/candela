import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.UnsupportedEncodingException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.Charset;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * ClkLog <b>Android 客户端</b>上报 SDK 骨架（Java 8 / HttpURLConnection 传输，零第三方依赖）。
 *
 * <h2>⚠️ 验证范围（诚实说明，勿夸大）</h2>
 * <ul>
 *   <li><b>① 语言级实现已实测</b>：本文件在 <b>系统 JDK 1.8.0_412</b>（macOS，非 Android 运行时）上
 *       {@code javac} 编译 + {@code java} 运行通过，5 条事件真实落入 ClickHouse（见 {@code Main.java} 头注释命令）。</li>
 *   <li><b>② 真机 / 模拟器打包未验证</b>：本机<b>没有 Android SDK / 模拟器 / Gradle</b>，因此
 *       <b>未</b>做 APK 打包、未在 Android 运行时（ART）上跑过、未验证 SharedPreferences、
 *       {@code android.util.Base64}、ProcessLifecycleOwner 的真实行为。</li>
 *   <li><b>③ 语言级差异需真机补验的项</b>（源码级已知，不是猜测）：
 *       <ul>
 *         <li>{@code java.util.Base64} 需 <b>API 26+</b>（Android 8.0）。minSdk &lt; 26 时把
 *             {@link #encodeBase64(byte[])} 换成 {@code android.util.Base64.encodeToString(bytes, Base64.NO_WRAP)}
 *             （{@code NO_WRAP} 保证单行，等价）；</li>
 *         <li>receiver 走 HTTPS，Android 4.4 以前默认只开 TLSv1 —— 生产要求 <b>API 20+</b> 或显式启用 TLSv1.2；</li>
 *         <li>持久化换成 {@code SharedPreferences}（实现 {@link Storage} 接口即可，见 {@link FileStorage} 注释）；</li>
 *         <li>退后台 flush 挂到 {@code ProcessLifecycleOwner.get().getLifecycle().addObserver(...)}（ON_STOP → {@link #onAppBackground()}）。</li>
 *       </ul></li>
 * </ul>
 *
 * <h2>④ 接进 App：生产用 OkHttp 时改哪里</h2>
 * 只把网络层 {@link #postForm(String)} 换成 OkHttp 即可，<b>协议与队列逻辑一字不改</b>：
 * <pre>{@code
 * FormBody form = new FormBody.Builder()
 *         .add("project", project).add("token", token).add("data", encodedData).build();
 * Request req = new Request.Builder().url(endpoint).post(form).build();
 * try (Response resp = okHttpClient.newCall(req).execute()) { int code = resp.code(); ... }
 * }</pre>
 * （OkHttp 会自动按 {@code application/x-www-form-urlencoded} 编码表单并对 name/value 做 urlencode，
 * 但 {@code data} 字段里我们的 base64 仍是<b>手工 urlencode</b> 后放进去的 —— 两种写法都对，
 * 只要保证 base64 里的 {@code + / =} 被转义，见 §1.3。）
 *
 * <h2>⑤ Kotlin 调用形状相同</h2>
 * <pre>{@code
 * val clk = ClkLogClient(endpoint, project, token, FileStorage(dir))
 * clk.setDeviceId(deviceId)
 * clk.track("Purchase", mapOf("order_id" to "O001", "amount" to 99.5))
 * clk.login("uid-1001")
 * clk.profileSet(mapOf("vip_level" to 3))
 * clk.flush()
 * }</pre>
 * Kotlin 里 {@code Map<String, Any?>} 对应本类 {@code Map<String, Object>}，方法名/参数顺序完全一致；
 * 也可以直接用 Kotlin 的 object 表达式实现 {@link Storage} 接口。
 *
 * <h2>协议要点（规范《数据上报规范与流程.md》§1~§3）</h2>
 * <ul>
 *   <li>POST {@code /receiver/api/gp}，{@code Content-Type: application/x-www-form-urlencoded}；</li>
 *   <li>表单字段 {@code project} / {@code token} / {@code data}；</li>
 *   <li><b>编码硬要求</b>：{@code data} = 事件 JSON 数组 → base64（<b>必须单行</b>）→ urlencode。
 *       直接 POST 原始 JSON 会 HTTP 200 但<b>静默丢数据</b>（§1.3）。{@link Base64#getEncoder()} 天然不折行
 *       （{@code getMimeEncoder} 会按 76 列折行，<b>勿用</b>）；</li>
 *   <li><b>用户标识口径与神策原生不同</b>（§3）：登录ID 走顶层 {@code identities.user_key}，
 *       登录绑定匿名ID 走 {@code properties.$track_signup_original_id}；登录后 {@code distinct_id}
 *       <b>仍为匿名ID</b>（保持稳定），不要切换成登录ID。</li>
 * </ul>
 *
 * <h2>客户端能力（与"服务端 Java"示例 {@code ../java/ClkLogReport.java} 的区别）</h2>
 * <ul>
 *   <li><b>设备ID生成与持久化</b>：{@link #getDeviceId()} 首次自动生成 UUID 落存储，App 重启不变；</li>
 *   <li><b>会话</b>：{@link #track} 自动附 {@code $event_session_id}，超过 {@link #setSessionTimeoutMs(long)}
 *       无事件即换新会话；</li>
 *   <li><b>批量上限</b>：单请求 ≤{@value #MAX_EVENTS_PER_REQUEST} 条事件，且请求体 ≤{@value #MAX_BODY_BYTES} 字节（超限自动折半切分）；</li>
 *   <li><b>失败退避重试</b>：默认 3 次，间隔 500ms / 1s / 2s；</li>
 *   <li><b>离线队列</b>：入队即持久化（{@code clklog.queue}），发送成功才删除；进程被杀重启后自动补发；</li>
 *   <li><b>退后台 flush</b>：{@link #onAppBackground()}（Android 挂在 ON_STOP）尽力发送，失败也保留队列。</li>
 * </ul>
 *
 * <p>token 只从环境变量 / {@code ../.env} 读取（见 {@code Main.java}），代码内不得出现 token 字面量（AGENTS.md 红线 3）。
 */
public final class ClkLogClient {

    /** 默认上报地址（生产）。 */
    public static final String DEFAULT_ENDPOINT = "https://receiver-clklog.xyxverse.com/receiver/api/gp";
    /** 默认项目名。 */
    public static final String DEFAULT_PROJECT = "clklogapp";
    /** SDK 标识，落 {@code lib.$lib}。 */
    public static final String LIB = "android";
    /** SDK 版本，落 {@code lib.$lib_version}。 */
    public static final String LIB_VERSION = "1.0.0";

    /** 单请求最多事件数（receiver 上限 50 条/次）。 */
    public static final int MAX_EVENTS_PER_REQUEST = 50;
    /** 单请求请求体字节上限（1MB）。 */
    public static final int MAX_BODY_BYTES = 1024 * 1024;
    /** 默认会话超时：30 分钟无事件即视为新会话。 */
    public static final long DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000L;

    private static final Charset UTF8 = Charset.forName("UTF-8");
    private static final String KEY_DEVICE_ID = "clklog.device_id";
    private static final String KEY_USER_KEY = "clklog.user_key";
    private static final String KEY_QUEUE = "clklog.queue";
    private static final String KEY_SESSION_ID = "clklog.session_id";
    private static final String KEY_SESSION_TS = "clklog.session_last_ts";

    /** 上报失败（重试耗尽）时抛出；<b>队列不会被清空</b>，可稍后 flush 补发。 */
    public static final class ClkLogException extends RuntimeException {
        private static final long serialVersionUID = 1L;

        ClkLogException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    /**
     * 客户端持久化接口（键值对 + 字符串值）。
     *
     * <p>Android 生产实现（SharedPreferences）：
     * <pre>{@code
     * public final class PrefsStorage implements ClkLogClient.Storage {
     *     private final SharedPreferences sp;
     *     public PrefsStorage(Context ctx) { sp = ctx.getSharedPreferences("clklog_sdk", Context.MODE_PRIVATE); }
     *     public String get(String k) { return sp.getString(k, null); }
     *     public void set(String k, String v) { sp.edit().putString(k, v).apply(); }
     *     public void remove(String k) { sp.edit().remove(k).apply(); }
     * }
     * }</pre>
     * {@link FileStorage} / {@link MemoryStorage} 是桌面 JVM（本仓库验证入口）与单元测试用的实现。
     */
    public interface Storage {
        /** 读键；不存在返回 {@code null}。 */
        String get(String key);

        /** 写键（覆盖）。 */
        void set(String key, String value);

        /** 删键。 */
        void remove(String key);
    }

    /** 文件实现：一个键一个 UTF-8 文件（仅用于桌面 JVM / 验证，Android 请用 SharedPreferences）。 */
    public static final class FileStorage implements Storage {
        private final File dir;

        public FileStorage(File dir) {
            this.dir = dir;
            if (!dir.exists() && !dir.mkdirs()) {
                throw new IllegalStateException("cannot create state dir: " + dir);
            }
        }

        private File fileOf(String key) {
            return new File(dir, key.replaceAll("[^A-Za-z0-9._-]", "_") + ".txt");
        }

        @Override
        public synchronized String get(String key) {
            File f = fileOf(key);
            if (!f.isFile()) {
                return null;
            }
            try {
                byte[] buf = new byte[(int) f.length()];
                FileInputStream in = new FileInputStream(f);
                try {
                    int off = 0;
                    while (off < buf.length) {
                        int n = in.read(buf, off, buf.length - off);
                        if (n < 0) {
                            break;
                        }
                        off += n;
                    }
                    return new String(buf, 0, off, UTF8);
                } finally {
                    in.close();
                }
            } catch (IOException e) {
                return null;
            }
        }

        @Override
        public synchronized void set(String key, String value) {
            File f = fileOf(key);
            try {
                FileOutputStream out = new FileOutputStream(f);
                try {
                    out.write(value.getBytes(UTF8));
                    out.flush();
                } finally {
                    out.close();
                }
            } catch (IOException e) {
                throw new ClkLogException("storage write failed: " + f, e);
            }
        }

        @Override
        public synchronized void remove(String key) {
            File f = fileOf(key);
            if (f.isFile() && !f.delete()) {
                f.deleteOnExit();
            }
        }

        /** 状态目录（便于排查）。 */
        public File directory() {
            return dir;
        }
    }

    /** 内存实现（单元测试 / 无需持久化场景）。 */
    public static final class MemoryStorage implements Storage {
        private final Map<String, String> map = new LinkedHashMap<String, String>();

        @Override
        public synchronized String get(String key) {
            return map.get(key);
        }

        @Override
        public synchronized void set(String key, String value) {
            map.put(key, value);
        }

        @Override
        public synchronized void remove(String key) {
            map.remove(key);
        }
    }

    // ---------------------------------------------------------------- 字段

    private final String endpoint;
    private final String project;
    private final String token;
    private final Storage storage;

    /** 待发送队列（本对象为锁：队列与持久化必须一致更新）。 */
    private final List<Map<String, Object>> queue = new ArrayList<Map<String, Object>>();

    private volatile String userKey;          // 登录ID（identities.user_key）
    private volatile int batchSize = 20;      // 攒批条数，达到即自动 flush
    private volatile boolean sessionAutoTrack = true;  // 自动附 $event_session_id
    private volatile long sessionTimeoutMs = DEFAULT_SESSION_TIMEOUT_MS;
    private volatile int connectTimeoutMs = 10_000;
    private volatile int readTimeoutMs = 15_000;
    private volatile int maxAttempts = 3;     // 失败重试次数
    private volatile long retryBaseDelayMs = 500L;  // 退避基数：500ms / 1s / 2s
    private volatile boolean debug = false;

    public ClkLogClient(String endpoint, String project, String token, Storage storage) {
        if (token == null || token.isEmpty()) {
            throw new IllegalArgumentException("token is empty (从环境变量/配置注入，禁止硬编码)");
        }
        this.endpoint = (endpoint == null || endpoint.isEmpty()) ? DEFAULT_ENDPOINT : endpoint;
        this.project = (project == null || project.isEmpty()) ? DEFAULT_PROJECT : project;
        this.token = token;
        this.storage = storage == null ? new MemoryStorage() : storage;
        this.userKey = emptyToNull(this.storage.get(KEY_USER_KEY));
        restoreQueue();  // 进程被杀/离线时的残留队列，启动即补发
    }

    // ------------------------------------------------------------ 链式配置

    /** 攒批条数（达到即自动 flush）；默认 20。 */
    public ClkLogClient setBatchSize(int batchSize) {
        this.batchSize = Math.max(1, Math.min(batchSize, MAX_EVENTS_PER_REQUEST));
        return this;
    }

    /** 关闭后 {@code track} 不再自动附 {@code $event_session_id}。 */
    public ClkLogClient setSessionAutoTrack(boolean enabled) {
        this.sessionAutoTrack = enabled;
        return this;
    }

    /** 会话超时（毫秒），默认 30 分钟。 */
    public ClkLogClient setSessionTimeoutMs(long sessionTimeoutMs) {
        this.sessionTimeoutMs = sessionTimeoutMs;
        return this;
    }

    /** HTTP 超时（连接 / 读取），默认 10s / 15s。 */
    public ClkLogClient setTimeoutMs(int connectTimeoutMs, int readTimeoutMs) {
        this.connectTimeoutMs = connectTimeoutMs;
        this.readTimeoutMs = readTimeoutMs;
        return this;
    }

    /** 失败重试次数（含首次），默认 3。 */
    public ClkLogClient setMaxAttempts(int maxAttempts) {
        this.maxAttempts = Math.max(1, maxAttempts);
        return this;
    }

    /** 退避基数（毫秒），第 n 次失败后睡 {@code base * 2^(n-1)}，默认 500ms。 */
    public ClkLogClient setRetryBaseDelayMs(long retryBaseDelayMs) {
        this.retryBaseDelayMs = Math.max(0L, retryBaseDelayMs);
        return this;
    }

    /** 打印诊断日志（<b>不含 token</b>）。 */
    public ClkLogClient setDebug(boolean debug) {
        this.debug = debug;
        return this;
    }

    // ------------------------------------------------------------ 设备 / 用户

    /**
     * 设备ID（= 后续所有事件的 {@code distinct_id}，即匿名ID）。
     * 首次调用自动生成 UUID 并持久化，App 重启后保持稳定（§3：全程稳定不切换）。
     */
    public String getDeviceId() {
        String id = emptyToNull(storage.get(KEY_DEVICE_ID));
        if (id == null) {
            id = LIB + "-" + UUID.randomUUID().toString().replace("-", "");
            storage.set(KEY_DEVICE_ID, id);
            if (debug) {
                System.out.println("[clklog] new device_id = " + id);
            }
        }
        return id;
    }

    /**
     * 覆盖设备ID（App 已有自己的设备标识，如 Android ID、厂商 OAID 的哈希）。
     * 传入 {@code null}/空串则清空，下次 {@link #getDeviceId()} 重新生成。
     */
    public void setDeviceId(String deviceId) {
        if (emptyToNull(deviceId) == null) {
            storage.remove(KEY_DEVICE_ID);
            return;
        }
        storage.set(KEY_DEVICE_ID, deviceId);
    }

    /** 当前登录ID（{@code identities.user_key}）；未登录返回 {@code null}。 */
    public String getUserKey() {
        return userKey;
    }

    /**
     * 手动设置登录ID（一般用 {@link #login(String)} 代替，由它顺带上报 {@code track_signup} 完成绑定）。
     * 传 {@code null}/空串 = 退出登录：之后事件不再携带 {@code identities.user_key}（§3 规则 4）。
     */
    public void setUserKey(String userKey) {
        this.userKey = emptyToNull(userKey);
        if (this.userKey == null) {
            storage.remove(KEY_USER_KEY);
        } else {
            storage.set(KEY_USER_KEY, this.userKey);
        }
    }

    /** 当前会话ID（{@code $event_session_id}）。 */
    public String getSessionId() {
        return currentSessionId();
    }

    // ---------------------------------------------------------------- 上报

    /** 行为事件：{@code distinct_id} 用当前设备ID（匿名ID），登录后自动带 {@code identities.user_key}。 */
    public void track(String event, Map<String, Object> properties) {
        track(getDeviceId(), event, properties);
    }

    /** 行为事件（显式指定 {@code distinct_id}；登录后仍应传匿名ID，见 §3 规则 3）。 */
    public void track(String distinctId, String event, Map<String, Object> properties) {
        if (event == null || event.isEmpty()) {
            throw new IllegalArgumentException("event is empty");
        }
        Map<String, Object> props = new LinkedHashMap<String, Object>();
        if (properties != null) {
            props.putAll(properties);
        }
        if (sessionAutoTrack) {
            props.put("$event_session_id", currentSessionId());  // 预置属性，自动落列（§4.3）
        }
        Map<String, Object> e = event("track", event, distinctId);
        e.put("properties", props);
        enqueue(e);
    }

    /**
     * 登录关联：上报 {@code track_signup}（{@code event=$SignUp}，{@code distinct_id}=登录ID，
     * {@code identities.user_key}=登录ID，{@code properties.$track_signup_original_id}=匿名ID），
     * 之后所有事件自动携带 {@code identities.user_key}（§3 规则 2/3）。
     */
    public void login(String loginId) {
        login(loginId, getDeviceId());
    }

    /** 登录关联（显式指定要绑定的匿名ID）。 */
    public void login(String loginId, String anonymousId) {
        if (loginId == null || loginId.isEmpty()) {
            throw new IllegalArgumentException("loginId is empty");
        }
        setUserKey(loginId);
        Map<String, Object> props = new LinkedHashMap<String, Object>();
        props.put("$track_signup_original_id", anonymousId);  // ClkLog 口径：绑定匿名ID 走 properties
        Map<String, Object> e = event("track_signup", "$SignUp", loginId);
        e.put("properties", props);
        enqueue(e);
    }

    /** 用户属性（覆盖写）：{@code distinct_id} 用当前设备ID。 */
    public void profileSet(Map<String, Object> properties) {
        profileSet(getDeviceId(), properties);
    }

    /** 用户属性（覆盖写，显式 {@code distinct_id}）。 */
    public void profileSet(String distinctId, Map<String, Object> properties) {
        Map<String, Object> e = event("user_set", null, distinctId);
        e.put("properties", properties == null ? new LinkedHashMap<String, Object>()
                : new LinkedHashMap<String, Object>(properties));
        enqueue(e);
    }

    // ---------------------------------------------------------------- 队列

    /** 待发送事件数（含已持久化但未发出的）。 */
    public int getQueueSize() {
        synchronized (queue) {
            return queue.size();
        }
    }

    /** 已持久化的队列 JSON 字节数（离线队列确实落盘的证据）。 */
    public int getPersistedQueueBytes() {
        String json = storage.get(KEY_QUEUE);
        return json == null ? 0 : json.getBytes(UTF8).length;
    }

    /** 丢弃待发送队列（仅在明确要放弃离线数据时调用）。 */
    public void clearQueue() {
        synchronized (queue) {
            queue.clear();
            storage.remove(KEY_QUEUE);
        }
    }

    /**
     * 发送队列中的全部事件；返回成功发送的条数。
     *
     * <p>分片规则：一次请求最多 {@value #MAX_EVENTS_PER_REQUEST} 条事件，且表单体不超过
     * {@value #MAX_BODY_BYTES} 字节（超限自动折半重试同一批）；失败按 {@link #setRetryBaseDelayMs(long)}
     * 退避重试，重试耗尽抛 {@link ClkLogException} 且<b>保留队列</b>（离线补发）。
     */
    public int flush() {
        int sent = 0;
        while (true) {
            List<Map<String, Object>> chunk;
            String form;
            synchronized (queue) {
                if (queue.isEmpty()) {
                    return sent;
                }
                int size = Math.min(queue.size(), MAX_EVENTS_PER_REQUEST);
                while (true) {
                    chunk = new ArrayList<Map<String, Object>>(queue.subList(0, size));
                    String encoded = encodeBase64(Json.encode(chunk).getBytes(UTF8));
                    form = buildForm(encoded);
                    if (form.getBytes(UTF8).length <= MAX_BODY_BYTES) {
                        break;
                    }
                    if (size == 1) {
                        throw new ClkLogException("single event body exceeds " + MAX_BODY_BYTES
                                + " bytes; queue kept for caller to handle", null);
                    }
                    size = Math.max(1, size / 2);
                }
            }
            if (debug) {
                System.out.println("[clklog] flush " + chunk.size() + " event(s), body "
                        + form.length() + " chars");
            }
            postForm(form);  // 失败抛异常，队列保留
            synchronized (queue) {
                for (int i = 0; i < chunk.size(); i++) {
                    queue.remove(0);
                }
                persistQueueLocked();
            }
            sent += chunk.size();
        }
    }

    /** 尽力发送（失败不抛，队列保留）。返回成功条数。 */
    public int flushQuietly() {
        try {
            return flush();
        } catch (RuntimeException e) {
            if (debug) {
                System.out.println("[clklog] flush failed (queue kept): " + e.getMessage());
            }
            return 0;
        }
    }

    /**
     * App 退到后台（Android：{@code ProcessLifecycleOwner} ON_STOP / {@code onActivityStopped}）。
     * 先固化队列再尽力发送；发送失败也不丢数据，下次启动或回前台自动补发。
     */
    public void onAppBackground() {
        synchronized (queue) {
            persistQueueLocked();
        }
        flushQuietly();
    }

    /** App 回到前台：补发上次残留的离线队列。 */
    public void onAppForeground() {
        flushQuietly();
    }

    /** 释放资源（本实现无长连接，等价于 {@link #onAppBackground()}）。 */
    public void close() {
        onAppBackground();
    }

    // ---------------------------------------------------------------- 内部

    private void enqueue(Map<String, Object> e) {
        boolean needFlush;
        synchronized (queue) {
            queue.add(e);
            persistQueueLocked();
            needFlush = queue.size() >= batchSize;
        }
        if (needFlush) {
            flush();  // 攒批触发；失败抛异常，队列已持久化
        }
    }

    /** 事件骨架：字段顺序与规范 §2.1 一致（type, event, distinct_id, time, identities, lib, properties）。 */
    private Map<String, Object> event(String type, String eventName, String distinctId) {
        Map<String, Object> e = new LinkedHashMap<String, Object>();
        e.put("type", type);
        if (eventName != null) {
            e.put("event", eventName);
        }
        e.put("distinct_id", distinctId);
        e.put("time", System.currentTimeMillis());  // 毫秒（秒级会导致时间错误）
        String uk = userKey;
        if (uk != null) {
            e.put("identities", identities(uk));
        }
        Map<String, Object> lib = new LinkedHashMap<String, Object>();
        lib.put("$lib", LIB);
        lib.put("$lib_method", "code");
        lib.put("$lib_version", LIB_VERSION);
        e.put("lib", lib);
        e.put("properties", new LinkedHashMap<String, Object>());  // 空也必须传 {}，不要 null
        return e;
    }

    private static Map<String, Object> identities(String userKey) {
        Map<String, Object> ids = new LinkedHashMap<String, Object>();
        ids.put("user_key", userKey);
        return ids;
    }

    /** 会话：超过 {@link #sessionTimeoutMs} 无事件即新建（与主流移动 SDK 口径一致）。 */
    private String currentSessionId() {
        long now = System.currentTimeMillis();
        String sid = emptyToNull(storage.get(KEY_SESSION_ID));
        long last = parseLong(storage.get(KEY_SESSION_TS));
        if (sid == null || now - last > sessionTimeoutMs) {
            sid = getDeviceId() + "-" + now + "-" + (int) (Math.random() * 100000);
            storage.set(KEY_SESSION_ID, sid);
        }
        storage.set(KEY_SESSION_TS, Long.toString(now));
        return sid;
    }

    /** 表单体：project / token / data（data 已是 urlencode 过的单行 base64）。 */
    private String buildForm(String encodedData) {
        StringBuilder sb = new StringBuilder();
        sb.append("project=").append(urlEncode(project));
        sb.append("&token=").append(urlEncode(token));
        sb.append("&data=").append(urlEncode(encodedData));
        return sb.toString();
    }

    /** 真实 HTTP 发送（本轮最多 {@link #maxAttempts} 次，退避递增）。 */
    private void postForm(String body) {
        RuntimeException last = null;
        for (int attempt = 1; attempt <= maxAttempts; attempt++) {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(endpoint).openConnection();
                conn.setRequestMethod("POST");
                conn.setDoOutput(true);
                conn.setConnectTimeout(connectTimeoutMs);
                conn.setReadTimeout(readTimeoutMs);
                conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                byte[] out = body.getBytes(UTF8);
                conn.setFixedLengthStreamingMode(out.length);
                OutputStream os = conn.getOutputStream();
                try {
                    os.write(out);
                    os.flush();
                } finally {
                    os.close();
                }
                int code = conn.getResponseCode();
                InputStream is = (code >= 200 && code < 300) ? conn.getInputStream() : conn.getErrorStream();
                String resp = readAll(is);
                if (code == 200) {
                    return;
                }
                last = new ClkLogException("http " + code + ": " + resp, null);
            } catch (IOException e) {
                last = new ClkLogException("io error: " + e, e);
            } finally {
                if (conn != null) {
                    conn.disconnect();
                }
            }
            if (debug) {
                System.out.println("[clklog] attempt " + attempt + "/" + maxAttempts
                        + " failed: " + last.getMessage());
            }
            if (attempt < maxAttempts) {
                sleep(retryBaseDelayMs * (1L << (attempt - 1)));
            }
        }
        throw last == null ? new ClkLogException("flush failed", null) : last;
    }

    private static String readAll(InputStream is) throws IOException {
        if (is == null) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        BufferedReader r = new BufferedReader(new InputStreamReader(is, UTF8));
        try {
            String line;
            while ((line = r.readLine()) != null) {
                sb.append(line);
            }
        } finally {
            r.close();
        }
        return sb.toString();
    }

    /** base64 单行。Android minSdk &lt; 26 时换 {@code android.util.Base64.NO_WRAP}。 */
    private static String encodeBase64(byte[] payload) {
        return Base64.getEncoder().encodeToString(payload);
    }

    /** urlencode：base64 里的 {@code + / =} 必须转义，否则 data 会损坏（§1.3）。 */
    private static String urlEncode(String s) {
        try {
            return URLEncoder.encode(s, "UTF-8");
        } catch (UnsupportedEncodingException e) {
            throw new IllegalStateException("UTF-8 unsupported", e);
        }
    }

    /** 队列 → JSON 落盘（调用方须持有 {@code queue} 锁）。 */
    private void persistQueueLocked() {
        if (queue.isEmpty()) {
            storage.remove(KEY_QUEUE);
        } else {
            storage.set(KEY_QUEUE, Json.encode(queue));
        }
    }

    /** 启动时恢复残留队列（离线补发）。 */
    private void restoreQueue() {
        String json = storage.get(KEY_QUEUE);
        if (json == null || json.isEmpty()) {
            return;
        }
        try {
            Object parsed = Json.parse(json);
            if (parsed instanceof List) {
                for (Object o : (List<?>) parsed) {
                    if (o instanceof Map) {
                        @SuppressWarnings("unchecked")
                        Map<String, Object> e = (Map<String, Object>) o;
                        queue.add(e);
                    }
                }
            }
            if (debug) {
                System.out.println("[clklog] restored " + queue.size() + " offline event(s)");
            }
        } catch (RuntimeException e) {
            storage.remove(KEY_QUEUE);  // 损坏的队列不拖累启动
        }
    }

    private static void sleep(long ms) {
        if (ms <= 0) {
            return;
        }
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
        }
    }

    private static String emptyToNull(String s) {
        return (s == null || s.isEmpty()) ? null : s;
    }

    private static long parseLong(String s) {
        if (s == null || s.isEmpty()) {
            return 0L;
        }
        try {
            return Long.parseLong(s);
        } catch (NumberFormatException e) {
            return 0L;
        }
    }

    /**
     * 极简 JSON 读写（避免引入 Gson/Jackson —— Android 上也可换成 Gson，序列化语义等价）。
     * 支持：Map / List / String / Number / Boolean / null；数字 NaN、Infinity 输出 null（合法 JSON）。
     */
    static final class Json {

        static String encode(Object value) {
            StringBuilder sb = new StringBuilder(256);
            write(sb, value);
            return sb.toString();
        }

        private static void write(StringBuilder sb, Object v) {
            if (v == null) {
                sb.append("null");
            } else if (v instanceof String) {
                writeString(sb, (String) v);
            } else if (v instanceof Boolean) {
                sb.append(((Boolean) v).booleanValue() ? "true" : "false");
            } else if (v instanceof Double || v instanceof Float) {
                double d = ((Number) v).doubleValue();
                if (Double.isNaN(d) || Double.isInfinite(d)) {
                    sb.append("null");
                } else {
                    sb.append(Double.toString(d));
                }
            } else if (v instanceof Number) {
                sb.append(v.toString());
            } else if (v instanceof Map) {
                sb.append('{');
                boolean first = true;
                for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
                    if (!first) {
                        sb.append(',');
                    }
                    first = false;
                    writeString(sb, String.valueOf(e.getKey()));
                    sb.append(':');
                    write(sb, e.getValue());
                }
                sb.append('}');
            } else if (v instanceof Iterable) {
                sb.append('[');
                boolean first = true;
                for (Object o : (Iterable<?>) v) {
                    if (!first) {
                        sb.append(',');
                    }
                    first = false;
                    write(sb, o);
                }
                sb.append(']');
            } else if (v instanceof Object[]) {
                write(sb, java.util.Arrays.asList((Object[]) v));
            } else {
                writeString(sb, v.toString());
            }
        }

        private static void writeString(StringBuilder sb, String s) {
            sb.append('"');
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                switch (c) {
                    case '"':
                        sb.append("\\\"");
                        break;
                    case '\\':
                        sb.append("\\\\");
                        break;
                    case '\n':
                        sb.append("\\n");
                        break;
                    case '\r':
                        sb.append("\\r");
                        break;
                    case '\t':
                        sb.append("\\t");
                        break;
                    case '\b':
                        sb.append("\\b");
                        break;
                    case '\f':
                        sb.append("\\f");
                        break;
                    default:
                        if (c < 0x20) {
                            sb.append(String.format("\\u%04x", Integer.valueOf(c)));
                        } else {
                            sb.append(c);
                        }
                }
            }
            sb.append('"');
        }

        /** 解析（仅用于恢复持久化队列）。 */
        static Object parse(String json) {
            Parser p = new Parser(json);
            p.skipWs();
            Object v = p.value();
            p.skipWs();
            return v;
        }

        private static final class Parser {
            private final String s;
            private int i;

            Parser(String s) {
                this.s = s;
            }

            void skipWs() {
                while (i < s.length() && Character.isWhitespace(s.charAt(i))) {
                    i++;
                }
            }

            Object value() {
                skipWs();
                char c = s.charAt(i);
                switch (c) {
                    case '{':
                        return object();
                    case '[':
                        return array();
                    case '"':
                        return string();
                    case 't':
                        expect("true");
                        return Boolean.TRUE;
                    case 'f':
                        expect("false");
                        return Boolean.FALSE;
                    case 'n':
                        expect("null");
                        return null;
                    default:
                        return number();
                }
            }

            private Map<String, Object> object() {
                Map<String, Object> m = new LinkedHashMap<String, Object>();
                i++;  // {
                skipWs();
                if (s.charAt(i) == '}') {
                    i++;
                    return m;
                }
                while (true) {
                    skipWs();
                    String k = string();
                    skipWs();
                    i++;  // :
                    m.put(k, value());
                    skipWs();
                    char c = s.charAt(i++);
                    if (c == '}') {
                        return m;
                    }
                }
            }

            private List<Object> array() {
                List<Object> l = new ArrayList<Object>();
                i++;  // [
                skipWs();
                if (s.charAt(i) == ']') {
                    i++;
                    return l;
                }
                while (true) {
                    l.add(value());
                    skipWs();
                    char c = s.charAt(i++);
                    if (c == ']') {
                        return l;
                    }
                }
            }

            private String string() {
                StringBuilder sb = new StringBuilder();
                i++;  // "
                while (true) {
                    char c = s.charAt(i++);
                    if (c == '"') {
                        return sb.toString();
                    }
                    if (c == '\\') {
                        char e = s.charAt(i++);
                        switch (e) {
                            case 'n':
                                sb.append('\n');
                                break;
                            case 'r':
                                sb.append('\r');
                                break;
                            case 't':
                                sb.append('\t');
                                break;
                            case 'b':
                                sb.append('\b');
                                break;
                            case 'f':
                                sb.append('\f');
                                break;
                            case 'u':
                                sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
                                i += 4;
                                break;
                            default:
                                sb.append(e);
                        }
                    } else {
                        sb.append(c);
                    }
                }
            }

            private Object number() {
                int start = i;
                while (i < s.length() && "+-.eE0123456789".indexOf(s.charAt(i)) >= 0) {
                    i++;
                }
                String raw = s.substring(start, i);
                if (raw.indexOf('.') < 0 && raw.indexOf('e') < 0 && raw.indexOf('E') < 0) {
                    return Long.valueOf(Long.parseLong(raw));
                }
                return Double.valueOf(Double.parseDouble(raw));
            }

            private void expect(String lit) {
                if (!s.startsWith(lit, i)) {
                    throw new IllegalStateException("bad json at " + i);
                }
                i += lit.length();
            }
        }
    }
}
