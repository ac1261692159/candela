# 架构设计：接入指南 v2（自包含 SDK 文档）

- `phase: clklog-analytics-onboarding-v2`
- 帽子：架构
- 配套 PRD：`docs/product/prd-clklog-analytics-onboarding-v2.md`
- 验收记录：`docs/project/acceptance-clklog-analytics-onboarding-v2.md`
- 实现状态：**已完成并上线**（纯前端）。as-built 差异：代码块组件复用在 `GuideDrawer.tsx` 内部实现、
  页面行为测试落在 `features/onboarding/OnboardingPage.spec.tsx`（另加 `sdk-guides.spec.ts` 内容契约测试）

---

## 1. 现状与问题

`apps/analytics-web/src/pages/Meta/OnboardingPage.tsx` 现状：

- 三个卡片（PHP / Golang / Unity）**副标题直接展示仓库目录** `examples/report-sdk/php` 等，弹窗底部再让用户「去仓库看完整示例」。
- 弹窗正文只有 4 条要点 + 一段 curl，**没有可运行代码、没有验证方法**，接入者拿不到闭环。
- 无后端接口；页面常量硬编码在组件文件里，无测试。

问题：接入指南是**对内开发者视角**（指向源码目录），而使用方是**接入方开发者**（需要步骤、代码、验证）。

## 2. 目标形态

前端单页 + 结构化内容模块，**纯前端交付**（无新后端接口）：

```
apps/analytics-web/src/features/onboarding/
├── sdk-guides.ts        # 内容真源：SDK 清单 + 已实测文档（结构化）
├── sdk-guides.spec.ts   # 内容契约测试（见 §5）
├── GuideDrawer.tsx      # 文档抽屉（步骤 / 代码块 / 提示）
└── CodeBlock.tsx        # 代码块 + 复制（沿用仓库裸 <pre> 视觉惯例）
apps/analytics-web/src/pages/Meta/OnboardingPage.tsx   # 页面装配（参数卡 + 三组入口）
```

### 2.1 内容模型

```ts
export type SdkGroup = 'client' | 'server' | 'other';
export type SdkStatus = 'ready' | 'planned';

export interface CodeSample { lang: string; label?: string; code: string }

export interface GuideStep {
  title: string;
  body?: string;          // 纯文本（含换行的有序说明）
  notes?: string[];       // 注意点（渲染成 Alert/list）
  codes?: CodeSample[];
}

export interface SdkGuide {
  key: string;            // 'php' | 'go' | 'unity' | 'http' | 'android' ...
  name: string;           // 'PHP'
  group: SdkGroup;
  status: SdkStatus;
  platform: string;       // 一句话定位（'服务端 / PHP 7.4+'）
  summary: string;
  steps?: GuideStep[];    // status==='ready' 必有；planned 必无
  faq?: { q: string; a: string }[];
}

export const SDK_GUIDES: SdkGuide[] = [...];
export function guidesByGroup(group: SdkGroup): SdkGuide[];
```

- **已实测（ready）**：`http`（通用协议）、`php`、`go`、`unity`（Unity / C#，同一份 C# 客户端）。
- **其余全部 planned**：客户端 Android / iOS / JavaScript / 微信小程序 / Flutter / React Native / Cocos2d-x / Unreal Engine；服务端 Java / Python / Node.js / C# / Ruby / C / Lua；其他 批量回补。

### 2.2 页面交互

| 元素 | 行为 |
|------|------|
| 接入参数卡 | 项目名（当前项目）+ App_ID 复制 + 上报地址复制 + token 获取方式文案（不显示值） |
| SDK 入口卡 | 显示名称 / 定位 / 状态标签「已实测」「暂未开发」；`ready` → 打开抽屉，`planned` → Modal「暂未开发」 |
| 文档抽屉 | 宽度 ~760，标题 = SDK 名，正文按 `steps` 顺序渲染：标题 + 段落 + 代码块（带复制）+ 注意点；末尾 FAQ 折叠面板 |
| 状态标签 | 已实测用 `Tag color="green"`，暂未开发用 `Tag`（默认灰），避免「看起来能用」 |

### 2.3 与协议 SSOT 的关系

- 上报地址/字段/编码口径来自《数据上报规范与流程》（v1.0）与 `puppet/clklog/manifests/nginx.pp`（`/receiver/` 前缀）。
- 页面内的**示例代码**是文档正文的一部分（刻意与 `examples/report-sdk/` 解耦：示例是**测试用最小骨架**，文档要的是**接入者能照抄的片段**），因此允许两者措辞不同，但不得与协议冲突。
- 项目 token 不从接口取也不展示；页面只写「向项目管理员索取」与注入方式（环境变量）。

## 3. 内容红线

1. 正文与常量**不得**出现 `examples/`、`.env`、仓库文件路径、真实 token。
2. `planned` 条目**不得**含 `steps`，点击只给「暂未开发」+ 一句「可先用通用 HTTP 协议接入」的指引。
3. 已实测文档必须覆盖 PRD §5 的九段要素（缺段由测试兜底，见 §5）。

## 4. 组件与依赖

- 沿用 antd 5：`Card / Row / Col / Tag / Drawer / Modal / Descriptions / Collapse / Typography / Space / Button / message`。
- 代码块用仓库惯例的裸 `<pre>` 包裹 + 复制按钮（不引入 markdown / highlight 依赖，保持包体与既有风格一致）。
- 项目名沿用页面既有读取逻辑（localStorage `clklog-analytics-project`，兼容裸串与 JSON），本期不改为 store（避免扩散）。

## 5. 测试契约（`sdk-guides.spec.ts`，纳入 CI）

| 断言 | 目的 |
|------|------|
| 三组各自非空，客户端 ≥9、服务端 ≥9 | O-1 |
| `status==='ready'` 的条目：`steps.length >= 5`，且全部代码块数 ≥2 | O-2 |
| `status==='planned'`：无 `steps`、无 `faq` 代码 | O-3 |
| 全量正文（含代码）不匹配 `/examples\/|\.env|report-sdk/` | O-4 回归防护 |
| 正文包含 `base64`、`urlencode`、`project`、`token`、`data`、`identities.user_key`、`$track_signup_original_id` | O-5 |
| 每份 ready 文档的 FAQ ≥3 条，且存在「200」「毫秒」相关条目 | O-6 |
| 全量正文与常量不出现 token 形态（`/token['\"]?\s*[:=]\s*['\"][A-Za-z0-9]{8,}/`） | O-7 |

CI：`scripts/build.sh` 前端切片加入 `src/features/onboarding`（与既有 `src/features/alerting`、`src/pages/Ops` 同批执行）。

## 6. 非目标

- 无后端接口、无内容后台、无 i18n、无搜索、无 markdown 渲染（见 PRD §3）。
- 不改 `examples/report-sdk/`（示例继续存在，只是页面不再指向它）。

## 7. 扩展：第三档状态 `partial`（2026-10-08）

各语言示例真实跑通落库后，指南要把它们从 `planned` 翻出来。但其中 5 张卡（小程序 / RN /
Android / iOS / Cocos2d-x）只完成了**语言级**验证 —— 目标平台没有环境打包（开发者工具、真机、
APK、App、引擎工程），标成 `ready` 等于把「语言级」说成「已实测」。因此引入第三档：

| 状态 | 语义 | 徽标色 | 点击行为 |
|---|---|---|---|
| `ready` | 语言与环境都跑通 | 绿 | 打开文档抽屉 |
| `partial` | 语言级实现跑通落库、平台未打包验证 | 金 | 打开文档抽屉（与 ready 相同） |
| `planned` | 未实测 / 平台功能未实现 | 灰 | 弹「暂未开发」 |

内容组织上的两点调整（O-1~O-7 契约不变）：

1. **公共步骤只翻译一次**：协议五步对所有语言相同，落在 `onboarding:guideCommon.*`；
   每张卡只提供 `platform` / `summary` / `note1` / `faq1Q` / `faq1A` 五段语言特有内容
   （卡片名复用既有的 `planned.<key>.name`，不为同一批名字重复翻译）。
2. **代码片段不进 i18n**：`sdk-code-samples.ts` 存各语言摘录，注释统一英文 —— 代码不是散文，
   否则同一段代码要在 13 个语言文件里各维护一份，也容易破坏 O-4 的「页面不引用仓库路径」。

`partial` 卡片的 platform / summary / note 必须逐张写清「已验证 / 未验证」的边界（不删限定语）；
平台级完整对照表在《数据上报规范与流程》§9.3。
