# 项目现状与阶段进展（原 README 内容迁移）

> 本文件是 `README.md` 早期内容的迁移归档（2026-10-10）：README 已重写为**面向开源的入口文档**，
> 原先的「当前阶段 / 架构速览 / 文档入口 / 关键约束 / 许可证」逐字保留在这里，作为阶段进展与设计速览的记录。
> 新入口看 `README.md`，文件导航看 `INDEX.md`。
> 另注：文中提到的部分根文档**未随拆分进入本仓库**（如 `OPEN.md`、`development.md`、`本地开发网络转发.md` 已移回旧仓库；`HANDOVER.md`/`数据上报规范与流程.md`/`analytics-extension-plan.md` 已转入 `docs/` 下），下文路径保留当时的写法。
>
> **更名说明**：项目原名 `clklog_manager`，2026-10-10 更名 **Candela**（品牌层：仓库/镜像/容器/栈/部署目录/界面文案；技术标识 `/sa/`、`clklog_sa*`、`CLKLOG_*` 按计划保留）。本文正文保留当时的旧名与措辞，作为历史记录。
>
> 注意：以下内容描述的是**生产环境（Puppet + CI 发版）**的形态与进展，不是本文档对应的部署手册；
> 部署步骤以 `README.md` 与 `docs/architecture/candela-deploy-two-paths.md` 为准。

## 当前阶段

- **部署**：ClkLog 社区版 1.3.0 标准模式（Kafka + Flink + ClickHouse）的数据上报链路已打通。当时环境的主机名和地址已从公开仓库删除。现行部署见 `README.md`。
- **分析平台 v1**：阶段 1（数据补齐链路）与阶段 2（M2 MVP：埋点管理 + 事件分析）已完成并验收（`phase: clklog-analytics-v1`）。ingestor 已稳定消费 CKafka `clklog` topic 写入 `clklog_sa.sa_events`；前后端已实现元事件管理、虚拟事件、事件分析 DSL 查询与图表。源码在 `apps/analytics-server/` 与 `apps/analytics-web/`，阶段 2 验收见 `docs/project/acceptance-clklog-analytics-v1-m2.md`。
- **M2.1**：已完成并验收（事件类型/昨日量/状态/批量操作 + 虚拟属性），PRD 见 `docs/product/prd-clklog-analytics-v1-m2.1.md`，实现方案见 `docs/architecture/clklog-analytics-design-m2.1.md`，验收记录见 `docs/project/acceptance-clklog-analytics-v1-m2.1.md`。
- **M2.2**：已完成并验收。埋点管理进阶（虚拟事件多事件 OR + 全局筛选、事件备注、事件属性面板、事件列表表头筛选/状态 Tooltip），目标 2026-08-18；PRD 见 `docs/product/prd-clklog-analytics-v1-m2.2.md`，实现方案见 `docs/architecture/clklog-analytics-design-m2.2.md`，验收记录见 `docs/project/acceptance-clklog-analytics-v1-m2.2.md`。
- **M3**：已完成并验收。事件分析增强（多指标、每指标筛选、全局筛选、多图表）+ 漏斗分析（多步骤、窗口期、转化/流失），目标 2026-08-15；PRD 见 `docs/product/prd-clklog-analytics-v1-m3.md`，实现方案见 `docs/architecture/clklog-analytics-design-m3.md`，验收记录见 `docs/project/acceptance-clklog-analytics-v1-m3.md`。
- **数据治理（进行中）**：数据一致性对拍已实现双通道——`scripts/reconcile.sh`（CLI，定时告警）与 Web「数据质量」页（`/sa/ops/quality`，人工查看），只读比对 `sa_events` vs `log_analysis`，兜底 ingestor 丢数据风险；敏感数据清洗（删除/掩码）已完成 PRD 与架构设计，待后续 phase 实现。PRD 见 `docs/product/prd-clklog-analytics-v1-data-governance.md`，方案见 `docs/architecture/clklog-analytics-design-data-governance.md`。
- **看板 SQL 卡片（已部署生产，phase: clklog-dashboard-sql-cards-v1）**：看板内 SQL 卡 refresh + 表格展示、API Key 目录/execute、SQL 页覆盖保存、Harness 静默拉数。2026-09-03 全量 45 张 `type=sql` 卡近 7 天 execute：**42 成功 + 3 空结果，全部通过**。ClickHouse cgroup 12G。守卫改为 `additional_table_filters`（不再包 `SELECT *`），字节上限 50GB，2GB 内存不放宽；查询墙钟 2026-09-09 起全局 300s（原 30s）。PRD 见 `docs/product/prd-clklog-dashboard-sql-cards-v1.md`，方案见 `docs/architecture/clklog-analytics-design-dashboard-sql-cards-v1.md`，审计见 `docs/project/sql-card-audit-clklog-dashboard-sql-cards-v1.md`。
- **P3 看板 + 卡片（报表闭环，已实现核心）**：看板列表/详情、卡片网格展示、卡片实时重算（`/report/dashboards` + `/{id}/cards` + `/refresh`）。事件分析/漏斗分析结果**一键保存为卡片**并聚合到看板展示。实现见 `apps/analytics-server/src/modules/report/` 与 `apps/analytics-web/src/pages/Report/`。
- **P3 自定义 SQL 分析（已实现核心）**：带元数据字典（事件/属性/系统字段，可搜索点击插入）+ SQL 编辑器 + Builder 分组模式 + 底部结果；原页内 AI 占位已迁移为全分析页共用面板。执行走安全守卫（词法级黑名单 + 逻辑表改写注入 project/time + 资源限额）+ 专用只读账号 `sa_readonly`（与写账号 `default` 隔离）。留存卡片仍为 TODO；「项目身份认证」仍 TODO（需引入认证体系）。PRD 见 `docs/product/prd-clklog-analytics-sql-report-v1.md`，方案见 `docs/architecture/clklog-analytics-design-sql-report.md`。
- **SQL 图表可视化（本地已实现，待生产只读验收，phase: clklog-analytics-charts-v1）**：独立可视化包完成列画像、唯一推荐、折线/柱条/饼环/指标卡/SQL 漏斗、字段绑定、配置随 SQL 卡保存与看板只读复现。旧 `ChartRenderer` 仍服务事件分析。本地 test/build/棘轮已通过。生产 45 张卡只读回归与浏览器 E2E 见 `docs/project/acceptance-clklog-analytics-charts-v1.md`。PRD 见 `docs/product/prd-clklog-analytics-charts-v1.md`，实现方案见 `docs/architecture/clklog-analytics-design-charts-v1.md`。
- **用户分群（条件/ID/结果已交付；SQL 分群 phase: clklog-analytics-sql-cohort-v1 已实现；SQL/看板分群 phase: clklog-analytics-cohort-sql-dashboard-v1 已实现；用户标签 phase: clklog-analytics-user-tag-v1 已实现；分析主体 phase: clklog-analytics-analysis-subject-v1 已实现）**：列表、条件句/CSV/结果快照、分析筛选分组读 `sa_cohort_members`。SQL 分群复用 SQL 报告 AST + `additional_table_filters`，试跑/物化走只读 SELECT，成员仍写同一张表。自定义 SQL Builder/字典与看板级分群筛选读同一成员表；手写 SQL 用 `sa_in_cohort()` 执行时注入现网 `batch_id`。规则标签预计算 `sa_tag_members`（uid → 一个离散值），分析筛选/分组与 SQL Builder 只读成员表。分析去重键可切换预置「用户」或属性主体，见 `docs/product/prd-clklog-analytics-user-segment-followups.md`。侧栏「用户」菜单含分群 / 标签 / 分析主体。
- **看板工作室（进行中，phase: clklog-analytics-dashboard-studio-v1）**：Grafana 式拖拽/缩放/列数、卡片独立缓存 + 后台温热、标签说明卡、删除入口收回设置/编辑面。PRD 见 `docs/product/prd-clklog-analytics-dashboard-studio-v1.md`，方案见 `docs/architecture/clklog-analytics-design-dashboard-studio-v1.md`。
- **用户 / 权限体系（RBAC v2 已实现，`phase: clklog-analytics-rbac-v2`）**：超管只做运维（账号 / 指定项目 owner / API Key / AI Workspace），项目能力走成员角色（owner / 分析管理员 / 分析师 / 普通成员 / 外部人员）。含成员组、数据权限注入查询、看板两层文件夹、资产锁定与编辑授权（互斥）。P1 登录/token/密码仍见 `docs/architecture/clklog-analytics-design-user-rbac.md`。调研 `docs/product/research-clklog-analytics-rbac.md`，PRD `docs/product/prd-clklog-analytics-rbac-v2.md`，方案 `docs/architecture/clklog-analytics-design-rbac-v2.md`。发版需 `prisma migrate deploy`（迁移会把原 `admin` 写成超管 + `clklogapp` owner）。
- **AI 数据分析助手（用户已部署，知识迁移完成，四类线上验收通过）**：`phase: clklog-ai-workspace-v1` 在原 MVP 上补齐能力/字典发现、留存工具、三类分析表单提案、签名续期、SQL 语义版本与迟到结果保护。thinkingdata 迁移清单及四类纵切方案见 [AI Workspace 架构](../architecture/clklog-ai-workspace-design.md)，127 项相关测试及本地证据见 [本地验收](validation-clklog-ai-workspace-v1.md)。2026-09-09 已发布模板 v3。产品事件候选与别名表已在公开前删除，见 [迁移记录](migration-thinkingdata-ai-workspace.md)。同日决策：分析提案与 SQL **自动应用/自动执行**（去人工确认，安全守卫与只读账号不变）；同日线上：独立 Harness Runtime 已更至应用版本 16923，E/F/R/S 四类纵切与 prompt/cancel、历史会话恢复在线上通过（证据见 validation 文档线上章节）；用户属性关联查询在 Harness 仍拒绝（见 `CODE_HANDOVER.md`）。
- **运维面板 + 监控告警（已上线，`phase: clklog-analytics-ops-console-v1` / `clklog-analytics-alerting-v1` / `clklog-analytics-alerting-v2`）**：平台内「运维」一级菜单（**仅超管可见**，权限码 `ops.runtime.access` + 后端 `isAdmin()` 双闸），含慢 SQL（只读 `system.query_log`，保留期约 3 天）、服务器状态（主机指标 + 磁盘用量采样与用尽预估 + 日志目录治理）、监控告警工作台（6 条内置规则可启停调阈值、窗口状态机、飞书/SMTP/腾讯云 SMS 三通道、屏蔽、通知记录）、数据运维（分区清理预演与执行、TTL）。生产 2026-09-15 完成线上端到端实测（触发→飞书投递→屏蔽抑制→恢复），验收记录见 `docs/project/acceptance-clklog-analytics-alerting-v1.md`。同日修复验收暴露的两项缺陷（慢查询时间窗偏 8 小时造成规则长期误报；后台定时任务在 server 与 ingestor 双跑），并交付 `phase: clklog-analytics-alerting-v3`「告警可运维性」：规则健康度与失效提示、配置变更审计（变更记录 Tab）、通知失败重试与投递可见、新增第 7 条内置规则「磁盘预计用尽」（预测线告警）。`slow_query_spike` 阈值待重新标定（真实基线约 42–49 次/5 分钟，高于现值 20），详见 `CODE_HANDOVER.md`。
- **告警 v4：指标告警 + 通知模板（已上线，`phase: clklog-analytics-alerting-v4`）**：告警对象从「分析卡片缓存」改为**「数据管理 → 指标」**（事件/留存指标），求值复用工作台查询链路，口径与工作台一致；窗口按天（今天/近 2/7/30 天），连续越线才触发。通知内容改为**可编辑模板**（触发/恢复 × 飞书/邮件/短信），默认模板预填充占位符，支持 Go 模板子集条件与预览。同时修复用户报告的「新建分析指标告警」500——根因是重复 `project` 查询参数被 Express 解析成数组后直传 Prisma，现已在 DTO 层规范化。生产 2026-09-15 完成端到端实测（触发/持续/恢复/留存求值/自定义模板投递），并保留 3 条自检指标。验收见 `docs/project/acceptance-clklog-analytics-alerting-v4.md`。
- **接入指南 v2（已上线，`phase: clklog-analytics-onboarding-v2`）**：「数据管理 → 接入指南」改为**自包含 SDK 文档站**，不再指向仓库示例目录：客户端 9 / 服务端 9 / 其他 2 个入口，已实测的 HTTP 协议、PHP、Go、Unity(C#) 在页面内给完整文档（步骤 + 可复制代码 + 验证 + 常见问题），其余入口点击提示「暂未开发」。验收见 `docs/project/acceptance-clklog-analytics-onboarding-v2.md`。
- **指标 v3：四则运算数值变换 / 留存队列范围 / 指标卡 + 三项体验修复（已上线，`phase: clklog-analytics-metric-v3`，17270）**：数值变换从「只能乘系数」扩展为**加减乘除 + 保留小数位**（旧定义自动按「乘以」兼容）；留存指标可设**队列范围**（≥ 周期+1 天、≤ 180 天）；卡片库新增**指标卡**（以已保存指标为数据源，折线/柱/表格/数值四视图，卡片跟随指标口径自动更新）；指标列表去掉操作列，编辑与删除（二次确认）收进详情抽屉并新增「创建看板卡片」。查询时间面板改为自适应视口（≤900px 单列）不再越界。方案见 `docs/product/prd-clklog-analytics-metric-v3.md` 与 `docs/architecture/clklog-analytics-design-metric-v3.md`。
- **指标 v2：与事件分析同深度的口径 + 查询时间 + 取值选择（已上线，`phase: clklog-analytics-metric-v2`，17259）**：指标编辑器补齐分析主体 / 事件 / 属性 / 计算方法（含分位数）/ 数值变换 / **取值选择** / **查询时间** / 条件组八区，并可直接「试算」先看数再保存（试算与告警求值共用同一实现）。指标可自带相对时间范围（今天 / 近 N 天（含今天）/ 过去 N 天 / 本周…，上限 90 天）与取值口径（累计 / 日均 / 最大 / 最小 / 最新一天 / 首日 / 整段去重合计 / 加权平均），告警规则默认跟随指标、也可按规则单独指定窗口（存量规则 `time_source=rule`，行为不变）。同时修掉两处保真缺陷：数值变换与阶段总和此前**保存即丢**，以及筛选条件在编辑界面不可见。方案见 `docs/product/prd-clklog-analytics-metric-v2.md` 与 `docs/architecture/clklog-analytics-design-metric-v2.md`。
- **指标查看与编辑（已上线，`phase: clklog-analytics-metric-detail-v1`）**：「数据管理 → 指标」补齐详情与编辑——可看完整口径（事件 + 计算方法 + 属性；留存初始→回访 + 周期 + 口径 + 队列 + 粒度），可就地改显示名/备注/格式与口径，指标名与类型只读（改了会打断分析与告警引用）。后端 `PUT` 语义补强为「部分更新 = 合并已存定义」，避免漏传字段被静默清空；同时挡住「事件为空」的坏指标落库。验收见 `docs/project/acceptance-clklog-analytics-metric-detail-v1.md`。
- **AI Workspace 项目隔离（已上线，`phase: clklog-ai-workspace-project-isolation-v1`）**：每个项目一个 `app` 目录（host `workspaces/<项目哈希>/app`），容器内固定挂 `/workspace/app`——同项目成员共享、跨项目不可见，切换项目启动 harness 读到的是另一个项目的 app。broker 只认这一种路径形状并拒符号链接；`app` 目录自动创建（0750 harness:harness）并带 `project.json` 租户标识。验收见 `docs/project/acceptance-clklog-ai-workspace-project-isolation-v1.md`（含「改 Harness 的发版要多跑 install-harness-runtime.sh」这一踩坑记录）。
- **AI 工作区内容入仓与双向同步（已上线，`phase: clklog-ai-workspace-sync-v1`）**：仓库新增 `ai_workspace/`，与目标机运行时**同构**——`default/` 是默认工作区模板（= 平台模板草稿），`app/<项目>/` 是项目空间（容器内 `/workspace/app`）。`scripts/ai-workspace-sync.sh` 提供 `init/push/pull/diff/status/migrate`：push=仓库胜、pull=运行时胜，默认都不删，pull 前过密钥/隐私门禁（命中即整批丢弃、不落仓库）；发版会把 `ai_workspace/` 带到目标机并自动 `init`（只补缺失）。验收见 `docs/project/acceptance-clklog-ai-workspace-sync-v1.md`。
- **告警通知多通道（已上线，`phase: clklog-analytics-alert-channels-v1`；通道集见 PRD 增补 v1.2）**：群机器人/IM（飞书、钉钉加签、企业微信）、Telegram、通用 Webhook（body 支持模板，可对接 PagerDuty/自建系统）、邮件（SMTP 平台可配 + 用户管理邮件通道回落）、短信（阿里云/腾讯云/AWS SNS/Twilio 官方 SDK）、WhatsApp（Cloud API 模板）。平台内「通道配置」管理凭证（AES-256-GCM 加密、只写不读、发送测试、可暂停投递），通道层带**令牌桶限流 + 积压合并**（钉钉/企微/Telegram 官方 20 条/分钟）。配置与手动测试清单见 `docs/product/guide-clklog-analytics-alert-channels-v1.md`，验收证据见 `docs/project/acceptance-clklog-analytics-alert-channels-v1.md`。
  同日反馈四项已上线（17243）：通知模板**左编辑右预览**；删掉「默认联系人」改为每个联系人的**启用**开关，规则可**多选联系人**（一条告警同时发多渠道）；联系人支持**编辑**（列表地址脱敏不回填，留空即不改）；新增**数据保留策略**——告警历史/通知记录默认 365 天、变更记录默认永久，三者在概览页可分设。
## 架构速览

ClkLog 社区版原有数据链路（不修改、不侵入）：

```
SDK / 上报脚本 → nginx → receiver → CKafka → Flink → ClickHouse:clklog.log_analysis
```

本仓库扩展的分析平台新增一条旁路链路：

```
SDK / 上报脚本 → nginx → receiver → CKafka → ingestor → ClickHouse:clklog_sa.sa_events
                                                         ↓
                                                  MySQL:clklog_sa_meta
                                                         ↓
                                              埋点管理 / 事件分析 / 漏斗分析
```

关键点：

- **ingestor 是本项目新增组件**，负责消费 CKafka 的 `clklog` topic，把事件写入 `clklog_sa.sa_events`，并在 MySQL 元数据表中自动发现事件和属性。
- 社区版链路（`log_analysis` 及 19 张聚合表）**不被修改**，保证社区版升级可用。
- 本地开发时，`./run_dev.sh all` 会同时启动后端 API、前端和 **ingestor**，新上报事件会自动进入 `sa_events` 与元事件管理。
- ingestor 异常退出时，`run_dev.sh` 会立即终止后端和前端并整体退出，避免“服务还活着但数据没进来”被掩盖。
- 如需单独启动 ingestor 或补历史数据（需要加载 `.env` 并开启 Kafka 本地转发）：

  ```bash
  cd apps/analytics-server
  set -a && source .env && set +a
  export KAFKA_LOCAL_FORWARD=true
  npm run start:ingestor:dev               # 正常消费（从当前 offset）
  INGESTOR_REPLAY=true npm run start:ingestor:dev  # 从头回灌一次
  ```

- **生产环境补历史数据**（`scripts/run_ingestor.sh`，supervisor 托管同款）：
  在 `target/ingestor/` 目录下执行，无需手工导出环境变量：

  ```bash
  ./run_ingestor.sh replay        # 从 topic 最早位点回灌一次（独立 consumer group + crc 幂等）
  ./run_ingestor.sh start --replay  # 与上面等价
  ./run_ingestor.sh start         # 恢复正常消费（从当前 offset）
  ```

  ⚠️ 回灌只能补 Kafka `clklog` topic **保留期（retention）内**的数据；早于保留期的消息已被删除，无法补回。

- **数据一致性对拍**（`scripts/reconcile.sh`，只读，不写库）：比对 `clklog_sa.sa_events` 与社区版 `clklog.log_analysis`，及时发现 ingestor 静默丢数据/停转/重复：

  ```bash
  ./reconcile.sh --type=count --from=2026-08-01 --to=2026-08-26   # 总量对拍（默认阈值 0.1）
  ./reconcile.sh --type=crc                                        # CRC 唯一性（重复检测）
  ./reconcile.sh --type=detail --sample=1000                       # 抽样细对拍
  ./reconcile.sh --help
  ```

  凭据走环境变量（`CLICKHOUSE_PASSWORD` 等）；建议 cron 每小时粗对拍 + 每日抽样细对拍。设计契约见 `docs/architecture/clklog-analytics-design-data-governance.md`。

  对拍结果也可在 **Web「数据质量」页**（`/sa/ops/quality`，运维 → 数据质量）查看：可选时间范围、手动触发对拍，展示每日总量对拍表、CRC 唯一性、事件级对照，以及**近期元数据变化**（自动发现的新增事件/属性/属性类型变更）。CLI 负责定时告警，Web 负责人工查看。

  埋点管理自动发现：已存在事件后续上报**新增字段会自动登记**；同名字段类型变化会被检测并更新，并写入 `metadiscoverylog` 审计记录（数据质量页可见）。
  **用户属性自动发现**：从 `user_set`/`user_set_once`/`track_signup` 提取用户属性登记到「用户属性管理」；`user_unset`/`user_delete` 自动将对应属性标记 `hidden`。新登记属性默认 `pending`，可在用户属性管理页确认并物化（复用现有接口）。

### 生产部署产物拆分（server / ingestor 独立）

CI 构建产物 `target/` 将主程序与 ingestor 拆分为**两个独立部署目录**（`scripts/build.sh` 产出，supervisor 分别管理）：

```
target/
├── server/        # HTTP 主服务：run.sh + dist/src + configs + prisma（可频繁更新）
├── ingestor/      # Kafka 消费者：run_ingestor.sh + dist/src + configs + prisma（独立稳定）
└── web/           # 前端静态文件（vite base=/sa/，产物带 /sa/ 层级）
```

- **更新主程序不影响 ingestor 监听**：两者物理隔离在独立目录，更新只重建 `server/`，`ingestor/` 文件与进程均不受影响。
- 二者共享同一份编译产物 `dist/src`（共用 `AppModule`），但可各自更新/重启/回滚。
- 生产 supervisor 配置见 `scripts/supervisord-clklog-manager.conf`，密钥经 `%(ENV_XXX)s` 注入（不入库）。
- **Prisma Client 随发版自动同步**：发版只更新 `dist/` 与 `prisma/schema.prisma`，`node_modules` 已存在时 `npm ci` 不会执行，Prisma Client 不会自动更新（新增/修改模型后运行时不可用）。为此：
  - supervisor 的启动 `command` 用 `bash -c '... && npx prisma generate && exec node ...'` 包装，启动前确保 Client 与 schema 同步；
  - `run.sh` / `run_ingestor.sh` 的 `install_deps_if_needed` 也在 `npm ci` 后执行 `prisma generate`。
  - 新增模型后需 `prisma migrate deploy`（`metadiscoverylog` 等新表），migration 文件随发版进入 `prisma/migrations/`。

### 前端产物与 nginx（vite base=/sa/）

前端 `vite base=/sa/`、`BrowserRouter basename="/sa"`，`build.sh` 将产物放到 `/sa/` 层级，**nginx 无需为前端配置 `location /sa/` alias**，`root web` 直接命中：

```
web/
├── index.html        # SPA 回退入口（内容同应用页面）
└── sa/
    ├── index.html    # 应用首页
    └── assets/       # 静态资源（/sa/assets/*.js）
```

nginx 配置（`scripts/nginx-clklog-manager.conf`）：
- `root /data/app/candela/web` + `index index.html`
- `location /sa/api/` → `proxy_pass http://127.0.0.1:3100`（后端 API）
- `location /` → `try_files $uri $uri/ /index.html`（静态 + SPA 回退）

## 文档入口

| 要看什么 | 去哪 |
|---------|------|
| Agent 工作规则 | `AGENTS.md` |
| 文件导航 | `INDEX.md` |
| 部署方案与成本 | `development.md` |
| 部署现状与运维 | `docs/project/legacy-production-handover.md` |
| 分析平台总体方案 | `docs/architecture/analytics-extension-plan.md` |
| PRD | `docs/product/prd-clklog-analytics-v1.md` |
| 前端原型图 | `docs/product/wireframes-clklog-analytics-v1.md` |
| 实现方案 | `docs/architecture/clklog-analytics-design.md` |
| AI 数据分析助手 PRD | `docs/product/prd-clklog-ai-analytics-v1.md` |
| AI 数据分析助手架构 | `docs/architecture/clklog-ai-analytics-design.md` |
| AI 阶段复盘与红线覆盖 | `docs/project/retrospective-clklog-ai-analytics-v1-2026-09-01.md` |
| 实现拆包 | `docs/architecture/implementation-breakdown-clklog-analytics-v1.md` |
| 项目计划 | `docs/project/plan-clklog-analytics-v1.md` |
| 后端源码 | `apps/analytics-server/` |
| 前端源码 | `apps/analytics-web/` |
| Puppet 代码 | `puppet/clklog/`（对照关系见 `puppet/README.md`） |
| CI 构建与部署产物（scripts/） | `scripts/build.sh` |
| 生产 supervisor 配置 | `scripts/supervisord-clklog-manager.conf` |
| 开源前准备调研（敏感信息 / 许可证 / 多语言 / 容器化） | `OPEN.md` |
| 许可证与上游归属声明 | `LICENSE`（AGPL-3.0）、`NOTICE` |

## 关键约束（速览）

- 不侵入社区版代码与表结构，分析域旁路扩展（详见 `AGENTS.md` 红线）。
- 密钥默认不入库，走 Puppet 模板参数化；AI phase 当前有项目所有者批准的临时供应商密钥例外，范围与退出条件见对应复盘记录。
- 服务器配置真相在 `puppet/`，禁止手工漂移。

## 许可证

本项目采用 **GNU Affero General Public License v3.0**（AGPL-3.0，SPDX：`AGPL-3.0-only`），
全文见 [`LICENSE`](../../LICENSE)。

**上游归属**：本项目是 ClkLog 社区版（[github.com/clklog/clklog](https://github.com/clklog/clklog)，
同样以 AGPL-3.0 授权）的旁路扩展与编排，仓库内包含复制或改编自其官方部署包的配置文件。
来源清单与逐文件改动声明见 [`NOTICE`](../../NOTICE)。

**网络服务注意**：AGPL-3.0 §13 要求，若通过网络向用户提供本软件的服务，
须向这些用户提供获取对应源码的机会。以本项目对外提供服务者应自行履行该义务。

当前仓库仍有若干不适合公开的内容（明文供应商密钥、内网拓扑、内部业务资料等），
**公开前须先按 [`OPEN.md`](OPEN.md) 完成脱敏**。
