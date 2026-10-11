# 验收记录：事件分析图表字段绑定与显示优化 v1

> phase: `clklog-analytics-event-chart-binding-v1`
> 验收日期：2026-09-23
> 对应 PRD：`docs/product/prd-clklog-analytics-event-chart-binding-v1.md`
> 对应架构设计：`docs/architecture/clklog-analytics-design-event-chart-binding-v1.md`
> 状态：**已发版并在生产环境完成验收**；本 phase 引入的一处线上回归已在验收中发现、修复并复验

---

## 1. 验收范围

让事件分析的图表拥有与自定义 SQL 同级的字段级显示控制（X 轴 / 拆分系列 / 指标 / 每指标单位 / 轴归属 / 列角色），
修掉三个既有显示缺陷（多指标量级差异被压平、第二个分组列被丢弃、长维度标签重叠裁切），并把事件侧展示配置
收敛到与 SQL 卡同一份 `dsl.chart_config: ChartConfigV1`。

不做：不改查询语义、不收敛两套 option builder、不改漏斗与留存、不做 dataZoom、不复用 SQL 的条形/环形图型。

---

## 2. 发版记录

| 项 | 值 |
|---|---|
| 变更提交 | `fe7d325` feat(analytics) 主体；`3e2c708` fix(ci) 单测隔离配置模块；`1386cbe` fix(analytics) 线上回归修复 |
| CI 流水线 | 17547（feat + ci 修复）→ **17548**（回归修复，当前生产版本） |
| 发版前生产版本 | 17535 |
| 升级方式 | `scripts/server-upgrade.sh`（经 2223 隧道 stdin 执行）；rsync + `prisma migrate deploy`（无待执行迁移）+ 重启 `clklog_analytics_server` |
| 部署核验 | `.version` = 17548；`supervisorctl status` = RUNNING；`server/dist/.../event-query.service.js` 含 `eventGroupRole`；前端新增 chunk `event-binding-*.js`、`FieldBindingPanel-*.js`、`EventAnalysisPage-*.js` |

⚠️ **首次升级时踩到的坑（值得记进发版流程）**：`server-upgrade.sh` 的 rsync 输出会被后续输出淹没，
用 `| head -20` 之类的管道观察会把 rsync 提前 SIGPIPE 掉、同步不完整而**不报错**；紧接着的
`supervisorctl restart` 仍会成功，于是服务按旧产物重启。核对方式：rsync 结束后直接 `grep` 目标文件里的新符号，
不要只看 `.version` 与 supervisor 状态。

---

## 3. 本地验收

| 检查 | 结果 |
|---|---|
| `python3 scripts/arch_ratchet.py` | passed（`features/event-chart/` 新增 4 个生产文件；`features/query/`、`features/visualization/` 零新增文件） |
| `python3 scripts/i18n_check.py` | 通过：13 语言 × 16 命名空间，3746 条键 |
| `python3 scripts/i18n_scan.py --check` | 通过：1390 处（基线 1390，本轮 `--force` +3，原因见设计文档 §12.2） |
| 后端 `jest`（CI 条件：清空四个密钥变量 + `APP_CONFIG_PATH` 指向不存在文件 + `--runInBand`） | 118 套件 / 894 用例通过 |
| 前端 `vitest` 受影响域 | 52 文件 / 275 用例通过（含 `features/event-chart/` 32 用例） |
| 两端构建 | `nest build`、`tsc && vite build` 均通过 |

---

## 4. 生产验收（浏览器实测，真实数据）

验收对象：生产 `当时的线上入口`，项目内 69 张卡片中的既有事件卡。

| AC | 结果 | 证据（生产实测） |
|---|---|---|
| AC1 列 role | ✅ | 字段面板的列角色来自服务端下发；卡片刷新响应里列带 `"role":"time"` |
| AC2 字段区 | ✅ | 既有卡「DAU 和 付费率」打开后字段区完整：X 轴=时间(day)、系列（不拆分）、指标=DAU/付费人数/付费率、每指标单位、每指标轴、列角色、恢复自动、应用配置 |
| AC3 双轴 | ✅ | 点「应用」后出现左右两条刻度轴：左 0–1.2万（DAU）、右 0–0.0012（付费率）；`付费率` 从此前贴基线的平线变为清晰可见的日间波动 |
| AC4 建议条 | ✅ | 真实数据自动给出「指标量级差异 **8508×**，建议把 付费率 拆到右轴」；点「应用」才写配置 |
| AC5 长标签 | ✅ | 单测锁定四档策略；本地实测维度轴标签不重叠不出界 |
| AC6 不重查 | ✅ | 点「应用」时页面内 `fetch` 钩子记录的 `/sa/api/query/` 请求数 = **0** |
| AC7 持久化 | ✅ | 本地实测：保存卡片 → 读回 `dsl.chart_config` 含 `metric_axis:{m_1:'right'}` → 重载重开 → 看板卡片均复现双轴 |
| AC8 旧卡一致 | ⚠️ **先失败后修复** | 见 §5；修复后 69 张卡片全量核对无空态 |
| AC9 透视 | ✅ | `event-binding.spec.ts` 11 项（矩阵、求和合并、超限截断、时间/维度排序） |
| AC10 域白名单 | ✅ | `test/report/chart-config.validator.spec.ts` 含两域逐项等价对比 |
| AC11 i18n | ✅ | 命令输出见 §3 |
| AC12 棘轮 | ✅ | 命令输出见 §3 |
| AC13 多语言 UI | ✅ | 生产 `?lang=en-US`：`<html lang>="en-US"`、UI 全英文；残留中文仅为**用户自建指标名**（付费人数 / 付费率），按硬门禁 24 不应翻译 |

**验收无副作用**：全程未点「覆盖保存」。验收后读回卡片 `card_uWhOsaDGti` 确认
`has_chart_config: false`、`updated_at` 仍是 `2026-09-11`（未被改写）。

**生产回归面**：核心数据看板 11 张卡片缓存全部 `error: null`，刷新时间横跨部署前后；
留存表、SQL 趋势卡（含预测线）、事件折线卡均正常渲染。

---

## 5. 验收发现并修复的回归（AC8 先失败）

**现象**：核心数据看板上「DAU-DNU-DOU(今日)」与「近一个月核心数据」两张卡，从改版前的有数据
变成「当前时间范围内暂无数据」。

**根因**：两张卡都是 `chart_type='number'` + `groups=[]`（结果里只有指标列，没有时间/维度列）。
`ExploreChart` 在 `categories` 为空时渲染空态；改造前 `x = groups[0] ?? columns[0]` 正好兜住这种卡片，
而新写的自动绑定只找「时间列 → 维度列」，找不到就把 `bindings.x` 留空。

**修法**：补回 `?? 可用列[0]`（提交 `1386cbe`），与改造前的回退一致。数值卡的图只画 series，
X 轴取什么不影响显示，因此这是纯粹的行为恢复。

**影响面**：全量核对生产 69 张卡片，仅这 2 张，均为数值卡。

**复验**：升级到 17548 后硬刷新看板，空态从 2 处降为 **0 处**；
两张卡恢复为数值卡（DAU 4.48K / DNU 414 / DOU 4.07K / 支付成功次数 1 / 充值金额 $99 / 平均游戏时长 25.84 分钟；
月充值总额 $34.61K）。

> 这条回归说明：自动绑定的**兜底链必须与改造前逐级等价**，任何一级缺失都会让某类旧卡从「有图」变「空态」，
> 而单测当时的用例全部带分组，覆盖不到无分组形状。

---

## 6. 遗留

| 项 | 说明 |
|---|---|
| ECB-03（`CODE_HANDOVER.md`） | 「拆分系列 + 双轴 + 系列级截断」三者组合仍只有单测覆盖，未做线上实测 |
| ECB-01（`CODE_HANDOVER.md`） | `features/visualization → features/explore-charts` 依赖倒挂，本 phase 仅登记 |
| dataZoom | 分类数过多时的缩放未做（PRD 非目标 7） |
| SQL 侧双轴 | 本 phase 只在事件侧生效；SQL 侧接入需先拆 `features/visualization/` |
