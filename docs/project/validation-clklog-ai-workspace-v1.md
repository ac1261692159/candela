# AI Workspace 本地实现与验收记录

> phase: clklog-ai-workspace-v1；验证日期：2026-09-08。
> [产品要求](../product/prd-clklog-ai-workspace-v1.md) · [迁移清单、数据链路和四类纵切方案](../architecture/clklog-ai-workspace-design.md)
> 用户授权为方案、实现与本地测试。本次未提交、未推送、未部署、未修改生产数据库或管理员已发布模板。

## 交付与证据范围

已完成本地工具、页面和稳定性实现。这里的后训练是 Workspace 规则、案例与回归改进，没有训练模型权重。

| 验收项 | 本地证据 | 边界 |
|---|---|---|
| AW-1 迁移 | 架构 §2 逐文件/章节列出 thinkingdata 可迁内容、适配和排除项；种子 AGENTS 与操作手册已写入 | 历史业务映射需管理员按项目审核；没有整体复制旧数据 |
| AW-2 获取数据 | capabilities、现代 DSL、目标事件属性、schema 检索/分页、三类 run；超过 100 项仍可定位；Gateway 覆盖请求体 project | 数据权限继续由既有 API 执行；测试没有代替生产成员权限验收 |
| AW-3 三类填表 | 三类真实 Antd 确认框、确认前不写入、DSL→Form→DSL 往返、真实编辑冲突、相同条件不虚增版本；页面接入当前草稿与完整初始表单 | 属于分层集成验证；未将真实供应商→生产三个页面→生产计算全链路标为通过 |
| AW-4 SQL | 真实 SQL 页面组件回归：结果刷新不假冲突、编辑只填入不执行、过期确认不执行、执行成功但回执失败仍保留结果 | 用户在途编辑仍需重新读取；不强制覆盖 |
| AW-5 连接 | 签名/归属/登录测试，宿主续期单飞、401/403/404 停止循环；真实浏览器验证 opaque iframe 消息和请求改写 | 未进行 24–48 小时真实休眠/节流、真实供应商取消/导出测试 |
| AW-6 纵切 | 同一 JSON 案例用于工具示例、validator、表单转换及本地 ClickHouse 查询；结果见下表 | ClickHouse 为本地合成库；生产币种、字段类型、事件覆盖需按方案核验 |
| AW-7 工程验证 | 后端 91、前端 29、Host 7 项通过；前后端构建、结构棘轮通过 | 构建仍有既有大 chunk 提示；没有因此放宽构建/棘轮门禁 |

## 四类可复现案例

输入唯一副本：[analysis-cases.json](../../apps/analytics-harness-host/plugins/analytics-tools/analysis-cases.json)。操作说明：[analysis-playbook.md](../../ai_workspace/default/tools/analysis-playbook.md)。生成 SQL 并实际执行：[run-local-cases.cjs](../../apps/analytics-server/test/ai-workspace/run-local-cases.cjs)。

| 案例 | 合成数据与负例 | 实际结果 |
|---|---|---|
| E 示例消耗 | A 两次 10+20，B 一次 5；非活动 99、其他项目 9999 排除 | 2026-08-01：3 次、2 人、金额 35 |
| F 购买→结果→展示 | 4 人购买；一人仅买、一人结果早于购买、一人展示超出 1 天窗口 | 严格漏斗 4→2→1；不存在逐事件人数伪漏斗 |
| R 模块参与留存 | D0 4 人；D1 2 人、D3 1 人、D7 2 人；其他模块回访排除 | cohort_size=4，D1=50%、D3=25%、D7=50% |
| S SQL 对拍 | 与 E 相同项目、日期、事件与活动过滤 | times=3、users=2、amount=35，与 E 一致 |

执行真实 SQL 生成器；元数据属性解析器采用合成字段适配，查询落隔离的 clickhouse-local Memory 表。脚本只创建并清理自己生成的临时目录，不连接生产。当地 Docker daemon 不可用，因此采用 ClickHouse 官方 macOS ARM64 单文件程序（[平台支持](https://clickhouse.com/support/platforms)），实际版本 **26.9.1.943**。仓库 Puppet 固定 **23.2.1**，本次结果不构成该生产版本的兼容证明；发布前须在同版本隔离环境复跑。

## 测试命令与结果

从仓库根进入对应目录执行；这里只列执行命令，不加载任何生产环境变量。

```bash
cd apps/analytics-server
npm test -- --runInBand src/modules/ai-assistant test/query test/report/sql-ast-guard.service.spec.ts
# 21 suites / 91 tests passed
npm run build
node test/ai-workspace/run-local-cases.cjs /tmp/clklog-ai-workspace-verification/clickhouse
# 四类结果均由 assert 核对，包括留存人数和比例
```

```bash
cd apps/analytics-web
npm test -- --run --threads=false --testTimeout=30000 src/features/ai src/features/ai-analysis src/features/ai-connection src/pages/Report/SqlReportPage.chart-config.spec.tsx
# 8 files / 29 tests passed，无 unhandled rejection
npm run build
```

前端初次按默认 5 秒运行时，SQL 页面测试在本机超时；单独复跑仍超时，使用 30 秒测试时限后全部通过。没有修改测试断言或产品超时值。新增过期确认用例曾发现 Antd onOk 向外抛出未处理 rejection，已改成明确反馈并结束过期操作。

```bash
cd apps/analytics-harness-host
npm test
# 7 tests passed，含实际插件注册、HTTP 工具传输与 401 不重试
```

仓库根运行 `python3 scripts/arch_ratchet.py`：`architecture ratchet passed`。`git diff --check` 通过。原来两个仅有 TODO、没有测试用例的 query spec 已改成有界 SQL 与严格漏斗结果断言。

## 真实浏览器验证

运行 `apps/analytics-server/test/ai-workspace/serve-browser-fixture.cjs`，打开 `http://127.0.0.1:18189`。测试加载本次构建的真实 proxy shim，iframe sandbox 参数与正式面板一致，签名和业务端点均为本地合成值。

通过 CUA 在 Codex 内置浏览器点击验证：

1. ready 消息 `origin=null`，iframe 初始化次数为 1。
2. “续期并请求”：调用仍使用旧签名 URL 常量，网络实际到 `fixture_new/api/session/prompt`，返回 200；iframe 初始化次数仍为 1。
3. “验证 401 不重放”：实际到 `fixture_old/api/session/prompt`，返回 401，宿主收到 unauthorized；iframe 初始化次数仍为 1。
4. 服务端 `/evidence` 只有上述两条请求，401 没有自动重复请求。

这证明真实隔离 iframe 的消息来源和 URL 改写机制可工作。该 fixture 没有启动官方 DSH、调用供应商或替代生产登录 E2E。

## 稳定性矩阵与仍待验证项

| 问题 | 本地处理/测试 | 上线前动作 |
|---|---|---|
| 固定签名过期 | 宿主认证续签、原 iframe 更新前缀，签名与所有权测试 | 在有效登录下跨签名截止时刻验证 prompt/cancel/export |
| 登录撤销/项目权限失效 | 续签重新校验登录与成员权限；401/403 停止自动检查并提示恢复 | 用测试账号撤销 token/成员，确认所有出口失效 |
| Runtime 回收/重启 | 404 提示重连；不承诺未落盘草稿恢复 | 同版本 Runtime 强制回收及后端重启后恢复会话 |
| 离线/后台节流 | online/focus/visibility 检查，单飞、不重放业务请求 | Chrome/Safari 后台 30 分钟、休眠 24–48 小时复跑 |
| 无限等待/857 分钟 | 单模型请求绝对 10 分钟截止，提案 295 秒结束；前后端都检查 expires_at | 取得原 Session/网络日志确认总 turn、工具与 UI 计时；单请求截止不能证明整轮总预算已实现 |
| SQL 旧版本 | 单一语义 revision；结果/加载不变版本；日期/编辑变版本 | 多窗口、网络乱序及真实手工编辑验证 |
| 迟到结果覆盖 | 三个查询 Store 使用代次守卫；reset/新请求后旧成功与旧失败不写入 | 生产慢查询时切换项目验证可见结果归属 |
| 用户属性 missing column | Harness 对 scope=user 明确拒绝，停止猜参；不把余额当消耗额 | 平台用户属性关联 SQL 仍需专门修复并覆盖三类生成器，不能直接解除保护 |
| 留存口径 | 按真实实现暴露 cohort 语义，案例使用明确起始日 | cohort=all 当前每主体取扫描内首次匹配日，不是每日重复入组；first_day 也不等于注册新用户 |

## 生效与交接

代码包中的 [Workspace AGENTS](../../ai_workspace/default/AGENTS.md) 已更新。已存在的管理员模板不会被 bootstrap 自动覆盖。上线后需要管理员预览/发布模板、对指定 Workspace 同步、按现有备份与审计确认并重连；完成前不能说现网 Harness 已读取新规则。

代码审计见根 [CODE_HANDOVER](../../CODE_HANDOVER.md) 的 2026-09-08 记录。红线未自动检：生产数据链路、数据库账号权限、服务器目录 owner、Puppet 生效与生产 DDL；本次未触及这些部署对象。门禁未自动检：依赖单向、状态所有权及领域纯净已做代码自检，没有给出自动化静态证明。

另按用户授权完成 impeccable **3.5.0→4.2.2** 更新，下次会话使用；它不改变本次 Harness 功能验收结果。

## 2026-09-09 线上验收启动（未完成）

用户已部署并授权开始验收；知识迁移结果另见 [迁移记录](migration-thinkingdata-ai-workspace.md)。

- 管理员列表确认 clklogapp/default 应用模板版本 3，active。
- 打开事件分析，初始页面提示「Harness 已回收或服务已重启，请重新连接，再从会话列表恢复」。点击「重新连接」后，新 Runtime 的 Harness 首页与输入框成功显示，原回收错误消失。此项仅证明回收提示和重连成功，不证明旧会话恢复或 prompt/cancel/export 成功。
- 重连后页面显示同账号其他窗口打开 Workspace 的提示；尚未验证是真实并发还是旧租约残留。
- 随后 CUA 连续返回 `Debugger unattached`。重新获取标签未恢复；尝试原生 Chrome 切回目标标签时，工具报告用户正在更改 Chrome 并中止动作。未绕过浏览器控制获取 cookie、签名或直接调用业务 API。
- 四类分析查询、自动填表、SQL 对拍与长时间后台恢复均仍待执行；本轮没有发送分析 prompt、计算查询或保存卡片，不能标记纵切通过。

恢复浏览器扩展控制连接后，从事件分析新会话开始：按 analysis-playbook 的 E/F/R/S 执行，每一步记录已验证字段、时间、实际 DSL/SQL、工具结果、确认填表和页面计算结果。跨签名时限的 prompt/cancel/export 单独记录，不用瞬时重连代替长时稳定性验收。

### 同日重试：控制恢复，发现 Harness 运行包未更新

浏览器控制恢复，成功发送 E 验收 prompt。模型实际读取了 tools/analysis-playbook.md、files/knowledge/thinkingdata/README.md、manifest.json、business-context.md，并调用 page_read/schema。这补充证明迁移知识已可由真实 Harness 读取。主动停止后页面明确显示「已停止」，未出现先前 cancel 401 提示；仅是本次即时取消证据。

四类纵切被版本不一致阻塞：生产 `.version=16923`，`/opt/clklog/harness/current` 仍指向 `releases/16668`。16923 的 harness-host 插件包含 capabilities、propose_analysis、run_retention 三项，当前 16668 插件未包含。真实模型也报告这些工具不在可调用集合。知识发布不会更新这个独立运行包。

修复入口已核对：`scripts/install-harness-runtime.sh` 使用已发布产物安装对应 Harness 版本。该脚本还会重启 broker、analytics_server、analytics_ingestor，并更新既有运行配置/nginx；超出纯验收，尚未执行。需用户授权完成此线上更新后，再重建 Runtime、验证三项工具可见并继续 E/F/R/S。没有把本次工具缺失算作模型能力失败或纵切通过。

### 同日续接（交接后）：Runtime 已更新至 16923，浏览器环节待恢复

按 [交接文档](handoff-harness-live-acceptance.md) 执行独立 Runtime 更新，用户交接消息即授权范围：

- 更新前复核：隧道 `localhost:2223` 连通；生产 `.version=16923`，`/opt/clklog/harness/current` → `releases/16668`（缺三项工具），broker/analytics_server/analytics_ingestor 均 RUNNING。
- 备份留服务器 `/root/backup-harness-20260909/`（current 指向、`/etc/clklog/harness-broker.json`、supervisor 与 nginx 站点配置、tmpfiles），保留权限，未打印含密钥正文。
- 以 CI 产物执行 `install-harness-runtime.sh`（stdin 传入，目标 `/data/project/clklog_manager/production`）：脚本输出 `Harness Runtime 安装完成 (user=harness, release=16923)`，npm ci 0 漏洞，podman 镜像拉取成功，nginx -t 通过。
- 更新后验证：`current` → `releases/16923`；`current/host/plugins/analytics-tools/index.mjs` 含 `clklog_get_analysis_capabilities`、`clklog_propose_analysis`、`clklog_run_retention_analysis` 三项；三服务重启后 RUNNING（fresh uptime）；nginx active。旧 release 未删除。
- **尚未完成**：UI 重连/新会话确认真实模型可见新工具；E/F/R/S 四类纵切；稳定性补验。本轮浏览器尝试受阻——本机 ZCode Computer Use 辅助功能与屏幕录制权限为 denied，无法控制用户已登录的 Chrome；应用内浏览器打开测试页跳转 `/sa/login`，无凭据可用。会话级工具可见性未证明，不计为通过。

### 同日：Runtime 更新后 E 事件分析纵切通过

（接上节）应用内浏览器实际已有登录会话（`/sa/login` 为瞬时跳转，随后进入看板页），浏览器环节恢复，按 playbook 继续线上验收。

- **新工具可见性：通过**。新 Runtime（16923）下新建 Harness 会话，真实模型按序调用 `clklog_page_read`、`clklog_get_analysis_capabilities`、`clklog_get_schema(campaign)`、`clklog_propose_analysis(event)`，均成功返回；未再出现「工具不在可调用集合」。
- **E 事件分析：通过**。固定窗口 2026-09-02~09-08，事件 `checkout_success`（经 schema 核验，非沿用候选旧名），指标总次数+去重人数，按天。模型先运行查询，再 propose；确认框六要素（事件/指标/筛选/分组/日期/主体）核对通过，日期已从默认 09-03~09-09 正确改为 09-02~09-08；确认填入后页面**未自动执行**（dsl 仍空），由人工点击「计算」。页面实时查询 897ms：阶段汇总 110,837 次 / 2,785 人；逐日 09-02..09-08 = 15344/1086、11864/976、17207/1248、17276/1253、16929/1238、16413/1183、15804/1133，与模型报告逐日完全一致，8 行未裁剪。结果区展示真实 ClickHouse SQL（含 `project_name` 过滤、`stat_date` 边界、`uniqExactIf` 去重、LIMIT 参数化）。
- **金额口径：按预期标记待确认**。模型证实 `source_type` 在 JSON 中以数值存储（引擎报错 `Cannot convert string campaign to type Float64`），活动归因编码未知 → 不以余额或全量消耗冒充消费额，标记「业务口径待确认」。符合红线要求。
- **发现缺陷（P3，UX）**：propose 等待用户确认超时后模型自动重试，宿主出现两个内容相同的堆叠确认框（第二个标注「上次超时未应用，页面 revision 仍为 3」）；接受重试提案、手动拒绝原始提案后状态一致，无错误写回。建议：提案等待确认期间模型侧应挂起而非超时重试，或宿主应替换而非堆叠同源提案框。
- 模型过程记录已存 Workspace `files/notes/2026-09-09-验收E-活动购买抽卡结果事件分析.md`；其额外核验的 `redeem_success`（195,434 次 / 6,343 人）与 `reward_show`（146,868 次 / 6,111 人）供 F 漏斗使用。

### 同日：F 漏斗、R 留存、S SQL 对拍纵切通过；稳定性快验通过

同一会话（跨页面导航后经会话列表恢复，见下）依次执行 F/R/S，固定窗口均为 2026-09-02~09-08：

- **会话恢复（补充证明）**：SPA 路由切换会使 AI 面板 iframe 重挂载回 Harness 首页，但经「Search sessions」会话列表点击即可恢复原会话且上下文完整（E/F 全程消息与产物可见）。这补上了交接中「未证明历史会话恢复」的缺口；仍不证明 Runtime 回收（404 重连）后的跨 Runtime 恢复。
- **F 漏斗：通过**。模型先重读漏斗页（revision 8、默认 2 空步骤、默认 09-03~09-09），以 capabilities 确认步骤 2–32、窗口示例 `window_seconds=86400`+`limit_window_in_range`；运行三步严格顺序漏斗 `checkout_success → redeem_success → reward_show`（1 整天窗口、限制在范围内）。提案确认框核对通过并填入（未自动执行），人工点击计算：页面 749ms 返回 2785 / 2783 / 2758，转化率 100.0% / 99.9% / 99.1%，与模型报告一致（99.93% / 99.10%，总体 99.03%）。结果区真实 SQL 为 `windowFunnel(86400)` + `project_name` 过滤 + 事件数组参数化，属严格顺序漏斗而非三个独立人数；模型并交叉验证步骤 1 人数=E 全窗去重人数 2,785、正确说明独立事件人数（6,343/6,111）≠漏斗步骤人数。
- **R 留存：通过**。以 capabilities 确认 cohort 语义后选 `all`（模型正确表述引擎口径：扫描范围内每主体首次满足初始条件日入组，不每日重复入组）；初始=回访=`checkout_success`，两侧过滤一致为空，D1/D3/D7。提案填入正确（全部用户/按天/日期 09-02~09-08），人工计算：页面 804ms 返回 7 个 cohort（1086/430/362/300/244/183/180，合计 2,785 与 E 全窗去重一致），逐 cohort D1/D3/D7 人数与比例与模型报告逐项一致。模型对成熟度标注正确：✓ 观察日≤09-08 成熟；⚠ 观察日=09-09（进行中，可能偏低，如 09-02-D7=39.5%、09-08-D1=14.4%）；✗ 未来窗口的 0 不代表真实零留存。SQL 为 `retention()` + `minIf(...) OVER (PARTITION BY uid)` 入组，符合 CODE_HANDOVER 已登记的 `all` 实现口径。
- **S SQL 对拍：通过（含两项冲突检查）**。模型先读页（编辑器为默认示例草稿，非用户卡片，可覆盖），写受控只读 SQL（同 E 的事件/日期/主体/过滤/日粒度，显式 `project_name='clklogapp'` + `LIMIT 100`，注释注明按日去重人数不可求和当全期）。流程：propose_sql（expected_revision=16→applied 17）→确认写入→未执行。
  - **冲突检查 (a) 通过**：人工把编辑器末行 `LIMIT 100` 改为 `LIMIT 1000` 后，指示模型不重读页面、按旧提案请求执行——宿主返回 `HTTP 409: sql_revision_conflict`（检测到编辑器 revision 已高于其携带的 17），模型未重试未绕过。
  - **冲突检查 (b) 通过**：模型重读页面（revision 18）后基于最新 revision 重新提案，diff 精确把 LIMIT 1000 恢复为 100，确认写入成功（revision 19）。
  - **执行对拍通过**：模型 `clklog_request_sql_execution` → 宿主二次确认框（注明仍经项目/时间范围/LIMIT/超时/只读账号守卫）→确认执行：行数 7、扫描 228,850 行，逐日 总次数/去重人数 15344/1086、11864/976、17207/1248、17276/1253、16929/1238、16413/1183、15804/1133，与 E 逐日完全一致（模型自核 7/7 ✅）；执行本身未产生 sql_revision_conflict。
- **稳定性快验：通过**。新 Runtime 下 (1) prompt 发送立即成功（全程 9 轮无 401）；(2) 生成中点击停止立即生效——长输出截断于中途、页面显示 Stopped、无 401/签名报错；(3) Session 日志导出点击后立即弹出 "Session download started / The browser is downloading the Session ZIP"（ZIP 文件内容未检查——IAB 沙箱下载不可直接读取，留待后续在可访问下载目录的环境核对脱敏结构）。
- **长时项未验证**（需用户同意另行安排，不标通过）：跨签名续签后的 prompt/cancel/export（契约时限见架构文档，未实测）、浏览器后台 30 分钟/休眠跨时段恢复、账号撤权后的 401/403/404 恢复分类、多窗口并发租约行为。857 分钟问题：本轮最长单轮（S，含两次冲突检查）约 46 分钟内正常终止，未再现整轮悬挂。

### 同日补充：活动消费金额口径验证计划（项2）

E 验收遗留口径：`source_type` 为 JSON 内数值编码，活动归因与金额字段/单位未证实。本节登记验证计划与数据证据；**编码语义与金额单位最终以业务确认为准，数据证据不能替代业务口径签字**。

- 方法：生产 ClickHouse 只读探查（`sa_readonly` 账号、`project_name='clklogapp'`、`stat_date` 限定 2026-09-02~09-08、显式 LIMIT），按事件统计 `source_type` 取值分布与金额候选字段；不走模型、不写任何数据。
- 通过条件（数据层）：找到活动事件独有/强关联的 `source_type` 取值；确认扣费事件上金额候选字段的存在性与典型量级。业务层仍需回答：编码→业务的映射、金额单位与精度、是否扣费口径（而非奖励/余额）。
- 非目标：不修改事件/属性定义，不更新 Harness 知识包结论（除非业务确认后另行执行）。

**探查结果（同日执行，经 Harness 受控只读 SQL，过程与证据存 Workspace `files/notes/2026-09-09-金额口径探查-source_type与金额候选字段.md`）**：

- `source_type` 与活动**无关联**：checkout_success/open_success/draw_result_show 三事件 100% 缺失该字段（110,837/195,435/146,869 条全无）；`item_consume` 全周仅 372 条，其中 8 条带值且均为 0。能力示例中 `source_type='campaign'` 的过滤示例对本项目有误导性。
- **量纲错配**：活动购买周 11 万次 vs 代币消耗事件周仅 372 条 → 活动扣费大概率不经由 `item_consume` 上报（或覆盖极窄），真实扣费事件待业务指认。
- 金额候选字段：`num`（372/372 非空，周合计 33,387、max 1,280）量级稳定、最有嫌疑为「本次消耗数量」，单位未证实；`yuanbao_num` 全非空但 09-02 单条 千万级 拉高当日合计至 亿级，高度疑似余额快照，不作为消耗额；`yuanbao_consume_num` 字典为 string、解析全为 0，不可用；`amount` 字段不存在。
- 过程记录：SQL A 首版中文别名未加反引号被 SQL 守卫 lint 拒绝（守卫按设计工作），模型加反引号重新提案后执行成功。
- **待业务确认清单**：① `source_type` 编码映射；② 活动购买/抽取的真实扣费事件名与上报路径；③ `num` 的语义与单位（是否代币数量、精度、退冲口径）；④ `yuanbao_num` 是否余额快照及 09-02 异常大值来源；⑤ `yuanbao_consume_num` 的实际写入格式；⑥ 法币口径需与充值订单金额分开对拍，余额不得充当消耗额。
- 结论维持：「活动代币消费金额」保持**业务口径待确认**；业务回复后可基于 `num` 出按日活动关联验证方案。

### 同日补充：长时项验收计划与契约（项3）

先读实现契约（不猜时长），再安排实测：

| 契约 | 值 | 出处 |
| --- | --- | --- |
| 连接签名有效期 | 每次续签签发 24h | `harness-web-proxy.service.ts::renewConnection` |
| 前端续签周期 | 页面可见时每 60s 调 `/assistant/connection/renew`，postMessage 原位更新前缀 | `useHarnessConnection.ts`（interval 60_000 + visibilitychange/focus/online 触发） |
| 平台登录 token | 7 天 | `auth.service.ts`（架构文档 §3/4/6） |
| Page Bridge 桥接 TTL | 10 分钟无心跳判定失效 | `page-bridge.service.ts::BRIDGE_TTL_MS` |
| 服务端提案 TTL | 4 分 55 秒（含 expires_at 校验） | `page-bridge.service.ts::PROPOSAL_TTL_MS` |
| Runtime | idle TTL 回收，回收后提示重连 | broker/runtime-manager |

- **已隐式覆盖的项**：验收会话连续约 1.5 小时（16:12–17:36+），页面可见状态下经历了约 90 次周期续签，期间 prompt/停止/导出全部成功、无 401——「可见状态跨签名续签后三出口可用」可标记为通过（证据即本轮验收全程）。
- **仍需实测的项**：① 页面长时间 hidden（≥30 分钟，超过 BRIDGE_TTL）后恢复可见，验证续签恢复 + 三出口可用 + 无重复提交；② 登录 token 7 天边界（跨天会话）；③ 撤权账号的 401/403/404 恢复分类（需用户提供的测试账号，不撤销当前管理员）；④ 多窗口并发租约。
- **安排**：①由一次性定时任务在本会话结束约 45 分钟后执行（保持标签页打开，优先把窗口置于后台）；②跨天自然发生，下次会话顺带记录；③④待用户指定测试账号/窗口条件后执行。
- 通过标准：恢复后续签成功（页面无「重新连接」提示），prompt 发送、生成中停止、Session 导出均一次成功，无 401/签名报错、无重复提交；任何失败按 401/403/404/5xx 分类记录并停止重试。

### 长时项实测：后台45分钟恢复（定时任务，2026-09-09 18:31）

- **间隔**：约 55 分钟（17:36 最后活动 → 18:31 定时任务开始），标签页保持打开。
- **恢复前状态**：无「重新连接」提示、无登录失效，会话视图与侧栏保持原样——分类为**续签正常**（未触发 404 重连路径；页面是否真正 hidden 未监控，按可见/后台混合计）。
- **a) prompt：通过**。发送「回复：连接正常」→ 模型正常回复，无 401/签名报错。
- **b) 生成中停止：通过**。第一次机会因短输出过快自然结束未点到；补发长输出 prompt，出现停止按钮后 2 秒内点击——立即终止（Stopped 标记，按钮消失），无 401、无重复提交。注：快照中的 "401" 字样经核实全部为表格数值（如 4019679），父页面无 401 通知条。
- **c) Session 日志导出：本轮未通过（待复测）**。点击 Session log：第一次点击被侧栏开关消费（侧栏被打开，与 17:02 首次点击行为一致）；第二次点击无 "Session download started" 提示、下载目录无新 ZIP、亦无任何报错——与 17:02 单次点击即下载的行为不一致。按任务纪律不再重试。可能相关因素：抽屉处于打开状态时按钮行为不稳定（时而是开关、时而无效）。判定：**未验证导出本身，交互层存在不稳定**；建议下轮在抽屉关闭状态下复测，并检查 Session log 按钮的事件绑定。
- 重复提交：全程未出现。浏览器控制一次截图管道超时，稍后自行恢复，不影响结论。

### 同日：两项用户决策改造（发版中）

用户报告自定义 SQL 写 DAU/DNU/DOU 全周查询 30s 超时（`Timeout exceeded: elapsed 30.9s, maximum: 30`），定位为 `query.maxExecutionTime`（全周 `properties` JSON 解析约 45GB，代码内 2026-09-03 实测注释）。用户决策并授权发版：

1. **全局查询墙钟 30→300s**：`config_server.yaml`/`config_dev.yaml` 的 `query.maxExecutionTime`。有界限额（亿级行/50GB 字节/2GB 内存/4 线程）与只读账号不变，仍满足红线 4 的有界要求；对拍路径此前已用 300s 验证可行。
2. **提案自动应用 + SQL 自动执行**（PRD「提案自动应用与查询自动执行」）：web 层 `useAnalysisProposal` 与 `SqlReportPage` 不再弹人工确认框，提案直接填入/写入，`sql_execute` 直接执行并回执；过期与 revision 复核保留，SQL 守卫/只读账号/资源限额/Harness fail-closed 全部不动。分析页「计算」仍是页面原生操作由用户点击。服务端协议（propose/decide/supersede/TTL）不变，确认框交互整体取消（P3 堆叠问题随之消失，supersede 保留为并发提案保护）。
- 本地证据：前端 tsc 通过，vitest 57 文件/249 用例全绿（提案 spec 重写为自动应用语义 4 例；SqlReportPage 3 例重写）；服务端 jest 268 用例通过（`test/ingestor/parser.spec.ts` 为初始提交遗留的 TODO 空套件，与本改动无关）；ratchet 通过。
- 发版：按隧道→push→CI→server-upgrade 流程执行，结果见下节。

### 发版记录（2026-09-09 19:42）

- CI 产物 `16966`（commit a3cda8f），rsync 到生产后 `prisma migrate deploy` 无待应用迁移，`clklog_analytics_server` 重启 RUNNING；ingestor/broker 未动。
- 生效核验：生产树与运行时外部 `config.yaml` 的 `query.maxExecutionTime` 均为 **300**；`web/sa/assets/` 静态资源更新于 19:42。版本、服务状态、前端 chunk 三项符合预期。
- 行为提示：用户浏览器需刷新页面加载新前端包才会启用自动应用/自动执行；旧会话可从会话列表恢复（已验证）。workspace-template playbook 的措辞更新需管理员下次发布模板并同步 Workspace 后才进入线上知识包（模型行为不受影响，仅文档口径）。

### 同日晚：SQL 结果图表不可用修复（发版中）

用户报告：DAU/DNU/DOU SQL 查询成功但所有图表「不可用」，报「无法可靠判断「DAU」是维度还是指标」，字段面板指标列显示 `pending/pending`。

- **根因**：数字列画像在名字正则不命中时判 `pending`（`insufficient_evidence`），`DAU/DNU/DOU` 这类自造缩写不匹配 `METRIC_NAME`（count/sum/次数/人数…），推荐引擎拒绝出图。查询优化（用户已自行加 `event='$AppStart'` 过滤，扫描 45 万行/472MB，秒级完成）与图表问题相互独立。
- **修复**：新增确定性信号 `sql_aggregate_alias`——从来源 SQL 顶层 SELECT 提取「聚合表达式 AS 别名」（支持反引号/中文/方括号别名，跳过子查询与引号内逗号），命中的数字列直接判 metric（certain）。SQL 经 `ProfilerContext.sql` 从 SQL 页执行链路（configAfterExecute/QueryResultPanel）传入。
- **本地证据**：新增用例覆盖别名提取（子查询/非聚合别名排除）与画像判定；visualization+report+ai-analysis 定向套件 127 用例全过，tsc 通过。全量 vitest 在系统负载 ~16 时出现随机 5s 超时（失败集合逐轮漂移、单跑全过），判定为环境性抖动；触及文件均单跑验证通过。
- 用户即时替代路径（发版前可用）：字段设置 → DAU/DNU/DOU 列角色改「指标」→ 应用配置。
- 发版随下一批 CI 产物执行，结果补充于下节。

### 发版记录（2026-09-09 20:22）

- CI 产物 `16971`（commit 735e2d8），升级脚本执行完成（无迁移），`clklog_analytics_server` 重启 RUNNING，前端资源 20:22 更新，`.version` 核验 16971。
- 生效后行为：SQL 页执行聚合查询（如 DAU/DNU/DOU）时，聚合别名列自动判定为指标，「自动」推荐与折线/柱状等图表可用；用户刷新页面后生效。

### 同日晚续：趋势图全指标外推 + 旧卡片出图修复（发版中）

用户确认图表已可用后提出两项：

1. **趋势图预测扩展到全部指标**（原设计仅主系列）：每个系列各自外推生成 `（预测）` 虚线与可选拟合线；系列数 > 8 时仅保留主系列（分组维度爆炸场景防不可读）；阈值线语义不变（主系列回归算交汇）。契约更新见趋势图设计文档。
2. **上个版本保存的旧卡片无图表、字段设置「应用配置」无效果**：根因是 `ChartWorkbench` 内部三处 `resolveVisualization` 未携带来源 SQL——主画面/恢复自动/字段面板的画像仍是 pending，推荐为空且手动配置被同一证据驳回（无网络请求是预期：应用配置纯前端）。修复后 ChartWorkbench 全链路传入 SQL：旧卡片重新执行即自动推荐出图，手动应用配置生效。
- 本地证据：tsc 通过；触及套件（visualization/report/ai-analysis/Report 页）136 用例全过；前端全量 57 文件/252 用例全过（含新增多指标外推用例）。
- 发版随下一批 CI 产物执行，结果补充于下节。

### 发版记录（2026-09-09 20:44）

- CI 产物 `16973`（commit 82d3f1d），升级完成（无迁移），`clklog_analytics_server` 重启 RUNNING，前端资源 20:44 更新，`.version` 核验 16973。
- 生效后行为：刷新页面后——趋势图对 DAU/DNU/DOU 各自给出预测虚线（摘要注明系列数）；打开旧版本保存的 DAU 卡片重新执行即自动出图；字段设置手动应用配置生效。

### 同日晚再续：趋势卡片保存 400 修复（发版中）

用户点「覆盖保存」报 400「chart_config 枚举无效」。根因是**趋势图上线时的存量缺陷**：设计文档 §4.1 清单列了服务端白名单，但实现只改了前端——`chart-config.validator.ts` 的 `CHART_TYPES` 与 `options` 白名单从未放行 `trend`，趋势图卡片自上线起保存必 400（AC7 的服务端部分实际未验收）。

- 修复：`CHART_TYPES` 加 `trend`；`options` 白名单加 `trend` 并校验形状（`forecast_points` 0..90 整数、`threshold` 数值或 null、两个布尔开关、未知键拒绝）。
- 本地证据：服务端新增保存 AC7 用例与非法键拒绝用例（10/10 过），服务端全量 270 用例过，ratchet 通过。
- 发版随下一批 CI 产物执行，结果补充于下节。

### 发版记录（2026-09-09 20:55）

- CI 产物 `16975`（commit f4859aa），升级完成（无迁移），`clklog_analytics_server` 重启 RUNNING，`.version` 核验 16975。
- 生效后行为：趋势图卡片「覆盖保存/另存为卡片」可正常持久化 `chart_type: 'trend'` 与 `options.trend`，看板/卡片列表按趋势图复现。

### 2026-09-10：事件分析系统属性修复（推送完成，发版待隧道恢复）

用户在事件分析页用 `$is_first_day` 做 DNU 指标被拦「属性名不合法」。根因：`dsl-validator.service.ts` 的 `PROP_KEY_PATTERN`（`^[a-zA-Z_][a-zA-Z0-9_$.-]{0,63}$`）不允许 `$` 做首字符，而 `$` 前缀正是神策/ThinkingData 系 SDK 系统属性的标准命名（本项目 `is_first_day` 系统列全 0，真标记在 `properties.$is_first_day`）。字典采集端无此限制（下拉能选出来），校验端拦截——两端不一致。

- 修复：正则放宽为 `^\$?[a-zA-Z_][a-zA-Z0-9_$.-]{0,63}$`（可选 `$` 前缀）；注入防护不依赖此正则（属性名以参数化字面量进 `JSONExtract`）。设计文档 §参数化契约同步。
- 本地证据：新增 `$` 前缀通过/非法名拒绝用例，服务端全量 271 用例过，ratchet 通过；commit 1185a4c 已推送，CI 已构建。
- **发版受阻**：执行 server-upgrade 时 `localhost:2223` 隧道 SSH 连接失败（连续三次），按规则不换跳板。待用户按 `本地开发网络转发.md` 恢复隧道后执行升级并补记版本号。

- 发版记录：CI 产物 `16989`，升级完成（无迁移），`clklog_analytics_server` 重启 RUNNING，前端资源 10:48 更新，`.version` 核验 16989。用户刷新页面后重新执行 DNU 指标即可。

### 发版记录（2026-09-10 10:21）

- 用户恢复隧道后执行升级：生产 `.version` 核验 **16986**（含 `$` 系统属性修复 commit 1185a4c 及其后全部文档提交），`clklog_analytics_server` 重启 RUNNING，前端资源 10:21 更新。
- 生效后行为：事件分析/漏斗/留存的属性筛选与指标属性可选用 `$` 开头的系统属性（如 `$is_first_day` 为真数）；用户刷新页面后重建 DAU/DNU/DOU 指标即可。

### 2026-09-10 再续：查询被前端 60 秒超时掐断（发版中）

用户单日查询（UI打开 + `$is_first_day` 筛选）仍报「请求超时。请缩小查询范围或稍后重试」，且感觉远没到 300 秒。核实为**前端 axios 全局超时 60 秒**（`services/api.ts`）——CH 的 300s 放宽后，前端先断。报错文案「请求超时…」即前端超时映射，非 ClickHouse 错误。nginx 层 `proxy_read_timeout 3600` 不是瓶颈。

- 修复：四处数据查询请求（事件/漏斗/留存/自定义 SQL 执行）单独放宽至 **310s**（略长于 CH 300s，让真实 CH 错误先冒出）；其余控制类请求维持 60s，避免挂死交互。
- 本地证据：tsc 通过；前端全量 57 文件/252 用例过；ratchet 通过。
- 根因备注：`base_ui_open_trigger` 为最高频事件，单日 `properties` 解析约 6-7GB，慢是 JSON 逐行解析的固有成本；300s 内可完成。长期优化仍是物化 `environment_id`/`$is_first_day`。
- 发版随下一批 CI 产物执行，结果补充于下节。

- 生效后行为：刷新页面后，事件/漏斗/留存/SQL 执行的查询请求前端等待上限 310s；高频事件的 JSON 解析类查询在数十秒内完成时不再被前端掐断。

### 发版记录（2026-09-10 11:06）

- CI 产物 `16992`（commit ee83a1b），升级完成（无迁移），`clklog_analytics_server` 重启 RUNNING，前端资源 11:06 更新，`.version` 核验 16992。
- 生效后行为：刷新页面后，事件/漏斗/留存/SQL 执行的查询请求前端等待上限 310s；高频事件的 JSON 解析类查询在数十秒内完成时不再被前端掐断。

### 2026-09-10 下午：指标流水线改造 + 公式缺陷修复 + DAU-DNU-DOU 卡片交付（发版 16999/17000）

用户报告公式不可用、改名不生效、卡片不能重命名，并提出指标流水线交互改造。实现（commit 75ce41a / c1f6f26 / 2c85666 等，详见事件分析对齐设计文档增补）：

- **公式引用失效（实锤）**：日志抓到 `400 metrics[1] 公式引用了不存在的指标`——引用存位置 ID，增删指标后失效。修复：新建指标用时间戳稳定 ID；校验文案可读（区分未选择/已删除）。默认表单位置 ID 保持不变以维持 AI 提案确定性（删除被引用的默认指标仍会失效，属数据不可恢复）。
- **指标 hidden 眼睛开关**：hidden=true 照常计算供公式引用但不进结果列（服务端列过滤）。
- **步骤内数值变换**：transform={factor,decimals} 聚合后应用，校验边界。
- **步骤排序**：上移/下移按钮；公式引用下拉仅允许前序步骤。
- **卡片重命名**：SQL 页卡片名可点击改名 + 分析卡片列表重命名入口（走已有 PUT）。
- **趋势卡片保存 400（存量缺陷）**：`chart-config.validator` 与卡片 DTO 的 `chart_type`/options 白名单从未放行 trend（趋势图上线时漏改服务端，AC7 服务端未验收）。两处已补。
- **发版**：16999（P0/P1/P2）→ 17000（DTO trend）→ 17000 即当前。

**DAU-DNU-DOU 卡片（已交付并核验）**：指标 DAU=$AppStart·触发用户数、DNU=$AppStart·`$is_first_day`=true·触发用户数、DOU=公式 DAU−DNU；全局筛选 environment_id=zhuzi；窗口 2026-09-02~09-08。计算 20.9s，逐日 DAU=DNU+DOU 恒等式全成立（09-02: 6890=1260+5630 … 09-08: 8349=1273+7076），别名 DAU/DNU/DOU 正确显示；与 SQL 卡同日数值差 1（去重边界用户），属正常。卡片已入库（事件分析/trend，列表可见且可重命名）。

**过程发现（记录备查）**：
1. `$AppStart` 与 `UI打开(base_ui_open_trigger)` 是两个不同事件——前者量级小（7 天 47 万行），后者为高频事件（7 天约 千万级行）。
2. **7 天 UI打开 类查询被 CH 预估守卫击杀**（`Estimated 300.9~539.8s > 300`，100s 时按进度估算提前拦），300s 放宽无法解决该类查询；根治=物化 `environment_id`/`$is_first_day`（DDL 操作需单独授权）。
3. **长查询且页面处于后台时响应 0 字节被丢**：nginx 日志证实服务端 201 成功但浏览器未渲染（多例 201/0）——IAB/浏览器后台节流所致，前台化后重试即恢复；事件分析查询失败时结果区无错误展示（仅 5 秒 toast），属 UX 缺陷，登记待修。
4. 阶段汇总对公式指标默认 avg 语义（6,677.714=逐日均值），与直觉的全窗公式（20,646−8,523=12,123）不同，公式卡 stage_reduce 可调，暂不改默认。

### 2026-09-10 傍晚：公式卡 UX 四项（用户反馈，发版 17003）

用户实测新公式卡后提出四项 UX 修正，全部落地：

1. **操作按钮重叠**：眼睛/删除在卡片右上角重叠——上移/下移/眼睛/删除并入同一操作容器（右上角一组，flex 排列），删除按钮不再单独绝对定位。
2. **公式卡步骤序号**：公式卡显示流水线位置序号徽章（替代原 Σ 徽章），与普通指标步骤编号一致。
3. **公式改名与普通步骤一致**：点击标题改名（默认名=公式摘要如「(DAU － DNU)」，设置别名后显示别名），移除独立别名输入框。
4. **结果格式上移**：结果格式选择进表达式行尾列，公式卡省一行。

本地证据：触及套件（query/visualization/report/ai-analysis/Report 页/utils）194 用例全过，tsc 通过；公式卡 spec 断言随点击改名交互更新（21/21，摘要 testid 移至标题按钮）。发版：CI 产物 `17003`（commit ed45668），升级完成（无迁移），服务重启 RUNNING，前端资源 14:40 更新，`.version` 核验 17003。刷新页面后生效。

### 2026-09-10 续：布尔属性筛选类型错误修复（发版 16989）

`$` 属性名放行后，用户实测 DNU 指标（`$is_first_day` 等于 true）报 `Cannot convert string true to type UInt8`。根因：字典把该属性标为 boolean，resolver 生成 `JSONExtractBool(...)`，而筛选值以 String 参数绑定；且底层存储形态不统一（用户可用 SQL 证明 `$is_first_day` 实存字符串 `"true"`）。

- 修复：新增 `query/boolean-filter-binding`——布尔属性筛选统一降级为 `JSONExtractString(...)` 比较，值归一化 true/false/1/0；JSON 布尔与字符串布尔两种存储形态都命中。event/funnel/retention/cohort 四处筛选编译全部接入（cohort `userOpSql` 线程化 dataType）。
- 本地证据：生成器用例断言生成 `JSONExtractString(properties, '$is_first_day') = {…: String}`；服务端全量 272 用例过，tsc/ratchet 通过；commit 2c85666。
- 发版记录：CI 产物 `16989`，升级完成（无迁移），`clklog_analytics_server` 重启 RUNNING，前端资源 10:48 更新，`.version` 核验 16989。用户刷新页面后重新执行 DNU 指标即可。

### 同日：P3 提案堆叠修复（本地完成，待随下次发版生效）

按 PRD「提案确认唯一性」与架构文档 §9 实现两层修复：

- 服务端 `PageBridgeService.propose`：同桥接新提案到达时，旧待确认提案以 `status:'superseded'` 立即结束并从事件列表移除——模型侧收到明确替换信号，`proposals` 同桥接至多一项。
- 前端 `useAnalysisProposal`（事件/漏斗/留存）与 `SqlReportPage`（SQL 写入/执行确认）：新提案事件先销毁已打开的提案确认框，屏幕至多一个提案框。
- 测试：服务端 `page-bridge.service.spec` 13/13 通过（新增 supersede 用例）；前端 `useAnalysisProposal.spec` 6/6 通过（新增替换用例）；web `tsc --noEmit` 通过。
- 该修复属于本地实现，**生产仍是旧行为**，随下次应用发版生效；生效后可在验收会话复现「提案超时不确认→重试」场景验证只显示一个确认框。

### 同日：P1 用户属性关联 JOIN 修复（本地完成，待发版 + 线上对拍）

按 [专门方案](../architecture/clklog-analytics-design-user-property-join-v1.md)（phase: clklog-user-property-join-v1）实现：

- `attribute-resolver.service.ts::resolveUserProperty`：标量子查询补 `AND project_name = sa_events.project_name` 与 `LIMIT 1`，与 `subject-expr` 已验证范式一致，消除多项目同 `distinct_id` 串项目取值。
- `cohort-condition-sql.service.ts`：profile 侧替换提取为导出函数 `stripSaEventsCorrelation`，同时改写 `distinct_id`/`project_name` 两处外层引用；profile 侧 SQL 自带 `{project}` 参数过滤。
- 测试：新增 `attribute-resolver.service.spec`（3/3 通过，断言生成 SQL 含项目关联与 LIMIT 1、替换函数无 `sa_events.` 残留）；cohort/query 回归 18 套件 62 用例全部通过。
- **未做**：Harness scope=user fail-closed 保护保持不变（方案明确不可仅删保护）；线上三类对拍在发版后按方案 §5.3 执行，通过前保护不解除。

### 同日：Session 导出 ZIP 脱敏结构核对（项5）

核对对象：本会话 17:03 导出的 `dsh-session-session-8e80392e….zip`（365KB）。

- 结构：ZIP 内仅一个 `session.jsonl`（3260 行），内容为会话元数据、permission/sandbox/approval 策略事件、assistant 消息块与工具调用记录；无独立凭据文件。
- 敏感模式扫描（仅计数）：`sk-`、`Bearer`、`access_token`、`Authorization`、`api_key`、`sig=`、签名 access token 形态（13 位数字.32+ 位串）全部 0 命中；`password` 2 次命中均为模型推理文本（"Avoid tokens/password"），非真实凭据。
- 结论：导出物脱敏结构合格，未发现凭据或签名 URL 落盘。判定**通过**。
