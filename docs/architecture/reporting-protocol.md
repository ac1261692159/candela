# 数据上报规范与流程（ClkLog 上报协议）

> 文件名 `reporting-protocol.md`（原 `数据上报规范与流程.md`）。文中示例入口原本写作内部域名，已替换为占位符（`<your-receiver-host>` 等）；部署后请填自己的实际入口（见 `README.md` 的部署章节：上报路径为 `/receiver/api/gp`）。

> 版本：v1.0（2026-07-28）｜ 适用端：PHP 服务端、Golang 服务端、Unity(C#) 客户端
> 本文所有代码均已**本地实测通过**（见 §9 实测记录），数据链路：SDK → receiver → CKafka → Flink → ClickHouse。
> 关联文档：`docs/architecture/analytics-extension-plan.md`、`docs/project/legacy-production-handover.md`；可运行示例源码：`examples/report-sdk/`（go/php/csharp）。

---

## 1. 上报协议

### 1.1 接口

| 项 | 值 |
|----|-----|
| 地址 | `https://<your-receiver-host>/receiver/api/gp`（生产：`<your-receiver-host-ta>`） |
| 方法 | POST（GET 亦可，推荐 POST） |
| Content-Type | `application/x-www-form-urlencoded` |

### 1.2 表单参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `project` | 是 | 项目名，当前 `clklogapp` |
| `token` | 是 | 项目 token（见 HANDOVER 第八节，泄露须轮换） |
| `data` | 是 | **JSON 数组 → base64 编码 → urlencode**。单条事件也必须包成数组 |

### 1.3 编码硬要求（最常踩的坑）

receiver **只接受** base64 + urlencode 后的神策格式数据；直接 POST 原始 JSON body 会被解析为「data 为空」，HTTP 仍返回 200 但**数据静默丢失**。

```
原始: [{"type":"track","event":"PageView","distinct_id":"u1","time":1785228036000,"properties":{}}]
      → base64 → W3sidHlwZSI6InRyYWNrIi...XQ==
      → urlencode → 放入表单 data 字段
```

### 1.4 响应

- HTTP 200：接收成功（仅代表格式解析通过，业务校验异步进行）
- 批量内单条异常不影响其他条；客户端按 §7.4 重试策略处理非 200

---

## 2. 数据模型

### 2.1 事件 JSON 结构

```json
{
  "type": "track",
  "event": "Purchase",
  "distinct_id": "anon-device-id-001",
  "time": 1785228036000,
  "identities": { "user_key": "uid-123" },
  "lib": { "$lib": "php", "$lib_version": "1.0.0" },
  "properties": { "order_id": "O001", "amount": 99.5 }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | string | 是 | 见 §2.2 |
| `event` | string | track 必填 | 事件名（命名规范见 §4.1） |
| `distinct_id` | string | 是 | 访客ID（匿名/设备ID），**全程稳定不切换** |
| `time` | number | 是 | **毫秒**时间戳（秒级会导致时间错误） |
| `identities` | object | 登录后必填 | 用户标识扩展，见 §3 |
| `lib` | object | 建议 | SDK 标识：`$lib`、`$lib_method`、`$lib_version`、`$app_version` |
| `properties` | object | 建议 | 事件属性；空则传 `{}`，不要传 null |

### 2.2 type 类型（已实测支持）

| type | 用途 | 落库 typeContext |
|------|------|-----------------|
| `track` | 行为事件 | `track` |
| `track_signup` | 登录关联（绑定匿名ID ↔ 登录ID） | `track_signup` |
| `user_set` | 用户属性（覆盖写） | `user_set` |

> `user_set_once`/`user_append`/`user_increment` 等类型规划在分析平台（`sa_user_profiles`）支持，上报前请确认 ingestor 已上线（见 `docs/architecture/clklog-analytics-design.md` §6.2）。

---

## 3. 用户标识规范（⚠️ 与神策原生口径不同，源码级确认）

ClkLog 社区版处理程序**不解析**神策顶层的 `login_id` / `original_id` 字段。经 `clklog-processing` 源码（`ExtractUtil.java`）确认并实测验证，正确口径为：

| 目的 | 字段位置 | 落库列 |
|------|---------|--------|
| 携带登录ID | **顶层 `identities.user_key`** | `user_key`，非空时 `is_logined=1` |
| 登录绑定匿名ID | **`properties.$track_signup_original_id`** | `track_signup_original_id` |
| Web Cookie ID | `identities.$identity_cookie_id` | `identity_cookie_id` |

规则：

1. **登录前**：所有事件只带 `distinct_id`（匿名/设备ID），不带 `identities`。
2. **登录成功时**：上报一条 `track_signup`（`event=$SignUp`，`distinct_id`=登录ID，`identities.user_key`=登录ID，`properties.$track_signup_original_id`=匿名ID）。
3. **登录后**：所有事件 `distinct_id` **仍为匿名ID**（保持稳定），通过 `identities.user_key` 携带登录ID；分析侧统一按 `if(user_key!='', user_key, distinct_id)` 归并（见实现方案 §5.3）。
4. **退出登录**：停止携带 `identities.user_key` 即可，无需上报事件。

---

## 4. 命名与属性规范

### 4.1 事件命名

- **大驼峰 PascalCase**：`PageView`、`SubmitOrder`、`PaySuccess`
- 字母开头，仅字母/数字/下划线，≤ 64 字符；**禁止 `$` 开头**（预置事件保留，如 `$SignUp`）
- 动宾结构，一事一名；禁止用属性区分本应是两个事件的业务动作

### 4.2 属性命名与类型

- **小写蛇形 snake_case**：`product_id`、`pay_type`、`is_new_user`
- 自定义属性**禁止 `$` 开头**（`$` 前缀 = 预置属性，由 SDK 自动采集，勿覆盖）
- 类型：String / Number / Bool / Datetime（`yyyy-MM-dd HH:mm:ss.SSS`）/ List
- **同一属性名跨事件类型必须一致**；新增/变更属性须先在埋点管理登记（分析平台 v1 上线前以埋点方案文档代管）
- 属性值禁止传隐私明文（手机号/身份证/详细地址），必要时脱敏或哈希

### 4.3 常用预置属性（properties 内 `$` 前缀，自动落列）

设备：`$os`、`$os_version`、`$brand`、`$manufacturer`、`$model`、`$browser`、`$browser_version`、`$carrier`、`$network_type`、`$screen_height`、`$screen_width`、`$device_id`
页面：`$url`、`$url_path`、`$title`、`$referrer`、`$referrer_host`、`$screen_name`
渠道：`$utm_source`、`$utm_medium`、`$utm_campaign`、`$utm_content`、`$utm_term`、`$latest_utm_*`
地域：`$country`、`$province`、`$city`、`$latitude`、`$longitude`
其他：`$is_first_day`、`$is_first_time`、`$event_duration`、`$event_session_id`、`$timezone_offset`、`$app_id`、`$app_name`、`$app_state`

> 完整清单以 `clklog-processing` 源码 `ExtractUtil.java` 为准（约 100 个）。

---

## 5. 埋点开发流程

```
① 设计 → ② 登记 → ③ 开发 → ④ 验证 → ⑤ 上线
```

| 步骤 | 动作 | 产出 |
|------|------|------|
| ① 设计 | 按业务拆解事件与属性，定义触发时机、上报端 | 埋点方案（事件+属性+类型+示例值） |
| ② 登记 | 埋点管理登记元事件/属性（v1 前用方案文档代管） | 元数据记录 |
| ③ 开发 | 按 §6~§8 SDK 示例接入；公共属性统一封装 | 代码 |
| ④ 验证 | 触发事件 → 按 §10 验证 SQL 查 ClickHouse 确认落库与字段 | 验证截图/记录 |
| ⑤ 上线 | 灰度发布 → 观察 1~3 天数据量与校验报告 → 全量 | 上线记录 |

---

## 6. PHP 示例（已实测：PHP 8.5.8）

```php
<?php
declare(strict_types=1);

/**
 * ClkLog 神策数据格式最简上报客户端（PHP 8+，生产可用骨架）
 */
final class ClkLogClient
{
    private array $queue = [];
    private ?string $loginId = null; // 登录ID，login() 后自动携带到 identities.user_key

    public function __construct(
        private readonly string $endpoint,  // 上报地址
        private readonly string $project,   // 项目名
        private readonly string $token,     // 项目 token
        private readonly int $batchSize = 10,
    ) {}

    /** 行为事件；登录后自动携带 identities.user_key */
    public function track(string $distinctId, string $event, array $properties = []): void
    {
        $this->enqueue($this->withIdentity([
            'type'        => 'track',
            'event'       => $event,
            'distinct_id' => $distinctId,
            'time'        => (int) (microtime(true) * 1000), // 毫秒时间戳
            'properties'  => (object) $properties,
        ]));
    }

    /** 用户属性（覆盖写） */
    public function profileSet(string $distinctId, array $properties): void
    {
        $this->enqueue($this->withIdentity([
            'type'        => 'user_set',
            'distinct_id' => $distinctId,
            'time'        => (int) (microtime(true) * 1000),
            'properties'  => (object) $properties,
        ]));
    }

    /** 登录关联：绑定匿名ID，之后事件自动带 user_key（ClkLog 口径，见 §3） */
    public function login(string $loginId, string $anonymousId): void
    {
        $this->loginId = $loginId;
        $this->enqueue([
            'type'        => 'track_signup',
            'event'       => '$SignUp',
            'distinct_id' => $loginId,
            'identities'  => ['user_key' => $loginId],
            'properties'  => ['$track_signup_original_id' => $anonymousId],
            'time'        => (int) (microtime(true) * 1000),
        ]);
    }

    private function withIdentity(array $event): array
    {
        if ($this->loginId !== null) {
            $event['identities'] = ['user_key' => $this->loginId];
        }
        return $event;
    }

    private function enqueue(array $event): void
    {
        $this->queue[] = $event;
        if (count($this->queue) >= $this->batchSize) {
            $this->flush();
        }
    }

    /** 发送队列：JSON 数组 → base64 → urlencode 表单 POST，失败重试 3 次 */
    public function flush(): void
    {
        if ($this->queue === []) {
            return;
        }
        $payload = base64_encode(json_encode($this->queue, JSON_UNESCAPED_UNICODE));

        $lastError = null;
        for ($attempt = 1; $attempt <= 3; $attempt++) {
            $ch = curl_init($this->endpoint);
            curl_setopt_array($ch, [
                CURLOPT_POST           => true,
                CURLOPT_POSTFIELDS     => http_build_query([
                    'project' => $this->project,
                    'token'   => $this->token,
                    'data'    => $payload,
                ]),
                CURLOPT_HTTPHEADER     => ['Content-Type: application/x-www-form-urlencoded'],
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT        => 10,
            ]);
            $body = curl_exec($ch);
            $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            $err  = curl_error($ch);
            unset($ch); // PHP >= 8.0 自动释放

            if ($err === '' && $code === 200) {
                $this->queue = [];
                return;
            }
            $lastError = "http $code $err $body";
            usleep($attempt * 500_000); // 退避
        }
        throw new RuntimeException("flush failed after 3 attempts: $lastError");
    }

    public function __destruct()
    {
        $this->flush(); // 进程退出前兜底发送
    }
}

// ================= 使用示例 =================
$cli = new ClkLogClient(
    'https://<your-receiver-host>/receiver/api/gp',
    'clklogapp',
    '<项目token>',
    10,
);

$anonId = 'device-abc-001';            // 匿名ID（设备/访客ID，全程稳定）

// 1. 登录前：匿名事件
$cli->track($anonId, 'PageView', ['page' => 'home']);

// 2. 登录关联
$cli->login('uid-123', $anonId);

// 3. 用户属性
$cli->profileSet($anonId, ['vip_level' => 3, 'register_channel' => 'app_store']);

// 4. 登录后行为事件（distinct_id 不变，登录ID 自动走 identities.user_key）
$cli->track($anonId, 'Purchase', [
    'order_id' => 'O20260728001', 'amount' => 99.5, 'pay_type' => 'alipay',
]);

$cli->flush(); // 建议请求结束/定时任务收尾时显式调用
```

> 生产建议：队列持久化可用 Laravel/Symfony 队列异步发送；`batchSize` 建议 10~50。

## 7. Golang 示例（已实测：Go 1.26.3）

```go
package clklog

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"
)

// ClkLogClient 神策数据格式最简上报客户端（生产可用骨架）
type ClkLogClient struct {
	Endpoint  string // 上报地址
	Project   string // 项目名
	Token     string // 项目 token
	BatchSize int    // 攒批条数，达到即自动发送

	loginID string // 登录ID，Login() 后自动携带到 identities.user_key
	queue   []Event
	http    *http.Client
}

// Event 神策格式事件 + ClkLog identities 身份扩展
type Event struct {
	Type       string         `json:"type"`                 // track / track_signup / user_set
	Event      string         `json:"event,omitempty"`      // 事件名（track 必填）
	DistinctID string         `json:"distinct_id"`          // 访客ID（匿名ID/设备ID，全程稳定）
	Time       int64          `json:"time"`                 // 毫秒时间戳
	Identities map[string]any `json:"identities,omitempty"` // ClkLog 身份扩展：user_key=登录ID
	Properties map[string]any `json:"properties,omitempty"` // 自定义属性；$ 前缀为预置属性
}

func NewClkLogClient(endpoint, project, token string, batchSize int) *ClkLogClient {
	if batchSize <= 0 {
		batchSize = 10
	}
	return &ClkLogClient{
		Endpoint: endpoint, Project: project, Token: token,
		BatchSize: batchSize,
		http:      &http.Client{Timeout: 10 * time.Second},
	}
}

// Track 入队一个行为事件，达到批量自动 Flush；登录后自动携带 identities.user_key
func (c *ClkLogClient) Track(distinctID, event string, props map[string]any) error {
	e := Event{
		Type: "track", Event: event, DistinctID: distinctID,
		Time: time.Now().UnixMilli(), Properties: props,
	}
	if c.loginID != "" {
		e.Identities = map[string]any{"user_key": c.loginID}
	}
	c.queue = append(c.queue, e)
	if len(c.queue) >= c.BatchSize {
		return c.Flush()
	}
	return nil
}

// ProfileSet 设置用户属性（覆盖）
func (c *ClkLogClient) ProfileSet(distinctID string, props map[string]any) error {
	e := Event{
		Type: "user_set", DistinctID: distinctID,
		Time: time.Now().UnixMilli(), Properties: props,
	}
	if c.loginID != "" {
		e.Identities = map[string]any{"user_key": c.loginID}
	}
	c.queue = append(c.queue, e)
	if len(c.queue) >= c.BatchSize {
		return c.Flush()
	}
	return nil
}

// Login 登录关联：上报 track_signup 绑定匿名ID，之后事件自动带 user_key
// ClkLog 口径：identities.user_key=登录ID，properties.$track_signup_original_id=匿名ID
func (c *ClkLogClient) Login(loginID, anonymousID string) error {
	c.loginID = loginID
	c.queue = append(c.queue, Event{
		Type: "track_signup", Event: "$SignUp", DistinctID: loginID,
		Identities: map[string]any{"user_key": loginID},
		Properties: map[string]any{"$track_signup_original_id": anonymousID},
		Time:       time.Now().UnixMilli(),
	})
	if len(c.queue) >= c.BatchSize {
		return c.Flush()
	}
	return nil
}

// Flush 发送队列中全部事件：JSON 数组 → base64 → urlencode 表单 POST，失败重试 3 次
func (c *ClkLogClient) Flush() error {
	if len(c.queue) == 0 {
		return nil
	}
	payload, err := json.Marshal(c.queue)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	encoded := base64.StdEncoding.EncodeToString(payload)

	form := url.Values{}
	form.Set("project", c.Project)
	form.Set("token", c.Token)
	form.Set("data", encoded)

	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		req, _ := http.NewRequest(http.MethodPost, c.Endpoint, bytes.NewBufferString(form.Encode()))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		resp, err := c.http.Do(req)
		if err == nil && resp.StatusCode == http.StatusOK {
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			c.queue = c.queue[:0]
			return nil
		}
		if err == nil {
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			lastErr = fmt.Errorf("http %d: %s", resp.StatusCode, string(body))
		} else {
			lastErr = err
		}
		time.Sleep(time.Duration(attempt) * 500 * time.Millisecond) // 退避
	}
	return fmt.Errorf("flush failed after 3 attempts: %w", lastErr)
}
```

使用示例：

```go
cli := clklog.NewClkLogClient(
	"https://<your-receiver-host>/receiver/api/gp",
	"clklogapp", "<项目token>", 10,
)
anonID := "device-abc-001"

_ = cli.Track(anonID, "PageView", map[string]any{"page": "home"}) // 1. 登录前
_ = cli.Login("uid-123", anonID)                                   // 2. 登录关联
_ = cli.ProfileSet(anonID, map[string]any{"vip_level": 3})         // 3. 用户属性
_ = cli.Track(anonID, "Purchase", map[string]any{                  // 4. 登录后事件
	"order_id": "O20260728001", "amount": 99.5, "pay_type": "alipay",
})
_ = cli.Flush()
```

> 生产建议：改用带 buffer 的 channel + 后台 goroutine 定时 Flush，进程退出前 `Flush()`。

## 8. Unity（C#）示例（已实测：.NET 8.0.423 编译运行通过）

客户端类（Unity 2021+ 可直接使用：.NET Standard 2.1 含 `HttpClient`；`System.Text.Json` 在 Unity 6 内置，更早版本用 NuGetForUnity 安装或替换为 Newtonsoft.Json）：

```csharp
using System.Text;
using System.Text.Json;

/// <summary>ClkLog 神策数据格式最简上报客户端（Unity / .NET 通用）</summary>
public sealed class ClkLogClient
{
    private readonly HttpClient _http;
    private readonly string _endpoint;   // 上报地址
    private readonly string _project;    // 项目名
    private readonly string _token;      // 项目 token
    private readonly int _batchSize;
    private readonly List<Dictionary<string, object?>> _queue = new();
    private string? _loginId;            // 登录ID，Login() 后自动携带到 identities.user_key

    public ClkLogClient(string endpoint, string project, string token, int batchSize = 10, HttpClient? http = null)
    {
        _endpoint = endpoint;
        _project = project;
        _token = token;
        _batchSize = batchSize > 0 ? batchSize : 10;
        _http = http ?? new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
    }

    /// <summary>行为事件；登录后自动携带 identities.user_key。</summary>
    public void Track(string distinctId, string eventName, Dictionary<string, object?>? properties = null)
    {
        var e = new Dictionary<string, object?>
        {
            ["type"] = "track",
            ["event"] = eventName,
            ["distinct_id"] = distinctId,
            ["time"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), // 毫秒时间戳
            ["properties"] = properties ?? new Dictionary<string, object?>(),
        };
        Enqueue(WithIdentity(e));
    }

    /// <summary>用户属性（覆盖写）。</summary>
    public void ProfileSet(string distinctId, Dictionary<string, object?> properties)
    {
        var e = new Dictionary<string, object?>
        {
            ["type"] = "user_set",
            ["distinct_id"] = distinctId,
            ["time"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            ["properties"] = properties,
        };
        Enqueue(WithIdentity(e));
    }

    /// <summary>登录关联：绑定匿名ID，之后事件自动带 user_key（ClkLog 口径，见 §3）。</summary>
    public void Login(string loginId, string anonymousId)
    {
        _loginId = loginId;
        Enqueue(new Dictionary<string, object?>
        {
            ["type"] = "track_signup",
            ["event"] = "$SignUp",
            ["distinct_id"] = loginId,
            ["identities"] = new Dictionary<string, object?> { ["user_key"] = loginId },
            ["properties"] = new Dictionary<string, object?> { ["$track_signup_original_id"] = anonymousId },
            ["time"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        });
    }

    private Dictionary<string, object?> WithIdentity(Dictionary<string, object?> e)
    {
        if (_loginId != null)
            e["identities"] = new Dictionary<string, object?> { ["user_key"] = _loginId };
        return e;
    }

    private void Enqueue(Dictionary<string, object?> e)
    {
        _queue.Add(e);
        if (_queue.Count >= _batchSize)
            _ = FlushAsync(); // 达到批量自动发送（fire-and-forget）
    }

    /// <summary>发送队列：JSON 数组 → base64 → urlencode 表单 POST，失败重试 3 次。</summary>
    public async Task FlushAsync()
    {
        if (_queue.Count == 0) return;
        var payload = Convert.ToBase64String(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(_queue)));

        Exception? lastError = null;
        for (var attempt = 1; attempt <= 3; attempt++)
        {
            try
            {
                using var content = new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["project"] = _project,
                    ["token"] = _token,
                    ["data"] = payload,
                });
                using var resp = await _http.PostAsync(_endpoint, content);
                if ((int)resp.StatusCode == 200)
                {
                    _queue.Clear();
                    return;
                }
                lastError = new Exception($"http {(int)resp.StatusCode}");
            }
            catch (Exception ex)
            {
                lastError = ex;
            }
            await Task.Delay(500 * attempt); // 退避
        }
        throw new InvalidOperationException($"flush failed after 3 attempts: {lastError?.Message}");
    }
}
```

Unity 集成用法（生命周期兜底发送）：

```csharp
public class ClkLogService : MonoBehaviour
{
    public static ClkLogClient Client { get; private set; }

    void Awake()
    {
        DontDestroyOnLoad(gameObject);
        Client = new ClkLogClient(
            "https://<your-receiver-host>/receiver/api/gp",
            "clklogapp", "<项目token>", batchSize: 10);

        string anonId = SystemInfo.deviceUniqueIdentifier; // 匿名ID：设备唯一标识
        Client.Track(anonId, "AppLaunch", new() { ["app_version"] = Application.version });
        // 登录成功后：Client.Login("uid-123", anonId);
    }

    void OnApplicationPause(bool paused) { if (paused) _ = Client.FlushAsync(); }
    void OnApplicationQuit() { _ = Client.FlushAsync(); }
}
```

> 注意：Unity 场景切换不销毁该 MonoBehaviour（`DontDestroyOnLoad`）；弱网环境建议增大重试退避并做本地持久化（PlayerPrefs/文件队列）。

---

## 9. 本地实测记录

验收口径（每门语言一致）：匿名事件 → Login 关联 → 用户属性 → 登录后事件 ×2，共 **5 条**，
逐行核对 ClickHouse `clklog.log_analysis`。示例代码与验收脚本都在 `examples/report-sdk/`：

```bash
cd examples/report-sdk/<语言目录> && <运行命令>     # 打印 DONE run_id = <lang>-<ts>
cd examples/report-sdk && ./verify.sh <run_id>      # 经 2223 隧道查库并断言 5 步链（默认轮询 300s）
```

> `verify.sh` 从**运行中的服务进程环境**读取 ClickHouse 凭据（不落盘、不打印）；数据链路
> SDK → nginx → receiver → CKafka → Flink → ClickHouse 实测延迟 **约 40 秒 ~ 2.5 分钟**，
> 所以脚本是轮询而不是一次性查询。

### 9.1 首批（2026-07-28）

| 语言 | 运行环境 | run_id | 结果 |
|------|---------|--------|------|
| Golang | go1.26.3 darwin/arm64 | `go-1785228737` | ✅ 5/5 行正确 |
| PHP | PHP 8.5.8 (cli) | `php-1785228821` | ✅ 5/5 行正确 |
| Unity(C#) | .NET 8.0.423 | `cs-1785230446` | ✅ 5/5 行正确 |

### 9.2 全语言批次（2026-10-08）

各语言示例均**真实运行**并落库，`verify.sh` 六条断言全绿。运行环境为开发机（macOS arm64）：
Go / PHP 8.5.8 / Python 3.9.6 / Node 24.14 / Ruby 2.6.10 / OpenJDK 8u412 / .NET 8.0.423 /
Apple clang 21（C11 与 C++17，libcurl）/ Lua 5.5.1（luasocket + luasec）/ Swift 6.3.3（Foundation URLSession）。

| 语言 / 端 | 目录 | 运行环境 | run_id | 结果 |
|------|------|---------|--------|------|
| Golang（服务端） | `go/` | go1.26.3 | `go-1791463443` | ✅ 5/5 |
| PHP（服务端） | `php/` | PHP 8.5.8 | `php-1791468455` | ✅ 5/5 |
| Python（服务端） | `python/` | Python 3.9.6（仅标准库） | `python-1791463739` | ✅ 5/5 |
| Node.js（服务端） | `nodejs/` | Node 24.14（内置 fetch） | `nodejs-1791463739` | ✅ 5/5 |
| Ruby（服务端） | `ruby/` | Ruby 2.6.10（net/http） | `ruby-1791463740` | ✅ 5/5 |
| C#（服务端） | `csharp/ServerReport/` | .NET 8.0.423（HttpClient） | `csharp-1791463742` | ✅ 5/5 |
| Java（服务端） | `java/` | OpenJDK 8u412（HttpURLConnection） | `java-1791464337` | ✅ 5/5 |
| C（服务端） | `c/` | C11 + libcurl | `c-1791464245` | ✅ 5/5 |
| C++（服务端 / Cocos 语言核心） | `cpp/` | C++17 + libcurl | `cpp-1791464290` | ✅ 5/5 |
| Lua（服务端 / OpenResty） | `lua/` | Lua 5.5.1 + luasocket + luasec | `lua-1791467203` | ✅ 5/5 |
| JavaScript / Web（浏览器 H5） | `js/` | **真实浏览器**（打开演示页，三个按钮各一次 flush） | `js-1791466559` | ✅ 5/5 |
| 微信小程序 | `miniprogram/` | Node 24 + `wx` 垫片（语言级） | `miniprogram-1791465315` | ✅ 5/5 |
| React Native | `react-native/` | Node 24 + 内存 storage（传输/队列核心） | `react-native-1791465316` | ✅ 5/5 |
| Android（Java 客户端核心） | `android/` | OpenJDK 8u412（JVM 运行，未打包 APK） | `android-1791465905` | ✅ 5/5 |
| iOS（Swift 客户端核心） | `ios/` | Swift 6.3.3 + Foundation URLSession（未打包 App） | `ios-1791466372` | ✅ 5/5 |
| Flutter / Dart（CLI 链路） | `flutter/` | Flutter 3.47.6 / Dart 3.13.5（http 1.6.0） | `flutter-1791472103` | ✅ 5/5 |
| Flutter Web（**真实浏览器**） | `flutter/`（`flutter build web` 产物） | dart2js 产物 + 浏览器点击三步（1+2+2） | `flutter-1791472650` | ✅ 5/5 |
| 批量回补 CLI（120 行 CSV） | `backfill/` | Python 3（仅标准库） | `backfill-1791470038`、`backfill-1791470783`（SIGINT 续跑） | ✅ 120/120 行落库，续跑无重发无丢行 |

落库结果（各语言一致，以下为 Go 实测行）：

```
typeContext   event        distinct_id               user_key        is_logined  track_signup_original_id
track         SdkSpecTest  sdk-test-anon-go-...      (空)            0           (空)     ← 登录前
user_set                   sdk-test-anon-go-...      uid-go-go-...   1           (空)     ← 登录后
track         SdkSpecTest  sdk-test-anon-go-...      uid-go-go-...   1           (空)
track         Purchase     sdk-test-anon-go-...      uid-go-go-...   1           (空)
track_signup  $SignUp      uid-go-go-...             uid-go-go-...   1           sdk-test-anon-go-...  ← 绑定
```

### 9.3 实测层级说明与未实测项（重要）

**「已实测」指什么**：语言实现（编码 → 表单 → 批次 → 身份字段）真实跑通并落库。
**不包含**平台打包验证的项：

| 项 | 已实测 | 未验证 | 原因 |
|----|--------|--------|------|
| 微信小程序 | `wx.request` / `wx.*Storage` / `onAppHide` 垫片下的完整链路 | 开发者工具/真机、request 合法域名白名单、基础库 timeout 支持 | 本机无微信开发者工具 |
| React Native | 传输与队列核心（全局 fetch + 注入式 storage + AppState 补发） | Metro 打包、AsyncStorage 原生模块、后台网络策略 | 本机无 RN 环境 |
| Android | Java 客户端核心（HttpURLConnection、设备ID 持久化、退避重试） | APK 构建、ART 运行、SharedPreferences、`android.util.Base64` | 本机无 Android SDK |
| iOS | Swift 客户端核心（URLSession、UserDefaults 队列） | Xcode 工程打包、模拟器/真机、后台任务时机、ATS | 本机只有 Command Line Tools |
| Flutter | Dart 语言链路（CLI）+ `flutter build web` 构建 + 真实浏览器点击 | iOS / Android / 桌面端打包、真机网络策略 | 本机无完整 Xcode 与 Android SDK（Web 已实测到浏览器） |
| Unreal / Cocos2d-x 引擎 | C++ / Lua 语言核心（见上表 `cpp` / `lua`） | 引擎工程内打包、引擎网络模块接入 | 无引擎环境（按需求跳过引擎本体） |
| 批量回补（文件导入） | CLI 全链路（dry-run / 限速 / 断点续跑 / 失败行落盘） | — | 已实现并实测，见 §11 |

> 接入指南页面（数据管理 → 接入指南）用三档状态表达同一口径：**已实测**（语言与环境都跑通）、
> **语言级已实测**（语言级实现实测、平台未打包）、**暂未开发**（Flutter / Unreal / 批量回补）。

---

## 10. 验收与排错

### 10.1 验证 SQL（本地经 SSH 隧道执行）

```bash
ssh root@localhost -p 2223 "curl -s -u 'default:<CK密码>' 'http://localhost:8123/' \
  --data-binary \"SELECT typeContext, event, distinct_id, user_key, is_logined, log_time \
  FROM clklog.log_analysis WHERE distinct_id LIKE '%<你的标识>%' \
  ORDER BY log_time FORMAT TSVWithNames\""
```

### 10.2 常见错误

| 现象 | 原因 | 解决 |
|------|------|------|
| HTTP 200 但库里无数据/「data为空」 | 直接 POST 了原始 JSON | 必须 base64 + urlencode 表单（§1.3） |
| 事件时间错乱 | `time` 用了秒级时间戳 | 必须毫秒 |
| `user_key` 始终为空、`is_logined=0` | 用了神策顶层 `login_id`/`original_id` | 用 `identities.user_key` + `properties.$track_signup_original_id`（§3） |
| 属性没进对应列 | 自定义属性无 `$` 前缀 | 预置属性才带 `$`；自定义属性进 `properties` JSON 原文 |
| properties 解析异常 | 传了 null 或数组 | 空属性传 `{}` |
| 401/403 | token 错误 | 核对 `tbl_project` 项目 token |

### 10.3 当前限制（重要）

- **自定义属性暂不落入社区版明细列**：`log_analysis` 只物化预置列，自定义属性现阶段仅在分析平台 `clklog_sa.sa_events`（properties JSON）可查可分析——ingestor 上线（P0）前，自定义属性的分析能力不可用，但**上报不受影响，请按规范正常携带**。
- 单条 data 建议 ≤ 50 事件；body ≤ 1MB。
- 生产环境必须 HTTPS。

---

## 11. 批量回补（文件导入 CLI）

把历史日志 / CSV 补报成事件（存量订单、支付、注册等）。工具在 `examples/report-sdk/backfill/backfill.py`，
**Python 3 仅标准库**，走与 SDK 完全相同的协议（base64 + urlencode 表单），因此无需为回补单独开通道。

```bash
python3 backfill.py --input history.csv --limit 5 --dry-run   # 试跑：只校验编码与体积，不联网
python3 backfill.py --input history.csv --limit 100 --rate 50 # 小批量真跑，打印 run 标识
python3 backfill.py --input history.csv --resume              # 正式回补（断点续跑）
```

| 项 | 说明 |
|----|------|
| 输入 | CSV（列规范见下）或 JSONL（每行一个事件对象） |
| 必需列 | `type`、`event`、`distinct_id`、`time`（毫秒或可解析时间字符串） |
| 身份列 | `user_key` → `identities.user_key`；`original_id` → `properties.$track_signup_original_id`（等价别名 `$track_signup_original_id` / `track_signup_original_id` / `signup_original_id`） |
| 其它列 | 进 `properties`（列名以 `$` 开头视为预置属性）；`properties_json` 列可放一段 JSON 整体合并 |
| 可靠性 | 单批 ≤50 条且 body ≤1MB（自动切分）；HTTP 200 才算成功；失败按 0.5s/1s/2s 退避重试 3 次；失败行连同行号写入 `<input>.failed.jsonl` |
| 续跑 | 进度写 `<input>.backfill-progress.json`；`--resume` 跳过已完成批次；输入文件内容/修改时间变化时拒绝续跑（除非 `--force-resume`） |
| 限速与试跑 | `--rate`（条/秒，0=不限）、`--dry-run`（不联网、不写进度）、`--limit`（单次条数） |
| 核对 | 每个事件的 `properties.backfill_run_id` 都写着本次 run 标识，可从 `clklog.log_analysis` 或 `clklog_sa.sa_events` 按 run 统计 |

**实测（2026-10-08）**：120 行 CSV 分两轮回补（`--limit 20` + 续跑补 100）→ 落库 **120 行**、
`count(DISTINCT (time,event)) = 120`，即**无重复无丢行**；另用真实 SIGINT 中断两次再续跑，
累计发送 120 条、落库仍为 120 行。失败路径（指向不可达 endpoint）实测 4 次尝试 / 3.5s 退避并写出失败文件。

**注意事项（重要）**：工具**不做去重** —— 同一条历史事件被完整回补两次就会入库两次；
请始终配合 `--resume` 续跑，或先用 `--dry-run` / `--limit` 验证。`time` 用**原始毫秒**保留历史时刻，
不要用当前时间替换，否则历史趋势会全部挤到回补当天。
