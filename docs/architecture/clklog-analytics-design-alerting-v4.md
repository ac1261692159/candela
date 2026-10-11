# 架构设计：指标告警重设计 + 告警通知模板

- `phase: clklog-analytics-alerting-v4`
- 帽子：架构
- 配套 PRD：`docs/product/prd-clklog-analytics-alerting-v4.md`
- 验收记录：`docs/project/acceptance-clklog-analytics-alerting-v4.md`（as-built 差异见该文 §6/§7）
- 实现状态：**已完成并上线**（生产 17196）；验收中把阈值上限由 1e6 放宽到 1e12（当日事件量千万级）
- 取代：`clklog-analytics-design-alerting-v2.md` §卡片告警（`source='card'`）

---

## 1. 缺陷回放：500 的真实原因（先修因，再改功能）

现象：点击「新建分析指标告警」→ `GET /sa/api/ops/alerts/cards?project=clklogapp` → HTTP 500「服务暂时不可用」。

```
PrismaClientValidationError:
Invalid `prisma.card.findMany()` invocation
Argument `project_name`: Invalid value provided.
  Expected StringFilter or String, provided (String, String).
  at AlertingService.listAlertCards (.../alerting.service.js:236)
```

根因链条（三段，缺一不可）：

1. `alerting-api.ts#getAlertCards(project)` 把 `project` **写进 URL 字符串**：`/ops/alerts/cards?project=clklogapp`；
2. `services/api.ts` 请求拦截器发现 `config.params == null`，于是补 `params = { project }`；
3. axios 把 `params` 再拼一次 → 实际请求 `?project=clklogapp&project=clklogapp`；Express 对重复 query 参数返回**数组**，`ProjectQueryDto` 的 `project?: string` 只有 `@Allow()`（无类型转换），数组一路传到 Prisma → 校验失败 → 500。

因此该功能**从未成功创建过规则**（生产 `alertrule` 表 `source='card'` 计数 = 0）。

修复策略（两层，防止同类缺陷再生）：

- **入参规范化（后端，根因层）**：所有 `project` query 参数在 DTO 层做 `@Transform`——`Array.isArray(v) ? v[0] : v`，并显式声明为 `string`。这样任何重复参数都不会把数组送进 Prisma。
- **前端不再手拼 query（调用层）**：`project` 一律走 `config.params`，URL 里不再出现 `?project=`，避免与拦截器重复。

## 2. 数据模型变更（`clklog_sa_meta`）

```prisma
model AlertRule {
  // ... 既有字段
  metric_id   String?   // 指标告警：指向 metasavedmetric.metric_id（source='metric'）
  window_days Int   @default(1)  // 指标时间窗口：1=今天, 2=近2天, 7, 30
  @@index([metric_id])
}

model AlertTemplate {
  id           BigInt   @id @default(autoincrement())
  project_name String
  kind         String   // fire | resolve
  channel      String   // feishu_webhook | email | sms
  subject      String   @default("")
  body         String   @db.Text
  updated_by   String
  updated_at   DateTime @updatedAt
  @@unique([project_name, kind, channel])
  @@map("alerttemplate")
}
```

迁移（`prisma/migrations/*_alert_metric_template/migration.sql`）须幂等可重放：

```sql
ALTER TABLE alertrule ADD COLUMN metric_id VARCHAR(191) NULL;
ALTER TABLE alertrule ADD COLUMN window_days INT NOT NULL DEFAULT 1;
CREATE INDEX alertrule_metric_id_idx ON alertrule (metric_id);
UPDATE alertrule SET enabled = 0 WHERE source = 'card';   -- A-8：旧卡片规则停用（生产 0 行）
CREATE TABLE alerttemplate (...);
```

> `card_id` / `metric_key` 列本期**保留不删**（删列是不可逆的破坏性变更，且 Prisma 迁移删列在线上有风险）；代码路径不再读写它们。

## 3. 指标求值（主线 A）

### 3.1 观测源

观测源 = `metasavedmetric`（数据管理 → 指标）。指标定义（`definition_json`）由 `MetaSavedMetricService.normalizeDefinition` 规范化，两类：

| kind | definition 形状 | 告警取值 |
|------|----------------|---------|
| `event` | `{ metric: { kind:'event', analysis, event, prop, filters, alias, type, func } }` | 事件分析结果的指标列 `m_0` |
| `retention` | `{ start_event, retain_event, cohort, granularity, n, measure: 'rate'\|'count' }` | 留存结果列 `n_{n}_rate`（rate，0~1）或 `n_{n}`（count） |

### 3.2 求值契约

求值**复用工作台查询链路**，保证「工作台看到的数」与「告警判定的数」同口径：

```ts
// 事件指标
const query: EventAnalysisQuery = {
  project,
  event: def.metric.event ?? '',
  metrics: [{ ...def.metric, id: 'm_alert' }],   // 单指标，无公式（DTO 已禁 formula）
  time_range: { start: ymd(today - (window_days - 1)), end: ymd(today) },
  groups: [],
};
const result = await eventQuery.analyze(query, project, /* refresh */ true);
const value = result.rows[0]?.['m_0'];

// 留存指标
const query: RetentionQuery = {
  project,
  start_event: def.start_event,
  retain_event: def.retain_event,
  cohort: def.cohort,
  granularity: def.granularity,
  n_list: [def.n],
  time_range: { start: ymd(today - 31), end: ymd(today) },
};
const result = await retentionQuery.analyze(query, project, true);
// 从最后一行（最新队列）向前取第一个非空值
const key = def.measure === 'count' ? `n_${def.n}` : `n_${def.n}_rate`;
value = 最后一个 rows[i][key] != null 的值；rate 需 ×100（与平台展示的百分比一致）
```

要点与理由：

- `refresh = true`：绕开查询缓存读取，确保判定基于当前数据（写回缓存是附带收益）。
- `groups: []`：不分组 → SQL 不生成 `GROUP BY` → 单行聚合，取值键固定 `m_0`（列生成规则见 `event-query.service.ts#formatResult`）。
- 时间窗口是**天**：事件分析的时间过滤作用在 `stat_date`（`YYYY-MM-DD`），故窗口用 `window_days ∈ {1,2,7,30}`，不承诺分钟级。
- `today` 用 `shanghaiTodayYmd()`（与查询引擎同一时区口径，避免 AL-01 那类 8 小时错位）。
- 数据权限：告警求值以**系统身份**运行（不传 `scope`），规则仅平台超管可建，符合运维面板权限模型。

### 3.3 有界与限额（红线 4）

| 约束 | 值 | 说明 |
|------|----|------|
| 单轮每规则查询数 | 1 | 求值即一次查询，不做回补 |
| 指标规则数上限 | 20 | `MAX_METRIC_RULES`，超限创建返回 400 |
| 窗口上限 | 30 天 | `window_days ∈ {1,2,7,30}`（DTO 白名单） |
| 项目过滤 | 强制 | `query.project` 必填并参与 SQL |
| 超时 | 复用 CH 客户端配置 | 现有 `ClickHouseService.query` 超时与只读账号不变 |
| 失败处理 | 跳过本轮 | 求值异常/取不到值 → 不改状态机，不计越线（避免误报/误恢复） |

### 3.4 评估与健康度

- 检测循环（60s）对 `source='metric'` 的规则逐条 `apply(code, byCode, () => evalMetric(rule))`，状态机（连续 `for_windows` 次越线 → firing；不越线 → resolved）复用既有 `apply/recordFiring/recordResolved/maybeNotify`。
- 求值服务记录**连续失败次数**（内存 Map，键为规则 code）：连续 ≥3 次失败 → 健康度 `metric_eval_failed`，详情带最后一次错误；成功即清零。
- 健康度枚举改为：`ok | metric_missing | metric_eval_failed | no_contact`（删除 `card_missing` / `cache_unavailable`）。`listRules()` 用一次批量查询判定 `metric_missing`。

## 4. 通知模板（主线 B）

### 4.1 语法子集（Go template 兼容子集）

```
模板   := (文本 | 变量 | 条件块)*
变量   := '{{' '.' 标识符 '}}'
条件块 := '{{if' 表达式 '}}' 模板 ('{{else}}' 模板)? '{{end}}'
表达式 := '(' 表达式 ')'
        | 函数 '(' 表达式 (',' 表达式)* ')'
函数   := eq | ne | or | and | not | gt | ge | lt | le | contains
原子   := '.' 标识符 | '"' 字符串 '"' | 数字
```

- 未定义变量渲染为**空串**（不是错误，也不是 `<no value>`）。
- 支持 `{{-` / `-}}` 裁剪空白（与 Go 一致，便于写紧凑短信）。
- 明确不支持：`range / with / define / template / 变量赋值 / 管道`（PRD 非目标）。

### 4.2 变量表（预填充占位符）

| 变量 | 说明 | 示例 |
|------|------|------|
| `{{.rule_name}}` | 规则名 | 今天上报量为 0 |
| `{{.rule_code}}` | 规则码 | metric_ab12cd |
| `{{.level}}` / `{{.level_fmt}}` | 级别 / 中文级别 | critical / 紧急 |
| `{{.status}}` / `{{.status_code}}` | 状态 / 状态码 | 触发 / fire |
| `{{.value}}` / `{{.value_raw}}` | 当前值（带格式化）/ 原始值 | 1,204 / 1204 |
| `{{.unit}}` | 单位 | 次 |
| `{{.comparator}}` / `{{.comparator_fmt}}` | 比较符 | gt / 大于 |
| `{{.threshold}}` | 阈值（格式化） | 1,000 |
| `{{.metric_name}}` | 指标显示名 | 今日上报次数 |
| `{{.metric_kind}}` | 指标类型 | 事件指标 / 留存指标 |
| `{{.window_days}}` / `{{.window_fmt}}` | 窗口天数 / 中文 | 1 / 今天 |
| `{{.project}}` | 项目名 | clklogapp |
| `{{.time}}` | 触发/恢复时间 | 2026-09-15 21:03:11 |
| `{{.detect_interval}}` | 检测周期 | 60s |
| `{{.contact_name}}` | 联系人 | 运维群 |

### 4.3 默认模板（预填充）

触发（fire，飞书/邮件通用，短信精简）：

```
{{if eq .status_code "resolve"}}✅【恢复】{{.rule_name}}
当前值：{{.value}}{{.unit}}（条件：{{.comparator_fmt}} {{.threshold}}{{.unit}}）
指标：{{.metric_name}}　窗口：{{.window_fmt}}
项目：{{.project}}　恢复时间：{{.time}}{{else}}🚨【{{.level_fmt}}】{{.status}} {{.rule_name}}
当前值：{{.value}}{{.unit}}（条件：{{.comparator_fmt}} {{.threshold}}{{.unit}}）
指标：{{.metric_name}}　窗口：{{.window_fmt}}
项目：{{.project}}　时间：{{.time}}{{end}}
```

> **2026-09-16 修正（phase: clklog-analytics-alert-channels-v1）**：触发与恢复改为**各一份独立默认模板**
> （🚨 触发 / ✅ 恢复 两套文案），模板页改哪条就只影响哪条。原设计让两条共用一份、内部用
> `{{if eq .status_code "resolve"}}` 区分两态，导致两个页签内容完全一样、使用者无法判断改的是哪一条（用户反馈）。
> `{{if}}` 语法仍支持，需要「一份管两态」可自己写。

- 邮件 `subject` 默认：`{{if eq .status_code "resolve"}}✅【恢复】{{else}}🚨【{{.level_fmt}}】{{end}}{{.rule_name}}`
- 短信默认：`【{{.level_fmt}}】{{.status}} {{.rule_name}} 当前{{.value}}{{.unit}} 条件{{.comparator_fmt}}{{.threshold}}{{.unit}}`（渲染后压缩空白并按 40 字符截断，页面注明）

### 4.4 存储与解析优先级

```
自定义模板（alerttemplate 表，project+kind+channel）
  ↓ 未命中
内置默认（代码常量 alert-template.ts#DEFAULT_TEMPLATES）
```

- `AlertTemplateService` 按轮次缓存（60s TTL，与检测周期一致），模板更新即失效。
- 保存时 `validateTemplate()`：未闭合条件块 / 未知动作 / 空表达式 → `BadRequestException`（HTTP 400），不落库。
- 变更写 `alertaudit`：`alert_template_update`、`alert_template_reset`（含 project/kind/channel 与前后差异摘要）。

### 4.5 通知链路改造

```
detect → apply → recordFiring/recordResolved → maybeNotify
  ├─ resolveContact(contact_id)              // 既有
  ├─ template.render(project, kind, channel, vars) → {subject, body}
  └─ notify.send(contact, {subject, body})
        ├─ feishu_webhook → {msg_type:'text', content:{text: body}}
        ├─ email         → SMTP(subject, body)
        └─ sms           → collapse(body).slice(0,40)
```

`AlertNotifyService.send` 的入参由 `text: string` 改为 `{ subject: string; body: string }`（重试、失败告警、`assertFeishuOk` 逻辑不变）。

## 5. API 契约（`/sa/api/ops/alerts`）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `metrics` | 可选指标列表（含 `alertable`/`reason`/`definition_summary`） |
| POST | `metrics/:metricId/probe` | 测试取值：body `{window_days}` → `{value, window_days, elapsed_ms, error?}` |
| POST | `rules` | 建指标规则：body `{name, metric_id, threshold, unit?, severity?, comparator?, window_days?, for_windows?, repeat_minutes?, notify_on_resolve?, contact_id?}` → `{code}` |
| DELETE | `rules/:code` | 删除规则（`source='builtin'` 拒绝） |
| GET | `templates` | 六组合有效模板 + 变量表 |
| PUT | `templates/:kind/:channel` | 保存自定义（`subject` 仅邮件有效） |
| DELETE | `templates/:kind/:channel` | 恢复默认（删除覆盖） |
| POST | `templates/preview` | 用示例数据渲染，仅返回文本 |
| ~~GET~~ | ~~`cards`~~ | **下线**（连同 `listAlertCards` / `MetricAlertCard` 前端类型） |

## 6. 前端改造

| 文件 | 变化 |
|------|------|
| `features/alerting/alerting-api.ts` | 新增 metrics/templates/probe；删除 `getAlertCards` 与 `AlertCardItem`；`project` 一律走 `params` |
| `features/alerting/MetricAlertDrawer.tsx` | 重写：指标选择（搜索/类型标签/定义摘要/测试取值）+ 阈值表单 + 窗口天数 |
| `features/alerting/TemplateEditor.tsx` | 新增：触发/恢复 × 飞书/邮件/短信，占位符插入、预览、恢复默认、语法错误内联 |
| `features/alerting/AlertsWorkbench.tsx` | 规则表「指标」列；新增「通知模板」标签页；按钮文案「新建指标告警」 |
| `features/alerting/AlertRuleEditor.tsx` | 行内编辑显示指标名与窗口天数 |
| `pages/Meta/SavedMetricsPage.tsx` | 提示「指标可作为监控告警的观测对象」 |

## 7. 测试与验收

**单元/集成（jest，进 CI 全量套件）**

| 文件 | 覆盖 |
|------|------|
| `test/alerting/alert-template.spec.ts` | 引擎：变量替换、if/else、eq/or/not/contains、空白裁剪、未闭合报错、未知变量空串、六份默认模板全部可渲染通过 |
| `test/alerting/alert-metric-eval.spec.ts` | 求值：事件指标取 `m_0`、留存 rate×100、count 取 `n_{n}`、空行/异常→null、窗口天数→时间范围、失败计数与健康度 |
| `test/alerting/alerting-metric-rule.spec.ts` | 规则创建：指标不存在 400、超上限 400、单位/窗口白名单、健康度 `metric_missing` |
| `test/alerting/alert-notify-retry.spec.ts`（改） | 新签名 `{subject, body}` 下的重试与失败记录 |
| `test/alerting/alert-detector.service.spec.ts`（改） | 指标规则走状态机；模板渲染内容进入投递 |
| `test/alerting/alert-metric.spec.ts` | **删除**（随 `alert-metric.ts` 下线） |

**前端（vitest，进 CI 切片）**：`AlertsWorkbench.spec.tsx`（规则表列名/按钮文案/无卡片字样）、`TemplateEditor` 交互（占位符插入、非法模板提示）。

**端到端取证（生产 release）**

1. 造 3 条测试指标（事件 ×2、留存 ×1）——通过 Web/API 创建，记录 metric_id；
2. 建 2 条规则：一条必命中（低阈值）、一条阈值设高（用于恢复路径）；
3. 观察 `alertevent` firing → resolved、`alertnotification` 成功记录、飞书群消息内容为模板渲染结果；
4. 留存指标 probe 取值与留存页展示一致（抽查一条）；
5. 证据写回 `docs/project/acceptance-clklog-analytics-alerting-v4.md`。

## 8. 风险与对策

| 风险 | 对策 |
|------|------|
| 按天窗口的「今天」是累计值，单调上升，容易一直 firing | UI 明确 `窗口=今天（当日累计）`；重复间隔默认 60 分钟；文档写清口径 |
| 求值复用查询链路，若指标定义含数据表/人群映射会变慢 | 上限 20 条规则 + 单轮 1 查询 + 失败即跳过；后续如需可加「评估超时熔断」 |
| 模板引擎自研，语法边界要与 Go 一致 | 只承诺子集并在 PRD/UI 写明；`validateTemplate` 对超出子集的写法直接报错，不猜测 |
| 删除 `alert-metric.ts` 影响既有测试 | 同批删除对应 spec，`scripts/arch_ratchet.py` 与全量 jest 作为兜底 |
