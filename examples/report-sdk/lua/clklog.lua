--[[
ClkLog 上报客户端（Lua 5.4+/5.5，依赖 luasocket + luasec 做 HTTPS）

适用场景
  - 服务端脚本 / 定时任务上报业务事件（订单、支付、注册）；
  - OpenResty / lua-resty 场景：**只需替换传输层**——把 `Client:post()` 里的 `ssl.https.request`
    换成 `resty.http` 或 `ngx.location.capture`，协议、编码、队列逻辑完全不变（OpenResty 自带
    LuaJIT 与 cosocket，不需要 luasocket/luasec）。

依赖安装（本机 macOS 实测）
  brew install lua luarocks
  luarocks install luasocket
  luarocks install luasec OPENSSL_DIR="$(brew --prefix openssl@3)"

协议（见根目录《数据上报规范与流程.md》§1–§3）
  POST 表单：project / token / data；data = base64(JSON 数组) → urlencode
  ⚠️ 直接 POST 原始 JSON 会 HTTP 200 但静默丢数据；base64 必须单行；
     表单里的 + / = 必须百分号编码（漏掉 + 会被服务端解码成空格）。
  用户标识：登录ID 走顶层 identities.user_key；绑定匿名ID 走 properties.$track_signup_original_id。

token 从环境变量读（CLKLOG_TOKEN），禁止硬编码入库（AGENTS.md 红线 3）。
]]

local https = require("ssl.https")
local ltn12 = require("ltn12")

local M = {}

M.VERSION = "1.0.0"

-- ---------------------------------------------------------------- JSON 编码

-- 空表在 Lua 里既有可能是对象也有可能是数组，显式标记一下（properties 必须是 {} 而不是 []）。
local function as_object(t)
  return setmetatable(t or {}, { __clklog_object = true })
end
local function as_array(t)
  return setmetatable(t or {}, { __clklog_array = true })
end
M.object = as_object
M.array = as_array

local escapes = { ['"'] = '\\"', ['\\'] = '\\\\', ['\b'] = '\\b', ['\f'] = '\\f', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t' }
local function encode_string(s)
  -- 控制字符转义，>= 0x80 的字节按 UTF-8 原样透传（中文属性值不被破坏）
  return '"' .. s:gsub('[%z\1-\31\\"]', function(c)
    return escapes[c] or string.format('\\u%04x', c:byte())
  end) .. '"'
end

local function encode_number(n)
  if n == math.floor(n) and math.abs(n) < 1e15 then
    return string.format("%d", n)
  end
  return string.format("%.14g", n)
end

local encode -- 前置声明（递归）

local function is_array(t)
  if getmetatable(t) and getmetatable(t).__clklog_array then return true end
  if getmetatable(t) and getmetatable(t).__clklog_object then return false end
  local n = #t
  if n == 0 then return false end -- 空表默认按对象走，需要数组请用 M.array{}
  for k in pairs(t) do
    if type(k) ~= "number" then return false end
  end
  return true
end

encode = function(v)
  local t = type(v)
  if v == nil then return "null" end
  if t == "boolean" then return v and "true" or "false" end
  if t == "number" then return encode_number(v) end
  if t == "string" then return encode_string(v) end
  if t == "table" then
    local out = {}
    if is_array(v) then
      for i = 1, #v do out[i] = encode(v[i]) end
      return "[" .. table.concat(out, ",") .. "]"
    end
    local keys = {}
    for k in pairs(v) do keys[#keys + 1] = k end
    table.sort(keys)
    for i, k in ipairs(keys) do
      out[i] = encode_string(tostring(k)) .. ":" .. encode(v[k])
    end
    return "{" .. table.concat(out, ",") .. "}"
  end
  error("无法编码的类型: " .. t)
end
M.json_encode = encode

-- ---------------------------------------------------------------- base64

local b64chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

--- 标准 base64，**单行输出不换行**（luasocket 的 mime.b64 会按 76 字符折行，不能用于表单）
function M.base64(data)
  local out, n = {}, 0
  local byte, sub, rep, char = string.byte, string.sub, string.rep, string.char
  for i = 1, #data, 3 do
    local a, b, c = byte(data, i, i + 2)
    local triple = (a or 0) * 65536 + (b or 0) * 256 + (c or 0)
    local e1 = math.floor(triple / 262144) % 64
    local e2 = math.floor(triple / 4096) % 64
    local e3 = math.floor(triple / 64) % 64
    local e4 = triple % 64
    n = n + 1
    out[n] = sub(b64chars, e1 + 1, e1 + 1) .. sub(b64chars, e2 + 1, e2 + 1)
    if b then out[n] = out[n] .. sub(b64chars, e3 + 1, e3 + 1) else out[n] = out[n] .. "=" end
    if c then out[n] = out[n] .. sub(b64chars, e4 + 1, e4 + 1) else out[n] = out[n] .. "=" end
  end
  local s = table.concat(out)
  assert(not s:find("[\r\n]"), "base64 必须是单行")
  return s
end

--- RFC3986 百分号编码：除 unreserved 外全部编码（含 base64 的 + / =）
function M.url_encode(s)
  return (s:gsub("[^A-Za-z0-9%-%_%.%~]", function(c)
    return string.format("%%%02X", string.byte(c))
  end))
end

-- ---------------------------------------------------------------- 传输

local function default_cainfo()
  for _, p in ipairs({ "/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt" }) do
    local f = io.open(p, "r")
    if f then f:close() return p end
  end
  return nil
end

--- 返回 response_body, http_code（网络层失败返回 nil, 错误串）
function M.post_form(endpoint, fields, timeout)
  local parts = {}
  for k, v in pairs(fields) do
    parts[#parts + 1] = M.url_encode(k) .. "=" .. M.url_encode(v)
  end
  local body = table.concat(parts, "&")
  local chunks = {}
  local params = {
    url = endpoint,
    method = "POST",
    headers = {
      ["Content-Type"] = "application/x-www-form-urlencoded",
      ["Content-Length"] = tostring(#body),
      ["User-Agent"] = "clklog-lua/" .. M.VERSION,
    },
    source = ltn12.source.string(body),
    sink = ltn12.sink.table(chunks),
    timeout = timeout or 10,
    -- 证书校验（luasec 默认不校验证书，必须显式打开，用系统 CA 包）
    -- 协议版本交给 luasec 协商（默认 any）；显式写 "tlsv12" 是错的，luasec 只认带下划线的 "tlsv1_2"
  }
  local ok, r1, r2, r3, r4 = pcall(function()
    local cainfo = default_cainfo()
    local p = {}
    for k, v in pairs(params) do p[k] = v end
    if cainfo then
      p.cafile = cainfo
      p.verify = "peer"
    else
      p.verify = "none"
    end
    return https.request(p)
  end)
  if not ok then return nil, nil, tostring(r1) end
  -- luasec 成功返回 1, code, headers, status；传输层失败返回 nil, err
  if r1 == nil then return nil, nil, tostring(r2) end
  local code = type(r2) == "number" and r2 or (type(r1) == "number" and r1 or nil)
  local status = (type(r4) == "string" and r4) or (type(r3) == "string" and r3) or nil
  return table.concat(chunks), code, status
end

--- 毫秒时间戳：socket.gettime() 有亚秒精度；取不到 luasocket 时退回 os.time()（秒级，会导致时间列偏差）
function M.now_ms()
  local ok, socket = pcall(require, "socket")
  if ok and socket.gettime then
    return math.floor(socket.gettime() * 1000)
  end
  return os.time() * 1000
end


-- ---------------------------------------------------------------- 客户端

local Client = {}
Client.__index = Client

--- new{endpoint=, project=, token=, batch_size=, flush_interval=, max_attempts=}
function M.new(opts)
  assert(opts and opts.token and opts.token ~= "", "缺少 token（从环境变量 CLKLOG_TOKEN 注入，勿硬编码）")
  return setmetatable({
    endpoint = opts.endpoint or "https://receiver-clklog.xyxverse.com/receiver/api/gp",
    project = opts.project or "clklogapp",
    token = opts.token,
    batch_size = opts.batch_size or 10,
    max_attempts = opts.max_attempts or 3,
    timeout = opts.timeout or 10,
    queue = {},
    user_key = nil,
    device_id = opts.device_id or ("lua-" .. tostring(os.time()) .. "-" .. tostring(math.random(100000, 999999))),
    lib = opts.lib or "lua",
    lib_version = opts.lib_version or M.VERSION,
  }, Client)
end

function Client:distinct_id()
  return self.device_id
end

--- 登录：记录 user_key，并上报 track_signup 绑定匿名ID（$SignUp）
function Client:login(user_key, anon_id)
  local prev = self.user_key
  self.user_key = user_key
  local props = as_object({ ["$track_signup_original_id"] = anon_id or self.device_id })
  self:enqueue({
    type = "track_signup",
    event = "$SignUp",
    distinct_id = user_key,
    time = M.now_ms(),
    identities = as_object({ user_key = user_key }),
    lib = as_object({ ["$lib"] = self.lib, ["$lib_version"] = self.lib_version }),
    properties = props,
  })
  return prev
end

function Client:logout()
  self.user_key = nil
end

function Client:track(event_name, props, distinct_id)
  self:enqueue({
    type = "track",
    event = event_name,
    distinct_id = distinct_id or self.device_id,
    time = M.now_ms(),
    identities = self.user_key and as_object({ user_key = self.user_key }) or nil,
    lib = as_object({ ["$lib"] = self.lib, ["$lib_version"] = self.lib_version }),
    properties = as_object(props),
  })
end

function Client:profile_set(props, distinct_id)
  self:enqueue({
    type = "user_set",
    distinct_id = distinct_id or self.device_id,
    time = M.now_ms(),
    identities = self.user_key and as_object({ user_key = self.user_key }) or nil,
    lib = as_object({ ["$lib"] = self.lib, ["$lib_version"] = self.lib_version }),
    properties = as_object(props),
  })
end

function Client:enqueue(event)
  self.queue[#self.queue + 1] = event
  if #self.queue >= self.batch_size then
    self:flush()
  end
end

--- 发送队列（失败按下标退避重试；只有 HTTP 200 才清队列）
function Client:flush()
  if #self.queue == 0 then return true end
  local batch = as_array({})
  for i, e in ipairs(self.queue) do batch[i] = e end
  local data = M.base64(encode(batch))
  local fields = { project = self.project, token = self.token, data = data }

  local last_err
  for attempt = 1, self.max_attempts do
    local body, code, err = M.post_form(self.endpoint, fields, self.timeout)
    if code == 200 then
      io.write(string.format("[clklog] flushed %d events OK\n", #self.queue))
      self.queue = {}
      return true
    end
    last_err = err or ("http " .. tostring(code) .. ": " .. tostring(body))
    if attempt < self.max_attempts then
      local backoff = 0.5 * (2 ^ (attempt - 1))
      io.write(string.format("[clklog] 第 %d 次失败（%s），%.1fs 后重试\n", attempt, tostring(last_err), backoff))
      -- 无 socket.sleep 依赖的简单等待（luasocket 可用时更精确）
      local ok_socket, socket = pcall(require, "socket")
      if ok_socket and socket.sleep then socket.sleep(backoff) end
    end
  end
  io.write(string.format("[clklog] flush 失败（%s），%d 条留在队列里待补发\n", tostring(last_err), #self.queue))
  return false
end

return M
