# Candela

**English** | [中文](README.zh-CN.md)

[CDD methodology](CDD-methodology.md) · [宪章驱动开发](CDD-methodology.zh-CN.md)

> **Fully AI-written (vibe coding):** this project is **100% written by AI**. No human hand-wrote the application code. People set goals, accept the result, and make the calls. Several vendors' models took turns on the same repository, kept in line by the rules and architecture constraints in [`AGENTS.md`](AGENTS.md). See [Fully AI-written](#fully-ai-written-vibe-coding) below.

**An open-source, self-hosted user-behavior analytics platform.** It runs alongside ClkLog Community Edition and turns raw events into measurements you can query, follow up, and alert on.

Open this repository in an AI agent (Cursor, Codex, ZCode, and the like). The rules in the repo are enough for the agent to know how the project is built.

> Candela is the SI unit of luminous intensity: we turn user behavior into numbers you can measure. The project was renamed from `clklog_manager` to Candela on 2026-10-10. See [Names and boundaries](#names-and-boundaries).

On top of ClkLog Community Edition (collection and basic reports), Candela adds a full analytics platform as a sidecar: event analysis, funnels, retention, cohorts and tags, dashboards, custom SQL and charts, metrics and alerts, project-level RBAC, a multilingual UI, and an AI analysis assistant. The analytics domain uses its own databases (MySQL `clklog_sa_meta` and ClickHouse `clklog_sa`). **It does not modify the community images and does not ALTER community tables**, so an official ClkLog upgrade still applies.

- License: AGPL-3.0 ([`LICENSE`](LICENSE)). Upstream attribution: [`NOTICE`](NOTICE)
- **Handoff:** [`docs/project/handoff-candela-new-repo.md`](docs/project/handoff-candela-new-repo.md) (where the repo came from, the target machine, open work, and known pitfalls)
- Status and design snapshot: [`docs/project/project-status.md`](docs/project/project-status.md)
- File index: [`INDEX.md`](INDEX.md)

---

## Contents

- [Fully AI-written](#fully-ai-written-vibe-coding)
  - [AGENTS.md](#agentsmd-the-layer-that-keeps-multi-model-work-controllable)
- [Capabilities](#capabilities)
- [Architecture](#architecture)
- [Deploy](#deploy)
  - [Prerequisites](#prerequisites)
  - [Step 1: Deploy middleware](#step-1-deploy-middleware)
  - [Step 2: Deploy ClkLog Community](#step-2-deploy-clklog-community)
  - [Step 3: Deploy the analytics platform](#step-3-deploy-the-analytics-platform-two-ways)
  - [Access and verification](#access-and-verification)
  - [Day-to-day operations](#day-to-day-operations)
- [Configuration and secrets](#configuration-and-secrets)
- [Local development](#local-development)
- [Repository layout](#repository-layout)
- [Documentation](#documentation)
- [Names and boundaries](#names-and-boundaries)
- [License and upstream attribution](#license-and-upstream-attribution)

---

## Fully AI-written (vibe coding)

> **This project is 100% written by AI.** No human hand-wrote the application code. People set goals, accept the result, and make the calls.

Models from different vendors, with different strengths, took turns on the same repository. Rough share of the work:

| Model | Client | Share |
|---|---|---|
| DeepSeek V4.0 / V4.1-Flash | ZCode | ~80% |
| Grok 4.5 | Cursor | ~12% |
| GLM 5.3-Flash | ZCode | ~5% |
| GPT-5.6 Sol | Codex | ~3% |

Models change, sessions break, and a single reply varies in quality. The repository stays consistent because of a **model-independent layer of rules and architecture**, not because one model is strong enough. Whichever vendor or version shows up, the same constraints pull the result toward the same acceptance bar. That layer starts at [`AGENTS.md`](AGENTS.md).

A strong model is an accelerator, not a requirement. DeepSeek alone was enough to build the system.

> The aim is to turn a technical problem into an engineering problem. The difficulty stays. The guarantee moves from "this model is strong enough" to "the rules and the checks." That is why this project uses CDD.

### AGENTS.md: the layer that keeps multi-model work controllable

[`AGENTS.md`](AGENTS.md) is the **agent working rules for this repository (the single source of truth)**. It does not depend on model memory or on the previous chat. Each session reloads the rules from the file.

**Those rules are not a loose list of tips. They are a method: CDD (Charter-Driven Development). The full argument is in [`CDD-methodology.md`](CDD-methodology.md).** In Candela, `AGENTS.md` is the charter. It fixes role boundaries, architecture red lines, design-before-code, and acceptance as standing rules, so control comes from the rules rather than from whichever model is in the seat. A handoff between vendors still converges on the same acceptance bar, and each incident or decision can be written back as a new constraint. That is a necessary condition for this project to keep shipping.

It does five things:

| Mechanism | What it does | Why it matters when models take turns |
|---|---|---|
| **Hats (roles)** | Each hat has one working directory (`docs/architecture/`, `docs/product/`, `docs/project/`, `apps/` + `scripts/`, `deploy-assets/`) and one question. Wear one hat at a time | "Where to write" and "which question to answer" become objective. The model does not edit the wrong place |
| **Implementation gate** | Before code changes, `docs/product/` and `docs/architecture/` must already contain **real files in the repo**, each with a `phase` id, scope, acceptance criteria, and non-goals. Missing any of these means the gate is not passed | Design first. No inventing the plan while coding. Ideas and implementation stay separate |
| **Hard red lines** | Seven boundaries that are not optional: do not invade ClkLog Community, do not break the data path, do not commit secrets, bound every ClickHouse query, keep directory owners correct, do not silently delete data, deploy truth lives in the scripts | The boundary does not depend on model skill. No model may cross it on its own |
| **Machine-checked gates** | Structure ratchet (`arch_ratchet.py`), two i18n checks (`i18n_check.py` / `i18n_scan.py`), and the acceptance scripts (end-to-end ingest, 12 and 19 checks) | Quality is a process exit code. The model cannot declare itself done |
| **Document and evidence discipline** | Each layer has one job (README / AGENTS / INDEX / `docs/` / code). Contract changes update the contract docs. Delivery includes evidence. Read the index, not the whole tree | A new model relocates from the index and the sources of truth, not from a huge chat context |

In one line: **CDD turns "a person reviews the model's output" into "the model proves itself against the rules."** The rules are searchable, the gates run, and acceptance can be rechecked, so swapping models does not lower the floor. **Without the charter, multi-model handoffs fall back to realigning every time, leaning on a huge context, and letting quality follow the model and luck. Because governance lives in the repo, fully AI-written work can be repeated, handed off, and kept alive.** Method and rationale: [`CDD-methodology.md`](CDD-methodology.md). Companions: the file index [`INDEX.md`](INDEX.md), the code hard gates [`docs/architecture/code-hard-gates.md`](docs/architecture/code-hard-gates.md), and the architecture ratchet baseline [`docs/architecture/arch-ratchet-baseline.md`](docs/architecture/arch-ratchet-baseline.md).

---

## Capabilities

| Area | What you get |
|---|---|
| Tracking catalog | Meta events and properties, virtual events, virtual properties, event notes, discovery log |
| Analysis | Event analysis (multiple metrics, filters, breakdowns, formulas, approximate calculation), funnels (2–32 steps, window, conversion and drop-off), retention (cohort, day N, trend), user timelines |
| Users | Cohorts (conditions / CSV / SQL / result snapshot), user tags, analysis subjects |
| Dashboards and reports | Dashboard studio (grid drag and resize), card cache and background warm-up, custom SQL reports (data dictionary + builder), charts (line / bar / pie / donut / metric / funnel), metrics v1–v3 |
| Data management | Dimension tables (CSV upload, versioned snapshots, cross-table joins), partition cleanup and TTL, log-directory governance, consistency reconciliation |
| Operations and alerts | Ops console (slow SQL, host status, disk forecast), alert rules (Feishu / email / SMS, templates, health, delivery retry, mute) |
| Access control | Three global roles plus five project roles, member groups, data-permission injection, dashboard folders, asset locks |
| AI | AI analysis assistant (Harness runtime, multiple model providers, Workspace template sync) — **off by default**, see [Configuration and secrets](#configuration-and-secrets) |
| Internationalization | 13 languages (zh-CN / zh-TW / en-US / ja / ko / ru / fr / de / es / pt / vi / th / id). CI checks key-set consistency and a hardcoded-text ratchet |

---

## Architecture

```
        Browser                       SDK (Web / App / mini program)
          │                                    │
          └──────────────►  Host nginx :80 ◄─────┘
                              │
        ┌─────────────────────┼──────────────────────────┐
        │                     │                          │
  Analytics /sa/         Community /               Ingest /receiver/
        │                     │                          │
   ┌────┴─────┐        ┌──────┴───────┐          ┌───────┴────────┐
   │ Web      │        │ UI / API /   │          │   receiver     │
   │ static   │        │ Manage       │          └───────┬────────┘
   └──────────┘        └──────┬───────┘                  │
        │              ┌──────┴───────┐        Kafka topic clklog
   ┌────┴──────────┐   │ MySQL clklog │                  │
   │ analytics-    │   │ Redis        │          ┌───────┴────────┐
   │ server :3100  │   └──────────────┘          │  Flink job     │
   ├───────────────┤                             └───────┬────────┘
   │ ingestor      │                                     │
   │ (Kafka)       │                            ClickHouse clklog
   └───────┬────────┘                                     │
           │                                              │
   ClickHouse clklog_sa ◄── sidecar write ◄──────────────┘ (read-only)
   MySQL clklog_sa_meta (platform metadata)
```

| Component | Role | Port (default) |
|---|---|---|
| Host nginx | Single entry, path-based routing (no domain; reach it by IP) | `80` |
| MySQL 8 | Community database `clklog` plus platform metadata `clklog_sa_meta` | `127.0.0.1:3306` |
| Redis 7 | Community cache plus platform query cache and sessions (key-prefix isolation) | `127.0.0.1:6379` |
| Kafka 3.7 (KRaft) | Ingest messages, topic `clklog` (6 partitions) | `127.0.0.1:19092` |
| ClickHouse 23.2 | Community database `clklog` plus platform database `clklog_sa` (writer `default`, reader `sa_readonly`) | `8123` / `9000` |
| Community apps | `clklog-ui` / `receiver` / `api` / `manage` / `init` plus Flink `jobmanager` / `taskmanager` | 127.0.0.1:8081–8085 |
| Analytics platform | `analytics-server` (HTTP) / `analytics-ingestor` (Kafka consumer) / web static files | `127.0.0.1:3100` (native) / `:3100` + `:8086` (containers) |

---

## Deploy

Deploy the three layers in order: **middleware → ClkLog Community → analytics platform**. Every script is **idempotent and safe to re-run**. There is no CI/CD requirement: the workstation rsyncs the source to the target, and the target builds it.

> Verified end to end on **AlmaLinux 9.6 / 4 cores / 15 GiB RAM / 92 GB disk**: middleware and community 12/12, native analytics 18/18, container analytics 19/19. Re-running either analytics path produced zero drift.
> Scripts live in `scripts/standalone-test-env/`. Design: [`docs/architecture/standalone-test-env-design.md`](docs/architecture/standalone-test-env-design.md) and [`docs/architecture/candela-deploy-two-paths.md`](docs/architecture/candela-deploy-two-paths.md). Evidence: `docs/project/deployment-record-*.md`.

### Prerequisites

| Item | Requirement |
|---|---|
| Target | AlmaLinux 9 (RHEL 9 family is the same), root login, inbound `80` open (optional `8123` if clients should reach ClickHouse directly) |
| Workstation | SSH to the target with key auth already set up (the scripts `ssh` and `rsync` the source, then run remotely) |
| Software | The scripts install Docker and nginx. The native path also needs EPEL (the script configures it; the machine must be able to reach an EPEL mirror) |
| Network | Must be able to pull images. Base images come from `public.ecr.aws/docker/library/*`. ClkLog images come from `registry.cn-shanghai.aliyuncs.com/clklog/*` |
| Capacity | At least 4 cores and 16 GiB is the recommendation (15 GiB has been shown to work). Memory caps are set explicitly for a small machine |
| Disk | At least 40 GB (images are about 2 GB; the rest is ClickHouse data and logs) |

Two deploy roots (override with environment variables):

- `<MW_BASE_DIR>` = `/data/clklog-oss-test` — middleware and community (data, config, secrets, scripts)
- `<BASE_DIR>` = `/data/app/candela` — analytics platform (releases, config, secrets, image recipes)

> On a machine outside China, or behind a proxy, override `APT_MIRROR=` (empty uses the image's own Debian mirrors), `NPM_REGISTRY=https://registry.npmjs.org`, `NODE_IMAGE=`, and `NGINX_IMAGE=`.
>
> ClkLog Community images are pulled from `registry.cn-shanghai.aliyuncs.com/clklog/*` by default. If that registry is unreachable, use a proxy, or mirror the images and change `CK_REG` in the deploy scripts. Official base images come from `public.ecr.aws/docker/library/*`.

---

### Step 1: Deploy middleware

MySQL, Redis, Kafka (KRaft), and ClickHouse, all in containers. Data lands in `<MW_BASE_DIR>/data/`. The script generates random passwords (32 hex characters) and writes them only on the target, in `<MW_BASE_DIR>/config/deploy.env` (mode 0600). It also creates the shared network `clklog-net` and the topic `clklog`.

The script does not pick a machine for you. Pass the SSH target every time:

```bash
# From the workstation, at the repository root
export HOST=user@your-server
bash scripts/standalone-test-env/deploy-remote.sh mw
```

To use another directory:

```bash
HOST=user@your-server MW_BASE_DIR=/data/mw bash scripts/standalone-test-env/deploy-remote.sh mw
```

When it finishes: 4 containers healthy, community MySQL schema in place, Kafka topic ready. Container names and ports are in the [Architecture](#architecture) table.

---

### Step 2: Deploy ClkLog Community

Deploys Community 1.3.0 in **standard mode** (`receiver → Kafka → Flink → ClickHouse`) and adds a single-host nginx entry (path routing, no domain).

```bash
HOST=user@your-server bash scripts/standalone-test-env/deploy-remote.sh clklog
```

> **Standard mode is required.** The analytics platform reads the same Kafka topic and the same ClickHouse database. Quick mode (receiver writes ClickHouse directly and skips Kafka) gives the platform nothing to consume.

---

### Step 3: Deploy the analytics platform (two ways)

Both paths **share the database init scripts, config rendering, and secret contract**. They differ only in how the process is started: native runs on the host, containers run in Docker. They are **mutually exclusive** (both bind `:3100` and the `/sa/` route). Switching stops the other path automatically.

#### Path A: native (host Node + supervisord)

Versioned releases (`releases/<timestamp>` plus `current` / `previous` symlinks, so switch and rollback are atomic). Supervisord runs `analytics-server` and `analytics-ingestor`. Host nginx serves the web build.

```bash
HOST=user@your-server bash scripts/standalone-test-env/candela/deploy-remote.sh native
```

Flow: install Node 24.20.0 (SHA256 checked) → install supervisord (EPEL) → build server and web (Prisma Client is generated **at build time**, so startup does not need the npm registry) → assemble the release (including precompressed gzip) → atomic switch → initialize databases → write supervisor programs → configure nginx → readiness check.

#### Path B: Docker Compose

Three images (`analytics-server`, `analytics-web`, and a one-shot `manager-migrate`). Stack name `candela`, joined to the middleware network `clklog-net` (containers address `mysql`, `redis`, `kafka`, and `clickhouse` by service name).

```bash
HOST=user@your-server bash scripts/standalone-test-env/candela/deploy-remote.sh docker
```

Images are tagged by content hash. Unchanged source and Dockerfiles reuse the existing image (a re-run does nothing). Rollback means setting `DOCKER_*_TAG` in `<BASE_DIR>/configs/candela.env` back to the previous tag, then running `docker --skip-build`.

#### Database initialization (shared, runs automatically)

No manual SQL:

- **MySQL:** creates `clklog` (community) and `clklog_sa_meta` (platform metadata); creates the least-privilege account `clklog_sa_app` (granted only on the metadata database; the app does not use root); builds metadata tables from `prisma/schema.prisma` as a **baseline**, records migration history, then **replays the idempotent seeds** inside the migrations (built-in alert rules, log-governance allowlist, retention policy, project row); finally creates the superuser `admin`.
- **ClickHouse:** creates `clklog_sa` and 4 core tables (`sa_events`, `sa_user_profiles`, `sa_cohort_members`, `sa_tag_members`), skip indexes, and the cleanup infrastructure (`clklog_sa_bak`, `clklog_sa_staging`, `sa_cleanup`); writes the read-only account `sa_readonly` (`readonly=2` profile plus embedded grants, `SELECT` only on `clklog_sa.*` and `clklog.*`, separate from the writer).
- Either script can be run alone: `init-db-mysql.sh --runner host|docker` and `init-db-clickhouse.sh --runner host|docker` (under `scripts/standalone-test-env/candela/`).

> If the metadata database already has a **usable** migration history, the path is incremental `prisma migrate deploy`. A baseline rebuild (which empties the metadata database and says so) runs only when there is no history, or the history contains a failed record. See [`docs/architecture/candela-deploy-two-paths.md`](docs/architecture/candela-deploy-two-paths.md) §3 and §5.

---

### Access and verification

| Entry | URL | Account |
|---|---|---|
| Analytics platform | `http://<target-ip>/sa/` | `admin` / `ADMIN_INIT_PASSWORD` in `<BASE_DIR>/configs/candela.env` on the target (generated at deploy time) |
| ClkLog Community | `http://<target-ip>/` | `admin` / `clklog` (community seed account; change it after login) |

One-shot verification. The script detects whether the current install is native or containers:

```bash
HOST=user@your-server bash scripts/standalone-test-env/candela/deploy-remote.sh verify   # analytics (18 checks; +3 when AI Harness is installed)
HOST=user@your-server bash scripts/standalone-test-env/deploy-remote.sh verify           # middleware + community (12 checks)
```

Coverage: process or container state, HTTP entry, MySQL tables and the superuser, ClickHouse tables and a proof that `sa_readonly` cannot write, Kafka consumer-group lag, the **end-to-end ingest path** (report through the receiver, then both community `log_analysis` and platform `sa_events` row counts increase), and the platform login API. A machine with the Harness runtime also checks the broker process, the socket health probe, and that the switch matches.

### Day-to-day operations

```bash
export HOST=user@your-server
M=scripts/standalone-test-env/candela/deploy-remote.sh

bash $M push            # push the latest source and scripts, do not deploy
bash $M native          # redeploy (idempotent: unchanged content reuses the release and skips the restart)
bash $M docker          # same, container path

# Rollback
#   Native: point current back at the previous symlink, then restart supervisor (the script prints the exact command)
#   Containers: restore the previous DOCKER_*_TAG, then bash $M docker --skip-build

bash $M wipe            # drop databases only (dry-run by default; prints what would be deleted)
bash $M wipe --yes      # actually drop them, then recreate environment resources (Kafka topic, community ClickHouse tables)

# Wipe the whole install (containers, images, volumes, data dirs, config, Node) back to "infrastructure only":
HOST=user@your-server bash scripts/standalone-test-env/deploy-remote.sh teardown        # dry-run
HOST=user@your-server bash scripts/standalone-test-env/deploy-remote.sh teardown --yes  # real delete; secret files go with it, and the next deploy generates new passwords

# Troubleshooting
supervisorctl status candela_server candela_ingestor   # native
docker compose -f /data/app/candela/docker/docker-compose.yml ps  # containers
docker logs -f candela-server
tail -f /data/logs/production/candela/analytics-server.log
```

---

## Configuration and secrets

- **Secrets stay off the repo and out of logs.** Deploy scripts generate every random password and write it only on the target, in `<BASE_DIR>/configs/candela.env` (mode 0600). Middleware passwords live in `<MW_BASE_DIR>/config/deploy.env`. Do not commit either file, and do not send them out.
- **Where config comes from.** The running platform config is `<BASE_DIR>/configs/config.yaml`, **rendered** by the deploy script from `apps/analytics-server/config_server.yaml`. The render changes only deploy-time values (database, Redis, and Kafka addresses, and the Harness switch), and **each substitution asserts how many times it must match**. If the repo config changes shape, the script fails instead of silently mismatching. Do not hand-edit `config.yaml` on the target (the next deploy overwrites it; change the source file in the repo).
- The app reads that YAML through `APP_CONFIG_PATH`. `${VAR}` placeholders are filled from the env file.
- **The AI assistant is off by default** (`deepseek_harness.enabled: false`). Turning it on needs the Harness runtime (rootless podman plus a broker) and a model-provider key (added in the product under Settings → AI Workspace → model providers; the key is stored as AES-256-GCM ciphertext). Read [`docs/architecture/clklog-ai-workspace-design.md`](docs/architecture/clklog-ai-workspace-design.md) first. On a test machine: `bash <BASE_DIR>/ops/candela/install-harness.sh` (idempotent; writes the `configs/harness.enabled` marker), then redeploy once (`HARNESS_ENABLED=1 bash deploy-native.sh --skip-build`) so the switch settles on `true`. Design and acceptance: [`docs/architecture/standalone-test-env-harness-design.md`](docs/architecture/standalone-test-env-harness-design.md).
- **Read-only isolation.** Custom SQL and AI queries use `sa_readonly` (config key `READONLY_CH_PASSWORD`). The writer account `default` is only for the platform's own sidecar writes.

---

## Local development

Start the web app (Vite, `base=/sa/`) and the server (NestJS + Prisma) separately.

```bash
# Server (Node 24, plus a reachable MySQL, ClickHouse, Redis, and Kafka)
cd apps/analytics-server
npm ci
npx prisma generate
npm run start:dev            # HTTP :3100
npm run start:ingestor:dev   # Kafka consumer (its own process)

# Web
cd apps/analytics-web
npm ci
npm run dev                  # Vite :8180, proxies /sa/api to :3100

# Tests and gates (CI runs the same checks)
cd apps/analytics-server && npm test
cd apps/analytics-web && npx vitest run
python3 scripts/i18n_check.py && python3 scripts/i18n_scan.py --check
python3 scripts/arch_ratchet.py          # structure ratchet (may only shrink)
```

For local data, stand up middleware on your own machine with `scripts/standalone-test-env/` (see [Deploy](#deploy); `HOST` is required). Public checks: [`.github/workflows/ci.yml`](.github/workflows/ci.yml). To build on GitLab and rsync the artifacts, copy [`scripts/gitlab-ci.yml.template`](scripts/gitlab-ci.yml.template) to `.gitlab-ci.yml` at the repo root, then fill in your own runner tags and hosts.

---

## Repository layout

```
apps/
  analytics-server/         NestJS server: HTTP API + Kafka ingestor + Prisma + ClickHouse access
  analytics-web/            React + Vite web app (13 languages)
  analytics-harness-broker/ AI Harness runtime manager (optional)
  analytics-harness-host/   In-container AI runtime host (optional)
scripts/
  standalone-test-env/      Deploy scripts: middleware + community
    candela/                Deploy scripts: analytics (native and container paths, database init, wipe, verify)
  build.sh and others       CI build and operations scripts
deploy-assets/
  clklog-community/         Config assets copied from the official ClkLog deploy package
                            (init SQL, ui config.js, dictionaries)
                            — the data source for both community and analytics deploy scripts
docs/
  product/                  PRDs (product hat)
  architecture/             Implementation plans and contracts (architecture hat)
  project/                  Schedule, acceptance records, retrospectives (project hat)
examples/report-sdk/        Ingest SDK examples (several languages)
```

---

## Documentation

| If you want | Read |
|---|---|
| Development method (Charter-Driven Development / CDD) | [`CDD-methodology.md`](CDD-methodology.md) · [中文](CDD-methodology.zh-CN.md) |
| This README in Chinese | [`README.zh-CN.md`](README.zh-CN.md) |
| Status and milestones | [`docs/project/project-status.md`](docs/project/project-status.md) |
| File index (task → file) | [`INDEX.md`](INDEX.md) |
| Deploy-script design | [`docs/architecture/standalone-test-env-design.md`](docs/architecture/standalone-test-env-design.md), [`docs/architecture/candela-deploy-two-paths.md`](docs/architecture/candela-deploy-two-paths.md) |
| Deploy evidence | [`docs/project/deployment-record-standalone-test-env.md`](docs/project/deployment-record-standalone-test-env.md), [`docs/project/deployment-record-candela-two-paths.md`](docs/project/deployment-record-candela-two-paths.md) |
| Containers / Kubernetes / Helm feasibility | [`docs/architecture/containerization-feasibility.md`](docs/architecture/containerization-feasibility.md) |
| Overall analytics plan and contracts | [`docs/architecture/analytics-extension-plan.md`](docs/architecture/analytics-extension-plan.md), [`docs/architecture/clklog-analytics-design.md`](docs/architecture/clklog-analytics-design.md) |
| Contributing / security reports | [`CONTRIBUTING.md`](CONTRIBUTING.md), [`SECURITY.md`](SECURITY.md) |
| Old production runbook | Withdrawn. [`docs/project/legacy-production-handover.md`](docs/project/legacy-production-handover.md) only explains why |
| Internationalization (glossary / adding a language) | [`docs/architecture/i18n-glossary.md`](docs/architecture/i18n-glossary.md) |
| Ingest protocol and SDKs | [`docs/architecture/reporting-protocol.md`](docs/architecture/reporting-protocol.md), [`examples/report-sdk/`](examples/report-sdk/) |

---

## Names and boundaries

| Name | Means | Notes |
|---|---|---|
| **Candela** | **This project / the analytics platform** | The repository, images (`candela-server`, `candela-web`, `candela-migrate`), containers (`candela-server` and the rest), the compose stack (`candela`), the deploy directory (`/data/app/candela`), supervisor programs (`candela_server`, `candela_ingestor`), and the product brand (title, wordmark, email signature) |
| **ClkLog** | **The upstream community edition** (collection and basic reports) | Official images, community containers (`clklog-receiver`, `clklog-api`, `clklog-manage`, `clklog-ui`, `clklog-init`, Flink), community databases (MySQL `clklog`, ClickHouse `clklog`), and the ingest protocol and SDK (`ClkLogClient`, `CLKLOG_ENDPOINT`, `CLKLOG_TOKEN`, `CLKLOG_PROJECT`). **These names stay as they are.** They point at the upstream protocol and components; renaming them would break the examples in the integration docs |
| `sa` **technical identifiers** | Historical internal identifiers | The path `/sa/`, the API prefix `sa/api`, database names `clklog_sa` and `clklog_sa_meta`, the read-only account `sa_readonly`, environment variables `CLKLOG_*`, and `clklog_sa.` plus `sa_in_cohort()` inside saved SQL. They are fixed in nginx routes, the web build base, the Prisma datasource, ClickHouse DDL, and analysis configs users have already saved. **Moving them is expensive and would break old links and old cards**, so that rename is its own phase (keep the old path working, then switch). It is out of scope for the brand rename |

**Why the name does not include ClkLog.** This project is a sidecar and a private-deploy layout on top of ClkLog Community. Putting the upstream name in the brand makes it easy to mistake the project for an official ClkLog product, and it crosses the upstream trademark line. The brand stands alone. README and `NOTICE` are where we say it is built on ClkLog Community Edition.

---

## License and upstream attribution

This project is released under the **GNU Affero General Public License v3.0** (AGPL-3.0, SPDX: `AGPL-3.0-only`). The full text is [`LICENSE`](LICENSE). Copyright is held by the natural person huzhengkun. Model-assisted writing does not change that license.

**Upstream.** This project is a sidecar and a private-deploy layout for [ClkLog](https://www.clklog.com/) Community Edition (AGPL-3.0). The repository contains configuration files copied or adapted from the official deploy package. Upstream components, images, and the per-file change list are in [`NOTICE`](NOTICE). This project **does not modify community images or table definitions**. The analytics domain lives entirely in its own databases (`clklog_sa` and `clklog_sa_meta`).

**Network use.** AGPL-3.0 §13 requires that if you offer this software as a network service, you give those users a way to obtain the corresponding source. Anyone who runs this project as a service is responsible for that obligation.
