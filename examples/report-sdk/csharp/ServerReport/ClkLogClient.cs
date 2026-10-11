using System.Text;
using System.Text.Json;

namespace ClkLogServerReport;

/// <summary>
/// ClkLog 神策数据格式上报客户端（服务端控制台 / 后台任务通用，生产可用骨架）。
/// 规范文档：仓库根目录《数据上报规范与流程.md》§1（编码硬要求）、§2（事件结构）、§3（用户标识口径）。
///
/// 要点：
/// - 表单字段 data = JSON 数组 → base64 → urlencode；直接 POST 原始 JSON 会 200 但静默丢数据（§1.3）；
/// - ClkLog 不解析神策顶层 login_id/original_id：登录ID 走 identities.user_key，
///   登录绑定匿名ID 走 properties.$track_signup_original_id（§3）。
/// </summary>
public sealed class ClkLogClient : IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        // 不转义中文（与 Go/PHP 示例一致；转义与否 receiver 均可解析）
        Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private readonly HttpClient _http;
    private readonly bool _ownsHttp;
    private readonly string _endpoint;   // 上报地址，如 https://receiver-clklog.xyxverse.com/receiver/api/gp
    private readonly string _project;    // 项目名
    private readonly string _token;      // 项目 token（禁止硬编码，见 AGENTS.md 红线 3）
    private readonly int _batchSize;
    private readonly int _maxAttempts;
    private readonly List<Dictionary<string, object?>> _queue = new();
    private string? _loginId;            // 登录ID，Login() 后自动携带到 identities.user_key

    public ClkLogClient(
        string endpoint,
        string project,
        string token,
        int batchSize = 10,
        TimeSpan? timeout = null,
        int maxAttempts = 3,
        HttpClient? http = null)
    {
        _endpoint = endpoint;
        _project = project;
        _token = token;
        _batchSize = batchSize > 0 ? batchSize : 10;
        _maxAttempts = maxAttempts > 0 ? maxAttempts : 3;
        _ownsHttp = http is null;
        _http = http ?? new HttpClient { Timeout = timeout ?? TimeSpan.FromSeconds(10) };
    }

    /// <summary>行为事件；登录后自动携带 identities.user_key。</summary>
    public async Task TrackAsync(string distinctId, string eventName, Dictionary<string, object?>? properties = null)
    {
        var e = new Dictionary<string, object?>
        {
            ["type"] = "track",
            ["event"] = eventName,
            ["distinct_id"] = distinctId,
            ["time"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), // 毫秒时间戳（秒级会时间错乱）
            ["properties"] = properties ?? new Dictionary<string, object?>(),
        };
        await EnqueueAsync(WithIdentity(e));
    }

    /// <summary>用户属性（覆盖写）；登录后自动携带 identities.user_key。</summary>
    public async Task ProfileSetAsync(string distinctId, Dictionary<string, object?> properties)
    {
        var e = new Dictionary<string, object?>
        {
            ["type"] = "user_set",
            ["distinct_id"] = distinctId,
            ["time"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            ["properties"] = properties,
        };
        await EnqueueAsync(WithIdentity(e));
    }

    /// <summary>
    /// 登录关联：上报 track_signup 绑定匿名ID，之后事件自动带 user_key。
    /// ClkLog 口径：identities.user_key=登录ID，properties.$track_signup_original_id=匿名ID。
    /// </summary>
    public async Task LoginAsync(string loginId, string anonymousId)
    {
        _loginId = loginId;
        await EnqueueAsync(new Dictionary<string, object?>
        {
            ["type"] = "track_signup",
            ["event"] = "$SignUp",
            ["distinct_id"] = loginId,
            ["identities"] = new Dictionary<string, object?> { ["user_key"] = loginId },
            ["properties"] = new Dictionary<string, object?> { ["$track_signup_original_id"] = anonymousId },
            ["time"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        });
    }

    /// <summary>发送队列内全部事件：JSON 数组 → base64 → urlencode 表单 POST，失败重试退避。</summary>
    public async Task FlushAsync()
    {
        if (_queue.Count == 0) return;

        var json = JsonSerializer.Serialize(_queue, JsonOptions);
        var payload = Convert.ToBase64String(Encoding.UTF8.GetBytes(json));

        var lastError = string.Empty;
        for (var attempt = 1; attempt <= _maxAttempts; attempt++)
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
                var body = await resp.Content.ReadAsStringAsync();
                if ((int)resp.StatusCode == 200)
                {
                    Console.WriteLine($"[clklog] flushed {_queue.Count} events OK");
                    _queue.Clear();
                    return;
                }
                lastError = $"http {(int)resp.StatusCode}: {Truncate(body, 200)}";
            }
            catch (Exception ex)
            {
                lastError = $"{ex.GetType().Name}: {ex.Message}";
            }
            await Task.Delay(TimeSpan.FromMilliseconds(500 * attempt)); // 线性退避
        }
        throw new InvalidOperationException($"flush failed after {_maxAttempts} attempts: {lastError}");
    }

    private static string Truncate(string value, int max) =>
        value.Length <= max ? value : value[..max];

    private Dictionary<string, object?> WithIdentity(Dictionary<string, object?> e)
    {
        if (_loginId is not null)
        {
            e["identities"] = new Dictionary<string, object?> { ["user_key"] = _loginId };
        }
        return e;
    }

    private async Task EnqueueAsync(Dictionary<string, object?> e)
    {
        _queue.Add(e);
        if (_queue.Count >= _batchSize)
        {
            await FlushAsync(); // 达到批量自动发送
        }
    }

    public void Dispose()
    {
        if (_ownsHttp) _http.Dispose();
    }
}
