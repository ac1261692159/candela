# 测试报告：Debug 实时查询（2026-10-08）

> 被测对象：`apps/analytics-web/src/features/meta/DebugQuery.tsx` + `apps/analytics-server/src/modules/meta/debug.{controller,service}.ts`
> 入口：`当时的线上入口/sa/meta/debug`（侧栏「Debug」）
> 生产版本 `.version` = 17602；`clklog_analytics_server` 运行中，`dist/src/modules/meta/debug.controller.js` 已在位（接口实测可用，非「产物旧、进程新」）。
> 结论：**功能可用、与 ClickHouse 直查逐行一致，但有一个展示错误（时间列 +8 小时）、一个计数误导、和一条「按设备/账号查」的重扫路径（user_key 会直接撞前端 60s 超时）。**

---

## 1. 方法与基线

- 数据侧基线：在 `生产主机` 上用只读账号直查 `clklog_sa.sa_events`（`project_name = 'clklogapp'`），与被测页面的结果逐行对拍。
- 界面侧：生产前端走真实浏览器操作（填表 → 点「查询」→ 读表格/分页/空态/错误提示），并核对实际请求 URL 与耗时（`performance` 资源项 + CH `system.query_log`）。
- 登录态：按仓库既有验收做法，用一次性 SQL 在 `sausertoken` 铸造 2 小时会话 token（账号 `admin`），测试后立即删除（见 §5）。
- 全程只读查询，未写入/删除任何业务数据。

## 2. 用例与结果

| # | 用例 | 输入 | 实测 | 判定 |
|---|---|---|---|---|
| 1 | 按事件名查询（低频） | `event=fish_open` | 4 行，与 CH 直查**逐行一致**（log_time / distinct_id / user_key 全同）；CH 侧读 28 万行、0.2–0.5s | ✅ |
| 2 | 单一命中 + properties 展开 | `event=pet_name_change` | 1 行（`样例标识`），展开行把 properties 格式化为缩进 JSON | ✅ |
| 3 | 按设备 ID 查询 | `distinct_id=样例标识`、条数 20 | 20 行，与 CH 前 20 行一致 | ✅（但慢，见 D3） |
| 4 | 按账号 ID 查询 | `user_key=样例标识`、条数 20 | **前端 60s 超时**，页面红条「请求超时。请缩小查询范围或稍后重试。」 | ❌ D3 |
| 5 | 无条件提交 | 三条件全空 | 前端红条「至少填写一个查询条件（distinct_id / user_key / 事件名）」；同形状直连接口返回 400 `meta.debug.conditionRequired` | ✅ |
| 6 | 无匹配空态 | `event=zz_no_such_event_zz` | 「无匹配数据（确认条件与最近 7 天内是否上报）」 | ✅ |
| 7 | 条数下限 | `limit=0` / `limit=-5` | 均回落为 1 条 | ✅ |
| 8 | 条数上限 | `limit=1000`（`room_created`，命中 385） | 返回 100 条、按 log_time DESC 有序 | ✅ |
| 9 | 7 天窗口 | `fish_open` 全量 12858 行 | 接口与界面只给出 7 天内的 4 行 | ✅ |
| 10 | 非法 limit | `limit=abc` | **HTTP 500**，响应 message 回显 ClickHouse 内部报错原文 | ❌ D4 |
| 11 | 时间列取值 | 用例 1/2/3/4 的同一批行 | 界面时间**比真实事件时间晚 8 小时** | ❌ D1 |

对拍样例（用例 2，唯一 1 行）：CH `log_time = 2026-10-01 12:13:51.790`；界面显示 `2026/10/01 20:13:51`。

## 3. 发现的问题

### D1 时间列整体 +8 小时（展示错误，影响排查判断）

- **机制**：`DebugQuery.tsx:108` 把 ClickHouse 的 naïve datetime 串按 UTC 解析
  （`formatDateTime(new Date(v.replace(' ', 'T') + 'Z'))`），而 `formatDateTime` 默认再按**平台时区**渲染，于是又加了 8 小时。
- **真相侧**：`log_time` 由采集侧写成「事件时刻在平台时区的墙钟」——
  `sa-event-flattener.service.ts:23` `formatChDateTimeMs(logTime, this.timezones.platformTz)`；
  平台时区实测 `Asia/Shanghai`（`GET /sa/api/auth/me` → `platform_timezone`）。
- **决定性证据**（实时流仍在写入，可排除「log_time 是 UTC」）：
  `gift_display_success` 存在 `log_time = 2026-10-08 10:03:19.750` 的行，而同一时刻 CH `now() = 2026-10-08 10:03:33`
  —— log_time 就是上海墙钟；按本页渲染逻辑，这条会被显示成 `18:03:19`（未来 8 小时）。
- **复现两条**：`event=pet_name_change`：CH 12:13:51.790 → 界面 20:13:51；
  `distinct_id=样例标识&limit=1`：最新行 CH 09:39:07 → 界面 `2026/10/08 17:39:07`（当时墙上时间 10:22）。
- **影响**：本页用途是「上报后立刻核对原始事件」，时间偏 8 小时会把「时间对不上」误导成 SDK/时区问题。
  修法方向：不要补 `Z`，按「平台时区墙钟」语义渲染（`formatDateTimeFixed` 一族或等价实现）；时间窗（7 天）本身不受影响，仍是 CH 侧 `now()` 计算。

### D2 分页「共 N 条」是「本次返回条数」而非命中总数（误导）

- **机制**：`DebugQuery.tsx:87` 的 `showTotal` 用的是 antd Table 本地 `dataSource` 长度，即 `items.length`；接口契约（`{ items }`）不带命中总数。
- **证据**：`distinct_id=样例标识` 在 7 天内真实命中 **27492** 行（CH `count()`），界面显示 **「共 20 条」**。
- **影响**：Debug 场景恰恰靠条数判断「数据到没到、到了多少」；把 27492 显示成 20 会让人误判上报量。
  修法方向（二选一）：后端在同条件下补 `count()`；或前端文案改为「显示最近 N 条」。

### D3 按 distinct_id / user_key 查询在全量数据上是重扫（可用性）

`sa_events` 排序键 `(event, stat_date, distinct_id, crc)`、分区键 `toYYYYMM(stat_date)`。缺少 `event` 前缀时，
7 天窗口只能全量读；实测（`system.query_log`，均为本页 SQL 形状）：

| 过滤条件 | 读行数 | CH 侧耗时 | 到界面 |
|---|---|---|---|
| `event=fish_open` | 28.7 万 | 0.12–0.51s | 秒级 ✅ |
| `distinct_id=样例标识` | 千万级行–千万级行 | 5.8–16.7s | 12–45s |
| `distinct_id=样例标识&limit=1` | 千万级行 | 47.7s | 45s ✅（等到就有） |
| `user_key=样例标识` | **亿级** | 68.6s | **60s 前端超时 ❌** |
| `event=base_ui_open_trigger&limit=1000`（超高频事件 + 大 limit） | 千万级行 | 66.8s → CH 拒 `160 TIMEOUT_EXCEEDED` | 无结果 ❌ |

- 前端 `axios` 超时是 60s（`apps/analytics-web/src/services/api.ts`），后端 `query.maxExecutionTime` 是 300s
  —— 也就是「服务端还在算、页面已经放弃」，用户看到的是超时而不是结果。
- 附带观察：本次并发探测期间，CH 出现过 2 次 `457 Too many simultaneous queries` 直接拒查（属并行施压所致，非页面自身行为），
  说明这类重扫并发几次就会互相挤压。
- **影响**：页面定位是「埋点接入验证」，最自然的入口就是「按 device_id / 账号 ID 查」——这条路径目前是几十秒级，账号维度直接不可用。

### D4 `limit` 非法值返回 500 并回显内部报错（接口健壮性）

- `debug.controller.ts:33` 直接 `parseInt(limit, 10)` 不校验；`debug.service.ts:20` 的 clamp 对 `NaN` 不生效（`Math.min/max` 遇 `NaN` 仍是 `NaN`）。
- 实测 `limit=abc` → **HTTP 500**，响应 message 原文即 ClickHouse 报错：
  `Value nan cannot be parsed as UInt32 for query parameter 'limit' ...`。
- 影响面小（界面 InputNumber 产不出该值），但直连接口可打到；应为 400（或回落到默认值），且不应把 CH 内部文本外泄给前端。

### D5（旁证，非本次范围）裸域名打开是白屏

`当时的线上入口/` 打开后 `#root` 为空、无任何可见内容（资源均加载成功），`/sa/` 才正常跳登录
——前端 `base: '/sa/'`，根路径没有可匹配路由。是否要修取决于是否希望裸域名可浏览（现有引用主要是 API 用途，见 `docs/project/legacy-production-handover.md`）。

## 4. 未覆盖

| 项 | 说明 |
|---|---|
| 跨项目查询 | 全程用 `clklogapp`；其它项目的 `project_name` 过滤行为未复测 |
| 其它语言 | 只读了 zh-CN 文案 |
| 弱网 / 重试 / 并发多用户 | 未模拟；D3 的并发拒查只观察到我方并行探测 |
| 未来时间戳数据 | 库内确有少量 `log_time` 超前于 `now()` 的行（上报端时钟偏差），本次未单列用例 |

## 5. 清理（已完成）

| 项 | 处置 |
|---|---|
| 临时会话 token | 已从 `sausertoken` 删除（`deleteMany` 命中 1 行，删后复查该 token 不存在） |
| 临时脚本 | 服务器 `/tmp/zz_*.js` 与本机 `/tmp/zz_mint_token.js` 已删除 |
| 业务数据 | 未做任何写入/删除；只读查询 |
| 菜单/页面状态 | 浏览器标签停在 `/sa/meta/debug`（会话 token 已删，页面下次刷新即退出登录） |
