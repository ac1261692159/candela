# 验收记录：自定义 SQL 结果可视化图表体系 v1

> phase: `clklog-analytics-charts-v1`
> 验收日期：2026-09-03
> 对应 PRD：`docs/product/prd-clklog-analytics-charts-v1.md`
> 对应架构设计：`docs/architecture/clklog-analytics-design-charts-v1.md`
> 状态：本地实现与单测已通过；生产只读回归与浏览器 E2E 待部署后补证据

---

## 1. 验收范围

在不改变 ClickHouse 查询与安全链路的前提下，为 SQL/Builder 结果提供独立于 `g_`/`m_` 的可视化内核：列画像、唯一推荐、兼容校验、字段绑定、漏斗行选择、配置保存与看板只读复现。

本阶段明确不做：堆叠柱/热力/散点、留存矩阵、看板内编辑、任意 ECharts option 持久化、SQL 守卫与社区版表改动。

---

## 2. 本地环境与命令

| 检查 | 结果 |
|---|---|
| `apps/analytics-web` `npm test -- --run` | 15 files / 61 tests 通过（含 jsdom 组件测试） |
| `apps/analytics-web` `npm run build`（tsc + vite） | 通过 |
| `apps/analytics-server` `jest` chart_config / sql-report.service | 7 tests 通过 |
| `apps/analytics-server` `nest build` | 通过 |
| `python3 scripts/arch_ratchet.py` | passed |
| `npm run lint` | 前后端仓库均无 ESLint 配置文件（既有问题，非本 phase 引入） |

未部署到 生产主机。未修改 SQL 守卫、项目过滤、时间限制、ClickHouse 表和数据。

---

## 3. 产品验收（CHART-AC01..36）

| ID | 结果 | 证据 |
|---|---|---|
| AC01 | 本地通过 | 自由 SQL 列无 `g_`/`m_` 仍可出图；事件分析仍走 `ChartRenderer` |
| AC02–AC08 | 本地通过 | `chart-recommender.spec.ts`、`column-profiler.spec.ts`、`production-shapes.spec.ts` |
| AC09–AC14 | 组件测试通过；浏览器主流程待补 | `ChartWorkbench.spec.tsx`、`FieldBindingPanel.spec.tsx`、`QueryResultPanel.spec.tsx` |
| AC15–AC19 | 本地通过（漏斗算法） | `funnel.adapter.spec.ts`：顺序、UV/PV、多行必选、非单调 |
| AC20–AC24 | 组件测试通过；生产看板复现待补 | `SqlReportPage.chart-config.spec.tsx`、`CardWidget.sql-chart.spec.tsx`；新查询可靠推荐默认进图，旧卡无配置仍表格 |
| AC25 | 实现已接入 | 虚拟表 >200 行；>10000 行 `TOO_MANY_ROWS` 不抽样 |
| AC26–AC30 | 实现已接入，960px/200%/读屏待浏览器补 | 结果区 240px–70vh、全屏、ARIA 摘要、reduced-motion |
| AC31 | 部分完成 | 形状 fixture + 下方 45 卡清单；生产 execute 列形状待只读回归填实 |
| AC32 | 本地通过 | profiler / recommender / compatibility / data / funnel / config / workbench |
| AC33 | 本地通过 | save/update/null/非法拒绝/坏 JSON 不 500 |
| AC34 | 本地通过（build/test）；lint 无配置 | 见 §2 |
| AC35 | 通过 | 棘轮 passed；未扩大 `common`/`shared`/`utils` |
| AC36 | 未做 | 需生产只读 execute + 看板复现 |

---

## 4. 架构验收（ARCH-CHART-01..12）

| ID | 结果 |
|---|---|
| 01 纯函数内核 | 通过：`column-profiler` / compatibility / recommender / data 无 React、无网络、无 `process.env` |
| 02 不依赖 `g_`/`m_` | 通过；旧 `ChartRenderer` 保留 |
| 03 唯一推荐 | 通过 |
| 04 NULL/不补桶/不二次聚合 | 通过 |
| 05 多行漏斗 | 通过：无 selector 不生成 series |
| 06 白名单配置 | 通过：服务端拒绝 option/脚本/危险 key |
| 07 保存复现 | 代码闭环已接；生产复现待补 |
| 08 失效回退 | 通过：`STALE_CONFIG` / `UNSUPPORTED_CONFIG_VERSION` |
| 09 点数上限 | 通过：不静默采样 |
| 10 同一内核 | 通过：分析页与看板共用 `resolveVisualization` |
| 11 测试覆盖 | 纯函数 + §14.2 组件测试已齐；E2E/45 卡生产形状待补 |
| 12 build/test/ratchet | 通过 |

---

## 5. 45 张生产 SQL 卡形状清单（CHART-AC31）

来源：`docs/project/sql-card-audit-clklog-dashboard-sql-cards-v1.md` 的 card id / 名称 / 行数。本表只记录**期望默认视图与禁止行为**，不含 SQL 全文和筛选值。列形状以分析页/看板只读 execute 为准，部署后逐张填「实测列」。

规则：漏斗多行必须选分组，禁止取首行或跨行累加 UV/比率；`error_code`/`场景ID` 不得仅因数值类型当指标；饼图不作为默认。

| card_id | 名称 | 行数 | 期望默认 | 禁止 |
|---|---|---:|---|---|
| `card_VSlfGuJliw` | 按日充值趋势 | 8 | 折线 | 不补时间桶 |
| `card_XUyQQ1Ad01` | 充值总体漏斗 | 10 | 漏斗或待选行 | 不跨行加 UV |
| `card_Jykhk7S4KI` | 购买→抽卡→展示漏斗 | 6 | 漏斗或待选行 | 同上 |
| `card_fbn9b08Zg2` | 用户群体×场景参与率 | 2 | 表/柱，视列角色 | 不把比率当可加饼 |
| `card_cbz1G3NksC` | 按日送礼趋势 | 7 | 折线 | 不补桶 |
| `card_Nmv3R2xSTT` | 按礼物 ID 漏斗 | 50 | 漏斗+选行 | 不取首行、不加总 UV |
| `card_R3NIYo1i9T` | 礼物总体漏斗 | 8 | 漏斗或待选行 | 不跨行加 UV |
| `card_1XataTnpgn` | 游戏 ID 漏斗 | 14 | 漏斗+选行或柱 | ID 不当默认指标 |
| `card_zo2SbGQ1AY` | 动作使用总览 | 2 | 指标卡或表 | 不跨行加 UV |
| `card_PB1NIhDZAo` | 按场景动作排行 | 30 | 柱/条 + Top20 | 不默认饼 |
| `card_XMmhupmXcb` | 动作使用深度分布 | 6 | 柱 | 占比不默认饼 |
| `card_KPH5SLpRH2` | 按日按钮点击趋势 | 8 | 折线 | 混合单位不同轴 |
| `card_STFwtqf-Gu` | 场景×按钮点击率 | 50 | 表/透视 | 不默认漏斗 |
| `card_W8HhVCs_Ms` | 社交关系链汇总 | 3 | 指标卡或表 | 不跨行加 UV |
| `card_cU4KXxfhdI` | 社交渗透率总览 | 6 | 表/指标卡 | 渗透率不可加 |
| `card_PsAZ_RAqKs` | 大赛投票参与 | 0 | 空状态 | — |
| `card_NMVIf5A5bh` | UGC 加载成功率 | 7 | 折线或表 | 成功率不默认饼 |
| `card_rRgV1OEDi5` | 按日创作漏斗 | 7 | 折线或漏斗 | 不跨行加 UV |
| `card_8u_faByjop` | 按日动态发布趋势 | 8 | 折线 | 不补桶 |
| `card_HzmImKitc-` | 动态发布率总览 | 7 | 表/指标卡 | 发布率不可加 |
| `card_Pcw3tsfkLj` | 主界面功能入口 | 30 | 柱/条 | 不默认饼 |
| `card_nl8f9Iza7k` | 按场景加载→进入 | 30 | 漏斗+选行 | 不取首行 |
| `card_uhyUYX_Gsc` | 场景曝光→进入→付费 | 1 | 漏斗 | 保持步骤顺序 |
| `card_PlKe5Lkxki` | 全品类总量 | 13 | 柱或表 | ID 列不当指标 |
| `card_H3X-mNpCGx` | 全品类日度转化 | 8 | 折线 | 转化率不默认饼 |
| `card_i8FUF2Pggo` | 活动按 ID 排行 | 30 | 柱/条 + Top20 | ID 为维度 |
| `card_nB-ENVztvR` | 活动抽卡分析 | 7 | 折线或表 | — |
| `card_C4DavaDbqJ` | 宠物商城兑换排行 | 0 | 空状态 | — |
| `card__WSDaIjV_G` | UGC 消费排行 | 8 | 柱 | — |
| `card_e5EbwDNyby` | 充值总览 | 7 | 折线或指标卡 | — |
| `card_vyBhGvv2eo` | 充值项目分析 | 0 | 空状态 | — |
| `card_6xBWmYNXNO` | 按日礼物趋势 | 7 | 折线 | 不补桶 |
| `card_5JC8ULo7bB` | 按礼物 ID 漏斗 | 50 | 漏斗+选行 | 不取首行 |
| `card_Dmw05vrMJc` | 按日动作趋势 | 7 | 折线 | — |
| `card_IycQHdrC62` | 双人动作排行 | 50 | 柱/条 + Top20 | — |
| `card_1qA_s9pHyj` | 单人动作展示→使用 | 50 | 漏斗+选行 | 不跨行加 UV |
| `card_NbmKboRlnd` | 按日服装销售 | 7 | 折线 | — |
| `card_AgFcBuoLSY` | 整体外观漏斗 | 5 | 漏斗 | 保持顺序 |
| `card_OVrgUSO0xh` | 按商品 ID 漏斗 | 50 | 漏斗+选行 | ID 为维度 |
| `card_lolIA6nRRU` | 场景×交互类型明细 | 50 | 表/透视 | 不默认漏斗 |
| `card_1acc9CqeUk` | 场景交互排行 | 30 | 柱/条 | 不默认饼 |
| `card_ldP177lpMO` | 交互类型总览 | 4 | 柱 | 饼仅手动 |
| `card_V77n7HwWmd` | 停留时长分布（场景看板） | 4 | 柱 | 用户数不可加饼 |
| `card_tgK_8PaOTL` | 按场景完整漏斗（场景看板） | 50 | 漏斗+选场景 | **重点：不取首行、不累加 UV** |
| `card_sql_02126fa191c649849c79b3c160a5b01d` | 内部场景漏斗 | 4 | 漏斗 | 保持步骤顺序 |

合成 fixture 已覆盖：日趋势、小时 count、中文多指标、国家排行、场景 ID、error_code、单行 KPI、单行四步 UV/PV、50 场景漏斗、非单调、NULL/Decimal/UInt64、重复键、10001 行、旧 `{chart_type:'line'}`。

---

## 6. Nielsen 复评（实现后规格）

对照原方案基线 20/40。本评分针对**已实现交互契约**，不是生产页面实测。

| # | 启发式 | 基线 | 现评 | 说明 |
|---|---|---:|---:|---|
| 1 | 系统状态可见性 | 2 | 4 | 自动/手动、推荐原因、TopN/截断/行选择标签 |
| 2 | 符合认知 | 3 | 3 | 沿用分析术语与 Ant Design |
| 3 | 用户控制 | 2 | 4 | 字段设置、恢复自动、不可用原因可见 |
| 4 | 一致性 | 2 | 3 | SQL 分析页与看板同一内核；事件分析仍独立 |
| 5 | 错误预防 | 1 | 4 | 唯一决策表、兼容拦截、禁止静默聚合 |
| 6 | 识别优于记忆 | 2 | 3 | 列类型/角色/置信度可见 |
| 7 | 灵活高效 | 2 | 3 | 绑定可保存复现；看板不提供编辑（有意） |
| 8 | 美观极简 | 3 | 3 | 下拉代替平铺九种图 |
| 9 | 诊断与恢复 | 2 | 4 | 失效/超量/漏斗未选均回退并保留表格 |
| 10 | 帮助 | 1 | 3 | 推荐原因与不可用原因 |
| **合计** |  | **20** | **34** | **≥32；无 P0/P1 规格缺口。生产实测可能回退单项。** |

原 5 个 P1（静默猜角色、多行漏斗取首行、推荐重叠、配置不保存、范围过宽）均已在实现中按 PRD 裁决关闭。

---

## 7. PR 声明底稿

```text
phase: clklog-analytics-charts-v1
红线未自动检：
- 图表字段业务语义是否符合真实分析口径
- 45 张生产 SQL 卡是否覆盖全部数据形状
- ECharts Canvas 的实际读屏体验
- 960px / 200% 缩放与真实看板尺寸
- SQL 图表与原始表格数值的一致性
```

部署后补：架构 §14.5 浏览器 E2E、45 卡只读 execute、场景看板 2 张 SQL 卡复现。本地已补：新查询默认推荐视图、旧卡无配置保持表格、截断/歧义列告警、结果区高度传入表格、图形下拉分组、看板失效回退表格。
