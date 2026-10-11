# 架构棘轮结构基线（arch-ratchet-baseline）

> 职责：记录架构棘轮（`scripts/arch_ratchet.py`）的自举口径、超标清单与每个超标项的退出条件。规则见 `AGENTS.md`「系统架构棘轮」；初始化器分发源为 `docs/architecture/templates/AGENTS_exec.md`。
> 检查命令：`python3 scripts/arch_ratchet.py`；基线文件：`scripts/arch_ratchet.json`。

## 统计口径

| 项 | 口径 |
|---|---|
| 扫描根 | `apps/`（`analytics-server` NestJS 后端 + `analytics-web` React 前端） |
| 源文件 | `*.ts` / `*.tsx` |
| 测试文件 | `*.spec.ts(x)` / `*.test.ts(x)` |
| 跳过目录 | `.git`、`node_modules`、`dist`、`build`、`coverage`、`testdata`、`data`、`docs`、`export`、`dlq`、`harness`、`public`、`.turbo`、`.vite` |
| 环境变量豁免前缀 | `analytics-server/src/config`、`analytics-server/src/scripts` |
| 上限 | 单文件 1200 行；单目录生产 30 文件 / 8000 行；测试 30 文件 / 8000 行 |

## 自举记录

- 自举日期：2026-09-01（依据 `docs/architecture/templates/AGENTS_exec.md` B.7 内嵌初始化器，CONFIG 按仓库真实结构适配后写入 `scripts/arch_ratchet.py`）。
- 自举时现状：**无超标目录**（最大生产目录 `modules/meta` 26 文件）、**无测试债目录**、**无超 1200 行文件**；结构基线仅冻结环境变量读取表（下表）。
- 初始检查退出码 `0`。

## i18n v1 带来的结构变化（2026-09-16）

`phase: clklog-analytics-i18n-v1` 按「承接式包只减不增」方向做了两处迁出，均为**下降**：

| 目录 | 变化 | 去向 |
|---|---|---|
| `analytics-server/src/common/` | 12 → 11 文件 | `filters/http-exception.filter.ts` → `src/i18n/error-response.filter.ts`（新增错误码字段） |
| `analytics-web/src/utils/` | 2 → 1 文件 | `formatter.ts` → `src/i18n/format.ts`（区域随语言） |

新增语义窄包：`apps/analytics-web/src/i18n/`（语言资源与语言能力）、`apps/analytics-server/src/i18n/`（错误码契约、请求语言解析、服务端文案）。
两个包均未读取 `process.env`（环境变量读取基线不受影响），未新增超标目录，`arch_ratchet.py` 退出码 0。

---

## 冻结清单（只减不增）

### 承接式包结构债（2026-09-01 登记，硬门禁 A6）

| 目录 | 冻结值（生产文件） | 构成与问题 | 退出条件 |
|---|---|---|---|
| `analytics-server/src/common/` | 12 → **11**（2026-09-16 i18n v1 迁出 filters） | decorators(4)/interceptors(2)/guards(1)/pipes(1) 为 NestJS 惯用横切原语，可声明保留；`utils/`(3) 为杂项 | ① utils 按语义并入使用方或改名窄包（如 `rbac/`）；② 保留的原语目录在窄包声明中改名或维持 NestJS 惯例并登记；全部完成后 `--update` 移出登记 |
| `analytics-server/src/modules/shared/` | 8 | 基础设施客户端（prisma/redis/clickhouse/kafka×2）+ DSL 相关（expression-compiler/attribute-resolver）混装 | 基础设施客户端并入基础设施窄包（如 `infra/`），DSL 编译相关并入 query 域窄包；完成后 `--update` 移出登记 |
| `analytics-web/src/utils/` | 2 → **1**（2026-09-16 i18n v1 迁出 formatter） | dsl-builder.ts、formatter.ts 杂项命名 | dsl-builder 并入 `features/query/`，formatter 已按用途落 `src/i18n/format.ts`；dsl-builder 迁出后 `--update` 移出登记 |

约束：三个目录只减不增，禁止新增任何生产文件或导出；新增公共能力一律落语义窄包。数量变化靠 Agent/人工自检（未超棘轮 30 文件线，棘轮不冻结此三目录）。

### 环境变量读取（非入口目录，`process.env`）

| 文件 | 冻结值 | 退出条件 |
|---|---|---|
| `analytics-server/src/modules/ai-assistant/harness-runtime-manager.service.ts` | 16 | 环境变量读取收敛到 `src/config/configuration.ts`，经配置注入；本文件降为 0 后运行 `--update` 移出基线 |
| `analytics-server/src/modules/ingestor/kafka-consumer.service.ts` | 3 | 同上，降为 0 |
| `analytics-server/src/modules/ingestor/dlq.service.ts` | 1 | 同上，降为 0 |
| `analytics-server/src/modules/shared/kafka-socket.factory.ts` | 1 | 工厂改为参数注入，降为 0 |
| `analytics-web/vite.config.ts` | 1 | 构建工具配置，允许长期保持 1 处；增加读取处数须先在本表登记调整理由 |

### 生产超标目录 / 测试债目录 / 超长文件

自举时为空。此后一旦进入基线，须在此登记：目录、冻结值（文件数/行数）、超标原因、拆分退出条件；数值只减不增，退出时同步删除本表行。
