# 验收记录：运维收尾与安全加固（phase: clklog-analytics-ops-hardening-v1）

- 日期：2026-09-15
- 帽子：项目（`docs/project/`）
- 环境：**生产** 生产主机，应用版本 **17165**（提交 `f010b80`）
- 性质：**维护批次**（无新功能）——安全加固 + 两个登记缺陷 + 死代码清理 + 补渲染验收
- 关联：`CODE_HANDOVER.md` 2026-09-15 节（SEC-01 / F2 / F3）、`docs/project/legacy-production-handover.md` §13（凭据治理）

---

## 1. 结论

**通过。** 五项全部完成并有可核对证据；其中 SEC-01 只完成「脚本止血」，**口令轮换因会影响社区版数据链路（红线 2）未做**，已写成方案交用户决策（§4）。

## 2. 交付与验收

| # | 项 | 交付 | 验收证据 |
|---|---|---|---|
| 1 | **SEC-01** 部署脚本明文口令 | `server-upgrade.sh` 删除硬编码 `DATABASE_URL`，统一从运行中 server 进程 `/proc/<pid>/environ` 继承；取不到即中止（不退回硬编码） | ① 仓库自检 `git grep -nE "mysql://[^:]+:[^@'\"]+@" -- scripts/ puppet/ apps/` 仅剩示例占位；② **本次发版用的就是这个脚本**，输出 `No pending migrations to apply` 证明 `DATABASE_URL` 确实由继承取得（否则脚本会打印中止信息）；③ `bash -n` 语法通过 |
| 2 | **F3** 无效联系人返回 500 | `AlertingService.resolveContactId()` 提前校验，`updateRule` 与 `createCardRule` 均接入 | 线上实测（版本 17165）：不存在的 id → `400 {"message":"联系人不存在"}`；非法格式 → `400 {"message":"contact_id 非法"}`（修复前为 500「服务暂时不可用」） |
| 3 | **F2** `slow_query_spike` 阈值 | 阈值 20 → **200**（约 4–5× 真实基线 42–49） | 线上实测：改后下一轮 **16:06:39 事件自动转 `resolved`** 并发出恢复通知（`alertnotification` id=12）；此后不再反复触发；变更留审计（见 #5） |
| 4 | **死代码清理** | 删除 5 个零消费者空壳文件：`meta/materialize.service.ts`、`meta/sampling.service.ts`、`types/meta.types.ts`、web `stores/dashboard.store.ts`、web `components/SqlEditor.tsx`；`meta.module.ts` 摘除两个 provider | 删除前逐一确认零消费者（`rg` 命中仅模块注册自身）；删除后双端 tsc 干净、后端 13 suites / 80 tests 全绿、生产重启后服务正常（模块装配无缺失） |
| 5 | **渲染验收**（补 v3「半通过」） | 新增 `AlertsWorkbench.spec.tsx` 7 例：三类提示条按需出现 / 一切正常时不出现 / 策略 Tab 健康标签（失效规则显示、正常规则不显示）/ 变更记录的「字段：旧 → 新」渲染与空态；并进 CI | 本地 `vitest run src/features/alerting src/pages/Ops` → **13 tests 通过**；CI 构建产物版本从 17161 升到 **17165**，说明新门禁在 CI 内同样通过；线上 `GET audits` 已产生真实审计行（下） |
| 6 | **文档回写** | 6 处「待评审 / 尚未实现」状态改为「已实现并上线」：`prd-clklog-analytics-ops-console-v1`、`design-ops-console-v1`、`prd-clklog-user-property-path-v1`、`design-user-property-path-v1`、`prd-clklog-analytics-trend-chart-v1`、`design-trend-chart-v1` | 逐处核对 `apps/` 实现或线上发版记录（详见各文件状态行的括注） |

## 3. 真实审计行（变更记录 Tab 的首条真实数据）

```json
{"id": 377, "operator": "admin", "action": "alert_rule_update",
 "detail": {"name": "慢查询次数突增", "changes": {"threshold": {"from": 20, "to": 200}}}}
```

这条是 F2 处置留下的真实变更（非测试造数），保留在库中，可在「运维 → 监控告警 → 变更记录」看到。

## 4. 未完成：口令轮换（需用户决策 + 维护窗口）

**为什么没做**：`<mysql-host>:3306` 是**共用实例**——社区版 ClkLog 主应用同样以 `root` 连接（`docker-compose-clklog-simple-prod.yml:120-122`，口令来自 Puppet `env.epp`）。单独轮换 root 会直接打断社区版数据链路（红线 2）；且 HANDOVER §11.2 记录过 Puppet 下发链路曾断（agent 被 KILL、挂载源被未知机制还原），「改 Puppet 变量」不能假定可靠生效。**无人值守时执行该操作风险不可接受**。

**方案（详见 `docs/project/legacy-production-handover.md` §13）**：

| 方案 | 内容 | 风险 |
|---|---|---|
| A（建议先做） | 为分析平台建专用 MySQL 用户，只授权 `clklog_sa_meta`，supervisord 的 `DATABASE_URL` 换用它 | 低（新增用户，root 可回退）；不消除已泄露 root 口令的风险 |
| B（真正修复） | 轮换 root：同步改社区版 `.env`（Puppet → 挂载源 → 重启容器）+ 分析平台 supervisord 环境 + 其它 root 使用者 | 高（漏一处断链路），须在维护窗口按「模板 → 实例 → 重启并验证上报」顺序执行 |
| C | 接受风险 | 有仓库读权限者即可 root 直连生产 MySQL |
| — | **现状注记（2026-09-15 18:30）** | 方案 A 当日 17:50 已实施并验证（`clklog_sa_app`），但 **18:00/18:30 被 Puppet agent 回滚**（`puppet_auto` 每 30 分钟一次；清单 `ops1/puppet` 硬编码 root 的 `DATABASE_URL`）→ 应用一度回到 root。**2026-09-15 19:47 终态**：清单已由用户推送并 `puppet agent -t` 生效，应用连接 = `clklog_sa_app`（`root → clklog_sa_meta` 连接数 0），持久。轮换方案仍以 B 为准 |

> git 历史里的口令无法抹除，因此 **A 不能替代 B**。

## 5. 遗留与下一步

1. **口令轮换**（§4，等用户选方案与窗口）。
2. 前端全量套件有 **2 个既有超时失败**（`src/pages/Report/SqlReportPage.chart-config.spec.tsx`，与本次改动无关），因此 CI 前端门禁暂只覆盖 ops/alerting；修好那 2 例后可扩为全量。
3. `card_Pcw3tsfkLj`（主界面功能入口渗透率）SQL 扫描 46.59 GiB 贴着 50GB 守卫，需优化或缩小范围——**未做**，进第二批次。
4. 第二批次（按既定顺序）：数据表 v2 生产造数对拍与性能基线 → 数据管理清理执行流验收。
