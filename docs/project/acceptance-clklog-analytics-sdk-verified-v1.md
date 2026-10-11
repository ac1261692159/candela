# 接入指南 SDK 全语言实测与状态翻牌（扩展 phase: clklog-analytics-onboarding-v2）

日期：2026-10-08　范围：接入指南页内容 + `examples/report-sdk/` 全语言示例
上游文档：`docs/product/prd-clklog-analytics-onboarding-v2.md`、`docs/architecture/clklog-analytics-design-onboarding-v2.md`、
`docs/architecture/reporting-protocol.md`（协议与实测口径）

> 本项是 onboarding-v2 的**内容扩展**（不是新 phase）：PRD 的「已适配给完整文档 / 未适配只留入口」
> 结构不变，本次把「未适配」里**能实测的语言**逐个跑通、翻状态并补文档；新增第三档状态 `partial`
> 用来区分「语言级已实测、平台未打包」，避免把语言级验证说成平台已实测。

## 1. 做了什么

| 项 | 结果 |
|---|---|
| 示例与开箱验收 | `examples/report-sdk/` 新增 **13 个目录**（python / nodejs / ruby / java / c / cpp / lua / js / miniprogram / react-native / android / ios / csharp 服务端），并新增统一验收器 `verify.sh` |
| 实测 | 15 门语言/端**真实运行**并落库（ClickHouse `clklog.log_analysis`，5 步事件链逐行断言），run_id 与逐条证据见规范 §9.2 |
| 指南翻状态 | 12 张卡 → **已实测**，5 张卡 → **语言级已实测**（partial），3 张卡保持**暂未开发** |
| 文案 | 新增 84 个键 × 13 语言（`guideCommon.*` 17 + `status.partial` 1 + 13 张卡 × 5），`i18n_check.py` 通过 |

## 2. 三档状态的口径（产品可见变化）

| 状态 | 含义 | 本次落位 |
|---|---|---|
| 已实测 `ready` | 语言与运行环境都跑通并落库 | http / php / go / unity / javascript / java / python / nodejs / csharp / ruby / c / lua（12） |
| 语言级已实测 `partial` | 语言级实现跑通落库，但目标平台未打包验证 | miniprogram / react-native / android / ios / cocos2d-x（5） |
| 暂未开发 `planned` | 未实测或平台功能未实现 | flutter（无 SDK 环境）/ unreal（引擎）/ batch-import（功能未实现）（3） |

页面里 `partial` 用金色标签，点击**照常打开文档抽屉**（只有 `planned` 才弹「暂未开发」）。
各平台「已验证 / 未验证」的边界逐条写在规范 §9.3，页面卡片文案也逐张标注（不删限定语）。

## 3. 关键取舍

1. **页面不引用仓库路径**：沿用既有内容契约测试的回归防护（`sdk-guides.spec.ts`），
   因此新增代码片段统一**英文注释**、命令改成"在你自己的工程里运行"，不出现 `examples/report-sdk/`。
   仓库示例的作用是**验收与照抄源**，通过规范 §9 与 `examples/report-sdk/README.md` 对外。
2. **`guideCommon` 只翻译一次**：五步流程（前置条件 → 运行环境 → 上报核心 → 登录关联 → 验证）
   对所有语言相同，放公共键；每张卡只写四段语言特有内容（platform / summary / note1 / faq1）。
   这既避免 13 份重复散文，也让 13 语言的资源体量可控。
3. **代码片段不进 i18n**：代码不是散文，注释统一英文（`sdk-code-samples.ts`），
   否则同一段代码要在 13 个语言文件里重复维护。
4. **卡片名复用 `planned.<key>.name`**：这些名字原本已翻译好，避免为同一批名字重复翻译一遍。
5. **诚实标注优先于好看**：Android/iOS/小程序/RN/Cocos 一律标 `partial` 并在 platform/summary/note 里
   写清"未打包验证"，不为凑"全部已实测"而拔高。

## 4. 验证

| 项 | 结果 |
|---|---|
| 落库验收 | 15 个 run_id 全部 `verify.sh` PASS（6/6 断言），逐条见规范 §9.2 |
| 真实浏览器 | H5 示例在内置浏览器里打开演示页、点完三步（1+2+2 flush），`js-1791466559` PASS |
| 内容契约测试 | `sdk-guides.spec.ts` / `OnboardingPage.spec.tsx` 更新为三档状态与新清单，19/19 通过 |
| i18n | `i18n_check.py`：13 语言 × 16 命名空间、3962 键通过；`i18n_scan.py --check` 与基线持平 |
| 结构棘轮 | `arch_ratchet.py` 通过（新增 `sdk-guides-verified.ts`、`sdk-code-samples.ts` 均为语义明确的窄模块） |

## 5. 残留（登记，非目标）

1. **Flutter / Unreal / 批量回补**保持 `planned`：前两者无环境，第三者是平台未实现的功能。
2. **平台打包验证**（APK / App / 小程序真机 / RN 壳 / 引擎工程）需要相应 SDK 与真机，未做。
3. **各语言母语者复核**：新增 84 键 × 12 语言由 Agent 翻译，建议按语言抽检（重点：`status.partial`
   徽标长度、`note1` 的技术语气、以及越南语 `faq1` 中把「中文」本地化为「本语言字符」的处理）。
4. **Lua 的 OpenResty 形态**只在注释里给了替换点（`resty.http`），未在 OpenResty 里实跑。

---

## 6. 追加批次（2026-10-08，Flutter + 批量回补 + 下载按钮 + 标签隐藏）

用户要求：继续 Flutter（授权准备环境）、看能否完成批量回补（不能就删）、把主页面状态标签全部隐藏但**抽屉里保留**、
并在抽屉里提供**一键下载演示工程**。

| 项 | 结果 |
|---|---|
| Flutter 环境 | 本机装 `flutter` cask（Flutter 3.47.6 / Dart 3.13.5，http 1.6.0），无需 Xcode 即可 `flutter build web` |
| Flutter 实测 | Dart CLI 跑 5 步链落库（`flutter-1791472103`，6/6）；`flutter build web --release` 成功；**真实浏览器里点完三步**（1+2+2，三次 HTTP 200）并落库核验（`flutter-1791472650`，6/6）；`flutter analyze` 0 issue；widget 测试 5/5 |
| Flutter 卡片 | 状态 **已实测**（Web 平台已构建并浏览器验证；iOS/Android 未打包的边界写在卡片文案里） |
| 批量回补 | **能完成** → 实现 `examples/report-sdk/backfill/backfill.py`（Python 3 标准库 CLI：dry-run / 限速 / 断点续跑 / 失败行落盘 / body 自动切分）。实测 120 行 CSV 回补：落库 120 行、`count(DISTINCT (time,event)) = 120`（无重无漏）；真实 SIGINT 中断两次后续跑仍为 120 行；失败路径写出 `*.failed.jsonl`（带行号） |
| 批量回补卡片 | 状态 **已实测**（原「暂未开发」→ 翻牌，未删除） |
| 卡片标签 | 主页面卡片上**不再显示**状态标签；状态标签移到文档抽屉里（颜色分档：绿/金/灰） |
| 演示工程下载 | 抽屉内新增「下载演示工程（zip）」按钮：`scripts/build-sdk-demos.sh` 打包 18 个工程到 `apps/analytics-web/public/sdk-demos/`（随产物发布），由 `build.sh` 在构建前端前调用；打包后**校验包内不含 token**，不通过则失败 |
| 文案 | 新增 28 键 × 13 语言（flutter 5 + batchImport 21 + drawer 2）；`i18n_check.py` 13 语言 × 16 命名空间 = 3990 键通过；`i18n_scan.py --check` 回到基线 1446（样例注释改英文、顿号改 ASCII 逗号） |

**保留未做**：Flutter iOS/Android 打包（无完整 Xcode / Android SDK）、引擎本体（Unreal）与 Cocos 引擎工程内打包。
