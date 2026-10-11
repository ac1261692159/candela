# 设计：数据质量页的信息架构与自解释（phase: clklog-data-quality-ops-ia-v1）

> 门禁要素：phase id `clklog-data-quality-ops-ia-v1`；范围/验收/非目标见
> `docs/product/prd-clklog-data-quality-ops-ia-v1.md`（IA-AC1~IA-AC7）。
> 本设计只覆盖前端 IA 与文案，**后端零改动**。

## 1. 变更点清单

| 文件 | 动作 |
|---|---|
| `apps/analytics-web/src/routes.tsx` | 新增 `ops/quality`（权限 `ops.runtime.access`）；`meta/quality` 改为 `<Navigate to="/sa/ops/quality" replace />` |
| `apps/analytics-web/src/layouts/MainLayout.tsx` | 菜单项从「数据管理」组移到「运维」组（标签仍用 `shell:menu.quality`） |
| `apps/analytics-web/src/pages/Meta/QualityPage.tsx` | 移到 `pages/Ops/QualityPage.tsx`（域名与目录对齐） |
| `apps/analytics-web/src/features/meta/QualityReport.tsx`(+spec) | 移到 `features/ops/QualityReport.tsx`(+spec) |
| `apps/analytics-web/src/pages/Ops/DataManagementPage.tsx` | 「前往数据质量页」跳转目标改为 `/ops/quality` |
| `apps/analytics-web/src/layouts/main-layout-menu.spec.tsx` | 断言从「数据管理组含 /meta/quality」改为「运维组含 /ops/quality、数据管理组不含」 |
| `i18n/locales/*/meta.json`、`*/ops.json`（13 语言） | `quality` 子树整体从 `meta` 命名空间迁到 `ops` 命名空间；新增 `quality.guide.*` |
| `features/ops/QualityReport.tsx`、`pages/Ops/QualityPage.tsx` | `useT('meta')` → `useT('ops')`，所有 `t('meta:quality.*')` → `t('ops:quality.*')` |

## 2. 路由与重定向

```tsx
// 新入口（与「数据运维」同权）
{ path: 'ops/quality', element: page('ops.runtime.access', <QualityPage />) },
// 旧入口保留：书签、文档、外部链接不 404（用 Navigate replace，不留历史栈）
{ path: 'meta/quality', element: <Navigate to="/sa/ops/quality" replace /> },
```

重定向放在同一路由表内，避免 nginx 侧改动（前端 base 是 `/sa/`，SPA 回退已由 nginx 处理）。

## 3. 权限变更与后果

| 项 | 迁移前 | 迁移后 |
|---|---|---|
| 菜单可见 | 「数据管理」组，`meta.view` 即可见 | 「运维」组，仅平台超管（`flags.showOps`） |
| 直达 URL | `meta.view` 放行 | `ops.runtime.access` 放行（其余角色被路由守卫拦到 403 页） |
| 页内设置写入 | `ops.runtime.access` + `isAdmin` | 不变 |
| 接口路径 | `/sa/api/meta/quality/*` | **不变**（脚本/AI 工具/历史引用兼容） |
| 接口权限 | `meta.view`（类级）+ 写接口 `ops.runtime.access`/isAdmin | **不变** |

**为什么接口权限不跟着页面走**：rbac-v3 已明确「`meta/quality/*` 保持 `meta.view`」，且分析师只持
`meta.picker.view`（不持 `meta.view`），所以 RB3-3 的「分析师拒止」本就成立；该决定由
`apps/analytics-server/src/modules/meta/meta-picker-permission.spec.ts` 锁着。本 phase 若顺手收紧到
`ops.runtime.access`，等于改另一 phase 已批准的权限边界（会影响项目所有者/分析管理员），超出范围。
如确需收紧，应作为独立变更同时更新 rbac-v3 设计与该 spec。

后果与替代路径：分析师失去该页可见性，但**结论仍在**「数据运维 → 数据健康」卡片（同源同新鲜度，
含 `stale_level`）。若将来需要分析师只读，做「只读视图 + 白名单」，属独立 phase。

## 4. i18n 命名空间迁移

- 规则：**键名不变，只换命名空间前缀**（`meta.quality.*` → `ops.quality.*`），13 语言同步迁移；
  迁完 `meta` 下不得再有 `quality` 键（`i18n_check.py` 的键集一致性会拦住漏迁）。
- 代码侧同步把 `useT('meta')` 改为 `useT('ops')`、`t('meta:quality.*')` 改为 `t('ops:quality.*')`。
- **为什么迁命名空间**：命名空间按域划分（`ops` = 慢 SQL/服务器状态/数据运维/日志清理），
  页面搬到运维层后仍用 `meta:*` 会让「域 → 命名空间」映射失真。
- 新键：`ops.quality.guide.*`（见 §5），13 语言同时补齐（repo 规则 G.22）。

## 5. 说明区（自解释）结构与文案键

位置：页面标题下方、配置行（启用/时刻/阈值）之上；用可折叠 `Collapse`（默认展开），
内容四段：

| 段 | 键前缀 | 要点 |
|---|---|---|
| 这个页面在做什么 | `guide.whatTitle` / `guide.whatBody` | 旁路校验：`sa_events`（我方 ingestor 写入）对比社区版 `log_analysis`，用于发现消费停滞、静默丢数、重复写入；只读、不写业务数据 |
| 关键术语 | `guide.termsTitle` + `terms.*`（range/threshold/crc/trusted/skipped/stale/events） | 对拍范围（默认昨天、单次≤3 天）、偏差阈值（百分比，当前值）、CRC 唯一性（近似去重 + 0.5% 容忍）、可信区间（两侧保留期取小，超出不比对）、已清理区间（不判告警）、快照新鲜度（fresh/warn/error）、事件级差异 Top |
| 结果怎么读 | `guide.howTitle` + `how.1`~`how.4` | 偏差 1%~2% 属已知结构性口径差（社区版对错误/重试类事件少计，见口径白皮书）；**偏差转负**或**某事件计数归零**才优先怀疑 ingestor；超保留期/已清理日期不计入异常；快照过期（黄/红）时结论不代表现状 |
| 谁该做什么 | `guide.whoTitle` + `who.admin` / `who.oncall` / `who.analyst` | 超管：改阈值/忽略清单、处理过期与失败通知；值班：先看事件级差异定位是「新事件类型」还是「整体消失」；分析师：看业务数据，链路结论看「数据运维 → 数据健康」 |

说明区不写「文档链接」以外的外链；口径白皮书路径写进 `guide.how.footnote`（纯文本，不做跳转）。

## 6. 测试策略

| 层 | 用例 |
|---|---|
| 单测（前端） | `main-layout-menu.spec`：运维组含 `/ops/quality`、数据管理组不含；`QualityReport.spec` 随目录迁移；新增 `QualityPage.guide.spec`（说明区 4 段渲染、可收起） |
| 资源一致性 | `i18n_check.py`（13 语言键集/占位符一致 + 无 `meta.quality` 残留）与 `i18n_scan.py --check`（硬编码棘轮不升） |
| 结构门禁 | `arch_ratchet.py`（迁移后目录文件数/行数仍在上限内） |
| 线上实测 | 菜单在运维组、`/sa/ops/quality` 正常、旧路径跳转、说明区展开收起、13 语言无残留（切到 en/ja 抽查） |

## 7. 非目标与回滚

- 非目标同 PRD（不动算法/契约/后端路径/角色细化）。
- 回滚：把路由与菜单项改回 `meta` 组、命名空间迁回即可（无数据迁移、无后端改动、无 DDL）；
  旧路径跳转本身可保留，不影响回滚。
