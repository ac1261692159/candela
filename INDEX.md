# INDEX.md — 按需文件导航

> 接手请先读 [`docs/project/handoff-candela-new-repo.md`](docs/project/handoff-candela-new-repo.md)。
> `puppet/` 不在本仓库；ClkLog 配置在 `deploy-assets/clklog-community/`。旧生产运维记录已撤出。

> 职责：文件在哪、各目录有什么、读哪篇入口。项目现状看 `README.md`，Agent 行为规则看 `AGENTS.md`，设计事实看各规格文档。

<!-- RUNTIME-META
索引版本: 4
最后全量扫描: 2026-10-11
下次计划扫描: 2026-10-18
计数(口径 rg --files <目录> -g '*.md'): 根目录=10, docs/product=91, docs/architecture=93, docs/project=55, examples/report-sdk=2, puppet=0, scripts=0
-->

## 任务入口

| 任务 | 首选文件 |
|------|---------|
| 项目现状与入口（英文，GitHub 默认） | `README.md` |
| 项目现状与入口（中文） | `README.zh-CN.md` |
| README 配图（埋点、事件分析、漏斗、留存、用户行为序列、自定义 SQL、看板、告警通道） | `docs/readme/` |
| 开发方法论 CDD（英文） | `CDD-methodology.md` |
| 开发方法论 CDD（中文） | `CDD-methodology.zh-CN.md` |
| **接手/交接入口（仓库来源、目标机现状、待办与已知坑）** | `docs/project/handoff-candela-new-repo.md` |
| 项目现状与阶段进展（原 README 内容迁移：阶段清单 / 架构速览 / 文档入口 / 约束） | `docs/project/project-status.md` |
| 产品与界面设计基线（用户/目的/品牌性格/设计原则） | `PRODUCT.md` |
| Agent 工作规则 | `AGENTS.md` |
| 前端布局与交互纪律（通用模板） | `docs/architecture/templates/AGENTS_front.md` |
| 旧生产运维记录（已撤出，只留说明） | `docs/project/legacy-production-handover.md` |
| 参与贡献 | `CONTRIBUTING.md` |
| 安全报告 | `SECURITY.md` |
| 容器化部署难度调研（compose / k8s yaml / helm + 持久化与扩副本，phase: clklog-containerization-feasibility-v0） | `docs/architecture/containerization-feasibility.md` |
| 许可证与上游归属声明（AGPL-3.0 / ClkLog 来源与改动声明） | `LICENSE`、`NOTICE` |
| 独立测试环境实现方案（全自建中间件 MySQL/Redis/Kafka/ClickHouse + 社区版标准模式，phase: clklog-standalone-test-env-v1） | `docs/architecture/standalone-test-env-design.md` |
| 独立测试环境部署记录与验收（2026-10-08 实测：12 项验证通过 / 幂等 A-B 零差异 / 9 个缺陷与修法，phase: clklog-standalone-test-env-v1） | `docs/project/deployment-record-standalone-test-env.md` |
| 独立测试环境部署脚本（幂等：lib/deploy-middleware/deploy-clklog/verify/deploy-remote） | `scripts/standalone-test-env/` |
| 分析平台两套部署流程实现方案（常规 supervisord / docker-compose + 共用数据库初始化脚本，phase: candela-deploy-two-paths-v1） | `docs/architecture/candela-deploy-two-paths.md` |
| 分析平台两套部署实测与验收（常规 18/18 + Docker 19/19 + 幂等零差异 + 12 项脚本缺陷，phase: candela-deploy-two-paths-v1） | `docs/project/deployment-record-candela-two-paths.md` |
| 分析平台部署脚本（两套流程 + MySQL/CH 初始化 + 铲库 + 验证） | `scripts/standalone-test-env/candela/` |
| 清空整机部署（容器/镜像/卷/数据目录/配置；默认 dry-run，需 --yes） | `scripts/standalone-test-env/teardown.sh` |
| 测试环境启用 AI Harness（运行时安装器 + 渲染开关 + 工作区种子；phase: standalone-test-env-harness-v1） | `docs/architecture/standalone-test-env-harness-design.md`、`scripts/standalone-test-env/candela/install-harness.sh` |
| 分析平台容器镜像配方（后端 runtime/migrate、前端 nginx 静态） | `apps/analytics-server/Dockerfile`、`apps/analytics-web/Dockerfile`、`apps/analytics-web/docker/nginx-web.conf` |
| release 环境 Agent 快速发版（查隧道 → push master → 等 CI → 上机 rsync） | `AGENTS.md`（实现专用规则） |
| 上报协议规范（协议 / 数据模型 / 用户标识口径 / 全语言实测记录 §9） | `docs/architecture/reporting-protocol.md` |
| 上报 SDK 全语言示例与验收器（go/php/python/nodejs/ruby/java/csharp/c/cpp/lua/js/miniprogram/react-native/android/ios/flutter/backfill + verify.sh；接入指南可一键下载各工程 zip） | `examples/report-sdk/` |
| 分析平台总体方案（调研结论） | `docs/architecture/analytics-extension-plan.md` |
| 分析平台 PRD（phase: clklog-analytics-v1） | `docs/product/prd-clklog-analytics-v1.md` |
| 分析平台 M2.1 PRD（埋点管理增强 + 虚拟属性） | `docs/product/prd-clklog-analytics-v1-m2.1.md` |
| 分析平台 M2.2 PRD（虚拟事件 OR/全局筛选 + 事件备注 + 事件属性面板） | `docs/product/prd-clklog-analytics-v1-m2.2.md` |
| 埋点管理详情编辑 PRD（列表只读 / 详情保存，phase: clklog-analytics-meta-detail-v1） | `docs/product/prd-clklog-analytics-meta-detail-v1.md` |
| Debug 实时查询 PRD（时间/计数口径修正 + 窗口可选 + 查询留档永久保存可删除，phase: clklog-analytics-debug-query-v1） | `docs/product/prd-clklog-analytics-debug-query-v1.md` |
| sa_events 跳数索引 PRD（设备/账号维度查询进秒级：bloom filter 取舍与验收判据，phase: clklog-analytics-sa-events-skip-index-v1） | `docs/product/prd-clklog-analytics-sa-events-skip-index-v1.md` |
| sa_events projection PRD（按人取最近的第二种排序 / 存储与写入成本上限，phase: clklog-analytics-sa-events-projection-v1） | `docs/product/prd-clklog-analytics-sa-events-projection-v1.md` |
| Debug 重查询异步化 PRD（两段式：快查询秒回 / 慢查询转后台 + 失败留痕，phase: clklog-analytics-debug-async-query-v1） | `docs/product/prd-clklog-analytics-debug-async-query-v1.md` |
| 调研：数数「行为序列」实现与我们已上线页面的对比（入口/三段结构/外显属性/前后行为与改版提案） | `docs/product/research-clklog-analytics-user-timeline-vs-thinkingdata.md` |
| 单用户行为序列 PRD（主体+标识+任意区间查该用户全部事件；归属/同口径/权限已定，phase: clklog-analytics-user-timeline-v1） | `docs/product/prd-clklog-analytics-user-timeline-v1.md` |
| 分析平台 M3 PRD（事件分析增强 + 漏斗分析） | `docs/product/prd-clklog-analytics-v1-m3.md` |
| 分析平台数据治理 PRD（一致性对拍 + 敏感数据清洗） | `docs/product/prd-clklog-analytics-v1-data-governance.md` |
| 告警通知渠道扩展调研（钉钉/企微/邮件/短信/Telegram/WhatsApp 的现成方案与选型，phase: clklog-analytics-alert-channels-v1） | `docs/product/research-clklog-analytics-alert-channels-v1.md` |
| 告警通道扩展 PRD（多通道 + 平台化配置 + 许可门禁，phase: clklog-analytics-alert-channels-v1） | `docs/product/prd-clklog-analytics-alert-channels-v1.md` |
| 告警通道配置指南（各通道申请步骤 / 限流与合并 / 手动测试清单，phase: clklog-analytics-alert-channels-v1） | `docs/product/guide-clklog-analytics-alert-channels-v1.md` |
| 告警通道扩展验收记录（13 通道 + 多联系人 + 保留策略的自动化门禁与生产实测，phase: clklog-analytics-alert-channels-v1） | `docs/project/acceptance-clklog-analytics-alert-channels-v1.md` |
| 告警邮件复用平台邮件通道验收记录（UX-7R-1~6 + 生产实测：真实告警邮件与测试邮件均投递成功；含 DI 元数据退化缺陷 AL-09，phase: clklog-analytics-account-lifecycle-v3 增补 v3.2 修订） | `docs/project/acceptance-clklog-analytics-platform-mail-fallback-2026-10-09.md` |
| 用户分群验收记录（试跑预估/列表重做/成员检索 + 看板引用/pending 回收/体限，release 实测 14+6 例，phase: clklog-analytics-user-segment-ux-v1、clklog-analytics-cohort-robustness-v1） | `docs/project/acceptance-clklog-analytics-user-segment-ux-v1.md` |
| 自定义 SQL 分析 PRD（布局/交互/错误/保存） | `docs/product/prd-clklog-analytics-sql-report-v1.md` |
| 看板 SQL 卡片 + 目录 API PRD（phase: clklog-dashboard-sql-cards-v1） | `docs/product/prd-clklog-dashboard-sql-cards-v1.md` |
| 图表可视化 PRD（phase: clklog-analytics-charts-v1） | `docs/product/prd-clklog-analytics-charts-v1.md` |
| 看板工作室 PRD（Grafana 排布 / 卡片缓存 / 标签卡，phase: clklog-analytics-dashboard-studio-v1） | `docs/product/prd-clklog-analytics-dashboard-studio-v1.md` |
| 看板卡片展示设置 PRD（标题可点 / 位置级样式，phase: clklog-analytics-dashboard-card-display-v1） | `docs/product/prd-clklog-analytics-dashboard-card-display-v1.md` |
| 分析工作台 + 留存 v1 PRD（窄配置栏 / 步骤卡片 / 留存查询，phase: clklog-analytics-workbench-v1） | `docs/product/prd-clklog-analytics-workbench-v1.md` |
| 分析卡片覆盖保存 / 另存为 PRD（phase: clklog-analytics-card-save-v1） | `docs/product/prd-clklog-analytics-card-save-v1.md` |
| 卡片生命周期与缓存健壮性 PRD（删除级联 / 孤儿容错 / 刷新失败退避，phase: clklog-analytics-card-lifecycle-v1） | `docs/product/prd-clklog-analytics-card-lifecycle-v1.md` |
| 趋势图 PRD（漏斗/留存/SQL 三页面接入 + 设置面板切换，phase: clklog-analytics-trend-chart-v1） | `docs/product/prd-clklog-analytics-trend-chart-v1.md` |
| 探索图扩展 PRD（事件多图 / 留存第N日与每日趋势 / 显示值 / 公式窄栏，phase: clklog-analytics-explore-charts-v1） | `docs/product/prd-clklog-analytics-explore-charts-v1.md` |
| 事件分析图表字段绑定 PRD（X 轴/拆分系列/指标可选 + 双 Y 轴 + 长标签可读，phase: clklog-analytics-event-chart-binding-v1，待评审） | `docs/product/prd-clklog-analytics-event-chart-binding-v1.md` |
| 自定义 SQL 折线图双 Y 轴 PRD（折线/趋势的轴归属 + 两轴各自单位，phase: clklog-analytics-sql-dual-axis-v1，待评审） | `docs/product/prd-clklog-analytics-sql-dual-axis-v1.md` |
| 运维面板 PRD（慢SQL / 服务器状态 / 监控告警，仅超管，phase: clklog-analytics-ops-console-v1） | `docs/product/prd-clklog-analytics-ops-console-v1.md` |
| 运维告警工作台 PRD（飞书通知 / 规则编辑器 / 屏蔽，phase: clklog-analytics-alerting-v1） | `docs/product/prd-clklog-analytics-alerting-v1.md` |
| 分析指标告警 + 邮件/短信 PRD（卡片缓存指标 / SMTP / 腾讯云 SMS，phase: clklog-analytics-alerting-v2） | `docs/product/prd-clklog-analytics-alerting-v2.md` |
| 告警可运维性 PRD（健康度 / 变更审计 / 投递重试 / 预测线告警，phase: clklog-analytics-alerting-v3） | `docs/product/prd-clklog-analytics-alerting-v3.md` |
| 告警 v4 PRD（指标告警重设计 + 通知模板，phase: clklog-analytics-alerting-v4） | `docs/product/prd-clklog-analytics-alerting-v4.md` |
| 接入指南 PRD（自包含 SDK 文档站 / 未适配入口，phase: clklog-analytics-onboarding-v2） | `docs/product/prd-clklog-analytics-onboarding-v2.md` |
| 指标查看与编辑 PRD（详情口径 / 就地编辑 / 名与类型只读，phase: clklog-analytics-metric-detail-v1） | `docs/product/prd-clklog-analytics-metric-detail-v1.md` |
| 指标 v2 PRD（与事件分析同深度口径 + 查询时间 + 取值选择 + 试算，phase: clklog-analytics-metric-v2） | `docs/product/prd-clklog-analytics-metric-v2.md` |
| 指标 v2 设计（definition_json v2 契约 / 求值口径 / 告警联动与兼容，phase: clklog-analytics-metric-v2） | `docs/architecture/clklog-analytics-design-metric-v2.md` |
| 指标 v3 PRD（留存队列范围 / 指标即卡片数据源 / 数值变换四则运算 / 时间面板，phase: clklog-analytics-metric-v3） | `docs/product/prd-clklog-analytics-metric-v3.md` |
| 指标 v3 设计（MetricTransform v2 / 队列窗口 / 指标卡契约 / 面板布局，phase: clklog-analytics-metric-v3） | `docs/architecture/clklog-analytics-design-metric-v3.md` |
| AI Workspace 项目隔离 PRD（仅新增 app 目录 / 切换项目读不同目录，phase: clklog-ai-workspace-project-isolation-v1） | `docs/product/prd-clklog-ai-workspace-project-isolation-v1.md` |
| AI 工作区入仓与双向同步 PRD（ai_workspace/default + app/<项目> / push-pull-diff，phase: clklog-ai-workspace-sync-v1） | `docs/product/prd-clklog-ai-workspace-sync-v1.md` |
| AI 模型供应商网页设置 PRD（设置页增删改供应商/密钥/默认模型 + 从配置文件导入，phase: clklog-ai-model-providers-v1） | `docs/product/prd-clklog-ai-model-providers-v1.md` |
| AI 工作区同步验收记录（双向实测 / 迁移 / SY-01~04 脚本修复 / 回拉仓库，phase: clklog-ai-workspace-sync-v1） | `docs/project/acceptance-clklog-ai-workspace-sync-v1.md` |
| AI 模型供应商网页设置验收记录（发版 17525 / 迁移与建表 / 接口挂载 / 人工待办，phase: clklog-ai-model-providers-v1） | `docs/project/acceptance-clklog-ai-model-providers-v1.md` |
| AI Workspace 项目隔离验收记录（A/B 双向不可见 / 权限 / broker 守门 / harness 发版缺口，phase: clklog-ai-workspace-project-isolation-v1） | `docs/project/acceptance-clklog-ai-workspace-project-isolation-v1.md` |
| 数据管理 PRD（存储盘点 / 清理预演 / TTL / 动作审计，phase: clklog-analytics-data-management-v1，2026-09-15 回补） | `docs/product/prd-clklog-analytics-data-management-v1.md` |
| 数据质量 × 数据运维 关系调研（对拍生产实测 / 保留策略错配 / 三阶段计划，phase: clklog-data-quality-ops-v1） | `docs/product/research-clklog-data-quality-ops-v1.md` |
| 数据质量 × 数据运维 PRD（R1 可信化 / R2 闭环 / R3 灵敏度，含 12 条验收，phase: clklog-data-quality-ops-v1） | `docs/product/prd-clklog-data-quality-ops-v1.md` |
| 对拍口径白皮书（1.22% 日总量差的归因：Top20 差异占 93.3% / 单向正差 / CRC 重复 0.054% / 阈值建议 3%，phase: clklog-data-quality-ops-v1 R3-a） | `docs/product/research-clklog-reconcile-caliber-v1.md` |
| 数据质量页 IA 与自解释 PRD（迁到运维层 + 页面说明区，phase: clklog-data-quality-ops-ia-v1） | `docs/product/prd-clklog-data-quality-ops-ia-v1.md` |
| 数据清理 v1.2 PRD（定点删除 ALTER DELETE / 未登记事件 / 项目退役，phase: clklog-data-management-v1.2） | `docs/product/prd-clklog-data-management-v1.2.md` |
| 数据质量 × 数据运维 设计（配置表 / 清理登记 / 可信区间 / 定时与前置对拍契约，phase: clklog-data-quality-ops-v1） | `docs/architecture/clklog-analytics-design-data-quality-ops-v1.md` |
| 数据质量页 IA 与自解释 设计（路由/菜单/权限/i18n 命名空间迁移与说明区结构，phase: clklog-data-quality-ops-ia-v1） | `docs/architecture/clklog-analytics-design-quality-ops-ia-v1.md` |
| 数据清理 v1.2 设计（条件白名单 / token / 备份 / 台账联动 / 未登记事件差集，phase: clklog-data-management-v1.2） | `docs/architecture/clklog-analytics-design-data-management-v1.2.md` |
| 分析结果设置齿轮 PRD（漏斗转化率/流失率，phase: clklog-analytics-result-settings-v1） | `docs/product/prd-clklog-analytics-result-settings-v1.md` |
| 事件分析近似计算 PRD（uniqCombined，phase: clklog-analytics-approx-compute-v1） | `docs/product/prd-clklog-analytics-approx-compute-v1.md` |
| 漏斗分析步骤上限 PRD（2~32，phase: clklog-analytics-funnel-steps-v1） | `docs/product/prd-clklog-analytics-funnel-steps-v1.md` |
| 漏斗结果横纵布局与阈值配色 PRD（phase: clklog-analytics-funnel-display-v1） | `docs/product/prd-clklog-analytics-funnel-display-v1.md` |
| 漏斗步骤插入排序与结果表两行 PRD（phase: clklog-analytics-funnel-edit-table-v1） | `docs/product/prd-clklog-analytics-funnel-edit-table-v1.md` |
| 多语言（i18n）PRD（语言集与上线门槛 / 切换入口体验 / 通知按接收者语言 / 翻什么不翻什么，phase: clklog-analytics-i18n-v1） | `docs/product/prd-clklog-analytics-i18n-v1.md` |
| 分析补齐 PRD（任意事件/创建指标/虚拟事件属性，phase: clklog-analytics-analysis-complete-v1） | `docs/product/prd-clklog-analytics-analysis-complete-v1.md` |
| 分析能力差异（ClkLog vs 神策 vs 数数，活文档；事件分析 + 用户分群 + 权限管理 + 数据表已调研） | `docs/product/gap-clklog-analytics-vs-thinkingdata.md` |
| 用户分群调研（神策/数数） | `docs/product/research-clklog-analytics-user-segment.md` |
| 用户分群 v1 PRD（条件/ID/结果 + 分析筛选分组，phase: clklog-analytics-user-segment-v1） | `docs/product/prd-clklog-analytics-user-segment-v1.md` |
| 用户分群后续 PRD（标签 / SQL 分群 / 分析主体 / SQL 与看板） | `docs/product/prd-clklog-analytics-user-segment-followups.md` |
| 用户分群体验优化与健壮性 PRD（试跑预估 / 列表重做 / 类型卡；ID 重传 / 引用检查 / pending 回收，phase: clklog-analytics-user-segment-ux-v1、clklog-analytics-cohort-robustness-v1） | `docs/product/prd-clklog-analytics-user-segment-ux-v1.md` |
| 分析主体生产冒烟（AS-1～AS-5，只读+可清理临时主体） | `scripts/smoke-analysis-subject.py` |
| 时区系统 v1 生产闭环冒烟（T1-T6 九项验收用例） | `scripts/smoke-timezone-v1.py` |
| 时区系统 v2 生产闭环冒烟（SC-1/2/3/5 十三项：用户偏好 / 项目时区 / 通知按收件人时区） | `scripts/smoke-timezone-v2.py` |
| 时区系统 v2 生产验收（CI 拦截复盘 / 迁移三列 / SC 对照，phase: clklog-analytics-timezone-v2） | `docs/project/acceptance-clklog-analytics-timezone-v2.md` |
| 时区系统 v1 生产验收（发版链路 / ZQ-1 生产例证 / SC 对照 / AS-2 遗留登记，phase: clklog-analytics-timezone-v1） | `docs/project/acceptance-clklog-analytics-timezone-v1.md` |
| 事件分析靠拢数数 PRD（phase: clklog-analytics-event-td-align-v1） | `docs/product/prd-clklog-analytics-event-td-align-v1.md` |
| 壳层多分辨率适配 PRD（先收菜单再收 Harness / 禁止竖字，phase: clklog-analytics-shell-responsive-v1） | `docs/product/prd-clklog-analytics-shell-responsive-v1.md` |
| 用户/权限体系 PRD（P1 登录 + 全局三角色） | `docs/product/prd-clklog-analytics-user-rbac-v1.md` |
| 权限管理调研（主流 RBAC/ABAC + 神策/数数） | `docs/product/research-clklog-analytics-rbac.md` |
| 成员生命周期调研（GitLab/Grafana/Metabase 对标 + 账号体系缺陷清单与改进路径：邮箱/找回/邀请/锁定/审计） | `docs/product/research-clklog-analytics-member-lifecycle.md` |
| 账号生命周期 v1 PRD（email/密码策略/登录锁定/用户管理页/审计，phase: clklog-analytics-account-lifecycle-v1） | `docs/product/prd-clklog-analytics-account-lifecycle-v1.md` |
| 账号生命周期 v2 PRD（邮件通道+网页SMTP配置 v1.1，phase: clklog-analytics-account-lifecycle-v2） | `docs/product/prd-clklog-analytics-account-lifecycle-v2.md` |
| 账号生命周期 v3 PRD（成员有效期/休眠标记/会话管理，phase: clklog-analytics-account-lifecycle-v3） | `docs/product/prd-clklog-analytics-account-lifecycle-v3.md` |
| 数据表 / 维度表调研（神策维度表+维度字典 / 数数数据表+维度表属性） | `docs/product/research-clklog-analytics-dimension-table.md` |
| 数据表（维度表）v1 PRD（CSV 上传 / 增量替换 / 关联属性 / 限额，phase: clklog-analytics-datatable-v1） | `docs/product/prd-clklog-analytics-datatable-v1.md` |
| 数据表（维度表）实现方案（版本化快照 / 租约 / 结果集值映射；Gate 0 实测：相关子查询不可用、JOIN 可用） | `docs/architecture/clklog-analytics-design-datatable-v1.md` |
| 数据表（维度表）v2 PRD（跨表维度：`{属性}@{字段}` 分组筛选聚合，phase: clklog-analytics-datatable-v2） | `docs/product/prd-clklog-analytics-datatable-v2.md` |
| 数据表（维度表）v2 实现方案（定案 JOIN 注入 / 属性名契约 / 性能门槛；含字典探针实测） | `docs/architecture/clklog-analytics-design-datatable-v2.md` |
| 用户属性查询路径修复 PRD（生产缺陷：表缺列 + 相关子查询不可用，phase: clklog-user-property-path-v1） | `docs/product/prd-clklog-user-property-path-v1.md` |
| 用户属性查询路径修复实现方案（表结构迁移 / 写入补列 / JoinRegistry） | `docs/architecture/clklog-analytics-design-user-property-path-v1.md` |
| 数据表 Gate 0 生产探测复盘（含 OVERRIDE-REASON） | `docs/project/retrospective-datatable-gate0-2026-09-14.md` |
| 账号生命周期 v1/v2/v3 测试报告（四层测试流程 + 验收用例矩阵 + 部署验证 + 复盘） | `docs/project/test-report-account-lifecycle-2026-09-18.md` |
| Debug 实时查询生产测试报告（对拍 ClickHouse / 时间列 +8h / 分页计数误导 / distinct_id·user_key 重扫超时） | `docs/project/test-report-debug-query-2026-10-08.md` |
| Debug 实时查询验收记录（发版 17648 / 时间与计数口径 / 窗口与裁剪 / 留档与开关，AC-1~AC-12，phase: clklog-analytics-debug-query-v1） | `docs/project/acceptance-clklog-analytics-debug-query-v1.md` |
| sa_events 跳数索引验收记录（演练 vs 生产差异 / 索引保留但未达秒级 / 切片方法学教训，IX-1~IX-7，phase: clklog-analytics-sa-events-skip-index-v1） | `docs/project/acceptance-clklog-analytics-sa-events-skip-index-v1.md` |
| sa_events projection 结论记录（机制已验证 / 磁盘容量装不下故不上线 / 两次方法论纠错与四条可选路线，phase: clklog-analytics-sa-events-projection-v1） | `docs/project/validation-clklog-analytics-sa-events-projection-v1.md` |
| Debug 重查询异步化验收记录（发版 17652 / AS-1~AS-8 / 留档清单 / 开关不落痕修复，phase: clklog-analytics-debug-async-query-v1） | `docs/project/acceptance-clklog-analytics-debug-async-query-v1.md` |
| CI 提速验收记录（发版 17678 / 文档提交跳过构建 + Node 归档进 cache + 前端 tsc 增量与漏检复验，phase: clklog-ci-speedup-v1） | `docs/project/acceptance-clklog-ci-speedup-v1.md` |
| 项目空间权限 PRD（成员/组/五角色/数据权限/看板文件夹/资产锁定，phase: clklog-analytics-rbac-v2） | `docs/product/prd-clklog-analytics-rbac-v2.md` |
| 项目权限口径修正 PRD（选择器与治理分离 / 指标归属，phase: clklog-analytics-rbac-v3） | `docs/product/prd-clklog-analytics-rbac-v3.md` |
| AI 数据分析助手 PRD（完整 Harness + 多供应商 + Workspace/模板同步 + Page Bridge） | `docs/product/prd-clklog-ai-analytics-v1.md` |
| AI Workspace 后训练、迁移与四类分析 PRD | `docs/product/prd-clklog-ai-workspace-v1.md` |
| Harness 填充 SQL 图表字段绑定 PRD（phase: clklog-ai-sql-chart-v1） | `docs/product/prd-clklog-ai-sql-chart-v1.md` |
| Harness 读写事件分析图表配置 PRD（读快照 + 提案待确认；phase: clklog-ai-event-chart-v1，待评审） | `docs/product/prd-clklog-ai-event-chart-v1.md` |
| Harness 读写自定义 SQL 图表编排（分轴与单位）PRD（读 analysis.chart_config + 写 options.metric_axis，phase: clklog-ai-sql-chart-axis-v1，待评审） | `docs/product/prd-clklog-ai-sql-chart-axis-v1.md` |
| 后台调度单写者与非生产不调度 PRD（只有生产 server 跑调度，phase: clklog-analytics-worker-singleton-v1，待评审） | `docs/product/prd-clklog-analytics-worker-singleton-v1.md` |
| 轴内单位一致 PRD（双轴之后「同一根轴」才要求同单位 + 一键按单位拆轴，phase: clklog-analytics-axis-unit-coherence-v1，待评审） | `docs/product/prd-clklog-analytics-axis-unit-coherence-v1.md` |
| AI 面板两种面 PRD（对话面 vs 第三方弹窗面：按需扩宽覆盖层并自动还原，phase: clklog-analytics-ai-panel-surface-v1，待评审） | `docs/product/prd-clklog-analytics-ai-panel-surface-v1.md` |
| 分析时间范围静态/动态 PRD（数数口径，phase: clklog-analytics-time-range-v1） | `docs/product/prd-clklog-analytics-time-range-v1.md` |
| 时区系统调研（作用域/全链路时区事实/ZQ-1～8 风险/神策数数对标，phase: clklog-analytics-timezone-v1） | `docs/product/research-clklog-analytics-timezone-v1.md` |
| 时区系统 v1 PRD（平台时区 + 查询口径时区化，phase: clklog-analytics-timezone-v1） | `docs/product/prd-clklog-analytics-timezone-v1.md` |
| 时区系统 v1 实现方案（time 窄包 SSOT / TimeScope 宽扫+epoch 精切 / 桶 tz 参数化 / ZQ 清零分批） | `docs/architecture/clklog-analytics-design-timezone-v1.md` |
| 时区系统 v2 PRD（用户偏好 / 项目级 / 通知按收件人时区，phase: clklog-analytics-timezone-v2） | `docs/product/prd-clklog-analytics-timezone-v2.md` |
| 时区系统 v2 实现方案（解析链四级 / 项目时区注册表 / 三列迁移 / 收件人预览） | `docs/architecture/clklog-analytics-design-timezone-v2.md` |
| 事件分析序号 / 金额聚合 / 看板与壳层 UX PRD（phase: clklog-analytics-ux-polish-v1） | `docs/product/prd-clklog-analytics-ux-polish-v1.md` |
| 分析图单位 / SQL 缓存回填 / 纯色与图例独立显示 PRD（phase: clklog-analytics-chart-units-v1） | `docs/product/prd-clklog-analytics-chart-units-v1.md` |
| thinkingdata 移植清单、数据取得、四类纵切与稳定性契约 | `docs/architecture/clklog-ai-workspace-design.md` |
| ThinkingData 知识迁移与线上证据 | `docs/project/migration-thinkingdata-ai-workspace.md` |
| 外部分析经验迁移（产品材料已删除） | `docs/project/migration-thinkingdata-ai-workspace.md` |
| Harness 线上验收接手续办 | `docs/project/handoff-harness-live-acceptance.md` |
| Harness 会话日志损坏修复（seq 稠密性检查 / 删重复空 marker / 帧规则重压） | `scripts/repair-session-log.py` |
| AI Workspace 本地验收与上线待验项 | `docs/project/validation-clklog-ai-workspace-v1.md` |
| AI 工作区内容（模板 default + 项目空间 app，与运行时同构） | `ai_workspace/` |
| AI 工作区双向同步脚本（init/push/pull/diff/status/migrate/--self-test） | `scripts/ai-workspace-sync.sh` |
| Harness Workspace 规则与案例 | `ai_workspace/default/AGENTS.md`、`ai_workspace/default/tools/analysis-playbook.md` |
| AI Workspace 合成 ClickHouse / 浏览器验证 | `apps/analytics-server/test/ai-workspace/` |
| AI Harness 会话保活 / 同账号多窗口（phase: clklog-ai-harness-session-v1） | `docs/product/prd-clklog-ai-analytics-v1.md` §13、`docs/architecture/clklog-ai-analytics-design.md` §20 |
| 代码审计问题登记（CODE_HANDOVER，阶段性审计/调试遗留） | `CODE_HANDOVER.md` |
| 分析平台前端原型图 | `docs/product/wireframes-clklog-analytics-v1.md` |
| 前端视觉资产清单与风格定义（phase: clklog-analytics-visual-assets-v1） | `docs/product/design-visual-assets-clklog-analytics-v1.md` |
| 分析平台实现方案（DSL/API/表结构/ID 契约） | `docs/architecture/clklog-analytics-design.md` |
| 分析平台 M2.1 实现方案 | `docs/architecture/clklog-analytics-design-m2.1.md` |
| 分析平台 M2.2 实现方案 | `docs/architecture/clklog-analytics-design-m2.2.md` |
| 埋点管理详情编辑实现方案 | `docs/architecture/clklog-analytics-design-meta-detail-v1.md` |
| Debug 实时查询实现方案（D1–D4 修复 + 留档表/接口/权限/体积上限，phase: clklog-analytics-debug-query-v1） | `docs/architecture/clklog-analytics-design-debug-query-v1.md` |
| sa_events 跳数索引实现方案（DDL/幂等迁移/演练与生产实测/方法学教训，phase: clklog-analytics-sa-events-skip-index-v1） | `docs/architecture/clklog-analytics-design-sa-events-skip-index-v1.md` |
| sa_events projection 实现方案（机制实测 19× / 成本实测 / 容量结论与四条可选路线，phase: clklog-analytics-sa-events-projection-v1） | `docs/architecture/clklog-analytics-design-sa-events-projection-v1.md` |
| Debug 重查询异步化实现方案（两段式契约 / 状态机 / worker 策略 / 回滚路径，phase: clklog-analytics-debug-async-query-v1） | `docs/architecture/clklog-analytics-design-debug-async-query-v1.md` |
| 单用户行为序列实现方案（复用主体表达式/时间渲染/两段式与记录表、SQL 形状与 i18n 计划，phase: clklog-analytics-user-timeline-v1） | `docs/architecture/clklog-analytics-design-user-timeline-v1.md` |
| 单用户行为序列验收记录（发版 17658→17660 / UT-1~UT-10 / 验收抓出的两处缺陷与复验，phase: clklog-analytics-user-timeline-v1） | `docs/project/acceptance-clklog-analytics-user-timeline-v1.md` |
| 分析平台 M3 实现方案 | `docs/architecture/clklog-analytics-design-m3.md` |
| 分析平台数据治理实现方案（对拍 SQL 契约 + 清洗流程/权限边界） | `docs/architecture/clklog-analytics-design-data-governance.md` |
| 自定义 SQL 分析实现方案（布局/数据字典/分组筛选/属性引用/安全） | `docs/architecture/clklog-analytics-design-sql-report.md` |
| 看板 SQL 卡片 + 目录 API 实现方案 | `docs/architecture/clklog-analytics-design-dashboard-sql-cards-v1.md` |
| 图表可视化实现方案（字段角色/推荐/配置契约/保存复现） | `docs/architecture/clklog-analytics-design-charts-v1.md` |
| 看板工作室实现方案（网格/缓存表/worker/标签卡 DSL） | `docs/architecture/clklog-analytics-design-dashboard-studio-v1.md` |
| 看板卡片展示设置实现方案（display_json / 标题进入，phase: clklog-analytics-dashboard-card-display-v1） | `docs/architecture/clklog-analytics-design-dashboard-card-display-v1.md` |
| 分析工作台 + 留存 v1 实现方案（布局/RetentionQuery SQL/漏斗 IN 收窄） | `docs/architecture/clklog-analytics-design-workbench-v1.md` |
| 分析卡片覆盖保存 / 另存为实现方案 | `docs/architecture/clklog-analytics-design-card-save-v1.md` |
| 卡片生命周期与缓存健壮性实现方案（级联清理 / 两段查询装配 / 失败退避） | `docs/architecture/clklog-analytics-design-card-lifecycle-v1.md` |
| 用户属性关联 JOIN 修复方案（scope=user 项目条件，phase: clklog-user-property-join-v1） | `docs/architecture/clklog-analytics-design-user-property-join-v1.md` |
| 运维面板实现方案（慢SQL / 服务器状态 / 监控告警，phase: clklog-analytics-ops-console-v1，仅超管，已实现并上线） | `docs/architecture/clklog-analytics-design-ops-console-v1.md` |
| 运维告警工作台实现方案（规则窗口 / 飞书 / 屏蔽，phase: clklog-analytics-alerting-v1） | `docs/architecture/clklog-analytics-design-alerting-v1.md` |
| 分析指标告警 + 邮件/短信实现方案（卡片缓存 / 通道分发，phase: clklog-analytics-alerting-v2） | `docs/architecture/clklog-analytics-design-alerting-v2.md` |
| 告警可运维性实现方案（健康度判定 / 审计复用 / 重试与防重入 / 磁盘外推，phase: clklog-analytics-alerting-v3） | `docs/architecture/clklog-analytics-design-alerting-v3.md` |
| 告警 v4 实现方案（指标求值口径 / 模板引擎子集 / 参数规范化，phase: clklog-analytics-alerting-v4） | `docs/architecture/clklog-analytics-design-alerting-v4.md` |
| 接入指南实现方案（内容模型 / 抽屉交互 / 内容契约测试，phase: clklog-analytics-onboarding-v2） | `docs/architecture/clklog-analytics-design-onboarding-v2.md` |
| 指标查看与编辑实现方案（摘要与载荷纯函数 / 后端定义合并语义，phase: clklog-analytics-metric-detail-v1） | `docs/architecture/clklog-analytics-design-metric-detail-v1.md` |
| 趋势图实现方案（时间轴 + 回归外推 + 阈值推演；运维面板磁盘预估的前置，phase: clklog-analytics-trend-chart-v1，待评审） | `docs/architecture/clklog-analytics-design-trend-chart-v1.md` |
| 探索图扩展实现方案（explore-charts / 显示值 / 留存两种趋势，phase: clklog-analytics-explore-charts-v1） | `docs/architecture/clklog-analytics-design-explore-charts-v1.md` |
| 事件分析图表字段绑定实现方案（服务端列角色 / ChartConfigV1 扩展双轴 / 系列透视 / 新包 features/event-chart，phase: clklog-analytics-event-chart-binding-v1，待评审） | `docs/architecture/clklog-analytics-design-event-chart-binding-v1.md` |
| 自定义 SQL 折线图双 Y 轴实现方案（line/trend adapter 加轴 + 字段面板放开轴控件，phase: clklog-analytics-sql-dual-axis-v1，待评审） | `docs/architecture/clklog-analytics-design-sql-dual-axis-v1.md` |
| 分析结果设置齿轮实现方案 | `docs/architecture/clklog-analytics-design-result-settings-v1.md` |
| 事件分析近似计算实现方案（仅去重类 uniqCombined，phase: clklog-analytics-approx-compute-v1） | `docs/architecture/clklog-analytics-design-approx-compute-v1.md` |
| 漏斗分析步骤上限实现方案 | `docs/architecture/clklog-analytics-design-funnel-steps-v1.md` |
| 漏斗结果横纵布局与阈值配色实现方案 | `docs/architecture/clklog-analytics-design-funnel-display-v1.md` |
| 漏斗步骤插入排序与结果表两行实现方案 | `docs/architecture/clklog-analytics-design-funnel-edit-table-v1.md` |
| 分析补齐实现方案（任意事件/创建指标/虚拟事件属性） | `docs/architecture/clklog-analytics-design-analysis-complete-v1.md` |
| 用户分群 v1 实现方案（预计算成员 + 分析筛选分组） | `docs/architecture/clklog-analytics-design-user-segment-v1.md` |
| 用户分群后续实现方案（标签 / SQL 分群 / 分析主体 / SQL 与看板） | `docs/architecture/clklog-analytics-design-user-segment-followups.md` |
| 用户分群体验优化与健壮性实现方案（试跑端点 / 成员检索 / 摘要渲染；重传名单 / 看板引用 / pending 回收，phase: clklog-analytics-user-segment-ux-v1、clklog-analytics-cohort-robustness-v1） | `docs/architecture/clklog-analytics-design-user-segment-ux-v1.md` |
| 事件分析靠拢数数实现方案（phase: clklog-analytics-event-td-align-v1） | `docs/architecture/clklog-analytics-design-event-td-align-v1.md` |
| 壳层多分辨率适配实现方案（档位常量 / resolveShellLayout，phase: clklog-analytics-shell-responsive-v1） | `docs/architecture/clklog-analytics-design-shell-responsive-v1.md` |
| 用户/权限体系实现方案（P1 登录/token/资产 owner） | `docs/architecture/clklog-analytics-design-user-rbac.md` |
| 账号生命周期 v1 实现方案（SaUser 加列/锁定算法/审计 auth_/强制改密，phase: clklog-analytics-account-lifecycle-v1） | `docs/architecture/clklog-analytics-design-account-lifecycle-v1.md` |
| 账号生命周期 v2 实现方案（AUTH_SMTP/令牌/邀请/网页配置存储 v1.1，phase: clklog-analytics-account-lifecycle-v2） | `docs/architecture/clklog-analytics-design-account-lifecycle-v2.md` |
| 账号生命周期 v3 实现方案（expires_at 过滤点/会话端点/契约，phase: clklog-analytics-account-lifecycle-v3） | `docs/architecture/clklog-analytics-design-account-lifecycle-v3.md` |
| 项目空间权限实现方案（成员表/权限码/文件夹/AssetPolicy，phase: clklog-analytics-rbac-v2） | `docs/architecture/clklog-analytics-design-rbac-v2.md` |
| 项目权限口径修正实现方案（meta.picker.view 选择器清单 / 指标归属判定，phase: clklog-analytics-rbac-v3） | `docs/architecture/clklog-analytics-design-rbac-v3.md` |
| AI 数据分析助手架构（Harness Host/Runtime 隔离/Workspace 模板同步/Page Bridge） | `docs/architecture/clklog-ai-analytics-design.md` |
| Harness 填充 SQL 图表字段绑定实现方案（phase: clklog-ai-sql-chart-v1） | `docs/architecture/clklog-ai-analytics-design-sql-chart-v1.md` |
| Harness 读写事件分析图表配置实现方案（快照增量 / analysis_chart_edit 按域分派 / 提案条，phase: clklog-ai-event-chart-v1，待评审） | `docs/architecture/clklog-ai-analytics-design-event-chart-v1.md` |
| Harness 读写自定义 SQL 图表编排实现方案（SQL 域 options 白名单补 metric_axis / 能力自述补 options_keys / options 整键替换语义，phase: clklog-ai-sql-chart-axis-v1，待评审） | `docs/architecture/clklog-ai-analytics-design-sql-chart-axis-v1.md` |
| 后台调度单写者实现方案（判据收窄到生产 server / 三个 @Cron 补守卫 / 启动摘要，phase: clklog-analytics-worker-singleton-v1，待评审） | `docs/architecture/clklog-analytics-design-worker-singleton-v1.md` |
| 轴内单位一致实现方案（按轴分组判定 / 混单位轴刻度退化 / splitMetricsByUnit / Harness 单位词表，phase: clklog-analytics-axis-unit-coherence-v1，待评审） | `docs/architecture/clklog-analytics-design-axis-unit-coherence-v1.md` |
| AI 面板两种面实现方案（HARNESS_DIALOG_MIN / shim 观察官方弹层 / 面板扩宽状态机，phase: clklog-analytics-ai-panel-surface-v1，待评审） | `docs/architecture/clklog-analytics-design-ai-panel-surface-v1.md` |
| AI 模型供应商网页设置实现方案（库优先合成 / 密钥密文 / revision 惰性生效 / 测试连接，phase: clklog-ai-model-providers-v1） | `docs/architecture/clklog-ai-analytics-design-model-providers-v1.md` |
| 分析时间范围静态/动态实现方案（phase: clklog-analytics-time-range-v1） | `docs/architecture/clklog-analytics-design-time-range-v1.md` |
| 事件分析序号 / 金额聚合 / 看板与壳层 UX 实现方案（phase: clklog-analytics-ux-polish-v1） | `docs/architecture/clklog-analytics-design-ux-polish-v1.md` |
| 分析图单位 / SQL 缓存回填 / 纯色与图例独立显示实现方案（phase: clklog-analytics-chart-units-v1） | `docs/architecture/clklog-analytics-design-chart-units-v1.md` |
| 卡片与看板描述 / 名称唯一 / 列表信息降噪实现方案（phase: clklog-analytics-asset-description-v1） | `docs/architecture/clklog-analytics-design-asset-description-v1.md` |
| 视觉资产实现方案（BrandLogo / EmptyState / Favicon，phase: clklog-analytics-visual-assets-v1） | `docs/architecture/clklog-analytics-design-visual-assets-v1.md` |
| 国际化（i18n）多语言实现方案（语言集/解析链/键命名/后端错误码契约/覆盖率棘轮，phase: clklog-analytics-i18n-v1） | `docs/architecture/clklog-analytics-design-i18n-v1.md` |
| i18n 覆盖率棘轮（待翻译中文文案只减不增；--report / --check / --update） | `scripts/i18n_scan.py` |
| i18n 资源一致性校验（键集合 / 占位符 / 残留中文 / 键存在性 / 禁止直连实例） | `scripts/i18n_check.py` |
| i18n 待翻译文案 AST 提取（上下文与作用域分布，用于派工与分析） | `scripts/i18n_extract.mjs` |
| i18n 术语表（zh-CN / en-US / zh-TW / ja-JP / ko-KR 五语对照 + 新增语言检查清单） | `docs/architecture/i18n-glossary.md` |
| i18n 翻译工作流（导出待译 CSV / 回填语言资源） | `scripts/i18n_export.py` |
| i18n 首发验收记录（zh-CN + en-US 交付清单 / 闭环证据 / 残留课题，phase: clklog-analytics-i18n-v1） | `docs/project/acceptance-clklog-analytics-i18n-v1.md` |
| i18n 覆盖率基线（待翻译文案只减不增的数据） | `scripts/i18n-baseline.json` |
| 分析平台实现拆包（前后端任务/验收点） | `docs/architecture/implementation-breakdown-clklog-analytics-v1.md` |
| 分析平台项目计划（排期/里程碑/风险） | `docs/project/plan-clklog-analytics-v1.md` |
| 分析平台阶段 1（P0）验收记录 | `docs/project/acceptance-clklog-analytics-p0.md` |
| 分析平台阶段 2（M2 MVP）验收记录 | `docs/project/acceptance-clklog-analytics-v1-m2.md` |
| 分析平台阶段 2.1（M2.1 埋点管理增强 + 虚拟属性）验收记录 | `docs/project/acceptance-clklog-analytics-v1-m2.1.md` |
| 分析平台阶段 2.2（M2.2 埋点管理进阶）验收记录 | `docs/project/acceptance-clklog-analytics-v1-m2.2.md` |
| 分析平台 M3（事件分析增强 + 漏斗分析）验收记录 | `docs/project/acceptance-clklog-analytics-v1-m3.md` |
| SQL 图表可视化验收记录（phase: clklog-analytics-charts-v1） | `docs/project/acceptance-clklog-analytics-charts-v1.md` |
| 事件分析图表字段绑定验收记录（含发版记录 17535→17548、验收发现并修复的线上回归；phase: clklog-analytics-event-chart-binding-v1） | `docs/project/acceptance-clklog-analytics-event-chart-binding-v1.md` |
| AI 读写事件图表配置验收记录（版本 17552；AI 端到端已于 §5.1 补跑通过；phase: clklog-ai-event-chart-v1） | `docs/project/acceptance-clklog-ai-event-chart-v1.md` |
| 自定义 SQL 折线图双 Y 轴验收记录（版本 17576；两轴各自量程与单位；phase: clklog-analytics-sql-dual-axis-v1） | `docs/project/acceptance-clklog-analytics-sql-dual-axis-v1.md` |
| Harness 读写 SQL 图表编排验收记录（版本 17579→17580；两页读编排 + 两侧写编排 + 挖出并修复的 action 名回归；phase: clklog-ai-sql-chart-axis-v1） | `docs/project/acceptance-clklog-ai-sql-chart-axis-v1.md` |
| 后台调度单写者验收记录（版本 17582；含本地残留实例事故、清理与生产两进程启动摘要；phase: clklog-analytics-worker-singleton-v1） | `docs/project/acceptance-clklog-analytics-worker-singleton-v1.md` |
| 轴内单位一致验收记录（版本 17591；线上实测按轴点名 + 一键拆轴只搬一个指标；phase: clklog-analytics-axis-unit-coherence-v1） | `docs/project/acceptance-clklog-analytics-axis-unit-coherence-v1.md` |
| AI 面板两种面验收记录（版本 17596→17600；官方弹窗自动扩宽 499→1472 并还原、会话不重建、窄视口如实提示；phase: clklog-analytics-ai-panel-surface-v1） | `docs/project/acceptance-clklog-analytics-ai-panel-surface-v1.md` |
| 运维告警验收记录（线上端到端实测 / 通知与屏蔽实测 / 待修缺陷，phase: clklog-analytics-alerting-v1+v2） | `docs/project/acceptance-clklog-analytics-alerting-v1.md` |
| 告警可运维性验收记录（健康度 / 审计 / 重试实测 / 预测线规则，phase: clklog-analytics-alerting-v3） | `docs/project/acceptance-clklog-analytics-alerting-v3.md` |
| 指标告警与通知模板验收记录（500 根因复测 / 求值对拍 / 模板六组合实测，phase: clklog-analytics-alerting-v4） | `docs/project/acceptance-clklog-analytics-alerting-v4.md` |
| 接入指南验收记录（三组入口 / 文档完整度 / 内容契约，phase: clklog-analytics-onboarding-v2） | `docs/project/acceptance-clklog-analytics-onboarding-v2.md` |
| 接入指南 SDK 全语言实测与状态翻牌（17 类语言/端落库实测 + Flutter Web 浏览器验证 + 批量回补 CLI + 演示工程下载 + 三档状态，扩展 phase: clklog-analytics-onboarding-v2） | `docs/project/acceptance-clklog-analytics-sdk-verified-v1.md` |
| 指标查看与编辑验收记录（部分更新保留 filters / 空事件校验 / 两处后端修复，phase: clklog-analytics-metric-detail-v1） | `docs/project/acceptance-clklog-analytics-metric-detail-v1.md` |
| 运维收尾与安全加固验收记录（SEC-01 / F2 / F3 / 死代码 / 渲染验收，phase: clklog-analytics-ops-hardening-v1） | `docs/project/acceptance-clklog-analytics-ops-hardening-v1.md` |
| 数据表 v2 跨表维度验收记录（A1–A11 生产对拍 / A7 修复 / CI 全量单测，phase: clklog-analytics-datatable-v2） | `docs/project/acceptance-clklog-analytics-datatable-v2.md` |
| 数据管理清理执行流验收记录（权限/盘点/预演/护栏/审计 + B1–B7，phase: clklog-analytics-data-management-v1） | `docs/project/acceptance-clklog-analytics-data-management-v1.md` |
| 数据质量 × 数据运维验收记录（R1 自动对拍产线实测 / 发版崩溃事故复盘 / R2 保留策略与可信区间只读核验 / AC-1~AC-12 逐条状态，phase: clklog-data-quality-ops-v1） | `docs/project/acceptance-clklog-data-quality-ops-v1.md` |
| 数据质量页 IA 与自解释验收记录（迁移菜单/路由/命名空间 + 说明区，含旧路径跳转缺陷与越权收紧回退，phase: clklog-data-quality-ops-ia-v1） | `docs/project/acceptance-clklog-data-quality-ops-ia-v1.md` |
| 数据清理 v1.2 验收记录（定点删除/未登记事件/项目退役，含 6 处实施缺陷与 R4-b 演练，V12-AC1~AC8，phase: clklog-data-management-v1.2） | `docs/project/acceptance-clklog-data-management-v1.2.md` |
| 敏感数据清洗验收记录（五步门禁 / 账号权限 / 演练阻断 / 合规边界，phase: clklog-analytics-v1-data-governance） | `docs/project/acceptance-clklog-analytics-v1-data-governance.md` |
| AI 数据分析助手复盘与临时密钥红线覆盖 | `docs/project/retrospective-clklog-ai-analytics-v1-2026-09-01.md` |
| 看板 SQL 卡片全量审计 | `docs/project/sql-card-audit-clklog-dashboard-sql-cards-v1.md` |
| 分析平台后端源码（NestJS + TS） | `apps/analytics-server/` |
| 分析平台后端服务器配置模板 | `apps/analytics-server/config_server.yaml` |
| 分析平台本地开发环境变量示例 | `apps/analytics-server/.env.example` |
| 分析平台前端源码（React + TS） | `apps/analytics-web/` |
| 隔离 Harness Host（官方 Web Profile + ClkLog 工具） | `apps/analytics-harness-host/` |
| rootless Podman Runtime Broker | `apps/analytics-harness-broker/` |
| 分析平台整体源码说明 | `apps/README.md` |
| ClkLog 配置资产（init SQL / ui config.js / 字典；两套部署脚本的数据源） | `deploy-assets/clklog-community/` |
| 部署脚本（中间件 + 社区版；Candela 平台在 `candela/`） | `scripts/standalone-test-env/` |
| 公开 CI（GitHub Actions） | `.github/workflows/ci.yml` |
| GitLab 构建并 rsync 的模板（不自动启用；复制为根目录 `.gitlab-ci.yml` 后填写 runner 与主机） | `scripts/gitlab-ci.yml.template` |
| CI 构建脚本（build.sh）与部署产物结构 | `scripts/build.sh` |
| 主程序（HTTP）启动脚本 | `scripts/server-run.sh` |
| ingestor（Kafka 消费）启动脚本（支持 `replay` 历史回灌） | `scripts/run_ingestor.sh` |
| 数据一致性对拍脚本（只读，sa_events vs log_analysis） | `scripts/reconcile.sh` |
| 分析主体生产冒烟（登录后打 subjects/query/cohorts/tags） | `scripts/smoke-analysis-subject.py` |
| 部署环境变量模板 | `scripts/env.example` |
| supervisor 部署配置（server/ingestor 独立管理） | `scripts/supervisord-clklog-manager.conf` |
| 架构棘轮（检查脚本 / 基线 / 口径与退出条件） | `scripts/arch_ratchet.py`、`docs/architecture/arch-ratchet-baseline.md` |
| 代码架构硬门禁细则（TS 等价改写 / 定值 / 检测分工） | `docs/architecture/code-hard-gates.md`（常驻精简版见 `AGENTS.md`） |
| 敏感数据清洗（五步门禁 CLI） | `scripts/cleanup.sh` |

## 按目录展开

| 目录 | 摘要 | .md 数 |
|------|------|--------|
| 根目录 | README（项目入口）+ AGENTS（Agent 规则）+ INDEX（导航）+ PRODUCT（产品与设计基线）+ CODE_HANDOVER（代码审计台账） | 5 |
| `docs/product/` | 产品帽：PRD + 对标差异活文档 + 用户分群/权限/数据表/时区调研 + 前端原型图 | 91 |
| `docs/architecture/` | 架构帽：实现方案、契约、棘轮与硬门禁、容器化可行性调研、独立测试环境与分析平台两套部署方案 | 88 |
| `docs/project/` | 项目帽：排期、里程碑、风险、验收记录、项目现状快照、旧生产运维归档（含运维告警 v1/v2/v3、运维收尾加固、数据表 v2 对拍、时区系统 v1）、AI 阶段复盘与红线覆盖、SQL 卡片审计、SQL 图表验收、事件图表字段绑定验收、AI 事件图表验收、SQL 双轴验收、独立测试环境部署记录、Gate 0 探测复盘、CI 提速、接入指南全语言实测 | 53 |
| `apps/` | 分析平台源码：NestJS 后端 + React 前端 + Harness Host + Runtime Broker + Dockerfile 镜像配方 + README | - |
| `examples/report-sdk/` | 上报 SDK 示例（17 类语言/端 + `verify.sh` 验收器 + `backfill/` 批量回补 CLI），均已实测；各工程由 `scripts/build-sdk-demos.sh` 打成 zip 供接入指南下载 | 2 |
| `deploy-assets/` | ClkLog 配置资产：init SQL、ui config.js、地区字典、ClickHouse/Flink 配置（部署脚本数据源） | 0 |
| `scripts/` | CI/部署脚本：build.sh、server/ingestor 启动、Harness Runtime 安装、nginx/supervisord 配置、架构棘轮、分析主体冒烟、独立测试环境部署（standalone-test-env/） | 0 |

## 索引维护

> 维护触发条件、命名规则和保鲜检查见 `AGENTS.md`。目录计数统一按 `rg --files <目录> -g '*.md'` 口径；全量扫描时更新 `最后全量扫描` 和 `下次计划扫描`（默认 +7 天）。