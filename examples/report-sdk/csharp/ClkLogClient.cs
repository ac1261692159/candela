using System.Text;
using System.Text.Json;

namespace ClkLogDemo;

/// <summary>
/// ClkLog 神策数据格式最简上报客户端。
/// 同时兼容 Unity 2021+（.NET Standard 2.1，含 HttpClient；
/// System.Text.Json 在 Unity 6 内置，更早版本可用 NuGetForUnity 安装或替换为 Newtonsoft.Json）。
/// 规范文档：根目录《数据上报规范与流程.md》§8
/// </summary>
public sealed class ClkLogClient
{
    private readonly HttpClient _http;
    private readonly string _endpoint;   // 上报地址，如 https://receiver-clklog.xyxverse.com/receiver/api/gp
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

    /// <summary>用户属性（覆盖写）；登录后自动携带 identities.user_key。</summary>
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

    /// <summary>
    /// 登录关联：上报 track_signup 绑定匿名ID，之后事件自动带 user_key。
    /// ClkLog 口径：identities.user_key=登录ID，properties.$track_signup_original_id=匿名ID。
    /// </summary>
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
            _ = FlushAsync(); // 达到批量自动发送（fire-and-forget，异常见 FlushAsync 返回值）
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
                    Console.WriteLine($"[clklog] flushed {_queue.Count} events OK");
                    _queue.Clear();
                    return;
                }
                lastError = new Exception($"http {(int)resp.StatusCode}: {await resp.Content.ReadAsStringAsync()}");
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
