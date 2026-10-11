using ClkLogServerReport;

// ClkLog 上报示例：服务端控制台入口（Unity 客户端示例见上级目录 Program.cs / ClkLogClient.cs）。
// 运行：dotnet run --project examples/report-sdk/csharp/ServerReport

// token 从环境变量（或仓库 examples/report-sdk/.env）读取，禁止硬编码入库（AGENTS.md 红线 3）
LoadDotenv("../../.env", "../.env", ".env");

var token = Environment.GetEnvironmentVariable("CLKLOG_TOKEN");
if (string.IsNullOrEmpty(token))
{
    Console.Error.WriteLine("missing env CLKLOG_TOKEN");
    return 1;
}
var endpoint = Environment.GetEnvironmentVariable("CLKLOG_ENDPOINT")
    ?? "https://receiver-clklog.xyxverse.com/receiver/api/gp";
var project = Environment.GetEnvironmentVariable("CLKLOG_PROJECT") ?? "clklogapp";

var runId = $"csharp-{DateTimeOffset.UtcNow.ToUnixTimeSeconds()}";  // <lang>-<unix 秒>
var anonId = $"sdk-test-anon-{runId}";                              // 匿名ID（登录前，全程稳定）
var loginId = $"uid-csharp-{runId}";                                // 登录ID

using var cli = new ClkLogClient(endpoint, project, token, batchSize: 10);

// 1. 登录前：匿名事件（不带 identities）
await cli.TrackAsync(anonId, "SdkSpecTest", new Dictionary<string, object?>
{
    ["test_run_id"] = runId, ["sdk_lang"] = "csharp", ["step"] = "before_login",
});
// 2. 登录关联：之后所有事件自动携带 identities.user_key
await cli.LoginAsync(loginId, anonId);
// 3. 用户属性（登录态）
await cli.ProfileSetAsync(anonId, new Dictionary<string, object?>
{
    ["vip_level"] = 3, ["register_channel"] = "app_store", ["sdk_lang"] = "csharp",
});
// 4. 登录后行为事件：distinct_id 仍为匿名ID，登录ID走 identities.user_key
await cli.TrackAsync(anonId, "SdkSpecTest", new Dictionary<string, object?>
{
    ["test_run_id"] = runId,
    ["sdk_lang"] = "csharp",
    ["amount"] = 99.5,
    ["is_new_user"] = true,
    ["product_id"] = "P1001",
    ["product_name"] = "测试商品",
});
// 5. 登录后购买事件
await cli.TrackAsync(anonId, "Purchase", new Dictionary<string, object?>
{
    ["test_run_id"] = runId,
    ["order_id"] = $"O{runId}",
    ["amount"] = 99.5,
    ["pay_type"] = "alipay",
});
await cli.FlushAsync();

Console.WriteLine($"DONE run_id = {runId}");
return 0;

// 按需加载 .env（已存在的环境变量优先），仅取 CLKLOG_* 键
static void LoadDotenv(params string[] candidates)
{
    foreach (var candidate in candidates)
    {
        var path = Path.GetFullPath(candidate);
        if (!File.Exists(path)) continue;
        foreach (var raw in File.ReadAllLines(path))
        {
            var line = raw.Trim();
            if (line.Length == 0 || line.StartsWith('#') || !line.Contains('=')) continue;
            var idx = line.IndexOf('=');
            var key = line[..idx].Trim();
            var value = line[(idx + 1)..].Trim().Trim('"', '\'');
            if (key.Length > 0 && string.IsNullOrEmpty(Environment.GetEnvironmentVariable(key)))
            {
                Environment.SetEnvironmentVariable(key, value);
            }
        }
        Console.WriteLine($"[clklog] loaded env from {path}");
        return;
    }
    Console.WriteLine("[clklog] .env not found, fallback to system env");
}
