# AGENTS.md — Agent 工作规则（普通软件项目模板）

> TEMPLATE-VERSION: 1.0（升级本模板时递增版本号；已落地项目据此判断是否需要同步更新）
>
> 本文件是从文档驱动、多真相源项目的 `AGENTS.md` 抽象出的通用模板。
> 复制为项目根目录 `AGENTS.md` 后，按 `[…]` 占位符填入本仓库实际路径与规则。
> 只保留 Agent 会话必须常驻的规则；项目现状看 `README.md`，文件导航看 `INDEX.md`，设计事实看规格文档。
> 更新该文件时，不要引用任何本地项目，所有的更新内容需要抽象成模版。

## 使用说明（给人看，可删）

1. 复制本文件为根目录 `AGENTS.md`，删掉本节与未使用的帽子行。
2. 帽子表控制在能分清职责即可，常见 3–5 顶；游戏/强设计项目可再加美术、叙事等。增删帽子走人类审批，不要让 Agent 自创。
3. SSOT 表只保留本仓库真实存在的层；链路写成你们实际的交付顺序。校验命令写在「实现专用规则」或 CI，不要塞进 SSOT 表。
4. 首次启用时确认根目录（或约定路径）有 `INDEX.md`；没有则让 Agent 按「首次启动」节创建。
5. 架构门禁里的上限（包文件数、包行数、聚合数）按技术栈调，但**必须留下棘轮**：老项目照当前值起基线，新项目起点为空，让它从第一天就只减不增。
6. 红线写「做错会伤产品」的事，并尽量配检测脚本；不写「最好怎样写代码」。
7. 实现规则里的命令必须是仓库里真实可跑的；过时命令比没有更糟。
8. 紧急热修走「紧急覆盖」短规则，事后补文档；不要另造一套常驻流程百科。
9. 保持短：Agent 每次加载；散文、版本史、版权、站会规范、shell 正文放到别处。
10. 全部 `[…]` 占位符替换干净后再启用：复制后全文搜索 `[`，把每个占位符（如 `[脚本目录]`、`[verify / test / lint 命令]`）替换为仓库真实值，一个都不留；漏填的占位符比不写更糟。

---

## 项目与帽子

用一句话说明产品是什么；当前阶段、里程碑和技术栈以 `README.md` 为准，不在此复制快照。

修改代码或文档前，先确认当前帽子；同一时刻只戴一顶：


| 帽子               | 工作目录                                | 只回答                |
| ---------------- | ----------------------------------- | ------------------ |
| 架构 / 愿景          | `docs/vision/`、`docs/architecture/` | 应该是什么？             |
| 产品               | `docs/product/`                     | 怎么无歧义地描述？          |
| 项目               | `docs/project/`                     | 怎么按时拼到一起？          |
| 程序 / 实现          | `src/`、`apps/`、`packages/`          | 如何稳定实现与验证？         |
| 数据 / 配置          | `data/`、`config/`、`migrations/`     | 实体、关系和配置如何成为可执行真相？ |
| （可选）设计 / 运营 / 合规 | `[按需目录]`                            | `[该帽子唯一问题]`        |


可增删帽子，但每顶帽子必须有：**唯一工作目录** + **唯一问题**。不要为同一问题开两顶帽子。

**增删帽子须用户明确同意**；Agent 不得自创帽子或私自改帽子表职责边界。仅允许在已批准前提下，按「帽子工作目录与仓库对齐」修正路径字符串。

做设计时不考虑排期，拆解时不扩写创意，排期时不重新设计；产出放入对应帽子的目录。

### 戴上「程序 / 实现」之前的门禁

切换到或开始「程序 / 实现」工作前，本地必须已有完整前置文档，缺一不可：

1. **产品设计文档**（产品帽产出，通常在 `docs/product/`）
2. **实现方案文档**（架构/程序侧方案，通常在 `docs/architecture/` 或约定路径）

两份文档须落地为仓库内真实文件（不可只存在于对话）。每份（或二者共同引用的 phase 块）须同时包含以下要素，**缺一视为门禁未过**：

| 要素 | 最低要求 |
|---|---|
| `phase` id | 稳定标识（如 `phase: user-auth-v2`），可检索、可引用 |
| 阶段目标与范围 | 本次做什么 |
| 验收标准 | 可核对的完成条件（测试名、检查清单或明确断言均可；不强制特定 ID 格式） |
| 非目标 | 明确不做什么，防止范围蔓延 |

缺文档或门禁要素不全时：先补文档，再写代码；不要边实现边补方案冒充门禁已过。

有条件的项目可将门禁做成 pre-commit / CI 检查（脚本放 `scripts/`，不把 shell 正文写进本文件）；无自动化时，Agent 仍须用「文件存在 + 要素齐全」自检，不得伪造路径。

### 帽子工作目录与仓库对齐

若当前仓库目录结构与帽子表中「程序 / 实现」「数据 / 配置」的工作目录不一致：

- **改 `AGENTS.md` 帽子表里的工作目录**，使其指向仓库真实路径；
- 不要为迁就帽子表去搬迁/虚构目录，也不要在错误路径下继续写文件。

对齐后若 `INDEX.md` 任务入口仍指向旧路径，同步改索引条目。

### 紧急覆盖（唯一逃生口）

仅当用户明确要求，或存在不可拖延的安全/数据损坏风险时，可暂时突破帽子或程序门禁。必须同时满足：

1. 提交说明或会话结论中声明 `OVERRIDE-REASON: [具体原因]`；
2. **24 小时内**（或用户指定更短时限）补全缺失文档，并关联该提交 / 会话；
3. 事后在项目约定处留一条复盘记录（如 `docs/project/` 或 issue）；无约定目录时写在对应 PR 描述即可。

不得将 OVERRIDE 用于「省事跳过设计」。

---



## 文档与 SSOT 边界


| 层             | 唯一职责                   | 不承担                 |
| ------------- | ---------------------- | ------------------- |
| `README.md`   | 面向人的项目现状与入口            | Agent 行为规则、完整文件清单   |
| `AGENTS.md`   | Agent 必须遵守的工作规则        | 易变化的阶段、数量和文档摘要      |
| `INDEX.md`    | 按需文件导航与结构元数据           | 业务百科、当前阶段、行为规则、完整正文 |
| 规格 / 设计文档     | 目标、rationale、验收标准、设计红线 | 运行时字段值权威            |
| 代码与 schema    | 可执行行为与类型真相             | 在注释或 PR 描述里另起权威定义   |
| 配置 / 迁移 / 生成物 | 环境与数据变更的可复现真相          | 手改生成物而不回写源头         |


链路（按项目裁剪）：愿景 → 规格/PRD → 架构 → 代码与 schema → 配置/迁移 → 部署与验证。

新建或修改「权威数值 / 实体 / API 契约」只写 SSOT 层；规格文档只写意图、体验与设计理由。ID、接口约定以架构文档为准，不在引用处硬编码文档版本号。

人类协作流程（站会、看板、RACI）写在 `CONTRIBUTING.md` 或 `docs/process/`，不要塞进本文件。

### INDEX 层说明

`INDEX.md`（或项目约定的 `docs/INDEX.md`）是 **导航层**，不是内容层：

- **只回答**：文件在哪、各目录有什么、读哪篇入口、结构计数/扫描元数据。
- **不回答**：产品该怎么设计、代码怎么写、当前里程碑快照（那些分别在规格、代码、`README.md`）。
- **使用方式**：先按任务关键词或文件名定位，再读相关章节；不要默认通读全文。
- **与 AGENTS 的分工**：维护触发条件、命名规则、保鲜检查写在 `AGENTS.md`；`INDEX.md` 文末「索引维护」节只指向本文件，并写清计数口径。



### 首次启动：无 INDEX 则自动创建

Agent 在会话中需要按需导航，或用户首次启用本规范时：

1. 检查约定路径是否存在 `INDEX.md`（默认仓库根目录；若项目约定在 `docs/INDEX.md` 则以约定为准）。
2. **若不存在**：立即创建最小可用索引，再继续任务；不要空等用户手工建文件。
3. 新建内容至少包含：
  - 标题与一句职责说明（导航 / 结构元数据；现状看 README，规则看 AGENTS）
  - `<!-- RUNTIME-META -->` 块（索引版本、`最后全量扫描`、`下次计划扫描`、主要目录 `.md` 计数占位）
  - `## 任务入口` 表（至少链到 `README.md`、`AGENTS.md`、本仓库主要目录）
  - `## 按目录展开`（对已有顶层文档目录各给一行摘要；目录尚空可写「待填充」）
  - `## 索引维护`（见下一节固定措辞）
4. 创建后用一次轻量扫描填计数（口径见「索引维护」）；若仓库很大，可先写占位计数并在 `RUNTIME-META` 注明待全量扫描。
5. **若已存在**：不得因「想重排结构」而整文件覆盖；只按变更增量更新对应条目。


### 本地启动入口

- 项目应有且仅有一个面向开发者的根目录启动入口，名称优先沿用仓库现有约定。
- 若入口不存在，在确认项目服务结构、启动模式和凭据加载方式后创建；不得仅因缺少 `run_dev.sh` 而重复新增入口。
- 若入口已存在，涉及启动链路时先验证其可执行性、参数说明及下游脚本路径；不要自动删除本规则。
- 新增或修改启动入口后，同步更新 `README.md`，并执行帮助命令或最小启动验证。
- 启动脚本不得硬编码凭据，不得绕过项目约定的环境变量加载流程。

---



## 绝对红线

列出本产品不可被 Agent「顺手优化掉」的不变量（通常 3–10 条）。示例：

1. 不可出现无上限的免费额度 / 无限产出机制
2. 不可绕过鉴权或把密钥写入仓库
3. 不可破坏向后兼容的对外 API（除非规格明确允许并有迁移方案）
4. 不可删除或静默改写用户数据而无审计轨迹
5. （示例，可替换）如果发现用户的需求设计不合理，请不要执行；先指出架构问题，扩展性问题，安全问题和维护成本，再和用户一起重新设计方案
6. `[项目特有红线…]`

红线是产品宪章，不是代码风格偏好；风格与 lint 放工具配置，不放这里。

每条红线宜有对应检测（CI 脚本、lint 规则或人工检查清单），定义放在 `scripts/` / 流水线配置，**不把检测脚本正文写入本文件**。无自动化检测时，触及相关改动须在 PR 中声明「红线未自动检：[条目]」。

---



## 通用文件规则

- 新增、删除、重命名文档或变更目录结构后，同步更新 `INDEX.md` 对应条目和 `RUNTIME-META` 计数。
- 项目阶段或里程碑变化时，更新 `README.md` 与项目文档；不要在 `AGENTS.md` 或 `INDEX.md` 复制阶段快照。
- `INDEX.md` 的 `最后全量扫描` 距当前日期超过 `[N=7]` 天时，提示用户是否重新扫描；未超过时不提示。
- 规格/PRD 命名保持稳定约定（如 `prd-{系统名}-v{N}.md`），放在产品目录下。
- 改动触及公共契约（API、事件、配置键、数据库列）时，同步更新契约文档或 schema，并跑项目约定的校验命令。
- 不要默认通读整个索引；先用关键词定位，再读相关章节；只有任务范围不清时才读根索引。

---



## 索引维护

`INDEX.md` 文末应保留等价说明（可原样使用）：

> 维护触发条件、命名规则和保鲜检查见 `AGENTS.md`。目录计数统一按 `rg --files <目录> -g '*.md'` 口径；全量扫描时更新 `最后全量扫描` 和 `下次计划扫描`。

Agent 侧必须遵守：

- **触发更新**：文档增删改名、目录结构调整、全量扫描、或用户明确要求刷新索引时。
- **计数口径**：`rg --files <目录> -g '*.md'`（或项目等价命令）；不要用「肉眼估数」覆盖 `RUNTIME-META`。
- **全量扫描**：更新 `最后全量扫描` 与 `下次计划扫描`（默认 +7 天，可按项目改 `[N]`）；扫描结果写回各目录计数，不把业务摘要抄进 `AGENTS.md`。
- **命名**：索引内链接路径与仓库真实路径一致；任务入口表保持「任务 → 首选文件」，不堆长文。
- **失效处理**：打开或扫描时发现索引条目指向的路径不存在 → 将该条目标记为失效（如 `⚠️ 路径失效（发现于: {日期}）`），**不删除条目**（保留导航线索）→ 并触发上文「帽子工作目录与仓库对齐」检查。不得因死链直接放弃任务。

---



## 实现专用规则

按技术栈填写「改这类真相时必须怎么做」；只写可执行步骤，不写原则散文。

- 工作范围限定在 `[实现/数据目录]`；不把规格表格改成字段 SSOT。
- 改数据或批量配置时优先：`[plan/dry-run 命令]` → 确认 → `[apply 命令]`。
- 直接编辑权威数据后必须运行：`[verify / test / lint 命令]`。
- 新实体 / 资源 ID 遵循 `[ID 约定文档]`；不在调用方另起 ID。
- 触及跨模块依赖时，修改前运行：`[audit / 影响分析命令]`。
- PR 附上 `[变更证据：测试结果 / schema diff / 导出快照]`，或明确声明未导出/未发布。

---



## 系统代码架构硬门禁

以下条目不是建议，是可判定的准入条件。任一门禁未满足时，停止实现并报告缺失项；不得以“后续补充”“先跑起来”“迁移期临时这样”或 TODO 绕过。判定以命令输出为准，不以模型判断为准。

### A. 结构规模（防止再次长成大泥球）

1. **单文件上限**：任何代码文件不得超过 1200 行。本次改动使文件越线时，必须在同一任务内按职责拆分实现与对应测试。
2. **单包上限**：任何一个业务包不得超过 `[30]` 个生产文件或 `[8000]` 行生产代码。达到 80% 时必须先拆子包再加功能，不得先超标后补拆。
3. **入口包禁止承载业务**：程序入口包（`main` / `cmd/*` / `index` / `app entry`）只保留参数解析、配置构造、依赖装配、路由挂载和启停，最多 `[5]` 个文件且不含业务规则、持久化和供应商调用。
4. **禁止文件名伪模块**：同一包内出现 `[3]` 个及以上共享同一前缀的文件（如 `art_*.go`、`workbench_*.go`、`datacenter_*.go`），视为该前缀应当独立成包。禁止用文件名前缀代替包边界继续新增文件。
5. **禁止集中式分派**：单个函数或文件中的路由/命令分派分支不得超过 `[20]` 个。超过时必须由各模块自行注册（`RegisterRoutes` 或等价机制），不得维护全局总路由表。
6. **禁止承接式包**：不得创建或扩大 `common`、`utils`、`shared`、`core`、`app`、`serverapp` 之类无领域含义、只用于承接杂项的包。抽公共能力必须落在语义明确的窄包（如 `filelock`、`jsonstore`、`httpx`）。

### B. 棘轮（超标处只能变小）

上限只能挡住新代码，挡不住既有的超标处继续膨胀——大泥球正是这样一次一个文件长出来的。棘轮把「已经超标」冻结成不可回退的基线。

7. **首次实现任务必须自举棘轮**：接到本仓库第一个实现类任务时，若 `[脚本目录]/arch_ratchet.py` 不存在，必须执行下方「内嵌初始化器」：
   1. 将代码块原样写入 `[脚本目录]/arch_ratchet.py`，只按仓库真实结构修改顶部 `CONFIG`（语言选配见下方「CONFIG 按项目语言选配」；CONFIG 以外的脚本逻辑不得改动）。
   2. 运行 `python3 [脚本目录]/arch_ratchet.py --report` 确认扫描范围，再运行 `--update` 写入初始基线。
   3. 将超标清单、统计口径和每个超标目录的退出条件写入 `[结构基线文档]`。
   4. 运行默认检查，必须退出码为 `0`；然后再继续原实现任务。
   5. **初始化器是一次性引导件**：初始化成功（默认检查退出码 `0`）后，立即从**当前生效的规则文件**中删除 `ARCH-RATCHET-BOOTSTRAP:BEGIN` 到 `ARCH-RATCHET-BOOTSTRAP:END` 整段以节省上下文，不得保留第二份拷贝；不得删除生成的脚本、JSON 基线、本条规则。本模板只维护**唯一一份**初始化器（即本段，分布在分发源模板中）；日后脚本或基线缺失时，只允许从分发源模板取回同一段，禁止另写实现。
   不得空等用户手工建立，也不得因「本次改动很小」跳过。若脚本已存在，只运行检查，不重复初始化、不覆盖已有基线。

**初始化器运行时（Python 必须）**：初始化器仅以 Python 3 实现，是唯一允许的实现形式，不得用其他语言重写等价脚本。环境缺少 `python3` 时，agent 必须先自动安装（按平台：`brew install python3` / `apt-get install python3` / `uv python install` 等）再继续自举；不得因缺运行时跳过棘轮自举。

**CONFIG 按项目语言选配**：初始化前先扫描仓库真实代码结构，按实际语言裁剪 `sourceGlobs` / `testGlobs` / `envMarkers`；不默认全开，也不漏配已有语言。`roots` / `entryPrefixes` / `skipDirs` / `limits` 同样按仓库真实结构调整（`limits` 见「使用说明」第 5 条）：

| 项目语言 | `sourceGlobs` | `testGlobs` | `envMarkers` |
|---|---|---|---|
| Go | `["*.go"]` | `["*_test.go"]` | `["os.Getenv", "os.LookupEnv"]` |
| TS / 前端 | `["*.ts", "*.tsx"]` | `["*.test.ts", "*.test.tsx", "*.spec.ts", "*.spec.tsx"]` | `["process.env"]` |
| Python | `["*.py"]` | `["test_*.py", "*_test.py"]` | `["os.environ", "os.getenv"]` |
| Rust / Java / C++ | 按需追加 `["*.rs"]` / `["*.java"]` / `["*.cpp", "*.h"]` | `["*_test.rs"]` / `["*Test.java"]` / `["*_test.cpp"]` | 按运行时追加（如 `"std::env::var"`、`"System.getenv"`） |
| 混合项目 | 合并各语言行（如 Go 后端 + TS 前端取两行 globs 的并集） | 同左合并 | 同左合并 |
8. **棘轮脚本契约**：脚本须与语言无关地实现以下行为，配置集中在文件顶部一个 CONFIG 块（扫描根、源文件 glob、测试文件 glob、入口目录前缀、跳过目录、生产/测试/单文件上限）：
   - 默认运行 = 检查：统计当前值与基线比较，任一超标目录的生产文件数、生产行数、测试文件数或测试行数上升，出现新的生产/测试超标目录、新的超长文件，或非入口目录新增环境变量读取，均打印差异并以退出码 `1` 失败。
   - `--report`：只打印当前数值，不比较，用于拆分过程中观察。
   - `--update`：写基线，且**只允许下调**；当前值高于基线时拒绝写入并退出码 `1`，确需上调必须显式 `--force` 并记录原因。
   - 基线存为脚本旁的 JSON，含 `updatedAt`、`limits`、生产超标目录、测试债目录、超长文件和环境变量读取表。
   - 实现必须来自下方内嵌初始化器，不得临时写一个只返回成功的空检查器。
9. **超标包只减不增**：进入基线的目录处于超标状态。禁止向其新增生产文件、测试文件、导出类型或功能分支；只允许迁出、拆分、删除和必要的缺陷修复。新增能力必须落在新包，测试随实现迁入真实所有者，禁止把白盒测试继续堆在组合根。
10. **基线不得回退**：每次涉及基线目录的改动后重新运行检查，数值必须持平或下降。检查失败时回退或当次完成拆分；禁止为通过检查而重记基线、放宽上限或把文件挪进跳过目录。
11. **禁止改名逃逸**：把超标包整体改名、整体搬到新路径或整体包进新壳，不算拆分，基线继续沿用原条目。
12. **退出基线**：某目录降到上限内后运行 `--update` 将其移出基线，并同步删除 `[结构基线文档]` 中对应行。

<!-- ARCH-RATCHET-BOOTSTRAP:BEGIN -->
### 内嵌初始化器（生成真实棘轮后删除本段）

```python
#!/usr/bin/env python3
"""Architecture ratchet: over-limit directories may only shrink."""
from __future__ import annotations

import argparse
import fnmatch
import json
import sys
from datetime import date
from pathlib import Path

# Only this block may be changed during initialization.
CONFIG = {
    "roots": ["../src"],
    "sourceGlobs": ["*.go", "*.py", "*.ts", "*.tsx", "*.js", "*.jsx", "*.rs", "*.java", "*.cpp", "*.h"],
    "testGlobs": ["*_test.go", "test_*.py", "*_test.py", "*.test.ts", "*.test.tsx", "*.spec.ts", "*.spec.tsx"],
    "entryPrefixes": ["cmd/", "config/", "src/config/"],
    "envMarkers": ["os.Getenv", "os.LookupEnv", "os.environ", "os.getenv", "process.env", "System.getenv"],
    "skipDirs": [".git", "node_modules", "vendor", "dist", "build", "coverage", "testdata", "data", "docs", "export"],
    "limits": {
        "packageFiles": 30,
        "packageLines": 8000,
        "packageTestFiles": 30,
        "packageTestLines": 8000,
        "fileLines": 1200,
    },
}

HERE = Path(__file__).resolve().parent
BASELINE = HERE / "arch_ratchet.json"
LIMITS = CONFIG["limits"]


def matches(name: str, globs: list[str]) -> bool:
    return any(fnmatch.fnmatch(name, pattern) for pattern in globs)


def sources():
    skip = set(CONFIG["skipDirs"])
    for root_spec in CONFIG["roots"]:
        root = (HERE / root_spec).resolve()
        if not root.is_dir():
            sys.exit(f"scan root does not exist: {root}")
        for path in root.rglob("*"):
            if not path.is_file() or not matches(path.name, CONFIG["sourceGlobs"]):
                continue
            rel = path.relative_to(root)
            if not (skip & set(rel.parts)):
                yield path, rel


def measure() -> dict:
    packages: dict[str, dict[str, int]] = {}
    test_packages: dict[str, dict[str, int]] = {}
    oversized: dict[str, int] = {}
    env_readers: dict[str, int] = {}
    entry_prefixes = tuple(CONFIG["entryPrefixes"])
    for path, rel in sources():
        package = rel.parent.as_posix()
        package = "" if package == "." else package
        text = path.read_text(encoding="utf-8", errors="ignore")
        lines = text.count("\n") + (0 if not text or text.endswith("\n") else 1)
        is_test = matches(path.name, CONFIG["testGlobs"])
        if is_test:
            stats = test_packages.setdefault(package, {"files": 0, "lines": 0})
            stats["files"] += 1
            stats["lines"] += lines
        else:
            stats = packages.setdefault(package, {"files": 0, "lines": 0})
            stats["files"] += 1
            stats["lines"] += lines
            if not entry_prefixes or not package.startswith(entry_prefixes):
                hits = sum(text.count(marker) for marker in CONFIG["envMarkers"])
                if hits:
                    env_readers[rel.as_posix()] = hits
        if lines > LIMITS["fileLines"]:
            oversized[rel.as_posix()] = lines
    over_limit = {
        package: stats
        for package, stats in packages.items()
        if stats["files"] > LIMITS["packageFiles"] or stats["lines"] > LIMITS["packageLines"]
    }
    test_debt = {
        package: stats
        for package, stats in test_packages.items()
        if package in over_limit
        or stats["files"] > LIMITS["packageTestFiles"]
        or stats["lines"] > LIMITS["packageTestLines"]
    }
    return {
        "limits": dict(LIMITS),
        "overLimitPackages": dict(sorted(over_limit.items())),
        "testDebtPackages": dict(sorted(test_debt.items())),
        "oversizedFiles": dict(sorted(oversized.items())),
        "envReaders": dict(sorted(env_readers.items())),
    }


def load_baseline() -> dict:
    if not BASELINE.is_file():
        sys.exit(f"missing baseline: {BASELINE}; initialize with --update")
    return json.loads(BASELINE.read_text(encoding="utf-8"))


def failures(current: dict, baseline: dict) -> list[str]:
    result: list[str] = []
    old_packages = baseline.get("overLimitPackages", {})
    for package, stats in current["overLimitPackages"].items():
        old = old_packages.get(package)
        if old is None:
            result.append(f"new over-limit package {package}: {stats}")
            continue
        for key in ("files", "lines"):
            if stats[key] > old[key]:
                result.append(f"{package} {key} increased: {old[key]} -> {stats[key]}")
    old_test_debt = baseline.get("testDebtPackages", {})
    for package, stats in current["testDebtPackages"].items():
        old = old_test_debt.get(package)
        if old is None:
            result.append(f"new test-debt package {package}: {stats}")
            continue
        for key in ("files", "lines"):
            if stats[key] > old[key]:
                result.append(f"{package} test {key} increased: {old[key]} -> {stats[key]}")
    for path, lines in current["oversizedFiles"].items():
        old = baseline.get("oversizedFiles", {}).get(path)
        if old is None:
            result.append(f"new oversized file {path}: {lines} lines")
        elif lines > old:
            result.append(f"oversized file grew {path}: {old} -> {lines}")
    for path, hits in current["envReaders"].items():
        old = baseline.get("envReaders", {}).get(path, 0)
        if hits > old:
            result.append(f"environment reads increased {path}: {old} -> {hits}")
    return result


def report(current: dict) -> None:
    print(json.dumps(current, ensure_ascii=False, indent=2))


def update(current: dict, force: bool) -> int:
    if BASELINE.is_file() and not force:
        regressions = failures(current, load_baseline())
        if regressions:
            print("baseline may only decrease; refusing update", file=sys.stderr)
            for item in regressions:
                print(f"  - {item}", file=sys.stderr)
            return 1
    payload = {"updatedAt": date.today().isoformat(), **current}
    BASELINE.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"baseline updated: {BASELINE}")
    return 0


def check(current: dict) -> int:
    regressions = failures(current, load_baseline())
    if not regressions:
        print("architecture ratchet passed")
        return 0
    print("architecture ratchet failed:", file=sys.stderr)
    for item in regressions:
        print(f"  - {item}", file=sys.stderr)
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="architecture structure ratchet")
    parser.add_argument("--report", action="store_true")
    parser.add_argument("--update", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    current = measure()
    if args.report:
        report(current)
        return 0
    if args.update:
        return update(current, args.force)
    return check(current)


if __name__ == "__main__":
    raise SystemExit(main())
```
<!-- ARCH-RATCHET-BOOTSTRAP:END -->

### C. 依赖与分层

13. **依赖单向**：领域包不得导入接口层、入口包和其他领域包的内部实现；跨领域只能依赖对方公开契约。禁止编译期循环依赖，同时禁止对象级回边（子组件持有父容器指针 / 反向引用根对象）。
14. **领域包纯净**：领域包内禁止出现 HTTP 类型（`http.ResponseWriter`、`Request`）、环境变量读取、硬编码文件路径和供应商 SDK。传输层只做 DTO 转换与错误映射。
15. **配置集中**：环境变量只允许在 `[配置包]` 和入口包读取，其余位置一律通过显式参数注入。棘轮脚本按此口径统计，非入口目录的读取处数量只减不增。
16. **接口定义在使用方**：需要抽象时，由调用方定义窄接口，实现方直接满足；禁止建立集中式 `interfaces` / `contracts` 大包。
17. **聚合上限**：单个结构体或容器不得聚合超过 `[5]` 个领域组件，且不得被当作服务定位器四处传递。超出时按上下文拆分为多个应用服务。

### D. 生命周期与状态所有权

18. **可控启停**：进程必须有显式的启动和关闭路径，处理终止信号，并在退出前停止后台 worker、取消 context、关闭连接、释放锁和落盘。禁止 `log.Fatal(ListenAndServe)` 之类无关闭路径的启动方式。
19. **单一写入方**：每类可变业务状态只能有一个权威写入包。其他模块只能通过公开命令、窄接口或事件触发变更，禁止直接改写其存储、文件或内存状态。
20. **跨域解耦**：跨领域联动必须通过事件或窄接口，由接收方决定如何更新自己的投影/索引。禁止写侧直接调用另一个领域的全量重建。
21. **一致性与锁边界**：跨两个以上持久化写入的操作必须原子提交或提供可验证补偿；异步任务必须具备持久化状态、幂等键、有限重试和崩溃恢复。网络、子进程、供应商或用户回调等不受控外部调用不得持有业务写锁；外部调用返回后须重新加锁，并用 CAS、版本号、RecordHash 或等价机制确认状态未漂移。仅靠进程内锁、布尔标志或内存队列视为未通过。
22. **单一写入口**：同一业务能力只能有一个正式入口。HTTP、CLI、定时任务、测试工具必须复用同一应用服务，不得复制业务规则或绕过校验直连存储。

### E. 迁移与双轨

23. **迁移整组搬**：重构按领域闭环整组迁移，仓储、状态机、失败语义、补偿顺序、实现与对应测试同批落位，不逐函数 peel。阶段开始前先列出不可退化语义（如幂等键、CAS、claim、checksum、信任边界、恢复证据）；阶段验收须同时满足：源包真实净减、目标包未超限、测试已迁到真实所有者、不可退化语义有测试。阶段内允许短暂编译失败，但收尾前必须恢复全部相关验证。
24. **双轨须登记**：任何 `legacy/new`、`v1/v2`、facade 兼容层在创建时必须登记到 `CODE_HANDOVER.md`，写明负责领域、删除条件和期限 `[默认 30 天]`。逾期未删由下一次实现任务优先清理。
25. **不夹带重做**：一次迁移只改变一个主要风险轴。结构拆包期间保持对外 API 路径、事件名、数据结构和持久化协议不变；数据模型、SSOT 写入协议或基础设施替换必须单独立项。
26. **禁止临时文件入库**：`tmp_*`、`*_new`、`*_old`、`*_backup`、`*_copy` 等临时代码文件不得提交；发现即删除或正式命名。

### F. 验证与例外

27. **方案先行**：新增系统、新增包、改变依赖方向或迁移数据所有权前，仓库内须有实现方案文档，写明模块边界、依赖方向、权威数据所有者、公共契约、失败恢复和验收标准。缺项不得写实现代码。
28. **测试所有权**：每个新包必须有至少一组外部视角测试（Go 用 `package xxx_test`，其他语言用只依赖公开 API 的测试）。迁出领域实现时对应测试必须迁入真实所有者，并尽量改为黑盒测试；组合根只保留跨模块装配、公共中间件和生命周期集成测试。禁止新包仅有白盒测试，也禁止把领域测试留在组合根维持兼容壳。
29. **完成定义**：新增状态变更必须覆盖成功、拒绝、重复请求和中途失败四类用例；迁移阶段按“目标领域黑盒测试 → 原入口兼容测试 → 全量测试 → 结构棘轮 → diff/lint”顺序验证。长测试须记录实测耗时并设置有依据的 timeout；超时只表示结果未知，不能直接宣称业务回归或测试通过。不得以“编译通过”替代测试证据。
30. **交付前自检**：宣称实现完成前必须运行棘轮检查并给出结果；一个迁移阶段必须形成一个可独立评审、可单独回退的变更单元。除非用户明确要求，不得把“每阶段一个单元”解释成自动创建 Git 提交。
31. **决策留痕**：引入新基础设施、改变依赖方向或采用不可逆方案时，在 `[架构决策记录目录]` 写 ADR，记录选择、替代方案、迁移与回滚方式。
32. **例外唯一出口**：只有用户明确批准，或存在不可拖延的数据损坏 / 安全风险时才能突破以上门禁，并按「紧急覆盖」记录 `OVERRIDE-REASON`、补档期限和复盘位置。不得用例外条款省事跳过结构约束。

---


## 阶段性架构审计与重构

- **审计触发**：完成一个领域业务组、单次实现改动达到 20 个代码文件、核心代码距上次审计超过 14 天，或用户明确要求时，执行一次系统架构审计。
- **审计记录**：问题统一写入根目录 `CODE_HANDOVER.md`，至少记录：发现日期、影响领域、严重级别、证据、建议方案、状态、最后复查日期。
- **保鲜提示**：`CODE_HANDOVER.md` 的最后全量审计距当前日期超过 14 天，且本次任务涉及程序实现时，提示用户是否重新审计；未超过时不提示。
- **增量复查**：修改已登记问题涉及的代码时，复查对应条目并更新状态；已修复项保留记录，不直接删除。
- **失效处理**：代码路径、测试名或问题证据失效时，将条目标记为 `⚠️ 待重新确认`，不得在没有验证的情况下直接关闭。
- **重构授权**：审计只记录问题；完成审计后询问用户是否修复和重构，未经确认不扩大为重构任务。
- **重构粒度**：按领域批量迁移完整业务组，包括实现及对应测试，不逐函数剥离。
- **阶段目标**：开始前声明可验证的源包净减目标或最终收口条件；数字按项目规模确定，不硬编码通用“减 N 行”。禁止靠删测试、压缩格式、改名或把代码搬进新的承接式包凑指标。
- **阶段验证**：领域组迁移期间允许短暂编译失败，但该领域阶段结束前必须恢复编译，并运行目标领域黑盒测试、原入口兼容测试、全量测试、lint/diff 和结构棘轮；失败不得进入下一领域。
- **可执行交接**：中断或交接时必须记录基准提交/变更范围、精确统计口径与当前数值、目标边界、已迁职责及新所有者、剩余文件/职责地图、不可退化语义、下一阶段、已运行命令/结果/实测耗时、明确禁止项。未完成时必须明确写“进行中”，不得把中间组合根描述成终态。


## 按需导航


| 任务           | 首选入口                       |
| ------------ | -------------------------- |
| 项目现状         | `README.md`                |
| 文件导航 / 结构    | `INDEX.md`（无则按上文自动创建）      |
| 产品目标 / 本质    | `docs/vision/…`            |
| 系统架构与集成      | `docs/architecture/…`      |
| 需求拆解         | `docs/product/…`           |
| 排期与里程碑       | `docs/project/…`           |
| 本地运行与开发      | `README.md` 或 `docs/dev/…` |
| 数据 / 配置 SSOT | `[data 或 config 入口]`       |
| 贡献与评审（人类）    | `CONTRIBUTING.md`          |
| 长测试执行规范      | 本文末尾「长测试执行规范」节        |
| 架构棘轮（脚本 / 基线）  | `[脚本目录]/arch_ratchet.py`、`[结构基线文档]` |


---

## 长测试执行规范（agent 跑 20 分钟级测试套件）

当单个测试包累计运行时间远超单条工具/命令的硬超时（如 `internal/serverapp` 整包 20+ 分钟）时，**不要用任何前台阻塞命令去等**——命令会被框架先 kill 掉。唯一干净的范式是：**后台终端跑测试、命令退出时框架自动回调重新激活对话、agent 在等待期彻底结束当前 turn**。这绕开了工具超时这道墙：agent 没有任何一条命令在阻塞等待，自然不会被掐断。

### 决策树

| 等待间隙 | 该用的姿势 | 为什么 |
|---|---|---|
| 没别的活可干 | **后台终端 + 结束 turn + 等退出回调** | 零轮询、零阻塞、不撞工具超时 |
| 有别的活可干 | 后台启动 + 穿插干活 + 偶尔非阻塞快照 | 等待被有效工作免费覆盖 |
| 任何情况 | 前台阻塞等 / `sleep N` 盲等 / 阻塞轮询 | 撞工具超时或纯浪费 turn |

### 三个硬约束（违反任一则回调失效）

1. **被监听命令的生命周期 = 整个测试**：后台终端里那个顶层命令必须 `wait` 所有子进程后才退出。框架监听它的退出 = 监听测试结束。**禁止**用 `nohup script &` 把脚本本身甩成脱离的守护进程让“启动命令”秒退——那样框架会在测试刚开始就误判结束、提前回调，agent 被激活时啥都没跑完。
2. **结尾汇总必须流到后台终端 stdout**：脚本内部给每个子进程单独重定向日志即可，脚本自己的汇总 `echo` 不要再被外层 `> log 2>&1` 吃掉。否则回调时 agent 拿到空白，还得再发一条 `cat`，白激活一次。启动时直接 `bash script`，不加外层重定向。
3. **删光 `sleep`，靠框架超时兜底**：`wait` 后不要再 `sleep`；框架级超时保证任何卡死的子进程最多 T 自杀，于是 `wait` 最多 ~T 必返回，脚本不会无限挂、回调不会永不触发。Go 用 `go test -timeout=T`；TS 用 `--test-timeout`（见文末「TS 项目适配」）；其他语言按各自测试框架的超时参数等价替换。

### 拆进程并行（缩短墙钟）

1. `go test -list '.*'` 取测试名清单，切成 N 桶（首次按个数均分；有历史 `-json` 每用例耗时后按耗时贪心加权，让最慢桶尽量小）。TS 无 `-list` 等价：按文件粒度分桶（每文件天然独立子进程），或用 `--test-reporter=json` 跑一次后按 `duration_ms` 回填耗时。
2. 每桶一条 `go test ./pkg -run "^(n1|n2|…)$" -count=1 -timeout=T`，独立子进程并行；每进程有独立全局状态与 tempdir，互不干扰。
3. 每桶结束立即 `echo $? > chunk{i}.done`（完成标记 + 真实退出码，**不要靠 `tail` 被缓冲的日志判断完成**：`go test` 不加 `-v` 时输出整段缓冲到结束才落盘）。
4. 脚本 `wait` 全部子进程后，汇总各 `chunk{i}.done` 退出码 `echo` 到 stdout，并 `exit overall`（退出码也带上成败）。
5. 进程级并行已吃满多核时，不要再给 CPU 密集用例加 `t.Parallel()`，会抢 CPU；纯 IO 等待型例外。

### agent 动作

- 没别的活：后台终端执行 `bash script`（不加外层重定向），**立刻结束当前 turn**，不发 `sleep`、不发轮询、不去 `cat`。框架在命令退出时回调，把 stdout 推回来，agent 在新 turn 直接读结论、判断成败、往下走。
- 有别的活：后台启动后去干活，干完一段调一次非阻塞快照（`test -f ALL_DONE` 秒返进度）；RUNNING 继续干别的，DONE 读结果。
- 判定完成永远只信 done 文件/退出码；要看实时进度再单独 `go test -v` 或 `-json | gotestsum`，两件事分开。
- 任何时候都不要出现 `sleep N` 这种固定盲等。

### 两路流分离：进度流 vs 汇总流（实战观察）

脚本把 `go test -v` 重定向到内部 `full.log` 后，**harness stdout 日志在运行期间是空的**——因为它只承载脚本自己的 `echo`（最后的 `FULL_DONE …`）。人/agent 想 `tail -f` 看实时进度，必须 tail 内部那个 `full.log`，而不是 harness stdout 日志；tail harness stdout 会看到一片空白，误以为没在跑。

- **汇总流**（harness stdout）：只放脚本结尾的 `FULL_DONE exit=… pass=… fail=…`，给退出回调用。
- **进度流**（内部重定向文件）：`go test -v` 流式写入，要看实时进度 `tail -f` 这个文件。
- 判定“跑没跑完”永远只信 done 文件/退出码，**不靠 tail 任一日志**；`tail -f` 只是为了人看进度。

### 后台进程必须脱离交互终端

退出回调范式要求后台任务**脱离用户的交互 shell 进程组**：用户在自己终端里 `Ctrl-C`（哪怕是 `tail -f` 那条命令）不应波及后台测试进程。若后台进程与交互 shell 共享进程组，一次 `Ctrl-C` 会把测试一起带掉，回调提前触发且结果残缺。启动后台任务时用框架提供的后台执行通道（而非 `nohup &` 挂在同一会话），保证它的生命周期只由 `wait`/`-timeout` 决定。

### 反模式与优化（实战教训；「症状」一段为背景细节可删，结论务必保留）

**症状**：6 桶 ×84 用例并行，每桶 `-timeout=1200s`，结果 6 桶全 20m 超时；其中 3 个是真实 FAIL 被超时噪声淹没。根因不是断言，是资源估算错。

- **并行 ≠ 免费加速（CPU 密集套件）**：6 路并行在有限核数下每进程只分到 ~1.3–1.6 核，CPU 密集用例（图像处理、图遍历）被争用拉长 ~4–6 倍。墙钟 ≈ max(桶) × 争用系数，不是 max(桶)。桶数要匹配物理核数，不是越多越好：CPU 密集 ≈ 核数，IO 密集可超分。
- **必须按耗时加权分桶，不能按个数均分**：测试耗时方差极大（慢的分钟级、快的毫秒级），个数均分会让某桶堆到几个慢用例就单跑 >T。第一轮用 `go test -json` 的 `Elapsed` 落 `elapsed.tsv`，后续按贪心装箱让最慢桶尽量小；第一次没数据可退化为个数均分，但拿到结果后**必须回填**。
- **per-chunk 超时是资源约束，不是默认值**：桶超时应按「单跑耗时 × 争用系数 + 余量」估；整包已知 >2400s 时，1200s 的桶超时在并行争用下毫无机会。
- **慢包/慢用例单独成桶**：chroma、workbench 这种独占一桶，快用例合并一桶，避免慢用例分散拖慢所有桶。
- **先区分“真失败”和“超时噪声”**：发现某桶有 `--- FAIL` 立刻单跑该用例确认，不要等整轮跑完再翻日志；超时 dump 里没有 `-v` 时也看不出卡在哪个用例。
- **可选**：给重计算用例加 `testing.Short()` 分支，CI 快车道 `go test -short` 跳过，全量放夜间；`-p`/`-parallel` 只对 IO 等待型用例有收益，CPU 密集别叠加。

---

### TS 项目适配（node:test）

TS/前端项目用 Node 内置 test runner（`node:test` + `node:assert/strict`），零第三方依赖，不引入 vitest/jest。同一套纪律（三条硬约束、done 文件判完成、两路流分离、按耗时加权分桶）照用，只换命令：

| Go | TS（node:test，Node ≥ 22.6） |
|---|---|
| `go test ./pkg` | `node --test "[测试目录]/*.test.ts"`（全量；可封成 npm script，如 `test:all`） |
| `go test -run '^TestX$'` | `node --test --test-name-pattern='^x$'` |
| `go test -v` | `--test-reporter=spec`（默认）/ `tap` |
| `go test -json` | `--test-reporter=json`（含 `duration_ms`，可回填耗时分桶） |
| `go test -timeout=T` | 单测 `test(name, {timeout: ms}, fn)` 或全局 `--test-timeout`（ms） |
| `t.Parallel()` | `test(name, {concurrency: true}, fn)` |
| `go test -p N` | `--test-concurrency=N`（默认核数-1；每文件独立子进程） |
| `-count=1` | 无缓存，天然等价 |
| `testing.Short()` | `--test-skip-pattern` 或环境变量 + `t.skip()` |
| `package xxx_test` 黑盒 | `[测试目录]` 只 import 公开 API；对 `.vue` / `.tsx` 等 UI 源码可做源码契约扫描 |

TS 侧注意事项：

- **目录参数不可用**：`node --test [测试目录]/` 会把目录当文件跑（`MODULE_NOT_FOUND`），必须用 glob：`"[测试目录]/*.test.ts"`。
- **类型剥离**：Node 23.6+ 默认开启，`--experimental-strip-types` 可省；保留可兼容 Node 22.6–23.5。
- **棘轮已兼容**：默认 `sourceGlobs` / `testGlobs` 已覆盖 TS；纯 TS 项目按上文「CONFIG 按项目语言选配」裁剪即可。
- **分桶并行 TS 版**：每桶 `node --test --test-name-pattern='^(n1|n2|…)$' "[测试目录]/*.test.ts"`，其余（done 文件、`wait`、结尾汇总、`--test-reporter=json` 回填耗时）与 Go 版一致。

---

## AI / 数据管线长周期任务执行纪律

> 适用于调用外部供应商、涉及多阶段状态机、或单次 wall-clock 可能超过 30 分钟的任务（AI 图标/模型生成、大数据迁移、批量配置 apply 等）。
> 核心原则：**先 fail-fast 检查环境与契约，再启动长任务；恢复只信权威持久化状态；后台执行方式按“是否还有独立工作”选择；修复后先验证失败 stage，再只跑一次最终门禁。**

### 进入长任务前的 fail-fast 门禁

开工前必须全部通过，任一失败先修环境：

1. **结构棘轮**：`python3 [脚本目录]/arch_ratchet.py`
2. **设计/数据校验**：项目约定的 `make validate-design` 或等效命令
3. **API/工作流冒烟**：项目约定的 art-production / 核心模块 acceptance 脚本
4. **环境变量与凭据**：只检查 `.env.local` 或等价配置中必需项是否存在，不得把凭据值输出到终端或日志
5. **服务与 Provider 健康**：`curl [API]/api/bootstrap` 返回 `ok:true`，付费 Plan 的 Provider readiness 通过

### 长任务执行模式

- 没有其他独立工作可做时：使用**后台终端**启动任务，结束当前 turn，等框架退出回调再继续。
- 有其他独立工作可做时：后台启动后继续处理这些工作，只做非阻塞进度快照；不要为了等待任务而占住 turn。
- 脚本必须 `wait` 所有子进程，结尾把汇总 `echo` 到 stdout；禁止 `nohup script &` 让启动命令秒退。
- 脚本内部把详细进度重定向到内部日志文件；要看实时进度 `tail -f` 内部日志，不要 tail harness stdout。
- 禁止前台 `sleep`、盲等和无界轮询。测试用框架/语言级超时兜底（如 `go test -timeout=T`）；外部供应商 Task polling 必须使用有总超时、最大间隔和限流上限的退避策略，不能忙轮询。

### 失败后的最小 rerun 原则

- 第一次失败后，**读日志定位到具体 stage**，不要直接 `make verify` 重跑全量。
- 修复后先 rerun 失败的 stage 一次（如单独的 acceptance、audit 或本地后处理）；只有存在明确 flaky 证据时才重复。
- 失败 stage 通过后，进入一次最终全量门禁；不要在此前手工重跑一套与最终门禁重复的完整测试链。
- 全量门禁失败时记录失败 stage、根因、修复位置和实际耗时。单次运行记录进入本次长任务日志或复盘；只有重复出现的架构债、已知 bug 或失效证据才登记到 `CODE_HANDOVER.md`。

### 状态持久化与可恢复

- 多 batch / 多阶段任务必须有权威持久化状态（数据库、Studio Plan/Claim/Task/Artifact、迁移日志或等价机制）。`.tmp` checkpoint 只缓存 ID 和观察进度，丢失或漂移时不得据此推断“未提交”。
- `--resume` 必须先从权威存储重载并核对 Plan、Claim、Attempt/Task、Artifact、版本和 CAS；已完成步骤幂等复用，`ambiguous`、`needs_reconcile` 或远端状态未知时停止新提交并对账。
- 单点重跑必须创建合法的后继 Plan/版本并保留旧证据；不得修改冻结记录、复用旧付费授权或绕过审核/采用门禁。

### 技术预检与权威验收

- 涉及供应商产物（图片、模型、音视频）的本地校验，必须先把 `storageKey` 解析到受控的本地资产根，**禁止**把 `storageKey` 当 URL 直接 fetch。
- 本地尺寸、格式、alpha 或结构检查只是技术预检，不能证明产物不是占位内容，也不能替代 Provider 血缘、签名 QA、审核、采用一致性和人工视觉/功能验收。

### 数据编辑后的派生产物同步

只同步本任务实际修改源头的派生产物；不得为了让全量门禁变绿而顺手改写其他人的并行变更。

- 具体“源文件 → 派生命令”映射由项目 SOP 定义，不在通用纪律中硬编码。
- 跨模块索引只在依赖它的批处理结束后重建，不在供应商生成过程中抢占服务资源。
- 验收脚本断言变更必须有相应契约/实现依据，不能只为匹配当前输出而改断言。

### 时间盒与复盘

| 检查点 | 建议时间盒 | 超时处理 |
|---|---|---|
| fail-fast 门禁 | 5–10 min | 停止，修环境 |
| 第一个付费/供应商 batch 完成 | +15–20 min | 检查凭据、workflow、postprocess spec |
| 全部 batch 完成 | 按目标数量估算 | 记录卡住 batch，单点重跑 |
| 本地校验通过 | +10 min | 失败项单点重跑 |
| 分层 verify 完成 | +20 min | 只 rerun 失败层 |
| 最终全量门禁通过 | 按历史实测估算 | 仍失败则记录并停止，不无限循环 |

### 与 AGENTS.md 的衔接

项目根目录 `AGENTS.md` 的对应规则应引用本节；项目 SOP 给出本项目具体的：
- fail-fast 命令清单
- 权威状态与恢复入口
- 合法的最小后继/重跑单元
- 派生命令清单
- 复盘文件位置

---

## 长任务定义与事后汇报纪律

> **长任务**：任何预计 wall-clock 超过 **30 分钟**，或执行中实际达到 **30 分钟** 的任务。包括但不限于：
> - 全量测试/verify（如 `make verify`、race 套件）
> - AI 图片/模型批量生成
> - 大数据迁移、索引重建、批量配置 apply
> - 长时间编译、构建、导出
> - 任何被用户明确标注为「长任务」的工作

### 事前：启动长任务时必须记录

预计会超过 30 分钟时，在发起第一条长命令前口头声明并记录；若任务事前估短但执行中达到 30 分钟，在发现时立即补发“长任务升级”记录并切换执行方式：

```text
【长任务启动】{任务名}
- 预计类型：{测试/生成/迁移/构建/其他}
- 启动时间：{YYYY-MM-DD HH:MM}
- 判定为长任务的理由：{如 68 个图标 8 个 batch / make verify 历史耗时 >20min / 用户指定}
- 失败后 rerun 的最小 stage：{具体命令或脚本}
```

如果无法精确预计，按历史同类任务耗时或目标数量推断；提前完成不需要“取消”记录，事后按实际耗时汇报即可。

### 事中：后台执行 + 结束 turn

- 所有长任务必须走**后台终端**或产品提供的等价异步执行机制（见上文「长测试执行规范」）。
- 没有其他独立工作时结束当前 turn 等回调；有独立工作时可以穿插，只做非阻塞快照。禁止前台阻塞、盲目 `sleep` 或频繁 `tail` harness stdout。
- 收到退出回调后先核对并汇报长任务状态，再继续依赖其结果的工作。

### 事后：必须输出统一格式汇报

长任务完成（成功、失败或被用户中断）后，Agent 必须输出一次**结构化汇报**，不能只用一句话带过。模板如下：

```markdown
## 长任务汇报：{任务名}

| 字段 | 内容 |
|---|---|
| 任务 ID / 命令 | {后台命令、现有 Task ID 或受审脚本名，如 `make verify` / `ArtTask_...`} |
| 状态 | {成功 / 失败 / 被中断 / 部分完成} |
| 启动时间 | {YYYY-MM-DD HH:MM} |
| 完成时间 | {YYYY-MM-DD HH:MM} |
| 实际耗时 | {约 X 小时 Y 分钟} |
| 是否命中超时/工具限制 | {是 / 否；若命中，说明如何处理} |

### 1. 任务目标
{用一句话说明本次长任务要达成什么}

### 2. 时间占用分解（估算）
| 阶段 | 时长 | 说明 |
|---|---|---|
| 后台进程运行 | X min | {AI 生成 / 测试执行 / 编译等；可与其他阶段重叠} |
| 可观测的诊断与修复 | X min | {读日志、定位失败、改数据/脚本/代码} |
| Agent 工具操作 | X min | {命令、检查、编辑；仅按可观测时间估算} |
| 用户/外部环境阻塞 | X min | {等待授权、用户操作、服务或供应商恢复等} |
| 无法可靠归因 | X min / 未知 | {没有可靠证据时明确写未知，不推测“思考时间”} |

### 3. 高频动作
{列出本次任务中重复最多的 3–5 个动作，如：读日志 tail、grep 定位、跑 `make verify`、改验收脚本}

### 4. 关键结果
- {成功：产出了什么、校验是否通过}
- {失败：失败在哪个 stage、错误信息是什么}
- {变更了哪些文件}

### 5. 阻塞与根因
| 问题 | 根因 | 修复位置 |
|---|---|---|
| {问题 1} | {根因} | {文件/命令} |
| {问题 2} | {根因} | {文件/命令} |

### 6. 后续行动
- {必须做的下一步，如：单点重跑失败图标 / 提交代码 / 补文档}
- {遗留风险或待确认项}
```

### 汇报纪律的红线

1. **不允许省略**：任何超过 30 分钟的任务，完成后必须按模板输出汇报，不能因为「任务很简单」或「用户没要求」而跳过。
2. **时间必须诚实**：没有精确计时器时，用日志 mtime、命令输出时间戳或后台任务通知时间推算，标注「约」和估算依据。禁止编造精确到秒的耗时。
3. **失败必须暴露**：任务失败时，汇报里必须包含失败 stage、错误原文、已尝试的修复、下一步最小 rerun 命令。
4. **变更必须可追溯**：小范围变更逐文件列出；大批量数据变更列出目录、数量和机器可读 manifest / `git diff --name-only` 证据，不在自然语言中手抄数百个路径。
5. **与 CODE_HANDOVER / 复盘衔接**：如果任务涉及架构债、已知 bug、验收脚本陈旧等重复出现的问题，必须同步在 `CODE_HANDOVER.md` 或项目约定的复盘位置登记。
