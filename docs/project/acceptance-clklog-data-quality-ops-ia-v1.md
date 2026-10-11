# 验收记录：数据质量页 IA 与自解释（phase: clklog-data-quality-ops-ia-v1）

> 门禁文档：`docs/product/prd-clklog-data-quality-ops-ia-v1.md`（IA-AC1~IA-AC7）、
> `docs/architecture/clklog-analytics-design-quality-ops-ia-v1.md`。

## 发版

| 版本 | 内容 | 核验 |
|---|---|---|
| 17689 | 菜单/路由搬迁 + 说明区 + i18n 命名空间迁移 | 产物：`QualityPage-CZCEEgdv.js`（11:32，15,690 字节，含 `quality.guide.whatTitle`，无 `meta:quality` 残留）；**线上实测发现旧路径跳到兜底页**（见下方缺陷 1） |
| 17691 | 上述 + 旧路径跳转修复（`to="/ops/quality"`） | 产物：`QualityPage-DelNvc_p.js`（11:51）；前端入口 chunk 随本次构建更新；线上实测旧路径正确跳转（见 IA-AC3） |

## IA-AC 逐条

| 编号 | 判据 | 结果 | 证据 |
|---|---|---|---|
| IA-AC1 | 运维组含「数据质量」、数据管理组不含 | **通过** | 线上实测侧栏：`运维 → 慢 SQL / 服务器状态 / 监控告警 / 数据运维 / 数据质量`；单测 `main-layout-menu.spec` 5 项（含新增「运维组含 `/ops/quality`」「数据管理组不含」） |
| IA-AC2 | `/sa/ops/quality` 展示完整内容 | **通过** | 线上实测：配置行（启用/03:30/**3%**/配置更新时间）、每日总量、事件级差异 Top、「近期元数据变化」、说明区四段 |
| IA-AC3 | 旧路径 `/sa/meta/quality` 跳转新路径 | **通过** | 线上实测：载入旧路径后 URL 变为 `/sa/ops/quality`；单测 `routes.spec` 锁定目标为路由内路径 `/ops/quality` |
| IA-AC4 | 页面权限 `ops.runtime.access`（接口权限不变） | **通过** | 路由断言（`ops/quality` 的 `RequirePermission` 码）；接口类级仍 `meta.view`，由 `meta-picker-permission.spec` 锁定 |
| IA-AC5 | 说明区可展开/收起，四段，13 语言 | **通过** | 线上实测：「作用」默认展开并显示全文，其余三段可点开；`QualityPage.guide.spec` 2 项；`i18n_check` 13 语言 4105 键一致 |
| IA-AC6 | 命名空间迁移干净 | **通过** | `meta.quality` 92 键整体迁到 `ops.quality`（13 语言），`meta` 下无 `quality` 残留；新增 `ops.quality.guide.*` 21 键；`i18n_check` 通过、`i18n_scan` 不升 |
| IA-AC7 | 门禁与线上实测 | **通过** | 前端 119 files / 644 tests、后端 132 suites / 1065 tests、`tsc`、`arch_ratchet`、`i18n_check`/`i18n_scan` 全绿；线上实测见上 |

## 实施中发现的缺陷（已修）

1. **旧路径跳到兜底页**（17689 线上实测）：`BrowserRouter basename="/sa"` 下 `Navigate to` 必须是**路由内路径**，
   写成完整 URL `/sa/ops/quality` 会解析成 `/sa/sa/ops/quality` → 无匹配 → 兜底跳转默认页。
   修复：`to="/ops/quality"`，并加静态守卫 `src/routes.spec.tsx`（断言目标不得以 `/sa/` 开头、`replace` 为真）。
2. **越权收紧被既有守卫拦下（已回退）**：实施中顺手把质量接口类级权限从 `meta.view` 改成
   `ops.runtime.access`，被 `meta-picker-permission.spec` 拦下——rbac-v3 已明确该接口留在 `meta.view`
   （分析师只持 `meta.picker.view`，拒止已成立）。已回退，并把理由写进设计文档与控制器注释；
   如确需收紧，应作为独立变更同步 rbac-v3 设计与该 spec。

## 遗留与建议（不在本 phase 范围）

- 全段超保留期时页面仍显示绿色「数据一致性正常」（下方统计另有「超保留期天数 43」）。
  建议后续单独 phase 改为中性提示（如「该范围全部超出保留期，未做比对」），避免被误读为「比对通过」。
- 分析师现在看不到该页（预期）：结论仍由「运维 → 数据运维 → 数据健康」承载（同源同新鲜度）。
- 若将来要给分析师只读视图，应做成独立 phase（只读视图 + 白名单），不要用页面权限回退来绕过。
