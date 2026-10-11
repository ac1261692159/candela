import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.nio.charset.Charset;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * ClkLog <b>Android 客户端 SDK</b> 验证入口：跑完规范 §9 的 5 步事件链并落 ClickHouse。
 *
 * <h2>⚠️ 验证范围（诚实说明，勿夸大）</h2>
 * <ul>
 *   <li><b>语言级实现已实测</b>：本机 <b>系统 JDK 1.8.0_412</b>（macOS）编译运行，
 *       5 条事件走真实 HTTPS 协议（base64 单行 + urlencode 表单）落 ClickHouse，由
 *       {@code ../verify.sh <run_id>} 断言 6 项全绿。</li>
 *   <li><b>真机 / 模拟器打包未验证</b>：本机<b>没有 Android SDK / 模拟器 / Gradle / adb</b>，
 *       未打 APK、未在 ART 上运行；见 {@code ClkLogClient.java} 头注释「语言级差异需真机补验的项」
 *       （{@code java.util.Base64} 需 API 26+、TLS 版本、SharedPreferences、ProcessLifecycleOwner）。</li>
 * </ul>
 *
 * <h2>编译 + 运行（实测命令，产物落 /tmp 不入库）</h2>
 * <pre>
 *   cd examples/report-sdk/android
 *   mkdir -p /tmp/clklog-android   # javac 不会自建 -d 目录
 *   javac -encoding UTF-8 -d /tmp/clklog-android *.java
 *   java -cp /tmp/clklog-android Main
 * </pre>
 * token 从环境变量 {@code CLKLOG_TOKEN} 或 {@code ../.env} 读取（后者优先环境变量），
 * <b>代码内不存在 token 字面量</b>（AGENTS.md 红线 3），日志只打印 run_id 与事件数。
 *
 * <h2>5 步事件链（顺序与 {@code ../go/main.go} 一致）</h2>
 * <ol>
 *   <li>{@code track} 匿名：无 {@code identities}，properties {@code {test_run_id, sdk_lang, step:before_login}}；</li>
 *   <li>{@code track_signup}：{@code $SignUp}，{@code distinct_id}=登录ID，{@code identities.user_key}=登录ID，
 *       {@code properties.$track_signup_original_id}=匿名ID；</li>
 *   <li>{@code user_set}：{@code distinct_id}=匿名ID，{@code identities.user_key}=登录ID，properties 含 vip_level 等；</li>
 *   <li>{@code track}（登录后）：{@code distinct_id} <b>仍为匿名ID</b> + {@code identities.user_key}=登录ID；</li>
 *   <li>{@code track} {@code Purchase}：同上身份，properties 含 {@code order_id}。</li>
 * </ol>
 * 末尾打印 {@code DONE run_id = <runID>}，供 {@code verify.sh} 使用。
 */
public final class Main {

    private static final Charset UTF8 = Charset.forName("UTF-8");

    /** 验证用状态目录（模拟 Android 上 SharedPreferences 的落盘效果）。 */
    private static final String STATE_DIR = "/tmp/clklog-android-state";

    private Main() {
    }

    public static void main(String[] args) {
        Map<String, String> dotenv = loadDotenv();

        String token = firstNonEmpty(System.getenv("CLKLOG_TOKEN"), dotenv.get("CLKLOG_TOKEN"));
        if (token == null) {
            System.err.println("[sdk] missing CLKLOG_TOKEN (env or ../.env)");
            System.exit(1);
        }
        String endpoint = firstNonEmpty(System.getenv("CLKLOG_ENDPOINT"), dotenv.get("CLKLOG_ENDPOINT"),
                ClkLogClient.DEFAULT_ENDPOINT);
        String project = firstNonEmpty(System.getenv("CLKLOG_PROJECT"), dotenv.get("CLKLOG_PROJECT"),
                ClkLogClient.DEFAULT_PROJECT);

        final String lang = "android";
        long sec = System.currentTimeMillis() / 1000L;
        final String runID = lang + "-" + sec;
        final String anonID = "sdk-test-anon-" + runID;  // 匿名ID / 设备ID（登录前后都不变）
        final String loginID = "uid-" + lang + "-" + runID;

        ClkLogClient cli = new ClkLogClient(endpoint, project, token,
                new ClkLogClient.FileStorage(new File(STATE_DIR)))
                .setBatchSize(50)          // 验证时 5 条一批一次性发出
                .setDebug(true);

        // 设备ID：真实 App 首次启动自动生成 UUID 并持久化（这里读一次，证明"生成 + 持久化"路径可用）
        System.out.println("[sdk] auto device_id     = " + cli.getDeviceId());
        // 本次验收要求 run_id 可检索，故显式覆盖设备ID；等价于 App 用自己的 device id 调 setDeviceId()
        cli.setDeviceId(anonID);
        System.out.println("[sdk] distinct_id (anon) = " + cli.getDeviceId() + "  (persist ok: "
                + anonID.equals(new ClkLogClient.FileStorage(new File(STATE_DIR)).get("clklog.device_id")) + ")");

        try {
            // ---- 1. 登录前：匿名事件（无 identities） ----
            Map<String, Object> p1 = map();
            p1.put("test_run_id", runID);
            p1.put("sdk_lang", lang);
            p1.put("step", "before_login");
            cli.track("SdkSpecTest", p1);

            // ---- 2. 登录关联：track_signup 绑定匿名ID → 登录ID ----
            cli.login(loginID, anonID);

            // ---- 3. 用户属性（登录态；distinct_id 仍为匿名ID） ----
            Map<String, Object> p3 = map();
            p3.put("vip_level", Integer.valueOf(3));
            p3.put("register_channel", "app_store");
            p3.put("sdk_lang", lang);
            cli.profileSet(anonID, p3);

            // ---- 4. 登录后行为事件：distinct_id 仍为匿名ID，登录ID 走 identities.user_key ----
            Map<String, Object> p4 = map();
            p4.put("test_run_id", runID);
            p4.put("sdk_lang", lang);
            p4.put("amount", Double.valueOf(99.5));
            p4.put("is_new_user", Boolean.TRUE);
            p4.put("product_id", "P1001");
            p4.put("product_name", "测试商品");
            cli.track(anonID, "SdkSpecTest", p4);

            // ---- 5. 登录后第二个事件 ----
            Map<String, Object> p5 = map();
            p5.put("test_run_id", runID);
            p5.put("order_id", "O" + runID);
            p5.put("amount", Double.valueOf(99.5));
            p5.put("pay_type", "alipay");
            cli.track(anonID, "Purchase", p5);

            // 离线队列证据：flush 前队列已持久化在磁盘上
            System.out.println("[sdk] pending queue       = " + cli.getQueueSize()
                    + " event(s), persisted " + cli.getPersistedQueueBytes() + " bytes @ " + STATE_DIR);
            System.out.println("[sdk] session_id         = " + cli.getSessionId());

            int sent = cli.flush();
            System.out.println("[sdk] flushed            = " + sent + " event(s)");

            // 模拟进程重启：同一存储目录重新构造客户端，队列应为空、设备ID 不变（离线队列 + 持久化证据）
            ClkLogClient reopened = new ClkLogClient(endpoint, project, token,
                    new ClkLogClient.FileStorage(new File(STATE_DIR)));
            System.out.println("[sdk] reopen check       : device_id=" + reopened.getDeviceId()
                    + ", pending=" + reopened.getQueueSize());

            // 模拟 App 退到后台：幂等，队列已空则不发请求
            cli.onAppBackground();
            System.out.println("[sdk] onAppBackground    : queue=" + cli.getQueueSize());
        } catch (RuntimeException e) {
            System.err.println("[sdk] FAILED: " + e.getMessage());
            System.err.println("[sdk] queue kept, run_id = " + runID + "（可重跑同 run_id 的 verify 或重发）");
            System.exit(1);
        }

        System.out.println("DONE run_id = " + runID);
    }

    private static Map<String, Object> map() {
        return new LinkedHashMap<String, Object>();
    }

    private static String firstNonEmpty(String... values) {
        for (String v : values) {
            if (v != null && !v.isEmpty()) {
                return v;
            }
        }
        return null;
    }

    /** 加载 {@code ../.env}（已存在的环境变量优先），仅取用到的键，token 不打印。 */
    private static Map<String, String> loadDotenv() {
        Map<String, String> out = new LinkedHashMap<String, String>();
        String[] candidates = {
                "../.env",                                                       // 从 examples/report-sdk/android/ 运行
                "examples/report-sdk/.env",                                      // 从仓库根目录运行
        };
        for (String path : candidates) {
            File f = new File(path);
            if (!f.isFile()) {
                continue;
            }
            try {
                BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(f), UTF8));
                try {
                    String line;
                    while ((line = r.readLine()) != null) {
                        line = line.trim();
                        if (line.isEmpty() || line.startsWith("#")) {
                            continue;
                        }
                        int eq = line.indexOf('=');
                        if (eq > 0) {
                            out.put(line.substring(0, eq).trim(), line.substring(eq + 1).trim());
                        }
                    }
                } finally {
                    r.close();
                }
                System.out.println("[sdk] loaded env from " + path + " (token not printed)");
                return out;
            } catch (Exception e) {
                System.err.println("[sdk] cannot read " + path + ": " + e);
            }
        }
        System.out.println("[sdk] .env not found, fallback to system env");
        return out;
    }
}
