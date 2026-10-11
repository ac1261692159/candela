# 验收记录：自定义 SQL 折线图双 Y 轴 v1

> phase: `clklog-analytics-sql-dual-axis-v1`
> 验收日期：2026-09-24
> 对应 PRD：`docs/product/prd-clklog-analytics-sql-dual-axis-v1.md`
> 对应架构设计：`docs/architecture/clklog-analytics-design-sql-dual-axis-v1.md`
> 状态：**已发版并在生产环境完成验收**

---

## 1. 背景：这是一次「补另一半」

使用者问「能否给自定义 SQL 和事件分析都加双 Y 轴」。查下来：

- **事件分析侧早已完成**（`clklog-analytics-event-chart-binding-v1`）：左右轴归属、每指标单位、量级差异自动建议，已上线并实测。
- **自定义 SQL 侧是「契约早就通了、渲染与 UI 没接」**：`options.metric_axis` 在前后端校验器白名单里且不按域收窄，SQL 卡今天就能存下它并通过校验，只是画图时被忽略；每指标单位也早已支持。

所以本 phase 的实际范围只有两块：两个 adapter 加轴、字段面板放开控件。

---

## 2. 发版记录

| 项 | 值 |
|---|---|
| 变更提交 | `ffee1ef` |
| CI 流水线 | **17576**（当前生产版本） |
| 发版前生产版本 | 17563 |
| 升级方式 | `scripts/server-upgrade.sh`（纯前端 + 无服务端改动，未触碰 Harness，故不跑 `install-harness-runtime.sh`） |
| 部署核验 | `.version`=17576；`supervisorctl status`=RUNNING；前端产物时间 `2026-09-24 11:24:52` 与本次构建一致 |

---

## 3. 本地验收

| 检查 | 结果 |
|---|---|
| `python3 scripts/arch_ratchet.py` | passed |
| `python3 scripts/i18n_check.py` | 通过：13 语言 × 16 命名空间，3753 条键（**未新增文案**，复用了事件侧已有的 `analysis:field.axis*`） |
| `python3 scripts/i18n_scan.py --check` | 通过：1401 处（基线未动） |
| 前端 `vitest` | `visualization` 15 文件 / 124 用例、`visualization+report+Report 页面` 31 文件 / 178 用例，全通过 |
| `tsc` + `vite build` | 通过 |

新增/扩充用例：

- `adapters/line.adapter.spec.ts`（**新建**，此前该 adapter 没有单测）6 项：单轴形状与边距不变、双轴数组与 `yAxisIndex`、右轴边距、左右轴各自单位、未绘制指标不逼出第二条轴、全右轴时左轴不被钉在 0..0
- `adapters/trend.adapter.spec.ts` +4 项：同上，另加预测段/拟合段跟主系列同轴
- `FieldBindingPanel.spec.tsx` +2 项：折线/趋势出现轴下拉、柱/饼不出现；改轴归属经「应用配置」写入 `options.metric_axis`

---

## 4. 生产验收（浏览器实测）

验收对象：生产 `/sa/report/sql`，查询 `SELECT toDate(log_time) AS d, count() AS 事件量, uniqExact(...) AS 用户数 ... GROUP BY d`（7 天，事件量 4.5–5.6 万 / 用户数 1.1–1.5 万）。

| AC | 结果 | 证据 |
|---|---|---|
| AC1 单轴行为不变 | ✅（单测） | `yAxis` 仍是对象、`grid.right` 仍是 16、系列无 `yAxisIndex`；单轴分支刻意保留改造前的原表达式 |
| AC2 双轴产出两条轴 | ✅ | 把「用户数」设为右轴后，图上出现左右两条刻度轴：左 4.6万–5.57万、右 1万–1.5万 |
| AC3 右轴刻度不被裁 | ✅ | 右轴刻度标签完整可见（`grid.right` 放宽到 48） |
| AC4 两轴各按所属单位 | ✅（单测） | 右轴指标设 `percent_0_100` 后右轴 formatter 含 `%`、左轴不含 |
| AC5 tooltip 按系列单位 | ✅（既有用例） | 未回归 |
| AC6 控件只在折线族出现 | ✅ | SQL 折线图字段设置里出现 `轴 · 事件量`、`轴 · 用户数`；柱/饼图不出现（单测断言） |
| AC7 走「应用配置」生效 | ✅ | 面板内改轴归属后图表即变（`layout='settings'` 属即时生效路径），并已进入待保存配置 |
| AC8 门禁与构建 | ✅ | 见 §3 |

**一个顺带观察到的改善**：双轴后左轴起点从 0 变成 4.6 万。原因是 min/max 现在**只按左轴自己的指标**算——单轴时它取的是全部指标的极值（含 1 万那个），把两条线都压在上半区；这正是双轴要解决的问题，也说明「min/max 只给左轴」这个决定是对的。

---

## 5. 未覆盖 / 非目标

| 项 | 说明 |
|---|---|
| 柱状 / 条形 / 饼图 / 数值卡的轴归属 | 本期不做。这些 adapter 还不读 `metric_axis`，**因此控件也不显示**，避免「能设但不生效」 |
| 量级差异自动建议（对应事件侧那条建议条） | 不做。`axis-suggest.ts` 现在在 `features/event-chart/`，SQL 侧引用会形成 `visualization → event-chart` 反向依赖；要用得先迁到中性位置并拆 `features/visualization/`（越 80% 线），单独排期 |
| 双轴 + 趋势图预测段的线上实测 | 单测覆盖（预测段与拟合段带正确 `yAxisIndex`），未在线上造趋势图验证 |
| 保存卡片后的复现 | 未实测；`metric_axis` 走既有 `chart_config` 持久化路径，与事件侧同构 |

---

## 6. 与事件侧的一致性

| 语义 | 事件侧 | SQL 侧（本期） |
|---|---|---|
| 何时产生第二条轴 | 任一系列 `axis === 'right'` | 任一**参与绘制**的指标为 `right`（绑定 series 时只看第一个） |
| 轴单位 | 该轴第一条系列的单位 | 该轴第一个指标的单位 |
| 全左轴时 | 输出单轴对象 | 同 |
| 右边距 | 双轴 48 / 单轴 16 | 同 |
| min/max | 只给左轴 | 只给左轴，且双轴时只按左轴指标算 |

两侧现在是**同一份 `ChartConfigV1` 契约 + 同一套语义**，差别只剩渲染器（事件侧 `explore-charts`、SQL 侧 `adapters/*`）——这也让「phase 2 收敛两条渲染链路」这件事更容易做。
