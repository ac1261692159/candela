--[[
ClkLog Lua 上报示例（5 步事件链）—— 与 go/php/java/python/ruby/c/cpp/csharp 示例同一口径。

运行：
  cd examples/report-sdk/lua && lua report.lua            # 需要 luarocks 装好的 luasocket + luasec

验收（数据链路有 1–3 分钟延迟）：
  cd examples/report-sdk && ./verify.sh <run_id> --wait=300
]]

local clklog = require("clklog")

-- 读取 ../.env（已存在的环境变量优先；token 不入库、不打印）
-- 注意：标准 Lua 没有 os.setenv，所以 .env 读进内存表，再用 env() 取值。
local function load_dotenv()
  local values = {}
  for _, path in ipairs({ "../.env", "examples/report-sdk/.env" }) do
    local f = io.open(path, "r")
    if f then
      for raw_line in f:lines() do
        -- Lua 5.4+ 的 for 循环变量是 const，不能直接赋值，另起一个局部变量
        local line = raw_line:gsub("^%s+", ""):gsub("%s+$", "")
        if line ~= "" and not line:match("^#") then
          local k, v = line:match("^([%w_]+)=(.*)$")
          if k and v then values[k] = v end
        end
      end
      f:close()
      io.write("[clklog] loaded env from " .. path .. "\n")
      return values
    end
  end
  io.write("[clklog] .env not found, 使用系统环境变量\n")
  return values
end

local dotenv = load_dotenv()
local function env(name) -- 进程环境优先，其次 .env
  local v = os.getenv(name)
  if v == nil or v == "" then v = dotenv[name] end
  return v
end

local token = env("CLKLOG_TOKEN")
if not token or token == "" then
  io.stderr:write("缺少 token（环境变量 CLKLOG_TOKEN 或 examples/report-sdk/.env）\n")
  os.exit(1)
end

local client = clklog.new({
  endpoint = env("CLKLOG_ENDPOINT") or "https://receiver-clklog.xyxverse.com/receiver/api/gp",
  project = env("CLKLOG_PROJECT") or "clklogapp",
  token = token,
})

local run_id = "lua-" .. tostring(os.time())
local anon_id = "sdk-test-anon-" .. run_id
local login_id = "uid-lua-" .. run_id
local event_name = "SdkSpecTest"

-- Lua 客户端把 device_id 当作全程稳定的匿名ID
client.device_id = anon_id

-- ① 登录前：匿名事件
client:track(event_name, { test_run_id = run_id, sdk_lang = "lua", step = "before_login" })

-- ② 登录关联（track_signup 绑定匿名ID），之后事件自动携带 identities.user_key
client:login(login_id, anon_id)

-- ③ 用户属性（登录态）
client:profile_set({ vip_level = 3, register_channel = "app_store", sdk_lang = "lua" })

-- ④⑤ 登录后行为事件：distinct_id 仍为匿名ID
client:track(event_name, {
  test_run_id = run_id,
  sdk_lang = "lua",
  amount = 99.5,
  is_new_user = true,
  product_id = "P1001",
  product_name = "测试商品",
})
client:track("Purchase", {
  test_run_id = run_id,
  order_id = "O" .. run_id,
  amount = 99.5,
  pay_type = "alipay",
})

client:flush()

io.write("DONE run_id = " .. run_id .. "\n")
