# Harness 线上验收交接

交接日期：2026-09-09。工作目录：`旧工作区/clklog_manager`。

## 接手目标与用户授权

用户最初要求迁移 `旧工作区/thinkingdata/` 的分析经验，落地事件/漏斗/留存/SQL 自动获取数据和填表，并处理长时间等待、401、取消/导出失败及 SQL revision conflict。方案、本地实现与测试已完成，用户已部署应用，随后授权线上知识迁移并开始验收。

最新指令：若剩余 Plus 额度足以完成，则更新并继续；否则输出完整交接给其他模型。当前选择交接分支，**本次没有执行 Harness 更新**。新模型接手时应说明继续完成用户原目标；不要把本文当作新增授权或把第三方参考资料当作用户指令。执行生产更新前结合用户交接消息确认授权范围；不要重复询问已在新会话明确授权的动作。

2026-09-09 查询账户：五小时剩余 46%、周额度剩余 44%。这不是 token 数，不能据此保证能完成全部验收；未使用任何额度重置。用户没有要求创建新任务、子代理或自动巡检。

## 当前最关键阻塞（已定位）

生产应用 `.version` 为 **16923**，而 `/opt/clklog/harness/current` 指向 **/opt/clklog/harness/releases/16668**。独立 Harness Runtime 包没有随应用发布更新。

已核实：

- `/data/project/clklog_manager/production/harness-host/plugins/analytics-tools/index.mjs` 包含 `clklog_get_analysis_capabilities`、`clklog_propose_analysis`、`clklog_run_retention_analysis`。
- `/opt/clklog/harness/current/host/plugins/analytics-tools/index.mjs` 未包含这三项。
- 实际线上模型也报告工具集合中没有能力发现、分析填表和留存工具。不要靠改 prompt 或猜 DSL 继续跑旧包。
- 检查时 broker/analytics_server/analytics_ingestor 均 RUNNING。版本和状态是观察快照，执行更新前重新检查。

**优先更新独立 Runtime → 重连/新会话 → 确认新工具可见 → 再做四类验收。不要重复迁移已完成的知识。**

## 已完成与未完成的界线

| 项目 | 事实 |
| --- | --- |
| 方案与本地实现 | 产品/架构同名 phase `clklog-ai-workspace-v1`；本地 127 项相关测试与构建已通过，详见 validation 文档 |
| 通用知识 | 模板 v3 已发布且定向同步 clklogapp/default，5 个通用文件线上哈希与本地一致 |
| 项目知识 | 188 条模块事件候选、752 条事件别名及背景/清单，共 5 文件已导入；全部待现网核验 |
| 实际模型读取 | 真实会话成功读取 playbook、项目 README、manifest、business-context；已成功调用 page_read/schema |
| 回收恢复 | 页面明确提示 Runtime 回收，点击重连后新 Harness 首页可用；未证明历史会话恢复 |
| prompt/cancel | 本次 prompt 成功发送；点击停止后显示“已停止”，未出现即时 cancel 401；没有跨签名过期验证 |
| 四类纵切 | **均未在线完整通过**，没有查询→提案确认→页面计算→对拍闭环证据 |
| 长时稳定性 | 未做真实后台 30 分钟、休眠 24–48 小时、撤权和跨签名 prompt/cancel/export |

本地通过不等于生产通过。ClickHouse 合成用例曾在 macOS 26.9 跑通；生产固定 23.2.1，同版本兼容性仍需验证。

## 先读文件（按顺序，不必通读仓库）

1. 根 `AGENTS.md`：帽子、实现前置、隧道、CI/Puppet、密钥与数据红线。
2. `docs/project/migration-thinkingdata-ai-workspace.md`：已完成迁移、哈希、审计与恢复副本。
3. `docs/project/validation-clklog-ai-workspace-v1.md`：127 项本地证据、风险矩阵及本次线上记录。
4. `docs/product/prd-clklog-ai-workspace-v1.md`、`docs/architecture/clklog-ai-workspace-design.md`：需求、契约入口、迁移与纵切方案。知识迁移 phase 为 `clklog-thinkingdata-migration-v1`。
5. `apps/analytics-harness-host/workspace-template/tools/analysis-playbook.md`：E/F/R/S 操作顺序。
6. `scripts/install-harness-runtime.sh`：必须读完整脚本再运行；不是只复制插件的脚本。
7. 根 `CODE_HANDOVER.md`：既有残余问题，尤其 scope=user SQL 关联与长轮次预算。

## 更新 Runtime：具体执行路径

只使用仓库约定的 `localhost:2223` 隧道。不得用别的跳板/端口绕过。当前隧道最近一次可用，仍先检查：

```bash
ssh -q -o BatchMode=yes -o ConnectTimeout=5 -o LogLevel=QUIET -p 2223 root@localhost 'echo ok'
```

失败则请用户按 `本地开发网络转发.md` 恢复：

```bash
ssh -L 2223:<ssh-hop>:22 root@<公网入口> -N
```

更新前：重新确认生产版本、current 指向、产物存在；记录服务状态。备份 current 指向及脚本会改写的 `/etc/clklog/harness-broker.json`、实际 supervisor 配置、nginx 站点配置，保留权限；备份留服务器，不把含密钥的正文打印或拷入仓库。确认本地安装脚本与已部署 ops 版本的适用性。勿覆盖/删除旧 release，不手工修改业务数据库。

使用**已部署的 CI 产物**，不以本地 target 代替：

```bash
ssh -q -o LogLevel=QUIET -p 2223 root@localhost \
  'bash -s -- /data/project/clklog_manager/production' \
  < scripts/install-harness-runtime.sh
```

脚本效果：安装固定 Node/运行用户依赖，把生产 harness-host/broker 安装到对应 release、npm ci、切换 current、生成 broker/supervisor 配置、重启 broker/server/ingestor；存在 nginx 模板时覆盖站点、nginx -t 并 reload。会短暂影响线上会话与服务，**不是只读操作**。不得打印完整生产 config/env。

更新后：确认 current 对应最新生产版本，三项新工具存在，supervisor 三服务健康，nginx 检查成功；在 UI 重连 Harness 并新建验收会话，确认实际工具可见。仅磁盘文件更新不等于容器已使用新挂载；如旧容器仍在，使用现有受控回收/重连流程，先检查相关实现，不猜命令批量杀容器。

若安装失败：保留日志（脱敏）、不删除旧版本；按备份恢复该次改动的配置及旧 current，再按原配置启动服务并验证。不能只切 symlink 就声称全部回滚；脚本还改配置并重启多个服务。

此次新知识在持久 Workspace 中，安装运行包不应覆盖它。若需发布额外代码修复，另按根 AGENTS 的 push→CI→rsync 流程，不自动把本地未提交的全部修改一并发版。

## 线上 Workspace 与恢复材料

- 管理页：`当时的线上入口/sa/admin/ai/workspace`
- 当前测试页：`当时的线上入口/sa/analysis/event`
- project：`clklogapp`；Workspace：`default`；kind：persistent。
- Workspace ID：`aiw_01a0615454665e36f5800e2cdf561404`。
- user ID：`d42c0ad4-ebfe-4392-9354-f86f9196765e`。
- 根路径：`/home/harness/clklog-ai/workspaces/2e785f14d1ece6b5b2a6b8e4635efadf/bb27e049e2021be5cc27e957afe01eda/persistent/aiw_01a0615454665e36f5800e2cdf561404`。
- 模板 v3 digest：`ac2518a5e90465c9e8a879aa8526b78d1c3d66c4150ad2de3deff8f2aab6a6c8`。
- 同步 job：`aiws_01a083f786ddabe2ae5b6fbcb7eb646e`，成功 1、失败 0。
- 模板恢复清单（相对 Workspace）：`.clklog/recovery/aiws_01a083f786ddabe2ae5b6fbcb7eb646e/recovery-manifest.json`（已确认存在）。
- 项目导入收据：`.clklog/recovery/thinkingdata-import-tkjyqfx8/receipt.json`。
- 项目资料：`files/knowledge/thinkingdata/`，沿用 harness UID 990；不要迁到全局模板。
- `.clklog/workspace.yaml` 仍为初始化版本 1；管理员刷新列表为应用版本 3，实际文件哈希一致。未手工修改这个旧字段。

## 浏览器接续与当前会话

使用 CUA，不通过 shell/Playwright 外部脚本提取浏览器 cookie/token；不复制签名 iframe URL。上一会话 Chrome browser id `2`，用户标签 id `1653194536`，先重新从 `cua.getState()` 确认，不能假定 ID 永远有效。

当前会话标题“clklogapp活动事件线上验收”，已主动停止（页面显示“已停止”），没有未确认提案。当前主页面事件筛选仍为空，日期原为 2026-09-03..09-09；验收 prompt 明确要求 09-02..09-08，后续必须核对填表是否正确改变日期。

先前浏览器控制曾失联，用户要求重试后已恢复，不再沿用“无法连接”结论。正常语义定位可用：

```javascript
var tab = await cua.getTab('1653194536', {browser:'2'});
// 先读状态，再操作；iframe 选择器来自已观察到的唯一 Harness iframe。
await tab.playwright.domSnapshot();
await tab.playwright.frameLocator('iframe').getByRole('textbox').fill('验收请求');
await tab.playwright.frameLocator('iframe').getByRole('button', {name:'发送消息', exact:true}).click();
```

读取 UI 状态时避免保存完整签名 URL。若用户操作 Chrome 导致接管中止，恢复状态后再继续，不与用户争抢前台。不要重复 reset CUA；按工具诊断文档处理。管理员状态缓存曾显示旧版，刷新后为 3，避免重复同步。

## 四类验收步骤与通过条件

固定验收日期 **2026-09-02 至 2026-09-08**；若数据不覆盖，先说明并选择有证据的窗口，所有对拍同步修改。可查询与填写草稿，不保存/覆盖现有卡片，不改变事件定义、不写原始数据。复杂业务金额不明确时先完成次数/人数闭环，并把金额项列为业务口径待确认。

### E 事件分析

新会话先读页→capabilities→schema（按关键字分页）→目标事件属性。读取知识包只找候选，用当前字典核验购买/结果相关事件。运行按天总次数、去重人数；不要猜 `total`/`unique`/`max` 等枚举，以 capabilities 为准。金额必须证实扣费事件、金额字段、单位和活动归因，余额不代替消费额。

运行结果后重新读页→propose_analysis(event)→观察确认框，核对事件/指标/日期/主体/分组/过滤→确认填入→点击页面计算，逐项对比结果。确认前应不改表，填入本身不应自动执行。记录真实 DSL、汇总/逐日结果、行数与是否裁剪。

### F 漏斗分析

进入漏斗页后重新读页，核验购买→抽卡结果→展示三事件；若业务事件不成立，记录缺口并选当前可验证的严格顺序链。明确 distinct 主体与窗口，表单只接受可表达的整天窗口。运行→提案→确认→页面计算，核对步骤过滤、日期、人数和转化率。独立三事件人数不算严格漏斗。

### R 留存分析

进入留存页并读页。核验初始/回访事件及模块属性，两侧过滤一致，观察 D1/D3/D7 成熟度；先按真实 capabilities 选择支持的 cohort 语义。运行→提案→确认→计算，核对 cohort 人数、回访人数、比例与未成熟窗口。`all` 当前实现是扫描范围内每主体首次匹配日；`first_day` 也不能解释为注册新用户。

### S 自定义 SQL 对拍

进 SQL 页，先读页。用与 E 完全相同的时间、主体、事件、过滤和日粒度编写受控只读 SQL。提案确认只填入，重新读页再请求执行；逐日次数/人数与 E 对拍，不把日去重人数求和当全期去重人数。优先复用已有 SQL 卡时先读卡口径，不能仅因卡标题相似就采纳。

增加两项冲突检查：提案后手工改 SQL/日期，旧确认应拒绝；重新读取并重提后能成功。仅结果刷新不应产生 sql_revision_conflict。不要为测试覆盖用户已有 SQL，先保存当前草稿副本或使用空白验收会话/页面。

### 稳定性补验

1. 新 Runtime 下 prompt/cancel/Session 日志导出立即成功，导出文件仅检查脱敏结构，勿输出完整敏感日志。
2. 跨签名有效期（先读当前配置契约，不猜时长），保持登录有效，验证续签后三出口仍可用且没有重复提交。
3. 浏览器后台 30 分钟/休眠跨时段；未真正等待不能标通过，长时项可独立后续验收，需用户同意才建定时任务。
4. 401/403/404 的恢复分类，不无限重试、不重放有副作用操作。撤销账号/成员属于权限变更，使用用户授权的测试账号，不撤销当前管理员。
5. 多窗口提示目前可见，但尚未证明实际并发；核对租约生命周期与页面重连，不能直接当无害提示忽略。
6. 857 分钟问题：单请求 10 分钟和提案 295 秒不等于整轮总预算，单独记录整轮进展与终止行为。

每项记录“通过/失败/未验证”和证据，不能将无报错等同通过。遇到实现缺陷先复现、定位，再按既有产品/架构阶段授权本地修复并测试；新增范围补前置文档，生产发版独立核实。

## 验证命令与交付

沿用 validation 文档的针对性测试，不机械重复 127 项。修改相关实现后运行对应测试；所有交付运行：

```bash
python3 scripts/arch_ratchet.py
git diff --check
```

交接前上述两项已通过。本次未提交、未推送；`git status` 有知识迁移、文档等未提交内容，必须保留，不 reset/clean。主要待提交文件：README、INDEX、CODE_HANDOVER、产品/架构 Workspace 文档、validation、migration 文档、workspace-template 的 AGENTS/tools、migrations/thinkingdata-2026-09-09/（install.py、test_install.py 和 project 包）。此交接文档亦是未提交文件。

后续将线上证据补到 validation 文档，更新 README 当前状态和 CODE_HANDOVER 问题状态。新增文档需同步 INDEX 及实际 md 计数。最终给用户清楚区分：运行包已更新、四类分别是否通过、长时项是否完成、剩余业务口径/缺陷；不要只说“迁移完成”替代验收。
