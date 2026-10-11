#!/usr/bin/env ruby
# frozen_string_literal: true

# ClkLog 神策数据格式最简上报客户端（Ruby 2.6+，仅标准库 net/http + base64 + json，生产可用骨架）。
#
# 规范文档：仓库根目录《数据上报规范与流程.md》§1（编码硬要求）、§2（事件结构）、§3（用户标识口径）。
#
# 要点：
# - 表单字段 data = JSON 数组 → base64 → urlencode；直接 POST 原始 JSON 会 200 但静默丢数据（§1.3）；
# - base64 必须用 Base64.strict_encode64：Base64.encode64 每 60 字符插入换行，会破坏 data 字段；
# - 事件名/属性键里的 `$` 必须写在**单引号**字符串里：双引号 "$SignUp" 会被当成全局变量插值成空串；
# - ClkLog 不解析神策顶层 login_id/original_id：登录ID 走 identities.user_key，
#   登录绑定匿名ID 走 properties.$track_signup_original_id（§3）。

require 'base64'
require 'json'
require 'net/http'
require 'uri'

DEFAULT_ENDPOINT = 'https://receiver-clklog.xyxverse.com/receiver/api/gp'
DEFAULT_PROJECT = 'clklogapp'
EVENT_NAME = 'SdkSpecTest'

# ClkLog 上报客户端：攒批 + 表单编码 + 超时 + 失败重试退避
class ClkLogClient
  # @param endpoint   [String]  上报地址
  # @param project    [String]  项目名
  # @param token      [String]  项目 token（禁止硬编码，见 AGENTS.md 红线 3）
  # @param batch_size [Integer] 攒批条数，达到即自动发送
  # @param timeout    [Integer] 单次 HTTP 超时（秒）
  def initialize(endpoint, project, token, batch_size: 10, timeout: 10, max_attempts: 3)
    @endpoint = endpoint
    @project = project
    @token = token
    @batch_size = batch_size.positive? ? batch_size : 10
    @timeout = timeout
    @max_attempts = max_attempts
    @queue = []          # 待发送事件
    @login_id = nil      # 登录ID，login 后自动携带到 identities.user_key
  end

  # 行为事件；登录后自动携带 identities.user_key
  def track(distinct_id, event, properties = {})
    enqueue(with_identity(
              'type' => 'track',
              'event' => event,
              'distinct_id' => distinct_id,
              'time' => now_ms, # 毫秒时间戳（秒级会时间错乱）
              'properties' => properties || {}
            ))
  end

  # 用户属性（覆盖写）；登录后自动携带 identities.user_key
  def profile_set(distinct_id, properties)
    enqueue(with_identity(
              'type' => 'user_set',
              'distinct_id' => distinct_id,
              'time' => now_ms,
              'properties' => properties || {}
            ))
  end

  # 登录关联：上报 track_signup 绑定匿名ID，之后事件自动带 user_key。
  # ClkLog 口径：identities.user_key=登录ID，properties.$track_signup_original_id=匿名ID。
  def login(login_id, anonymous_id)
    @login_id = login_id
    enqueue(
      'type' => 'track_signup',
      'event' => '$SignUp', # 单引号：双引号 "$SignUp" 会被插值成空串
      'distinct_id' => login_id,
      'identities' => { 'user_key' => login_id },
      'properties' => { '$track_signup_original_id' => anonymous_id },
      'time' => now_ms
    )
  end

  # 发送队列内全部事件：JSON 数组 → base64 → urlencode 表单 POST，失败重试退避
  def flush
    return if @queue.empty?

    payload = Base64.strict_encode64(JSON.generate(@queue))
    body = URI.encode_www_form('project' => @project, 'token' => @token, 'data' => payload)

    last_error = nil
    (1..@max_attempts).each do |attempt|
      begin
        response = post_form(body)
        if response.code.to_i == 200
          puts "[clklog] flushed #{@queue.size} events OK"
          @queue = []
          return
        end

        last_error = "http #{response.code}: #{response.body.to_s[0, 200]}"
      rescue StandardError => e
        last_error = "#{e.class}: #{e.message}"
      end
      sleep(attempt * 0.5) # 线性退避
    end
    raise "flush failed after #{@max_attempts} attempts: #{last_error}"
  end

  private

  def with_identity(event)
    event['identities'] = { 'user_key' => @login_id } unless @login_id.nil?
    event
  end

  def enqueue(event)
    @queue << event
    flush if @queue.size >= @batch_size
  end

  def now_ms
    (Time.now.to_f * 1000).to_i
  end

  # 每次重试新建连接（避免 keep-alive 连接在退避期间被服务端关闭）
  def post_form(body)
    uri = URI.parse(@endpoint)
    http = Net::HTTP.new(uri.host, uri.port)
    http.use_ssl = (uri.scheme == 'https')
    http.open_timeout = @timeout
    http.read_timeout = @timeout
    http.write_timeout = @timeout if http.respond_to?(:write_timeout=)
    request = Net::HTTP::Post.new(uri.request_uri)
    request['Content-Type'] = 'application/x-www-form-urlencoded'
    request['Accept'] = '*/*'
    request.body = body
    http.request(request)
  end
end

# 按需加载 ../.env（已存在的环境变量优先），仅取 CLKLOG_* 键
def load_dotenv
  candidates = [File.expand_path('../.env', __dir__), File.expand_path('.env', Dir.pwd)]
  candidates.each do |path|
    next unless File.file?(path)

    File.readlines(path, chomp: true).each do |raw|
      line = raw.strip
      next if line.empty? || line.start_with?('#') || !line.include?('=')

      key, value = line.split('=', 2).map(&:strip)
      value = value.gsub(/\A["']|["']\z/, '')
      ENV[key] = value if !key.to_s.empty? && ENV[key].to_s.empty?
    end
    puts "[clklog] loaded env from #{path}"
    return
  end
  puts '[clklog] .env not found, fallback to system env'
end

# ---------- 主流程 ----------
load_dotenv

# token 只从环境变量读取，禁止硬编码入库（AGENTS.md 红线 3）
token = ENV['CLKLOG_TOKEN'].to_s
if token.empty?
  warn 'missing env CLKLOG_TOKEN'
  exit 1
end
endpoint = ENV['CLKLOG_ENDPOINT'].to_s.empty? ? DEFAULT_ENDPOINT : ENV['CLKLOG_ENDPOINT']
project = ENV['CLKLOG_PROJECT'].to_s.empty? ? DEFAULT_PROJECT : ENV['CLKLOG_PROJECT']

run_id = "ruby-#{Time.now.to_i}"                     # <lang>-<unix 秒>
anon_id = "sdk-test-anon-#{run_id}"                  # 匿名ID（登录前，全程稳定）
login_id = "uid-ruby-#{run_id}"                      # 登录ID

cli = ClkLogClient.new(endpoint, project, token, batch_size: 10)

# 1. 登录前：匿名事件（不带 identities）
cli.track(anon_id, EVENT_NAME,
          'test_run_id' => run_id, 'sdk_lang' => 'ruby', 'step' => 'before_login')
# 2. 登录关联：之后所有事件自动携带 identities.user_key
cli.login(login_id, anon_id)
# 3. 用户属性（登录态）
cli.profile_set(anon_id,
                'vip_level' => 3, 'register_channel' => 'app_store', 'sdk_lang' => 'ruby')
# 4. 登录后行为事件：distinct_id 仍为匿名ID，登录ID走 identities.user_key
cli.track(anon_id, EVENT_NAME,
          'test_run_id' => run_id,
          'sdk_lang' => 'ruby',
          'amount' => 99.5,
          'is_new_user' => true,
          'product_id' => 'P1001',
          'product_name' => '测试商品')
# 5. 登录后购买事件
cli.track(anon_id, 'Purchase',
          'test_run_id' => run_id,
          'order_id' => "O#{run_id}",
          'amount' => 99.5,
          'pay_type' => 'alipay')

cli.flush
puts "DONE run_id = #{run_id}"
