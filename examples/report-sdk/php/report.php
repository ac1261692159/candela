<?php
declare(strict_types=1);

/**
 * ClkLog 神策数据格式最简上报客户端（PHP 8+，生产可用骨架）
 * 规范文档：根目录《数据上报规范与流程.md》§6
 */
final class ClkLogClient
{
    private array $queue = [];
    private ?string $loginId = null; // 登录ID，login() 后自动携带到 identities.user_key

    public function __construct(
        private readonly string $endpoint,  // 上报地址，如 https://receiver-clklog.xyxverse.com/receiver/api/gp
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

    /** 用户属性（覆盖写）；登录后自动携带 identities.user_key */
    public function profileSet(string $distinctId, array $properties): void
    {
        $this->enqueue($this->withIdentity([
            'type'        => 'user_set',
            'distinct_id' => $distinctId,
            'time'        => (int) (microtime(true) * 1000),
            'properties'  => (object) $properties,
        ]));
    }

    /**
     * 登录关联：上报 track_signup 绑定匿名ID，之后事件自动带 user_key
     * ClkLog 口径：identities.user_key=登录ID，properties.$track_signup_original_id=匿名ID
     */
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
            unset($ch); // PHP >= 8.0 自动释放，无需 curl_close

            if ($err === '' && $code === 200) {
                printf("[clklog] flushed %d events OK\n", count($this->queue));
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
// token 从环境变量读取，禁止硬编码入库（AGENTS.md 红线 3）
$token = getenv('CLKLOG_TOKEN');
if ($token === false || $token === '') {
    fwrite(STDERR, "missing env CLKLOG_TOKEN\n");
    exit(1);
}
$endpoint = getenv('CLKLOG_ENDPOINT') ?: 'https://receiver-clklog.xyxverse.com/receiver/api/gp';
$project  = getenv('CLKLOG_PROJECT') ?: 'clklogapp';

$runId   = 'php-' . time();
$anonId  = "sdk-test-anon-$runId";  // 匿名ID（登录前）
$loginId = "uid-php-$runId";        // 登录ID

$cli = new ClkLogClient($endpoint, $project, $token, 10);

// 1. 登录前：匿名事件
$cli->track($anonId, 'SdkSpecTest', [
    'test_run_id' => $runId, 'sdk_lang' => 'php', 'step' => 'before_login',
]);
// 2. 登录关联：之后所有事件自动携带 identities.user_key
$cli->login($loginId, $anonId);
// 3. 用户属性（登录态）
$cli->profileSet($anonId, [
    'vip_level' => 3, 'register_channel' => 'app_store', 'sdk_lang' => 'php',
]);
// 4. 登录后行为事件：distinct_id 仍为匿名ID，登录ID走 identities.user_key
$cli->track($anonId, 'SdkSpecTest', [
    'test_run_id'  => $runId,
    'sdk_lang'     => 'php',
    'amount'       => 99.5,
    'is_new_user'  => true,
    'product_id'   => 'P1001',
    'product_name' => '测试商品',
]);
$cli->track($anonId, 'Purchase', [
    'test_run_id' => $runId, 'order_id' => "O$runId", 'amount' => 99.5, 'pay_type' => 'alipay',
]);
$cli->flush();
echo "DONE run_id = $runId\n";
