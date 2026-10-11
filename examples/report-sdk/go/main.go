package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// ClkLogClient 神策数据格式最简上报客户端（生产可用骨架）
// 规范文档：根目录《数据上报规范与流程.md》§7
type ClkLogClient struct {
	Endpoint  string // 上报地址，如 https://receiver-clklog.xyxverse.com/receiver/api/gp
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

// ProfileSet 设置用户属性（覆盖）；登录后自动携带 identities.user_key
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
			fmt.Printf("[clklog] flushed %d events OK\n", len(c.queue))
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

// loadDotenv 加载 ../.env 文件（优先已存在的环境变量）
func loadDotenv() {
	candidates := []string{
		"../.env",                              // 从 examples/report-sdk/go/ 运行
		"examples/report-sdk/.env",             // 从项目根目录运行
	}
	for _, path := range candidates {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			parts := strings.SplitN(line, "=", 2)
			if len(parts) == 2 {
				key := strings.TrimSpace(parts[0])
				val := strings.TrimSpace(parts[1])
				if os.Getenv(key) == "" {
					os.Setenv(key, val)
				}
			}
		}
		fmt.Printf("[clklog] loaded env from %s\n", path)
		return
	}
	fmt.Println("[clklog] .env not found, fallback to system env")
}

func main() {
	loadDotenv()

	eventName := flag.String("event", "SdkSpecTest", "事件名")
	flag.Parse()

	// token 从环境变量读取，禁止硬编码入库（AGENTS.md 红线 3）
	token := os.Getenv("CLKLOG_TOKEN")
	if token == "" {
		fmt.Fprintln(os.Stderr, "missing env CLKLOG_TOKEN")
		os.Exit(1)
	}
	endpoint := os.Getenv("CLKLOG_ENDPOINT")
	if endpoint == "" {
		endpoint = "https://receiver-clklog.xyxverse.com/receiver/api/gp"
	}
	project := os.Getenv("CLKLOG_PROJECT")
	if project == "" {
		project = "clklogapp"
	}

	cli := NewClkLogClient(endpoint, project, token, 10)

	runID := fmt.Sprintf("go-%d", time.Now().Unix())
	anonID := "sdk-test-anon-" + runID // 匿名ID（登录前）
	loginID := "uid-go-" + runID       // 登录ID

	must := func(err error) {
		if err != nil {
			panic(err)
		}
	}

	// 1. 登录前：匿名事件
	must(cli.Track(anonID, *eventName, map[string]any{
		"test_run_id": runID, "sdk_lang": "go", "step": "before_login",
	}))
	// 2. 登录关联：之后所有事件自动携带 identities.user_key
	must(cli.Login(loginID, anonID))
	// 3. 用户属性（登录态）
	must(cli.ProfileSet(anonID, map[string]any{
		"vip_level": 3, "register_channel": "app_store", "sdk_lang": "go",
	}))
	// 4. 登录后行为事件：distinct_id 仍为匿名ID，登录ID走 identities.user_key
	must(cli.Track(anonID, *eventName, map[string]any{
		"test_run_id":  runID,
		"sdk_lang":     "go",
		"amount":       99.5,
		"is_new_user":  true,
		"product_id":   "P1001",
		"product_name": "测试商品",
	}))
	must(cli.Track(anonID, "Purchase", map[string]any{
		"test_run_id": runID, "order_id": "O" + runID, "amount": 99.5, "pay_type": "alipay",
	}))
	must(cli.Flush())
	fmt.Println("DONE run_id =", runID)
}
