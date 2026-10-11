# CI 提速验收记录（phase: clklog-ci-speedup-v1）

日期：2026-10-08　提交：`55c7aae`　CI 发布模块版本：**17678**（此前 17677）

> 范围说明：本项是用户在会话中直接指定的三条 CI 提速改动（发版链路配置调整），
> 不新增系统 / 包 / 数据结构，因此没有独立 PRD 与架构方案；验收标准与证据即本文。

## 1. 目标与测量

**目标**：缩短 `master` 每条 pipeline 的等待时间，不改变任何交付内容与门禁强度。

同一份代码在本机（8 核 Mac，依赖已装）跑完整 `scripts/build.sh` 是 **2 分 06 秒**，
而 CI 每条 pipeline 要 **9–10 分钟**。逐阶段实测：

| 阶段 | 本机耗时 |
| --- | --- |
| `prisma generate` + `nest build`（后端编译） | 18s |
| 后端单测 `jest --runInBand`（129 文件 / 1015 用例） | 11s |
| 前端 `tsc && vite build` | 16s（tsc 5.7s / vite 8.6s） |
| 前端单测 `vitest run`（115 文件 / 630 用例） | 87s |
| i18n 双门禁 + Harness 测试 + 产物收集 + `.gz` 预压缩 | 4s |
| 合计 | **2m06s** |

CI 侧用模块时间戳反推：提交 `7f0d738` 于 19:09:35 推送，模块里 vite 产物落盘 19:14:42——
**本机 14 秒的活儿在 CI 上花了 5 分钟**；pipeline 日志中「服务端用例结束 19:38:05 → 前端用例开始 19:41:37」
这 3.5 分钟就是「许可检查 + 前端 `tsc` + `vite build`」整段。**结论：慢在 CI 的准备阶段与单线程阶段，
不是用例数量**，因此不动用例与超时设置。

## 2. 三项改动、收益与验证

| # | 改动 | 位置 | 收益 | 验证 |
| --- | --- | --- | --- | --- |
| 1 | 纯文档提交跳过整条构建 | `.gitlab-ci.yml` → `build-main.rules.changes`（只认 `apps/**`、`scripts/**`、`puppet/**`、`ai_workspace/**`、`.gitlab-ci.yml`） | 文档提交 100% 省掉；当天两次文档提交曾各白跑一遍完整流水线 | YAML 解析校验；`only:` 与 `rules:` 不可并用，分支限制已一并搬进 rules；无更早提交可比时 `changes` 视为真（保守方向） |
| 2 | Node 运行时归档进 cache | `.gitlab-ci.yml` 第三个 cache 条目（`.runtime/*.tar.xz`、`.runtime/*.tar.gz`，key 绑 `scripts/use-node24.sh`）+ `use-node24.sh` 优先复用已缓存归档 | 每 pipeline 省一次 ~50MB 下载 + 校验 + 解压；实测本机**首次 26s → 命中 2.2s** | 三条路径实测：正常下载（留存归档）、命中缓存（**封网下**仍成功，证明未联网）、下载失败（退出码 1 且 `.runtime/` 无残留）；坏包场景：校验失败 → 删除缓存副本 → 退出码 1（否则坏包会让后续每次都「命中」后失败，自己锁死） |
| 3 | 前端类型检查增量 | `apps/analytics-web/tsconfig.json`：`incremental` + `tsBuildInfoFile: ./node_modules/.cache/tsconfig.tsbuildinfo` | tsc 本机 **5.7s → 1.9s**（CPU 8.8s → 2.5s） | 冷/热对比实测；`.tsbuildinfo` 必须落在 `node_modules/` 内（CI 只缓存 node_modules，放外面等于白开） |

**只缓存归档而非解压目录**的理由：载荷停在 50MB 单文件，打包与回放都快；解压仍在 runner 本地做，
`sha256` 校验照旧保留，来源校验不放松。

## 3. 增量不得变成漏检（关键安全属性）

开启 `incremental` 后，类型检查可能因缓存而跳过文件。已用两条用例实测确认**不会漏**：

| 场景 | 结果 |
| --- | --- |
| 新增文件内含类型错误 | `src/__gate-probe.ts(2,7): error TS2322`，`tsc` 退出码 **2** |
| 修改既有文件引入错误（`src/i18n/useT.ts` 追加赋值） | `error TS2322` + `error TS6133`，退出码 **2**；改回后退出码 **0** |

日后若再动类型检查相关配置，必须先用这两条用例复验。

## 4. 门禁结果

`bash scripts/build.sh` 退出码 **0**：Server 1015 用例、Web 115 文件 / 630 用例、
`i18n_check.py`（13 语言 × 16 命名空间 3879 键）与 `i18n_scan.py --check`（待翻译 1446 = 基线）通过。

CI 生效验证（实测时间线）：提交 `55c7aae`（含 `apps/`、`scripts/`、`.gitlab-ci.yml` 改动）20:12 推送 →
模块版本由 17677 → **17678**（约 5 分钟），说明三个 cache 条目与 `rules` 均被 GitLab 正常解析、构建照常发布；
随后提交 `9743818`（**纯文档**：`docs/project/**` + `INDEX.md`）20:18:55 推送 →
持续观察到 20:28:19（9.5 分钟，超过前一次 5 分钟的构建时长）模块版本**一直是 17678**，
即 `rules: changes` 跳过整条构建生效。同时可排除「配置写错导致 pipeline 直接失败」：同一份配置在前一次
代码提交里已成功构建并发布。

## 5. 未做（登记，非目标）

1. **`tsc` 与 `vitest` 并行**：两者无依赖，但在 2 vCPU runner 上会互相抢 CPU，需在模拟 2 核的容器里实测后再定。
2. **模块目录瘦身**：`master/web/sa/assets/` 已积累数万个历史 chunk（约 1GB，从不清理），
   `--delete` 涉及多分支共用同一 rsync daemon，需单独确认后再动。
3. **调低前端用例超时 / 增加用例白名单**：不采用——30s 超时是为整页渲染用例在负载下不误报而设。
