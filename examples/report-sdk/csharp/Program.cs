using ClkLogDemo;

// token 从环境变量读取，禁止硬编码入库（AGENTS.md 红线 3）
var token = Environment.GetEnvironmentVariable("CLKLOG_TOKEN");
if (string.IsNullOrEmpty(token))
{
    Console.Error.WriteLine("missing env CLKLOG_TOKEN");
    return 1;
}
var endpoint = Environment.GetEnvironmentVariable("CLKLOG_ENDPOINT")
    ?? "https://receiver-clklog.xyxverse.com/receiver/api/gp";
var project = Environment.GetEnvironmentVariable("CLKLOG_PROJECT") ?? "clklogapp";

var runId = $"cs-{DateTimeOffset.UtcNow.ToUnixTimeSeconds()}";
var anonId = $"sdk-test-anon-{runId}";  // 匿名ID（登录前）
var loginId = $"uid-cs-{runId}";        // 登录ID

var cli = new ClkLogClient(endpoint, project, token, 10);

// 1. 登录前：匿名事件
cli.Track(anonId, "SdkSpecTest", new()
{
    ["test_run_id"] = runId, ["sdk_lang"] = "csharp", ["step"] = "before_login",
});
// 2. 登录关联：之后所有事件自动携带 identities.user_key
cli.Login(loginId, anonId);
// 3. 用户属性（登录态）
cli.ProfileSet(anonId, new()
{
    ["vip_level"] = 3, ["register_channel"] = "app_store", ["sdk_lang"] = "csharp",
});
// 4. 登录后行为事件：distinct_id 仍为匿名ID，登录ID走 identities.user_key
cli.Track(anonId, "SdkSpecTest", new()
{
    ["test_run_id"] = runId,
    ["sdk_lang"] = "csharp",
    ["amount"] = 99.5,
    ["is_new_user"] = true,
    ["product_id"] = "P1001",
    ["product_name"] = "测试商品",
});
cli.Track(anonId, "Purchase", new()
{
    ["test_run_id"] = runId, ["order_id"] = $"O{runId}", ["amount"] = 99.5, ["pay_type"] = "alipay",
});
await cli.FlushAsync();
Console.WriteLine($"DONE run_id = {runId}");
return 0;
