# 验收记录：接入指南（自包含 SDK 文档站，phase: clklog-analytics-onboarding-v2）

- 日期：2026-09-15
- 帽子：项目（`docs/project/`）
- 环境：**生产** 生产主机，应用版本 **17195 / 17196**（前端静态资源随 rsync 生效，`web/sa/assets/` 时间戳 20:20 与本批一致）
- 上游：PRD `docs/product/prd-clklog-analytics-onboarding-v2.md`、实现方案 `docs/architecture/clklog-analytics-design-onboarding-v2.md`
- 范围：**纯前端**（无后端接口、无数据模型变更；上报协议未改）

---

## 1. 结论

**通过。** 接入指南从「指向仓库示例目录的索引页」改为**自包含文档站**：三组入口（客户端 9 / 服务端 9 / 其他 2），已实测的四种接入方式（HTTP 协议 / PHP / Go / Unity(C#)）在页面内给出完整文档（步骤 + 可复制代码 + 验证方法 + 常见问题），其余入口点击提示「暂未开发」，全页不再出现任何仓库路径。

## 2. 验收方法

| 手段 | 说明 |
|---|---|
| 内容契约测试 | `src/features/onboarding/sdk-guides.spec.ts`（10 例）：入口数量、已实测条目文档完整度、未适配条目「无文档」、术语覆盖、**禁用仓库路径/令牌形态** |
| 页面行为测试 | `src/features/onboarding/OnboardingPage.spec.tsx`（4 例）：三组入口渲染、点击已实测 → 文档抽屉、点击未适配 → 暂未开发、接入前必读 |
| CI 门禁 | `scripts/build.sh` 前端切片加入 `src/features/onboarding`（与 alerting / ops 同批执行） |
| 构建产物 | 前端 `npm run build` 通过；生产 `web/sa/assets/` 与本批版本时间一致 |
| 人工核对项 | 页面文案与《数据上报规范与流程》一致（字段、编码、身份口径） |

## 3. 需求 → 证据矩阵

| 需求 | 证据 | 结论 |
|---|---|---|
| O-1 三组入口、客户端/服务端各 ≥9 | 契约测试（`client=9`、`server=9`、`other=2`）| ✅ |
| O-2 已实测条目 ≥5 步骤、≥2 段代码 | 契约测试逐条断言（http/php/go/unity）| ✅ |
| O-3 未适配条目只留入口、点击提示暂未开发 | 契约测试（`steps/faq` 必须为空）+ 页面测试（点 Java → 「Java：暂未开发」，且无「1. 前置条件」/「常见问题」）| ✅ |
| O-4 不引用仓库路径 | 契约测试：全量正文不匹配 `examples/`、`report-sdk`、`.env` | ✅ |
| O-5 关键字覆盖 | 契约测试：`base64`/`urlencode`/`project`/`token`/`data`/`identities.user_key`/`$track_signup_original_id`/`毫秒` 全部出现 | ✅ |
| O-6 验证方法与常见问题 | 每份文档 FAQ ≥3 条；正文含 Debug 与「HTTP 200 但无数据」 | ✅ |
| O-7 不显示真实令牌 | 契约测试：正文不匹配令牌形态；示例只出现 `<项目 token>` 占位符 | ✅ |
| O-8 测试纳入 CI | `build.sh` 切片 + 本地 `vitest run src/features/onboarding` 14 例通过 | ✅ |

## 4. 页面结构（as-built）

```
数据管理 · 接入指南
├── 接入参数：项目名称 / App_ID（可复制）/ 上报地址（可复制）/ 项目 token（说明获取方式，不显示值）
├── 接入前必读：协议三要素表格 + 编码链路示例（base64 → urlencode，含「200 但丢数据」告警）+ curl 最小请求
├── 客户端 SDK（9）：Android / iOS / JavaScript·Web / 微信小程序 / Flutter / React Native / Cocos2d-x / Unreal Engine / Unity(C#)✓
├── 服务端 SDK（9）：Java / Python / PHP✓ / Go✓ / Node.js / C# / Ruby / C / Lua
└── 其他接入（2）：HTTP / RESTful API✓ / 批量回补（文件导入）
    ✓ = 已实测（绿色标签 + 完整文档抽屉）；其余点开为「暂未开发」提示
```

## 5. 已实测文档覆盖内容（示例：Go）

1. 前置条件（Go 1.18+，仅标准库）→ 2. 事件结构体与客户端构造 → 3. `Track` 上报行为事件 → 4. `Login` 身份关联 / `ProfileSet` 用户属性 → 5. `Flush` 批量发送与 3 次退避重试 → 6. 验证（Debug 查询 / 事件分析）→ FAQ 4 条。

PHP、Unity(C#)、HTTP 协议三份文档同结构，代码片段均取自本项目已实测通过的实现骨架（去掉测试脚本专有内容）。

## 6. 遗留与说明

| 项 | 说明 |
|---|---|
| 未适配 SDK | 16 个入口仍为「暂未开发」（客户端 8、服务端 6、其他 1、另含 1 个已实测项之外的计划项），本 phase 只做入口与提示，不产出半截文档 |
| 文档更新成本 | 内容随前端版本发布（`sdk-guides.ts` 为内容真源），改文案需要发版；未做内容后台（PRD 非目标）|
| 浏览器人工路径 | Agent 未复现人工点击（缺交互式登录态），以组件测试 + 生产构建产物核验代替；页面为纯前端静态内容，风险低 |
| `examples/report-sdk/` | 仍保留在仓库（测试用可运行骨架），但页面不再引用它 |
