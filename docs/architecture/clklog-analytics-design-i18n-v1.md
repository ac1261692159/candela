# 实现方案：分析平台国际化（i18n）多语言体系 v1

> phase: `clklog-analytics-i18n-v1`
> 版本：v1.0（2026-09-16）
> 状态：**实施中**（zh-CN + en-US 首发）。基建（i18n 前后端窄包、语言解析链、切换入口、错误码契约、通知按接收者语言）已落地并测试通过；各业务域文案迁移按 §11.3 分批推进，进度以 `python3 scripts/i18n_scan.py --report` 为准。
> 上游：`docs/product/prd-clklog-analytics-i18n-v1.md`（`I18N-1..16`）
> 实施记录（差异与新裁决）：见文末 §14。
> 关联：`AGENTS.md`（帽子 / 门禁 / 红线）、`docs/architecture/templates/AGENTS_front.md`（布局与交互门禁）、`docs/architecture/code-hard-gates.md`、`docs/architecture/arch-ratchet-baseline.md`、`docs/architecture/clklog-analytics-design-rbac-v2.md`、`docs/architecture/clklog-analytics-design-alerting-v4.md`
> 本文档是本 phase 的**语言集、语言解析链、键命名与资源组织、后端错误码契约、通知/导出本地化、测试与工具**的 SSOT。

---

## 0. 执行入口

实施前按以下顺序读取并执行：

1. 先读产品 PRD `docs/product/prd-clklog-analytics-i18n-v1.md`，确认「谁在什么场景切语言」「哪些内容必须/不必翻译」；本文件只裁决**怎么实现**。
2. 按 §11 的分批顺序实施，每批一个可验收单元（实现 + 测试 + 资源文件同时提交），不跨批混做。
3. 产品行为冲突以 PRD 为准；语言标签、键命名、资源目录、错误码契约、解析优先级冲突以本文为准；现有代码只代表当前基线。
4. 若代码现实使本文契约不可实现（例如某个第三方组件无法接入 antd locale），先在本文登记差异并获得确认，**不得静默发明第二套键命名或第二套解析链**。
5. 每批完成后运行 `python3 scripts/i18n_check.py` 与 `python3 scripts/arch_ratchet.py`，附输出证据；全部完成后在 `docs/project/` 新增本 phase 验收记录。

---

## 1. 阶段目标与范围（程序门禁要素①）

### 1.1 阶段目标

让分析平台（`/sa` SPA + `/sa/api` 后端）**在不改动任何业务逻辑与数据链路的前提下**，按用户语言渲染全部界面文案、系统生成的用户可见内容（错误提示、通知、导出表头）与预置数据展示名；新增一种语言是**纯数据改动**（新增一份资源目录 + 注册表一行），不需要改组件、不需要改后端代码、不需要发版新逻辑。

### 1.2 范围内

| 层 | 范围 |
|---|---|
| 前端文案 | `apps/analytics-web/src/` 全部面向用户的中文字面量与 JSX 文本（壳层、页面、features、空态、按钮、表单标签、校验提示、图表配置项） |
| 前端格式 | 数字 / 百分比 / 时长 / 日期时间的本地化格式；`dayjs` 与 `antd` 组件内置文案（日期选择器、分页、表格空态等） |
| 语言解析 | 登录前语言（浏览器 / 本地缓存 / URL 参数）与登录后语言（用户偏好），切换入口与持久化 |
| 后端提示 | `throw` 出来的用户可见错误提示：改为**稳定错误码 + 参数**，由前端按当前语言渲染；旧 `message` 字段保留 |
| 后端预置展示名 | 角色名、权限目录（feature / op / detail）、内置告警规则健康度文案等**平台预置、由服务端下发**的展示文本 |
| 系统生成内容 | 告警通知（飞书 / 邮件 / 短信）默认模板、导出文件表头、AI 助手回答语言指示 |
| 工具与验收 | 硬编码扫描脚本、覆盖率基线（只减不增）、资源一致性校验脚本、CI 接入 |

### 1.3 非目标（本 phase 明确不做）

1. **不改 ClkLog 社区版**。社区版自带前端不在本仓库、不属本次范围；红线 1「不可侵入 ClkLog 社区版」同样适用于文案——不为社区版做 i18n，也不改官方镜像与模板。
2. **不翻译用户数据**。事件名、属性名、看板名、卡片标题、备注、分群名、SQL 文本等用户自建内容是**数据**，不随界面语言变化。
3. **不做时区本地化**。本 phase 只本地化「格式」，展示时区仍固定 `Asia/Shanghai`（与告警通知现状一致，见 `alert-template.ts` 的 `formatShanghaiTime`）。「时区随用户走」是独立 phase，不在本次范围内（参见 `docs/product/gap-clklog-analytics-vs-thinkingdata.md` 的时区条目）。
4. **不做 RTL（阿拉伯语 / 希伯来语）**。语言集不含 RTL 语种；仅约定新代码优先使用逻辑属性（`margin-inline-start`）以降低未来成本。
5. **不翻译 Markdown 内容资产**。`ai_workspace/default/*.md`（SOUL / AGENTS / MASS / tools）是 AI 指令层而非界面文案，v1 保持中文单版；只要求助手**回答语言**跟随用户（§7.4）。
6. **不翻译内部日志与审计存储**。`ops_action_log.detail`、`AlertEvent`、ingestor 日志等是排障与合规记录，存储原文不变（审计记录在 UI 的展示走 §4 的分类 5）。
7. **不做逐字段 DTO 校验消息本地化**（§6.4 列为 P3 可选块）：现状 class-validator 已输出英文，属增量优化而非本次契约。

### 1.4 程序门禁状态

`AGENTS.md` 要求进入「程序 / 实现」前同时具备产品设计文档与实现方案文档。当前状态：

| 门禁要素 | 状态 |
|---|---|
| ① 产品设计文档（`docs/product/prd-clklog-analytics-i18n-v1.md`） | 已落地（用户与场景、语言集与上线门槛、切换入口体验、`I18N-1..16`、非目标） |
| ② 实现方案文档（本文） | 已就绪（phase id、目标与范围、验收标准 §10、非目标 §1.3） |

**门禁已过，可进入编码**；但按 §11.3 的分批顺序与「告警域冻结窗口」协作（告警通知渠道扩展期间不碰 `src/modules/alerting/`、`features/alerting/`、`pages/Ops/`）。

### 1.5 产品验收与实现验收的对应

PRD 的 `I18N-1..16` 是产品可核对项，本文 §10 的 `I18N-AC01..16` 是实现可核对项，两者对应关系见 PRD §9 的映射表；验收记录（`docs/project/acceptance-clklog-analytics-i18n-v1.md`）须同时覆盖两组编号。

---

## 2. 调研结论：现状与规模

### 2.1 技术栈与现状（2026-09-16 实测）

| 项 | 现状 |
|---|---|
| 前端 | React 18 + TypeScript + Vite 5 + antd 5 + dayjs + ECharts + zustand + react-router 6；SPA 挂 `/sa`，无 SSR |
| 后端 | NestJS 10 + Prisma（MySQL）+ ClickHouse + Kafka；统一响应体 `{ code, message, data }` |
| 现有 i18n | **无**。`main.tsx` 硬编码 `ConfigProvider locale={zhCN}`；`src/utils/formatter.ts` 硬编码 `toLocaleString('zh-CN')`；无任何 i18n 依赖 |
| 错误提示链路 | 后端 `throw new XxxException('中文')` → `HttpExceptionFilter` 输出 `{code, message}` → 前端 `api.ts` 拦截器 `toast(message)`；`api-error.ts` 对技术错误做中文兜底 |
| 多语言现状定位 | 既有文档已明确记录：`docs/product/prd-clklog-analytics-v1.md`「多语言 → 不考虑」；`gap-clklog-analytics-vs-thinkingdata.md` 将「多语言适配」列入 gap。本 phase 即把该 gap 的第一块补齐 |

### 2.2 文案规模实测

扫描方法：`scripts/i18n_scan.py`（本 phase 新增，§11 P0），区分**字符串字面量 / JSX 文本**（需翻译）与**注释**（不翻译）。

**2026-09-16 21:00 重扫（实施起点，`python3 scripts/i18n_scan.py`）**：

| 范围 | 生产文件（含文案） | 待翻译处 | 其中 JSX 文本 | 说明 |
|---|---|---|---|---|
| `analytics-web/src/` | 155 | **3,252** | 488 | 含 metric-v2/v3 与告警通道扩展新增文案 |
| `analytics-server/src/` | 143 | **1,292** | — | 以 `throw` 的用户可见提示为主 |
| 合计 | 298 | **4,544** | 488 | 另：测试文件 111 个、1,002 处中文（按设计不迁移） |

> 同日上午的初版统计为 3,787 处；9 小时内主干新增约 20%（`apps/` 103 个文件、+9,539 行），故开工前做了全量重扫并据此重置基线。

AST 级明细（`node scripts/i18n_extract.mjs`）：4,934 处出现 / 3,291 条去重文案；其中**模块级作用域 913 处**（不能直接用 Hook，需改造成 `(t: TFunction) => …` 工厂或搬进组件）、模板字符串插值 948 处、`throw` 390 处。

前端按模块分布（待翻译处）：

| 模块 | 处数 | 模块 | 处数 |
|---|---|---|---|
| `features/query/`（事件/漏斗/留存工作台） | 506 | `pages/Meta/`（埋点全套） | 366 |
| `features/visualization/`（SQL 图表可视化） | 395 | `features/alerting/`（告警工作台） | 303 |
| `features/report/`（看板与卡片） | 285 | `pages/Report/`（看板页 + SQL 报告页） | 234 |
| `features/meta/` | 207 | `features/onboarding/`（SDK 文档站） | 207 |
| `pages/Analysis/` | 203 | `pages/Ops/`（运维四页） | 183 |
| `features/metrics/` | 169 | `pages/Admin/`（AI Workspace） | 87 |
| `pages/Iam/` | 68 | `features/time-range/` | 51 |
| `components/`（公共组件） | 153 | `layouts/`（壳层菜单） | 43 |
| 其余（分群 / 标签 / 主体 / AI 系列 / 探索图 / 时间轴 / 设置页 / services / stores / utils / 登录页） | 327 | | |

> 口径说明：去重（同一文案多处复用）与插值合并后，**预计落地 key 约 2,400–3,000 条**，这是翻译工作量的真实基数；3,311 处是迁移工作量。

后端 1,255 处中，`throw` 站点 741 处（含非用户可见的内部断言）；拆出用户可见部分后**预计错误码 300–450 条**。

### 2.3 关键约束（决定方案形态）

| 约束 | 来源 | 对方案的影响 |
|---|---|---|
| `analytics-server/src/common/`（12 文件）冻结，只减不增；`modules/shared/`（8）同 | `arch-ratchet-baseline.md` | 后端 i18n 不能塞进 `common/`；新能力必须落**新窄包** `src/i18n/` |
| `analytics-web/src/utils/`（2 文件）冻结，退出条件已写明「formatter 按用途落语义位置」 | 同上 | i18n 顺势把 `formatter.ts` 迁到 `src/i18n/format.ts`，**本轮即偿还一笔结构债** |
| 单文件 ≤1200 行；单目录生产 ≤30 文件 / 8000 行 | `AGENTS.md` 硬门禁 A/B | 资源文件按语言分子目录；单命名空间文件自设 ≤1000 行预算 |
| 棘轮扫描 glob 为 `*.ts` / `*.tsx` | `scripts/arch_ratchet.py` CONFIG | 语言资源用 `.json`（i18next 标准做法），不占棘轮文件额度；但**不得**因此把资源写成超大单文件 |
| 前端 87 个测试文件（其中 71 个含中文断言）；后端 20 个 | 实测 | 源语言必须保持 `zh-CN` 且默认渲染结果与现状逐字一致，否则测试大面积回归 |
| 发版链路：CI 只打包 `target/` 静态产物 | `AGENTS.md` 实现专用规则 | 资源随 Vite 打包进 `web/sa/assets/`，**发版流程零改动**；动态导入按命名空间切 chunk |
| 红线 1/2/3 | `AGENTS.md` | 不改社区版、不动数据链路、不入库密钥 —— i18n 全为展示层改动，天然合规（§12 逐条对照） |

---

## 3. 设计裁决（决策表）

| # | 决策 | 选择 | 理由 | 被否方案 |
|---|---|---|---|---|
| D1 | 源语言 | `zh-CN`（现有中文即源文案） | 测试断言、现有文案零改写；避免「先翻英再回中」造成术语漂移 | 以 `en-US` 为源 |
| D2 | 语言集 | 首发 `zh-CN` + `en-US`；第二梯队 `zh-TW` / `ja-JP` / `ko-KR`；预留 `de-DE` / `fr-FR` / `es-ES` / `pt-BR` / `ru-RU` | 国产私有化交付以中文为主，外籍团队 / 海外部署需要英文，亚太私有化常见繁中·日·韩；欧洲语言按客户激活 | 一次上齐 10 种（翻译质量与维护成本失控） |
| D3 | 前端库 | `i18next` + `react-i18next`（+ `i18next-browser-languagedetector`） | React 生态事实标准；命名空间懒加载、插值、复数、`suspense` 与 Vite 天然契合；社区与文档量大 | ① `react-intl`：ICU 更利于译者但迁移侵入面大、需要大量 `<FormattedMessage>` 改写；② `LinguiJS`：需 babel 宏与构建改造；③ 自研：省依赖但插值/复数/懒加载全要自己写 |
| D4 | 键形态 | **语义键** `feature.component.element`，源文案在 `zh-CN` JSON 中 | 文案可改而不动代码；占位符/复数可校验；便于术语表对齐 | 以中文原文作键（改文案即改代码，占位符易漏） |
| D5 | 资源格式与组织 | `src/i18n/locales/<tag>/<namespace>.json`，按语言分目录、按命名空间分文件 | 目录清晰、可懒加载、翻译可按命名空间派工；JSON 不占棘轮额度且便于导出给译者 | 单文件 `messages.ts`（无法懒加载、合并冲突严重） |
| D6 | 语言解析 | 四级链：`?lang=` → 用户偏好（服务端）→ 本地缓存 → 浏览器协商 → 平台默认 `zh-CN`（§5.2） | 显式意图优先；未登录也必须能选语言 | 只读浏览器语言（无法固定偏好） |
| D7 | 后端文案 | 后端返回**错误码 + 参数**，前端按当前语言渲染；`message` 字段保留为中文兜底 | 一处（前端）渲染 = 一套翻译资产；避免服务端渲染时还要猜客户端语言；向后兼容 API Key / Harness 等非浏览器调用方 | 服务端按 `Accept-Language` 渲染（双份翻译资产 + 每个响应都要解析协商） |
| D8 | 预置展示名 | 服务端预置数据（角色、权限目录、健康度）改为**下发 key + 中文兜底**，前端翻译 | 与 D7 同一套思路；权限目录是典型的「平台定义、界面展示」数据 | 前端硬编码一份中文↔英文映射（与后端漂移） |
| D9 | 通知与导出 | 服务端按**接收者语言**渲染（联系人 / 用户偏好），默认模板按语言分组，用户自定义模板原样发送 | 通知的「读者」不是当前会话用户，必须按接收者定语言 | 按发送者语言（收件人看不懂） |
| D10 | 用户数据 | 不翻译 | 事件名 / 看板名是业务数据，翻译会破坏可追溯性 | 建「资产翻译表」（神策有，属后续 phase） |
| D11 | 语言切换入口 | 个人设置（主）+ 登录页（未登录）+ `?lang=` 调试覆盖 | 登录前也要能读；`?lang=` 支撑验收与支持排障 | 仅侧栏下拉（未登录不可选） |
| D12 | 时间 / 数字 | 格式随语言，时区固定 `Asia/Shanghai` | 与本 phase 解耦，避免一次性改动过大；时区独立 phase | 一起做（范围膨胀，且会动告警口径） |
| D13 | 覆盖率治理 | 新增 `scripts/i18n_scan.py` + `scripts/i18n-baseline.json`，**只减不增**；不改动架构棘轮脚本 | 棘轮脚本是分发源模板产物（`AGENTS.md` B.5），不得私改口径；同思路另立一个专用棘轮 | 把 i18n 指标塞进 `arch_ratchet.py` |

---

## 4. 文案分类与归属矩阵（本 phase 的核心分类法）

迁移时**先归类再动手**，避免把「数据」当「文案」翻。

| # | 类别 | 实例 | 权威层 | 处理方式 | 批次 |
|---|---|---|---|---|---|
| 1 | 界面框架文案 | 菜单、按钮、表单标签、表头、空态、Tooltip、引导文案 | 前端 | `t('report.dashboard.create')`，命名空间 §5.3 | P1–P2 |
| 2 | 前端固定枚举展示 | 状态（启用/隐藏）、类型（事件/虚拟事件）、操作（查看/编辑）、时间粒度、图表类型 | 前端 | 稳定 key → 文案映射，集中放 `common` / 所属命名空间 | P1–P2 |
| 3 | 前端技术错误兜底 | `api-error.ts` 的 401/403/5xx/超时/网络提示 | 前端 | `errors` 命名空间 | P1 |
| 4 | 后端错误与校验提示 | `throw new BadRequestException('数据表没有字段，无法关联属性')` | 后端定义 key / 前端渲染 | `{ errorCode, messageKey, params, message }`，前端优先 `messageKey`（§6.1） | P3 |
| 5 | 服务端预置展示名 | 角色名、权限目录 feature/op/detail、告警健康度、内置指标口径名 | 后端下发 key | 服务端返回 `*_key` + 中文原值兜底；前端翻译（§6.3） | P3 |
| 6 | 服务端生成内容 | 告警默认模板、导出表头、AI 回答语言 | 服务端按接收者 | 默认模板按语言分组；导出走 `x-locale`（§7） | P4 |
| 7 | 内容型资产 | 接入指南 / SDK 文档站（`sdk-guides.ts` 730 行）、AI 工作区 markdown | 前端内容层 | 转成命名空间资源，逐语言补齐；未翻译语言回退中文并在页面标注 | P6 |
| 8 | 用户数据 | 事件名、属性名、看板/卡片标题、备注、SQL、分群名 | 用户 | **不翻译** | — |
| 9 | 内部记录 | 应用日志、`ops_action_log`、ingestor 日志、DLQ | 系统 | 不翻译；UI 上展示的部分改走类别 4/5 | — |

---

## 5. 前端架构

### 5.1 新窄包 `apps/analytics-web/src/i18n/`

按硬门禁 A4：不得落 `src/utils/`（冻结）或新建 `common`/`shared` 类杂项包；`i18n` 是语义明确的能力包。

```
apps/analytics-web/src/i18n/
├── index.ts            # 实例创建 + initI18n/changeLocale/applyUserLocale + 重导出（唯一入口）
├── config.ts           # LOCALES 注册表、命名空间清单、回退链（唯一权威）
├── detect.ts           # 语言解析链（§5.2，纯函数可单测）
├── backend.ts          # i18next 资源后端（import.meta.glob 按文件切 chunk）
├── LocaleBridge.tsx    # antd / dayjs 语言包映射 + <html lang> + 文档标题（原计划名 antd-locale.ts）
├── LocaleSelect.tsx    # 语言选择组件（个人设置 / 登录页共用，原计划名 locale-switcher.tsx）
├── useT.ts             # 组件内取 t 的薄包装（原计划名 useLocale.ts）
├── format.ts           # 数字/百分比/时长/日期时间格式化（承接 utils/formatter.ts 的退出条件）
├── i18next.d.ts        # 模块增强（键的编译期类型见 §14.2-1 的差异说明）
└── locales/
    ├── zh-CN/{common,shell,auth,errors,report,analysis,cohort,meta,metrics,sql,datatable,iam,alerting,ops,onboarding,ai}.json
    └── en-US/…（同构；第二梯队语言按需新增目录）
```

文件数 9（生产，含 1 个 `.d.ts`），低于包上限；命名空间 16 个（比 §5.3 初版多一个 `metrics`，把指标域从 `meta` 里分出来避免单文件过大）。

包内文件预算：生产 ≤12 文件 / ≤1200 行（远低于上限）。单 JSON ≤1000 行（自设，便于评审与翻译）。

**接线点（保持入口纯净，硬门禁 A2）**：`main.tsx` 仅新增 `import './i18n'` 与把写死的 `zhCN` 换成 `<LocaleBridge>`（读取当前语言 → 包一层 `ConfigProvider locale={antdLocale}` + `dayjs.locale(...)` + `<html lang>`）。业务规则一律留在 `src/i18n/`，不进 `main.tsx`。

### 5.2 语言解析链（唯一权威，纯函数）

优先级从高到低：

| 级 | 来源 | 生效范围 | 说明 |
|---|---|---|---|
| 1 | URL `?lang=<tag>` | 本次会话（写 `sessionStorage`，便于支持排障与验收脚本） | 非法 tag 静默忽略，不报错 |
| 2 | 登录用户偏好 `SaUser.locale` | 账号级 | 登录成功后由 `auth.store` 同步进语言偏好 |
| 3 | 本地缓存 `clklog-analytics-locale` | 设备级 | 覆盖「未登录 / 登出后」场景 |
| 4 | `navigator.languages`（服务端可读 `Accept-Language`） | 设备级 | 取第一个可匹配 tag |
| 5 | 平台默认 `zh-CN` | 全局 | 最终兜底 |

**标签匹配与回退**：用 BCP-47 标签；匹配规则为「精确 → 语言级回退 → 平台默认」：`zh-TW` → `zh-Hant` → `zh-CN`；`en-GB` → `en-US`；`de-AT` → `de-DE`。调用方禁止自行写 `startsWith('en')` 之类的判断，一律走 `resolveLocale()`。

**切换语义**：登录用户切换即调 `PUT /sa/api/auth/preferences` 落库（与 `default_project` 同一接口，字段加法）；未登录用户只写本地缓存；切换后**不整页刷新**——`i18next.changeLanguage` 触发 React 重渲染，antd locale 与 dayjs 同步切换。

### 5.3 命名空间与键命名

命名空间（15 个，与路由/业务域对齐，翻译可按域派工）：

| 命名空间 | 覆盖内容 |
|---|---|
| `common` | 通用动作、状态、空态、单位、日期粒度、确认弹窗 |
| `shell` | 侧栏菜单、顶栏、项目切换、退出、加载中占位 |
| `auth` | 登录页、个人设置、改密、权限门（403 / 需登录） |
| `errors` | 前端错误兜底 + 后端错误码渲染（键与后端 §6.2 目录一一对应） |
| `report` | 看板列表 / 详情 / 工作室 / 卡片 / 缓存态 |
| `analysis` | 事件分析 / 漏斗 / 留存 / 工作台 / 时间范围 |
| `cohort` | 用户分群 / 标签 / 分析主体 |
| `meta` | 埋点管理、事件 / 属性 / 虚拟对象、指标、数据质量、Debug |
| `sql` | SQL 报告、Builder、元数据字典、图表配置 |
| `datatable` | 数据表、字段绑定、模板导入 |
| `iam` | 成员、成员组、角色、权限目录、数据权限 |
| `alerting` | 规则、联系人、模板、通知记录、屏蔽、健康度 |
| `ops` | 慢 SQL、服务器状态、数据管理、日志清理 |
| `onboarding` | 接入指南 / SDK 文档站（内容型，P6） |
| `ai` | AI 助手面板、AI 工作区、连接与同步状态 |

键命名规则（评审强制）：

```
<namespace>:<对象>.<动作|属性>.<细分>
common:action.save                 report:dashboard.empty
alerting:rule.health.metric_missing  meta:event.type.virtual
errors:meta.datatable.field_required  sql:builder.group.by
```

- 层级 ≤4 段；每一段用 `lowerCamelCase`（与 TS 命名一致，便于在代码里直接书写）；**禁止**在键里编码语言（`title_cn`）或版本。
- 动态拼接键（`` t(`status.${s}`) ``）只允许用于**枚举白名单**，且必须经 `assertEnumKey()` 校验（漏键在测试中失败）；其余一律枚举写死，保证可静态校验。
- 插值统一 `{{name}}`（i18next 默认）。
- **复数（2026-09-17 落地细节）**：基础键是所有语言都必须提供的**兜底形态**（数字插值即可，如 en `{{count}} item(s)`）；
  语言按自己的 CLDR 规则**追加变体** `_zero/_one/_two/_few/_many/_other`（英/法/德 one+other；俄 one/few/many/other；
  中/日/韩只用基础键）。i18next 在缺少变体时回退到基础键（已实测：只写基础键的 zh-CN 渲染正常），
  因此**已发布语言无需返工**；`i18n_check.py` 与前端 `resources.spec.ts` 按「剥离后缀后比较键集」校验，
  并强制「变体必须挂在源语言存在的基础键上」。
- 富文本（含 `<strong>`、链接）用 `<Trans>` 组件，禁止把 HTML 塞进 JSON。
- **术语表（glossary）与本方案同批维护**，作为翻译一致性的唯一依据：埋点 = tracking plan / event tracking，事件 = event，属性 = property，虚拟事件 = virtual event，漏斗 = funnel，留存 = retention，分群 = cohort，标签 = tag，看板 = dashboard，卡片 = card，指标 = metric，告警 = alert，屏蔽 = mute，分析主体 = analysis subject，元数据 = metadata，数据表 = data table，归属 = attribution。

### 5.4 组件与开发约定

1. 函数组件内 `const { t } = useTranslation('report');`；仅在需要多命名空间时传数组。
2. 文案**不出组件**：禁止把 `t()` 结果当 props 传递后再拼接（破坏复数与语序），需要组合时传 key。
3. 表头、列宽、按钮宽度：英文比中文长 30–50%，`docs/architecture/templates/AGENTS_front.md` 的门禁（禁止把标签压成竖字 / 禁止 `word-break: break-all`）在英文下表现为长词截断——统一 `ellipsis + Tooltip`，列宽给 `min-width` 而不是固定 `width`。
4. 文案迁移与业务改动**不得混提**：迁移批次只允许「等值替换」（渲染结果与 zh-CN 现状逐字一致）。
5. 语言资源懒加载：`zh-CN` 与 `common`/`shell`/`auth`/`errors` 静态打包（首屏零闪烁），其余命名空间按路由 `import()` 动态加载；`Suspense` 边界沿用现有 `LazyWrap`。

### 5.5 与 antd / dayjs / ECharts 的集成

| 项 | 做法 |
|---|---|
| antd | `antd/locale/{zh_CN,en_US,zh_TW,ja_JP,ko_KR,...}` 按当前语言注入 `ConfigProvider`；缺语言包时回退 `en_US` 并在控制台告警 |
| dayjs | `import 'dayjs/locale/xx'` + `dayjs.locale(tag)`；日期格式字符串仍用 `YYYY-MM-DD` 这类 token（跨语言稳定），**月份 / 星期名**交给 locale |
| 格式化 | `format.ts` 用 `Intl.NumberFormat` / `Intl.DateTimeFormat`，`locale` 取当前语言；中文的「万/亿」仅在 `zh-*` 语言下启用，其他语言用 K/M/B（现有 `formatNumber` 依赖 `toLocaleString('zh-CN')`，本次一并纠正） |
| ECharts | 图表内固定文案（图例、坐标轴名、tooltip 前缀）由调用方 `t()` 传入；不再在图表组件内写死中文 |
| 文档标题 / `<html lang>` | 随语言更新（`document.documentElement.lang`），影响浏览器翻译提示与无障碍朗读 |

---

## 6. 后端架构

### 6.1 错误响应契约（加法式，不破坏现有客户端）

现有响应：

```json
{ "code": 400, "message": "数据表没有字段，无法关联属性", "data": null }
```

新增契约（**全部为可选新增字段**，`code` / `message` / `data` 语义不变）：

```json
{
  "code": 400,
  "message": "数据表没有字段，无法关联属性",     // 保留：中文兜底，老客户端 / API Key / Harness 继续可用
  "errorCode": "meta.datatable.no_fields",      // 稳定机器码（日志、告警、埋点用）
  "messageKey": "errors:meta.datatable.no_fields", // 前端翻译键（与前端 errors 命名空间同名）
  "params": { "count": 0 }                       // 插值参数（无则省略）
}
```

前端 `toUserFacingApiError` 改为：**有 `messageKey` → `t(messageKey, params)`；否则沿用现有中文兜底逻辑**（技术错误脱敏规则完全保留）。这样 P3 可以逐模块推进，未迁移模块行为零变化。

> `message` 在 `DomainErrorInput` 里是**可选**的（2026-09-20 明确）：新错误若没有值得保留的中文兜底，只给 `code` + `messageKey` 即可。
> 覆盖率棘轮统计的是「调用块内没有 `messageKey` 的抛错」（见 §11.9），而新增一条**带兜底**的错误会推高所在目录的硬编码计数，与「只减不增」冲突。
> 老客户端对新错误会拿到空 `message`，前端不受影响（优先按 `messageKey` 渲染）。

### 6.2 后端新窄包 `apps/analytics-server/src/i18n/`

按硬门禁 A4 与冻结清单：`src/common/`（12 文件）不可新增文件，故 i18n 能力落新包，并**顺手把钱还了**（冻结目录只减不增）：

```
apps/analytics-server/src/i18n/
├── domain-error.ts        # DomainError 基类 + 工厂（code + messageKey + params + 中文兜底）
├── error-response.filter.ts   # 由 common/filters/http-exception.filter.ts 迁入，增加 errorCode/messageKey/params
├── locales.ts             # 服务端语言注册表 + normalizeLocaleTag（与前端 LOCALES 对齐）
├── locale.ts              # 从请求解析语言（x-locale / Accept-Language），供导出等按操作者语言渲染
├── messages.ts            # serverT(locale, key, params)：服务端产出内容用（通知等），缺键回退 zh-CN
└── messages/{zh-CN,en-US}.json   # 服务端侧渲染用的文案（仅通知 / 导出等，不含接口错误）
```

实现时**未**建 `error-catalog.ts` 与 `validation.pipe.ts`：错误码随之写在 `DomainError` 调用处（`code` 与 `messageKey` 同时给出，目录即代码），DTO 校验消息本地化见 §1.3-7 的非目标；`common/pipes/` 因此未迁出。

迁移带来的结构债偿还（需在 `arch-ratchet-baseline.md` 同步登记）：

| 目录 | 迁移前 | 迁移后 | 依据 |
|---|---|---|---|
| `analytics-server/src/common/` | 12 文件 | **11**（filters 迁出；P3 可选块再迁 pipes → 10） | 冻结值只减不增，迁出合法 |
| `analytics-web/src/utils/` | 2 文件 | **1**（`formatter.ts` → `src/i18n/format.ts`） | 基线已写明该文件退出条件 |

**禁止**：在新包内读 `process.env`（环境变量豁免仅 `src/config/`、`src/scripts/`）；如需配置，经 `src/config/configuration.ts` 注入。

### 6.3 平台预置展示名的 key 化

| 预置数据 | 现状 | 目标 |
|---|---|---|
| 角色名 `ROLE_LABELS` | 中文常量 | 下发 `role_key`（已有）+ 前端 `iam:role.<key>`；`ROLE_LABELS` 保留为中文兜底（非浏览器调用方） |
| 权限目录 `PERMISSION_CATALOG` | `feature` / `op` / `detail` 均为中文 | 新增 `feature_key` / `op_key` / `detail_key`，原字段保留中文兜底；前端优先 key |
| 告警健康度 | 中文枚举文案 | 下发 `health` 枚举（已有）+ 前端 `alerting:rule.health.<key>` |
| 告警默认模板 | 单一中文模板 | 按语言分组（§7.2） |
| 内置指标 / 规则名 | 用户可见（存库） | **不翻译**（属类别 5→8 的边界：规则名是用户可编辑数据，改动会改写用户资产） |

原则：**预置「结构」下发 key，预置「文本」只在默认值场景本地化**；用户改过的值永不被翻译覆盖。

### 6.4 DTO 校验消息（可选块，P3 之后）

`validation.pipe.ts` 现状无 `exceptionFactory`，class-validator 输出英文默认消息（中文用户当前也看到英文）。改进方式：加 `exceptionFactory`，把 constraint 名映射为 `errors:validation.<constraint>` 并带上 `property` 参数，前端插值渲染属性名。因涉及迁移冻结目录文件，与 §6.2 的 pipes 迁移同批完成，不单独插队。

---

## 7. 通知、导出与 AI

### 7.1 接收者语言解析

| 场景 | 语言来源 |
|---|---|
| 告警通知（飞书 / 邮件 / 短信） | 联系人绑定用户 → `SaUser.locale`；联系人无账号（纯 webhook） → 项目默认 → 平台默认 `zh-CN` |
| 导出文件（Excel / CSV 表头） | 请求方：请求头 `x-locale`（前端所有导出请求带上）→ 回退 `zh-CN` |
| AI 助手回答 | 用户偏好 `SaUser.locale` → 会话请求携带，注入系统提示 |

### 7.2 告警模板

- 现结构 `DEFAULT_TEMPLATES[kind][channel]` 扩为 `DEFAULT_TEMPLATES[locale][kind][channel]`，`zh-CN` 为必填、`en-US` 同批交付；解析顺序：**用户自定义模板 → 当前语言默认模板 → `zh-CN` 默认模板**。
- 模板编辑器（告警工作台「通知模板」Tab）中的占位符说明、预览内容随界面语言；预览渲染用**接收者语言**（与投递一致），避免「预览中文、实发英文」的错觉。
- 存量自定义模板是用户数据，**原样发送、不被翻译**（§4 类别 8）；模板表不新增 locale 列（一个项目一套自定义模板，语言不参与存储）。
- 短信 40 字符截断逻辑（`collapseForSms`）在英文下更易截断，需按渲染后长度判定（现状即如此，本次只加断言用例）。

### 7.3 导出

技术图表 / 表格导出（`exceljs`）的表头、工作表名、文件名走 `x-locale`；导出内容里的用户数据不译。文件名建议 `{dashboard}-{YYYYMMDD}.xlsx`（语言无关部分保持稳定，避免下游脚本解析失败）。

### 7.4 AI 助手

- 系统提示追加一条语言指示：`以 {{locale}} 回答用户；术语遵循平台术语表`（提示模板本身保持中文，属指令层）。
- 分析提案 / SQL 生成结果中的**解释性文字**随指示变化；生成的 SQL 与字段名不变（数据层）。
- AI 工作区 markdown（`ai_workspace/default/*.md`）v1 不翻译（§1.3-5），仅在文件中标注语言指示入口。

---

## 8. 数据与持久化变更

| # | 变更 | 说明 | 兼容性 |
|---|---|---|---|
| 1 | `SaUser.locale String?` | 用户语言偏好；`null` = 跟随浏览器 | 迁移新增可空列，老数据不受影响 |
| 2 | `SaProject.default_locale String?`（第二梯队） | 项目默认语言（通知接收者无账号时的兜底） | 可空，默认 `null` → 平台默认 |
| 3 | `PUT /sa/api/auth/preferences` 增加 `locale` 字段 | 与 `default_project` 同一接口，字段加法 | 老客户端不传即不更新 |
| 4 | 错误响应新增 `errorCode` / `messageKey` / `params` | §6.1 | 加法式，老客户端忽略 |
| 5 | 权限目录新增 `*_key` 字段 | §6.3 | 加法式，原中文字段保留 |

迁移文件命名沿用现有约定（`prisma/migrations/<timestamp>_i18n_locale/`），发版时随 `prisma migrate deploy` 生效（`AGENTS.md` 实现专用规则）。

---

## 9. 门禁合规对照

| 门禁条目 | 本方案的落地 |
|---|---|
| A1 行数 / 包上限 | 新包 12 文件 / ≤1200 行；单 JSON ≤1000 行；不触碰 30 文件 / 8000 行线 |
| A2 入口装配纯净 | `main.tsx` 只加一行 import 与 locale 注入；业务规则在 `src/i18n/` |
| A3 禁止伪模块 | `i18n/` 为语义包；语言注册表集中一处，无集中分派 |
| A4 禁止承接式包 | 不落 `utils/`、不新建 `common|shared|core`；并**迁出** 2 个冻结目录文件 |
| B6 超标包只减不增 | `common/` 12→11（+可选 10）；`utils/` 2→1；不新增任何冻结目录文件 |
| B7 基线不得回退 | 每批跑 `arch_ratchet.py`，数值持平或下降 |
| C10 依赖单向 | 前端 i18n 不依赖 `features/*`（只被依赖）；后端 i18n 不依赖业务模块（业务模块依赖它） |
| C11 领域包纯净 | 后端 i18n 不读 `process.env`、不碰 `Request`/`Response`（`locale.ts` 只接受已提取的字符串） |
| D13 单一写入方 | 语言偏好的写入方唯一：`auth` 模块的 preferences 接口 |
| D15 单一写入口 | 语言偏好 HTTP 与后续 CLI 复用同一 service |
| E17 双轨登记 | 错误码迁移期「有 key 走 key、无 key 走中文」是兼容层，需在 `CODE_HANDOVER.md` 登记（负责域：全后端；删除条件：P3 完成且覆盖率基线清零；期限 30 天） |
| 前端布局门禁 | 英文变长：列宽用 `min-width` + `ellipsis`；禁止 `word-break: break-all`；E2E 断言英文下无竖排/截断溢出 |
| 红线 1–7 | 见 §12 |

---

## 10. 验收标准（可核对）

统一验收命令：

```bash
python3 scripts/i18n_scan.py --check      # 覆盖率棘轮（只减不增）
python3 scripts/i18n_check.py             # 资源一致性（parity / 占位符 / CJK 残留）
python3 scripts/arch_ratchet.py           # 结构棘轮
cd apps/analytics-web && npm test && npm run build
cd apps/analytics-server && npm test
```

| 编号 | 验收项 | 判定 |
|---|---|---|
| I18N-AC01 | 语言解析链 | `detect.spec.ts` 覆盖 `?lang=` > 用户偏好 > 本地缓存 > 浏览器 > 默认，含 `zh-TW→zh-CN`、`en-GB→en-US`、非法 tag 忽略，全部通过 |
| I18N-AC02 | 资源一致性 | `i18n_check.py` 退出码 0：各语言 key 集合完全相同、无多余 key、`{{}}` 占位符集合一致、`en-US` 无 CJK 字符残留 |
| I18N-AC03 | 现有测试不回归 | 前端 87 个 spec、后端 20 个 spec 全绿（zh-CN 默认渲染结果与迁移前逐字一致） |
| I18N-AC04 | 切换持久化 | 个人设置切换语言 → 刷新保持；`SaUser.locale` 落库；清 localStorage 后回退浏览器语言；未登录切换只写本地缓存 |
| I18N-AC05 | 英文无残留（E2E） | `?lang=en-US` 下登录页、看板详情、事件分析、告警工作台四页 DOM 文本扫描无 CJK（白名单仅用户数据与专有名词），附截图 |
| I18N-AC06 | 组件库联动 | antd 日期选择器、分页、表格空态、确认框在 `en-US` 下全英文；`<html lang>` 与 `document.title` 同步 |
| I18N-AC07 | 格式本地化 | 数字千分位、百分数、时长、日期在同一数据下 `zh-CN` / `en-US` 输出符合各自习惯（含 `万/亿` 仅中文启用）用例 |
| I18N-AC08 | 后端错误契约 | 契约测试：`code!=0` 响应含 `errorCode` + `messageKey`；未迁移模块仍返回中文 `message`，前端展示不回归 |
| I18N-AC09 | 错误码渲染 | 前端 `toUserFacingApiError` 在 `en-US` 下把已迁移错误码渲染成英文，未迁移仍走中文兜底且技术错误脱敏规则不变 |
| I18N-AC10 | 通知本地化 | 单测 + 实测：`en-US` 接收者收到英文飞书 / 邮件；自定义模板用户保持原文；无账号联系人回退项目 / 平台默认 |
| I18N-AC11 | 导出本地化 | 带 `x-locale: en-US` 的导出表头为英文，数据内容不变（含断言文件名字形稳定） |
| I18N-AC12 | 覆盖率棘轮 | `i18n_scan.py --check` 退出码 0；未迁移条数 ≤ 基线；`--update` 只允许下调 |
| I18N-AC13 | 结构棘轮与债务偿还 | `arch_ratchet.py` 退出码 0；`common/` 12→11（或 10）、`utils/` 2→1，基线文档同步登记 |
| I18N-AC14 | 首屏体积 | `npm run build` 通过；首屏语言包（`common`+`shell`+`auth`+`errors`，单语言）gzip ≤ 60KB；其余命名空间各自成 chunk（构建产物断言） |
| I18N-AC15 | 新增语言零代码 | 仅新增 `locales/<tag>/` + 注册表一行即可上线，`i18n_check.py` 通过；以 `zh-TW` 为验证样本（可用机器初翻 + 人工校正） |
| I18N-AC16 | 生产只读验证 | 发版后线上实测：切换语言 → 四页浏览 → 触发一条测试告警（用自检指标）确认通知语言；附 `.version`、chunk 与新 supervisor uptime 证据（发版流程见 `AGENTS.md`） |

---

## 11. 工具、治理与实施分批

### 11.1 工具

| 脚本 | 职责 | 说明 |
|---|---|---|
| `scripts/i18n_scan.py` | 扫描 `apps/analytics-web/src`、`apps/analytics-server/src` 中**待翻译中文字面量**，按目录统计；`--check` 与 `scripts/i18n-baseline.json` 比较（只减不增），`--report` 仅打印，`--update` 只允许下调 | 自建专用棘轮；**不改动** `arch_ratchet.py`（分发源模板产物）。口径：仅计字符串字面量与 JSX 文本，注释不计；白名单文件（测试断言、术语表、SQL 示例）显式登记 |
| `scripts/i18n_check.py` | 资源一致性 + 键存在性：各语言 key 集合一致、占位符一致、空值（白名单）、`en-US` 的 CJK 残留、键命名规范、**业务代码里 `t('ns:key')` 引用的键必须存在**、业务代码不得直连 i18n 实例 | CI 必跑；失败即阻断 |
| `scripts/i18n_extract.mjs` | **AST 级**提取器（TypeScript 编译器 API）：列出每处待翻译文案的上下文（JSX 属性 / 对象属性 / 调用 / 异常）与作用域（组件内 / 函数内 / 模块级），用于决定迁移机制与分批派工 | 比 `i18n_scan.py` 的正则口径更细，仅用于分析与派工，不参与棘轮 |
| `scripts/i18n_export.py` | 导出/回填翻译包（按命名空间生成待译 CSV，回填后覆盖 JSON） | **未实现**：本轮 zh↔en 由实施过程直接生成，术语表 + `i18n_check.py` 已足以保证一致性；引入第三种语言前补 |
| CI（`.gitlab-ci.yml`） | build 阶段追加 `i18n_check.py` + `i18n_scan.py --check` | 失败即构建失败，避免「语言包漏 key 上线」 |

### 11.2 翻译工作流

1. 迁移代码时同步写 `zh-CN` 资源（源文案 = 从代码里原样剪切，**不得顺手改文案**）。
2. 每批迁移完成后 `i18n_export.py` 输出待译包 → 机器初翻 → 人工按术语表校正 → 回填 `en-US`。
3. `i18n_check.py` 通过 + 该模块 E2E 截图留证 → 合入。
4. 术语表随批更新，禁止同一术语多种译法（校验脚本对术语表做白名单检查）。

### 11.3 分批实施（每批一个可验收单元）

| 批 | 内容 | 规模（待迁移处，估算 ±10%） | 出口条件 |
|---|---|---|---|
| **P0** | `src/i18n/` 包 + 解析链 + `LocaleBridge` + 语言切换 UI + `format.ts` 迁移 + 三个脚本 + 测试骨架 | 0（纯基建） | I18N-AC01/02/12/13/15 |
| **P1** | 壳层与公共面：`layouts/` + `components/` + 登录页 / 403 页 + `services/` 前端兜底 + `errors` 命名空间 | ≈ 280 | I18N-AC03/05/06/07（+ 登录页 E2E） |
| **P2-A** | 看板域：`pages/Report/` + `features/report/` | ≈ 519 | 该域 spec + 英文截图 |
| **P2-B** | 分析域：`features/query/` + `features/time-range/` + `features/explore-charts/` + `pages/Analysis/`（事件/漏斗/留存/主体） | ≈ 798 | 同上 |
| **P2-C** | 埋点域：`pages/Meta/` + `features/meta/` + `features/metrics/` | ≈ 742 | 同上 |
| **P2-D** | SQL 与可视化：`features/visualization/` + SQL 报告页 / Builder | ≈ 420 | 同上 |
| **P2-E** | 分群 / 标签 / 主体 / 数据表：`features/cohort`、`features/tag`、`features/subject` + 数据表页与导入导出 | ≈ 150 | 同上 |
| **P2-F** | 权限与设置：`pages/Iam/` + `pages/Settings/` | ≈ 150 | 同上 |
| **P2-G** | 告警与运维：`features/alerting/` + `pages/Ops/` | ≈ 486 | 同上 |
| **P2-H** | AI 域：`features/ai*` + `pages/Admin/AiWorkspacePage` | ≈ 156 | 同上 |
| **P3** | 后端错误码：`src/i18n/` 后端包 + filter/pipe 迁移 + 逐模块替换 `throw` + 预置展示名 key 化 | 1,255 处中用户可见部分 | I18N-AC08/09，`i18n_scan` 后端基线清零或登记剩余 |
| **P4** | 通知与导出：默认模板按语言、接收者语言解析、导出 `x-locale` | — | I18N-AC10/11 |
| **P5** | 第二梯队语言上线：`zh-TW`、`ja-JP`、`ko-KR` | 全量 key × 3 | I18N-AC02/15 |
| **P6** | 内容层：接入指南 / SDK 文档站命名空间化 + AI 回答语言指示 | ≈ 207 + 提示层 | 页面语言标注 + 助手按语言回答实测 |
| **P7** | 生产验收：线上四页实测 + 一条测试告警 | — | I18N-AC16 + `docs/project/acceptance-clklog-analytics-i18n-v1.md` |

依赖顺序：P0 → P1 → P2-*（可并行，按域独立）→ P3 → P4 → P5 → P6 → P7。**P3 不前置**是刻意选择：前端 key 化完成后，错误码只需对齐 `errors` 命名空间，避免两边同时动。

---

## 12. 红线对照与风险

### 12.1 红线对照（`AGENTS.md` 绝对红线）

| 红线 | 本方案 |
|---|---|
| 1 不可侵入 ClkLog 社区版 | 只改 `/sa` 分析平台；社区版前端与镜像零改动（§1.3-1） |
| 2 不可破坏数据链路 | 纯展示层；无 Kafka / Flink / ClickHouse 改动 |
| 3 不可把密钥写入仓库 | 语言资源不含任何凭据；翻译包导出脚本不做外发上传 |
| 4 ClickHouse 查询有界 | 不受影响（无查询改动） |
| 5 目录权限 | 不受影响（无 Puppet / 目录 owner 改动） |
| 6 不可静默改写数据 | 新增列均为可空；不修改任何存量行（含告警自定义模板） |
| 7 配置真相在 Puppet | 无新增环境变量；语言集为代码内注册表，不做服务器侧配置 |

### 12.2 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 英文文案变长导致布局溢出 / 标签截断 | 界面可用性 | 列宽 `min-width` + `ellipsis`；E2E 在 `en-US` 下断言关键页无溢出（I18N-AC05）；禁 `word-break: break-all` |
| 71 个含中文断言的测试文件回归 | 交付节奏 | 默认语言固定 `zh-CN` 且迁移只做等值替换；测试基建在 `vitest.setup.ts` 统一初始化 i18n（不逐个改测试） |
| 一次性迁移 3,311 处引入行为差异 | 质量 | 按域分批（P2-A…H），每批只等值替换 + 附该域 spec 与截图 |
| 后端错误码迁移造成「有 key 无文案」的空白提示 | 体验 | `i18n_check.py` 强制 key 双向存在；前端渲染失败自动回退中文 `message`；`errors` 命名空间纳入 AC09 |
| 术语不一致（同一概念多种译法） | 专业度 | 术语表 + 校验脚本白名单；翻译评审按术语表逐条核对 |
| 首发语言包过大拖慢首屏 | 性能 | 命名空间懒加载 + 构建产物 chunk 断言（I18N-AC14） |
| 通知语言与界面语言混淆 | 误报投诉 | 明确定义「接收者语言」（§7.1），模板预览按接收者语言渲染 |
| 时区误认为已本地化 | 期待落差 | §1.3-3 明确非目标；文档与 PRD 同步声明 |

---

## 13. 后续 phase（本 phase 不做，登记备查）

1. **时区本地化**：用户 / 项目时区、看板时间口径、告警窗口与展示对齐（与本文 D12 解耦）。
2. **资产翻译（神策式「翻译资产」）**：事件名 / 属性名 / 看板名的多语言显示名（属 §4 类别 8 的扩展，需要新的资产表与权限）。
3. **RTL 支持**：CSS 逻辑属性改造 + 布局镜像 + 图表方向适配。
4. **内容型资产多语言**：`ai_workspace/default/*.md`、接入指南全文多语言版本管理与版本切换。
5. **翻译平台接入**：若翻译语言数 > 5 或迭代频繁，再评估引入 TMS（当前用仓库内 JSON + 导出脚本足够）。

---

## 14. 实施记录与差异登记（2026-09-16，首发 zh-CN + en-US）

> 规则来源：本文 §0 第 4 条——实现与契约不一致时必须写进文档，不得静默另立一套。

### 14.1 已落地

| 项 | 落点 | 证据 |
|---|---|---|
| 前端 i18n 包 | `apps/analytics-web/src/i18n/`：`index.ts`（实例 + `initI18n` / `changeLocale` / `applyUserLocale`）、`config.ts`（语言与命名空间注册表）、`detect.ts`（解析链）、`backend.ts`（`import.meta.glob` 懒加载）、`useT.ts`、`LocaleBridge.tsx`（antd / dayjs / `<html lang>` / 标题）、`LocaleSelect.tsx`（登录页与个人设置共用）、`format.ts` | `src/i18n/*.spec.ts(x)` 12 项通过 |
| 语言解析链 | `?lang=` → 会话覆盖（sessionStorage）→ 用户偏好（localStorage，登录后由服务端下发覆盖）→ 浏览器语言 → 平台默认 | `detect.spec.ts` 6 项 |
| 切换入口 | 登录页右下角（未登录可用）+ 个人设置「界面语言」；登录成功后按 `SaUser.locale` 应用 | `en-US-render.spec.tsx` |
| 后端语言偏好 | `sauser.locale` 列 + `PUT /sa/api/auth/preferences` 支持 `locale`（**部分更新**语义，避免只改语言清空默认项目）；`login`/`me` 返回 `locale` | 迁移 `20260916230000_user_locale`；server 84 套 / 617 用例通过 |
| 错误码契约 | `DomainError` + `errorCode` / `messageKey` / `params`（`src/i18n/domain-error.ts`）；过滤器迁至 `src/i18n/error-response.filter.ts`；前端 `api-error.ts` 优先按 `messageKey` 渲染，无 key 时保持原有中文兜底与技术错误脱敏 | 老客户端继续读 `message`，契约加法式 |
| 通知按接收者语言 | `DEFAULT_TEMPLATES` 增加语言维度 + 英文默认模板；`AlertContact.locale` 列；检测器按联系人语言逐个渲染；level / status / metric kind / window 标签按语言生成 | `test/alerting/alert-template.spec.ts` 21 项（含语言矩阵与回退） |
| 服务端文案包 | `src/i18n/messages/{zh-CN,en-US}.json` + `serverT()`（缺键回退 zh-CN，再回退键名，投递不因缺文案失败） | 同上 |
| 结构债偿还 | `common/` 12→11 文件、`utils/` 2→1 文件；登记见 `arch-ratchet-baseline.md` | `arch_ratchet.py` 退出码 0 |
| 业务域迁移 | 12 个域按 §11.3 分批推进（壳层、公共组件、告警、看板、分析、埋点、指标、SQL、分群、权限、运维、AI、接入指南） | `i18n_scan.py --report` |
| 结果列名本地化（2026-09-17 补交） | `QueryColumn.title_key` / `title_params` 加法式契约 + 前端单点 `features/query/column-titles.ts` | 见 §14.3 |
| 指标口径多语言（2026-09-17 收口） | 复合指标列名（`metricTitleDescriptor` + `<slot>_key` 子键）、阶段汇总行行值、窗口/摘要/取值说明结构字段；前端单点 `column-titles.ts` / `metric-definition.ts` | 见 §14.4 |

### 14.2 与契约的差异（均已在本节登记）

1. **键的编译期类型未启用**。i18next v23 的 `CustomTypeOptions.resources` 在「多命名空间 + `ns:key` 全限定键」组合下不生成带前缀的键类型，强行开启会让所有 `t('shell:document.title')` 报类型错。改为：`scripts/i18n_check.py` 做**键存在性 + 语言一致性 + 占位符**校验（比编译期类型更贴近运行时），并在测试里保留运行期一致性断言（`resources.spec.ts`）。
2. **资源加载策略**：不按路由懒加载命名空间，而是**启动时预载当前语言的全部命名空间**（`initI18n()` 在 render 之前 await）。理由：避免每个使用懒加载命名空间的组件都必须处在 Suspense 边界内，也避免首屏键名闪烁。代价是每语言一次性加载全部 JSON（约几十 KB gzip，浏览器缓存）。**AC14 相应调整为**：首屏不得因语言包产生可见闪烁；构建产物按语言分 chunk（不把非当前语言打进首屏）。
3. **键命名末段**：采用 `lowerCamelCase`（原 §5.3 写 `snake_case`），已同步修正 §5.3 与校验脚本。
4. **测试基建**：`vitest.setup.ts` 直接读磁盘把两种语言的资源灌进 i18next 并把语言固定为 `zh-CN`（jsdom 的 `navigator.language` 是 `en-US`，不固定会漂）；这也是「源语言 zh-CN 是事实」的自动化保障。
5. **通知语言的收件人识别**：现网 `AlertContact` 没有与 `SaUser` 的关联字段（联系人只有 webhook / 邮箱 / 手机号），因此把语言放在**联系人自身**（`AlertContact.locale`，可空 = 平台默认），而不是「联系人 → 用户 → `SaUser.locale`」。联系表单的语言选择器待告警域前端迁移批次一并补（后端字段与 DTO 已就绪）。
   （2026-09-17 补交：表单语言下拉与列表列已补，见 §14.6。）
6. **留存指标的窗口文案**：中文沿用指标求值阶段算好的口径串（含「队列 X 天」说明）；非中文按窗口天数就地生成（`Last N days`）。
   （2026-09-17 补交：界面展示路径已改为**结构 + 键**，含「队列」前缀，见 §14.4；告警通知路径仍按收件人语言由服务端渲染，保留不动。）
7. **后端错误文案迁移是渐进的**：本 phase 交付**契约 + 过滤器 + 前端渲染**，`throw` 站点按模块逐批改为 `DomainError`（未迁移的模块行为不变：仍是中文 `message`）。覆盖率由 `i18n_scan.py --report` 观察，基线只减不增。
8. **服务端错误键的命名空间归属**：`errors` 命名空间只放**通用/系统**错误（401/403/超时/网络），
   **领域错误落本域命名空间**：`<domain>:error.<sub>.<name>`（如 `analysis:error.timeRangeTooLong`、`alerting:error.ruleNotFound`）。
   理由：① 并行迁移时一个 JSON 只能有一个写入者；② 该域命名空间本就由显示这些错误的界面加载；
   ③ `errors.json` 保持小而稳定。已落地的 `errors:iam.*` 已迁到 `iam:error.*`；`scripts/i18n_check.py` 会双向校验
   「服务端 `messageKey` 有对应资源」与「前端 `t()` 引用的键存在」。
9. **服务端棘轮口径换成「未迁移抛错」**：迁移后的 `message` 字段**故意保留中文原文**（老客户端 / API Key / Harness 兜底），
   因此「中文串数量」在服务端永远不会归零。`scripts/i18n_scan.py` 对服务端改为统计
   「`throw new *Exception(` 且同一调用块内没有 `messageKey`」的处数（只减不增），这才是真实进度。
   同时修正了扫描器把**正则字面量**里的引号误当字符串的缺陷（曾把注释里的中文误报成文案），
   并为数据层文件（SQL 别名生成、结果列名启发式、错误文案匹配）、测试夹具（`chart.fixtures.ts`）
   与语言注册表登记了 allowlist（附理由，逐条写在 `scripts/i18n_scan.py` 的 CONFIG 里）。
10. **本 phase 不处理的已知中文残留（en-US 下可见）**：
    - **查询结果的列名**由后端 SQL/DSL 生成（如「事件时间」「触发次数」），仍是中文——属「结果列名/指标口径多语言」后续课题；
      （2026-09-17 补交：**固定文案列名已迁移**，见 §14.3；**复合口径串 / 阶段行 / 指标口径摘要也已迁移**，见 §14.4，剩余只有用户数据列）；
    - 少数**按中文子串匹配服务端提示**的逻辑（卡片「未保存 sql / 超时 / 暂不支持」、分群与标签「已被卡片引用」）
      在英文下退化为展示原始提示；改进方向是改按 `errorCode` 匹配（响应体已带该字段）；
    - AI 工作区的指令文档（`ai_workspace/default/*.md`）与发给 Harness 的 prompt 属指令层，保持中文。
11. **服务端多了一个资源目录**：`apps/analytics-server/src/i18n/messages/`（服务端产出内容用）。它不在前端 `errors` 命名空间里，避免把「接口错误文案」与「通知文案」混成一套。

### 14.3 结果列名本地化补交（2026-09-17，phase 收口）

> 补 §14.2-10 的第一条残留：分析结果表的列名（事件 / 漏斗 / 留存 / 指标卡）。

契约（**加法式**，旧客户端与数据层不受影响）：

| 字段 | 位置 | 语义 |
|---|---|---|
| `title_key` | `QueryColumn`（`event-query.service.ts` / `funnel-query.service.ts` / `retention-query.service.ts` 各自的列接口；前端 `types/dsl.types.ts`） | 服务端**固定文案**列名的文案键，落 `analysis:column.*` |
| `title_params` | 同上 | 文案键插值参数，**值只能是数据**（时间粒度 / 第 N 日 / 步骤名 / 属性标识） |
| `title` | 同上 | **中文原值保留**：老客户端兜底 + 数据层启发式（`DataTable` 时间列判定）继续读它 |

**为什么不在服务端按请求语言渲染**：看板卡片结果是**带缓存的**（`CardCache`，TTL 内跨用户复用）。按请求语言生成标题会把某一种语言固化进缓存，其他语言的用户随后看到错的语言。故：服务端只下发 key + 数据参数，**渲染在查看者一侧**。

前端单点：`apps/analytics-web/src/features/query/column-titles.ts`
（`localizedColumnTitle` 单列 / `localizedColumns` 批量；有 key 用 `t(key, params)`，否则回落 `title`）。
接入点：`EventAnalysisResult` / `RetentionResult`（表格 + 图表系列名）、`funnel-display.buildFunnelTableModel`、
`report/CardWidget`（卡片表格 / 图表 / 指标卡）、`components/DataTable`（表头，时间列启发式仍读中文原文）、
`result-csv.resultToCsv`（导出表头）、`analysis-cache-result.parseColumns` 与 `CardWidget` 的列映射（缓存往返必须带 key）。

新增键（`analysis:column.*`，zh 逐字等于服务端原值）：
`cohortDate` 队列日期、`userTag` 用户标签、`userCohort` 用户分群、`users` 人数、
`retentionDay` `{{unit}}{{n}}`（如 `D1`）、`retentionRate` `{{unit}}{{n}} 留存率`、
`conversionRate` `{{step}} 转化率`、`churn` `{{step}} 流失`、`date` 日期（指标卡）、
`formula` 公式、`timeGroup` `时间({{granularity}})`、`unknownGroup` 未知分组、
`hourOfDay` / `dayOfMonth` / `minuteOfHour` = `{{prop}}(时|日|分)`。

未迁移（登记为「指标口径多语言」后续 phase，与 §14.2-6 同批）：
① 由「事件名 / 属性名 / 指标别名 + 方法名」拼成的复合指标列标题——整串本地化需要带键的嵌套插值，且别名本身是用户数据；
② 行值层的固定文案（`阶段汇总` 等）与 `metric_meta.window_label` 口径串；
③ 按任务边界保留：漏斗步骤列（事件名/别名）与漏斗分组列（时间/分群/标签 + 维表显示名覆盖）。

> ①② 已于同日收口，见 §14.4；③ 为有意保留（用户数据列）。

### 14.4 指标口径多语言收口（2026-09-17，phase 最后一层固定文案）

> 补 §14.3 的 ①② 与 §14.2-6：复合指标列名、阶段汇总行行值、指标窗口/口径摘要。

三条契约的共同前提与 §14.3 相同：**结果进缓存（`CardCache`）时服务端不能按请求语言渲染**，
一律「服务端下发稳定 key + 结构，前端在渲染边界按查看者语言渲染」。

#### ① 复合指标列名（`事件名.属性名.方法名`）

服务端 `modules/query/metric-normalize.ts` 的 `metricTitleDescriptor()` 取代原「只覆盖纯公式」的
`fixedMetricTitleKey()`：`title` 原值不变（老客户端兜底），另下发四种形态的模板键之一。

| 形态 | `title_key` | 参数 |
|---|---|---|
| `event.prop.method` | `analysis:column.metricEventPropMethod` | `event` / `prop` / `method` + `method_key` |
| `event.method` | `analysis:column.metricEventMethod` | `event` / `method` + `method_key` |
| `prop.method` | `analysis:column.metricPropMethod` | `prop` / `method` + `method_key` |
| `method` | `analysis:column.metricMethod` | `method` + `method_key` |

- `event` / `prop` 是**用户数据**，原样作插值参数；事件为「任意事件」时另带 `event_key`
  （`analysis:column.anyEvent`）；
- `method` 是**固定文案**：服务端同时下发中文原值（老渲染兜底）与 `method_key`
  （`analysis:analysisMethod.*`，与前端 `ANALYSIS_LABEL_KEYS` 同源；P50 走 `median`，
  `P25`/`P75`/`P90`/`P99` 语言无关不下发键）；
- 前端单点解析：`features/query/column-titles.ts` 的 `resolveTitleParams()` 把参数里的
  `<slot>_key`（`ns:key` 形态）先按当前语言渲染，再覆盖同名 `{{slot}}` 插槽（只解析一层，
  不递归、不猜键）；`localizedColumnTitle` / `localizedColumns` 已接入的 6 处渲染边界全部自动生效。
- 别名 / 指标名（用户数据）与「纯公式」（`analysis:column.formula`）行为不变。

#### ② 阶段汇总行的行值

引擎在 `event-query.service.ts#attachStageRow` 与指标卡（`card.service.ts`）写入 `__stage: true` 行、
分组单元格值为中文「阶段汇总」（**行值**，不进 SQL 语义）。本地化在渲染边界完成：
`column-titles.ts#localizedStageCellValue()`（非阶段行 / 非 `g_*` 列 / 空单元格返回 `null` 表示不改写），
接入 `components/DataTable`（结果表）与 `report/CardWidget`（卡片表格）。
服务端行值原样保留——`__stage` 已是稳定标记，**不新增 `stage_label_key`**。

#### ③ 指标窗口 / 口径摘要（结构化字段，老中文串全部保留兜底）

| 载荷 | 新增结构字段 | 界面渲染 |
|---|---|---|
| 试算 `POST /sa/api/meta/metrics/preview` | `window.relative`（仅 `source=metric` 时给出） | `metricWindowPayloadLabel()` |
| 告警抽屉指标目录（`MetricCatalogItem`） | `definition_summary_structure`、`window_days`、`window_relative`、`value_pick` | `metricSummaryText()` / `metricWindowPayloadLabel()` / `valuePickLabel()` |
| 「测试取值」（`MetricProbeResult`） | `window_relative`、`window_cohort` | 同上（`window_cohort` → 「队列 {window}」前缀） |
| 指标卡 `metric_meta`（**进缓存**） | `window_days`、`window_source`、`window_relative`、`value_pick` | 暂无渲染点，载荷已结构化备用 |

- 窗口文案规则：有 `relative` 按相对结构渲染（`metrics:window.*`）；`source=metric` 但缺 `relative`
  的老响应回落中文 `label`（长形态「近 N 天（含今天）」不能按天数硬猜）；`rule`/`default` 按
  `days` 生成短形态「今天 / 近 N 天」；都没有再回落 `label`。
- 口径摘要由 `features/metrics/metric-definition.ts#metricSummaryText()` 拼装，分隔符（` · ` / ` → `）
  与后端 `definitionSummary` 逐字一致；中文占位（未指定事件）/ 人数 / 天 均落 `metrics:summary.*`。
- 取值说明（试算面板）落 `metrics:valuePick.note.*`（zh 逐字等于后端 `VALUE_PICK_DESCRIPTION`，
  与表单下拉提示 `metrics:valuePick.hint.*` 分开，避免改动界面文案）。
- **通知路径不动**：`alert-metric-eval.ts#windowLabel(days, locale)` 仍按收件人语言在服务端渲染，
  `MetricBrief.window_label` 语义不变。

新增键：`analysis:column.anyEvent` / `metricEventPropMethod` / `metricEventMethod` / `metricPropMethod` / `metricMethod`、
`analysis:row.stageTotal`；`metrics:window.lastNDays` / `cohortWindow`、
`metrics:summary.*`（`event` / `propSegment` / `windowSegment` / `pickSegment` / `retention` / `periodDays` / `noEvent` / `measureCount`）、
`metrics:valuePick.note.*`。

证据：
`analytics-server/test/query/metric-title-i18n.spec.ts`（四种形态 zh 逐字 = `metricTitle()`，键在中英文都存在）、
`analytics-server/test/query/metric-summary.spec.ts`（结构与后端中文串同口径，含 rule/default 短形态）、
`analytics-web/src/features/query/column-titles.spec.ts`（复合列名 + 阶段行 zh/en）、
`analytics-web/src/features/metrics/metric-definition.spec.ts`（窗口 / 摘要 / 取值说明 zh 逐字 + en）、
`analytics-web/src/components/DataTable.i18n.spec.tsx`（渲染边界 zh/en 集成）。

### 14.6 告警域收口（2026-09-17，phase 最后两处）

> 补 §14.2-5（联系表单语言选择器）与「校验兜底文案」（通道 / 联系人校验失败提示）。

#### ① 联系表单「语言」（`AlertContact.locale`）

新增 / 编辑表单增加语言下拉（选项用语言自身书写，与登录页 / 个人设置一致，**不翻译语言名**），
可留空 = 平台默认；列表新增「语言」列（语言自名 Tag / 「平台默认」）。提交沿用既有 `locale` 字段（加法式）。
服务端落库前规范化（`src/i18n/locales.ts#normalizeLocaleTag`：`en-GB` → `en-US`、`zh_TW` → `zh-CN`），
不受支持 / 非法的标签 400（`alerting:error.contact.localeInvalid`，不静默改写）。

新增键：`alerting:contact.locale` / `localeDefault` / `localeHint`。

#### ② 校验失败提示的结构化负载

`channels/channel-types.ts#ValidationIssue` = `message`（**中文逐字保留**）+ `message_key` + `params`：

- 校验器（`channel-config-schema.ts#validateConfigInput` 与 7 个 sender 的 `validateContact`）返回
  `ValidationIssue | null`；抛错统一走 `channels/validation-issue.ts#validationError()` →
  `badRequest({ code, messageKey, params, message })`，前端既有 `api-error.ts` 的「优先 messageKey」逻辑直接生效；
- 需要本地化的**字段名**以 `field`（中文兜底）+ `field_key`（资源键，指向 `alerting:channelConfig.*`）成对下发，
  渲染在查看者一侧：`services/error-params.ts#resolveParamKeys()` 把参数里 `*_key` 按当前语言解析后覆盖同名插槽
  （缺翻译保留兜底，不露键名、不插空串）。同一约定顺手用在「通道不可用」（`alerting:error.channel.unavailable`）：
  通道名以 `channel` + `channel_key`（`alerting:channel.*`）成对下发，英文界面不再露出中文通道名；
  **为什么不服务端渲染**：字段名的唯一资源就是界面文案（表单标签本身），服务端再抄一份会产生无检查可防的
  翻译漂移；与 §14.3「服务端只下发 key + 数据参数」及同域 `reason_key` 先例一致；
- 「发送测试」的目标校验失败是 200 响应体：`error`（中文原文）语义不变，**加法式**新增 `error_key` / `error_params`，
  前端优先按它们渲染。

新增键：`alerting:error.validate.*`（33 条，zh 逐字等于原校验文案）、`alerting:error.contact.localeInvalid`。

证据：
`analytics-server/test/alerting/alert-channels.spec.ts`（结构化负载 / save 抛错 / 测试接口 error_key）、
`analytics-server/test/alerting/alert-contact-multi.spec.ts`（联系人校验 + locale 规范化与 400）、
`analytics-web/src/services/__tests__/api-error.spec.ts`（`*_key` 参数解析）、
`analytics-web/src/features/alerting/AlertFeedback.spec.tsx`（列表 Tag / 编辑回填 / 新增提交 locale）。

### 14.7 第二梯队语言上线（2026-09-17）

语言集从 2 门扩到 5 门：`zh-CN` / `en-US` / **`zh-TW`** / **`ja-JP`** / **`ko-KR`**，每门 3,340 键（16 命名空间）+ 服务端 messages 61 键。

| 项 | 做法 |
|---|---|
| 注册点（本次实测仅这三处） | 前端 `i18n/config.ts` 的 `LOCALES` 一行；服务端 `i18n/locales.ts` 的 `SUPPORTED_LOCALE_TAGS`；`LocaleBridge` 的 antd/dayjs 映射（5 门语言的语言包此前已 import，未改代码） |
| 繁中方法 | 简化短语预映射（163 条）→ OpenCC `s2twp` → 繁體后修正（42 条词 + 7 条正则）；按台灣用語而非字面转换（使用者/平臺/登入/資料/儲存/範本/佇列/對帳） |
| 日韩方法 | 以 zh-CN 为源、术语表约束直译；日文用日本字形（発火/復旧/重大度），韩文注意助词收音 |
| 新增门禁 | `i18n_check.py` 增加「繁中不得含简体专用字」（558 字表）与「按语系区分 CJK 规则」（zh/ja/ko 允许汉字，en 等禁用） |
| 翻译工具 | `scripts/i18n_export.py`（导出待译 CSV / 回填），术语表 `docs/architecture/i18n-glossary.md` |
| 回退规则 | `zh-Hant`/`zh-HK`/`zh-MO` → `zh-TW`；`zh-Hans` → `zh-CN`；`ja`/`ko` 按同基语言归位 |
| CI | `scripts/build.sh` 起运行全量前端测试 + `i18n_check.py` + `i18n_scan.py --check`（python3 缺失时降级告警） |

**待母语复核**（各语言 10 条，已登记在验收记录 §3.8）：繁中的「平台/平臺」「資訊/訊息」取舍、行/列语义互换、視窗/時間窗；日文的语序重排条目（`{{count}} 件のイベントを…`）；韩文的助词与拼装型文案（`선택: {{column}}={{value}}`）。

### 14.8 五常语言补齐 + 德语（2026-09-17）

语言集 5 → **8 门**：在 `zh-CN`/`en-US`/`zh-TW`/`ja-JP`/`ko-KR` 基础上补齐 **`ru-RU`**、**`fr-FR`**、**`de-DE`**
（中文 / 英文 / 俄文 / 法文 → 联合国五常语言齐备；德文为点名需求）。

| 项 | 说明 |
|---|---|
| 前置框架改动 | 打开**复数变体**机制（见 §5.3）：基础键 = 兜底，按 CLDR 追加 `_one/_few/_many/_other`；`i18n_check.py` 与 `resources.spec.ts` 改为复数感知比较。现有 5 门语言**零改动**（实测 i18next 会回退基础键）。 |
| 与中日韩的差别 | 这三门是**屈折语**：需要复数、格/性一致（俄语 6 格）、法语排版（`：`/`？` 前不换行空格、`« »`）、德语名词首字母大写；同时**文本膨胀 30–50%**（德语最甚），需按 `docs/architecture/templates/AGENTS_front.md` 的布局门禁复核按钮/标签/表头。 |
| 注册点 | 同前：`LOCALES` 三行 + `SUPPORTED_LOCALE_TAGS` + `messages.ts` 的 import/BUNDLES（后者由校验脚本强制）。 |
| 回退 | `ru`/`fr`/`de` 按同基语言归位；`fr-CA`/`de-AT`/`ru-KZ` 等区域变体自动落到这三门。 |

### 14.9 第三梯队语言上线（es / pt-BR / vi / th / id，2026-09-17）

语言集 8 → **13 门**。至此除 RTL 语言外，主流语言集齐（中英俄法 + 日韩繁 + 西葡越泰印尼 + 德）。

| 项 | 说明 |
|---|---|
| 批次划分 | `es` 与 `pt-BR` 合并为一个批次（罗曼语系共享复数与排版规则），`vi`/`th`/`id` 各一批（均无复数形态，成本低于屈折语） |
| 复数 | es / pt 各 126 条变体（63 键 × `_one`/`_other`）；vi / th / id **只用基础键** |
| 语言特性 | 泰语「词内不空格、无折行机会」→ 按钮/标签刻意取短；越南语长度控制与语序重写；罗曼语系 `%` 与引号按各自规范（es `«»` + 空格、pt `“ ”` 紧贴） |
| 注册点 | 仍是三处：`LOCALES`（含 antd 联合类型）/ `SUPPORTED_LOCALE_TAGS` / `messages.ts`（后者由校验脚本强制） |
| 术语表 | 新增「第二批语言术语」表（7 列）+ 各语言规则表 |

### 14.10 长语言版式（L4）：走查方法与规则（2026-09-17）

多语言上线后暴露的**版式类**问题（挤压、截断、压箭头）与文案本身无关，属"容器按中文尺寸写死"。
本节是这类问题的**统一走查方法与判据**，新增语言或改版时照做（与 `AGENTS.md` G.29 配套）。

**四层修法（从容器到兜底）**

| 层 | 做法 | 反例（禁止） |
|---|---|---|
| L1 容器自适应 | 侧栏展开宽度由 `useSiderWidth()` 实测当前语言菜单标签 → `clamp(160, 260)`，并回填给 `resolveShellLayout` | 按语言维护宽度表（标签一改就漂移）；把宽度算死成中文尺寸 |
| L2 文案短化 | 菜单/按钮/分段控件是**导航不是说明**：删掉父级分组已表明语境的限定词（`Хронология пользователя → Хронология`），目标 ≤ ~18 个拉丁字符 | 把长解释塞进菜单项 |
| L3 兜底可见性 | 可能截断处 `min-width:0 + overflow:hidden + text-overflow:ellipsis` **且带 `title`**；子菜单标题要为箭头留位（antd 箭头绝对定位占右侧 [16,26]px，`padding-inline-end: 28px`） | 只有 `overflow:hidden`（切半个字）、`word-break: break-all`、标签竖排 |
| L4 内容区规则 | 表格列 `ellipsis: { showTitle: true }` + `minWidth`；表单标签允许换行/竖排，不反压输入框；分段/按钮组容器允许 `flexWrap`；空态允许换行 | 固定 `width`/`maxWidth` 承载译文、固定高度塞多行 |

**宽度估算（判断"放不放得下"时用）**：俄语 ≈ 中文字符宽度 ×2.2、德语 ≈ ×2.0、越南语 ≈ ×2.0、泰语 ≈ ×2.0、法语 ≈ ×1.8、英语 ≈ ×1.6。**不要按中文长度定宽**。

**走查流程**

1. 静态排查（先扫再改，避免漏点）：
   ```bash
   rg "width: 1[0-9][0-9]|maxWidth|nowrap|labelCol|labelWidth|layout=\"inline\"" src --include="*.tsx"
   ```
   逐个判断该容器是否承载**译文**（而不是图标/数字/用户数据）。
2. 逐处按 L1–L4 改，每处说明「俄/德/越/泰下会发生什么」。
3. **交付前用最长语言目视关键页**（俄 或 越）：导航、列表、详情、表单、空态各一屏，截图留证；新增语言后至少再看一遍。
4. 只改布局与样式，**不改文案字面量**（文案在 `locales/`，改代码字面量会破坏 i18n 键与门禁）。

**已知需要留意的高危结构**（历史踩坑）：固定 160px 侧栏、子菜单箭头压字、`layout="inline"` 过滤器、窄卡片（看板卡片副标题/空态）、模板编辑器左右双栏、通道配置字段表单、分段控件（`Начала новые` 换行）。

### 14.11 L4 全量走查结果（2026-09-17，四批并行）

按 §14.10 流程对 `apps/analytics-web/src` 全量走查，分四批（互不重叠）：① 分析页 `pages/Analysis` + `features/query` + `features/time-range` + `features/explore-charts`；② 公共组件 `components` + `features/report` + `pages/Report`；③ 告警/运维/元数据/指标/权限/设置（`features/alerting`、`features/meta`、`features/metrics`、`pages/Ops|Meta|Iam|Settings`）；④ 行为序列 `features/timeline`。共 **67 个文件**、860+ 处改动，全部为版式（不动文案字面量）。

**通用改法**（与 §14.10 四层对应）

| 症状 | 改法 |
|---|---|
| 表格列按中文定宽被等比压窄 | 列 `width` → `minWidth`（下限按最长语言估），`ellipsis: true` → `ellipsis: { showTitle: true }`；`scroll.x` 由硬编码改为「各列下限之和」 |
| 工具条/操作列放不下 | `Space` 加 `wrap`（文本+标签/按钮组合）；分段控件容器 `min-width: max-content` + option 补 `title` |
| 表单标签被压 | `labelCol` 加宽或改 `labelWrap`；`layout="inline"` 过滤器改按词换行；控件固定宽 → `minWidth` |
| 窄卡片/空态截断 | 空态、卡片标题、说明句放开 `white-space: normal` + `overflow-wrap: break-word`（**不用** `break-all`）；Tag 由 antd 默认 nowrap 改为可换行 + `maxWidth: 100%` |

**实测确认的三条 antd 行为**（避免重复试错）

1. 表格列同时出现 `ellipsis` 与数值 `scroll.x` 时，rc-table 会锁 `table-layout: fixed` —— 此时**列 `min-width` 依然生效**，因此"`minWidth` 兜下限 + `scroll.x` 兜总和"是可靠组合（已用真实渲染验证，非常规猜测）。
2. `Segmented` 的 label 元素自带 `overflow:hidden + text-overflow:ellipsis + nowrap`（antd 5.29 `segmented/style`），**不可能折行**，被压窄时表现为省略号；`rc-segmented` 会把 `option.title` 写到该 label 上，故修法是「容器 `min-width: max-content` 不压缩 + option 补 `title`」，而非试图让它换行。
3. `rc-select` 对**字符串 label** 自动为选中值与选项加 `title`（`SingleSelector`/`MultipleSelector`）；把 `option.label` 换成 ReactNode 会**同时丢掉 title 与 `optionFilterProp="label"` 过滤**，因此 Select 宽度一律用 `minWidth` 而**不改 label 结构**。

**保留未改（判断依据）**：`InputNumber` 等纯数字控件保留固定宽；`Descriptions` 中已是用户数据的 label（属性键）保留宽度、只补折行与值列 tooltip；`Drawer/Modal` 固定 `width` 保留（模态自带 `max-width: calc(100vw - 32px)`，属窄视口响应式问题，不属 L4）。

**上线**：提交 `7f0d738` → CI 模块 **17675** → 生产 `.version` 17675（服务已重启）。生产核验同时看文件层（timeline L4 CSS 规则、`index-BKT_YQ9f.css` 箭头留位、`AlertsPage-B31E-kV5.js` 的 `ellipsis:{showTitle:!0}`，且上一版同类 chunk 为 0）与浏览器层（`/sa/login?lang=ru-RU`：`lang=ru-RU`、俄文界面、入口即本次产物）。

**未闭环项**：本批为子代理执行、无法使用浏览器，故**未附最长语言目视截图**；主代理在 prod 只完成了登录页俄语确认（新产物 + `lang=ru-RU`），登录后各页需用户在其会话硬刷新后自查。后续新增语言或改版时按 §14.10 步骤 3 补做。
