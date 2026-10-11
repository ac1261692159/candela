#!/usr/bin/env bash
# build.sh — ClkLog 分析平台 CI 构建脚本
#
# 构建 apps/analytics-server（NestJS 后端）与 apps/analytics-web（React + Vite 前端），
# 将构建产物收集到 ./target/ 目录。
# 公开检查见 .github/workflows/ci.yml。
# 若要在 GitLab 上 rsync 推送，使用 scripts/gitlab-ci.yml.template（复制为根目录 .gitlab-ci.yml 后再填主机）。
#
# 产物结构（CI 推送 ./target/* 与 ./target/.version）：
#   target/
#     .version            # 版本号（由 CI 写入 CI_PIPELINE_ID，此处若缺失则写 build 时间戳）
#     server/             # 主程序部署目录（HTTP 服务，可独立更新/回滚，不影响 ingestor）
#       run.sh            # HTTP 主服务启动脚本（由 scripts/server-run.sh 复制而来）
#       env.example       # 环境变量模板（cp 为 .env 填真实密钥，不入库）
#       configs/config.yaml   # 服务器端配置（源自 config_server.yaml）
#       dist/src/         # 编译产物（仅 dist/src，不含 test/ 等）
#       prisma/           # schema 与迁移（服务器启动脚本 run.sh 会据此 prisma generate 同步 client）
#       package.json / package-lock.json   # 服务器端 npm ci --production 用
#     ingestor/           # ingestor 部署目录（Kafka 消费者，独立部署单元，不随主程序更新）
#       run_ingestor.sh   # ingestor 启动脚本（由 scripts/run_ingestor.sh 复制而来）
#       env.example / configs/ / dist/src/ / prisma/ / package*.json   # 同 server/
#     web/                # 前端产物（vite base=/sa/，产物带 /sa/ 层级，nginx root web 即可命中）
#       index.html        # SPA 回退入口（内容同应用页面，nginx try_files 回退用）
#       sa/
#         index.html      # 应用首页
#         assets/         # 静态资源（/sa/assets/*.js）
#
# 说明：
#   server 与 ingestor 共享同一份编译产物 dist/src（二者共用 AppModule），
#   但物理隔离为两个独立目录，supervisor 分别管理，可各自更新/重启/回滚。
#   更新主程序时只重建 server/，ingestor/ 保持旧文件，Kafka 监听不受影响。
#
# 用法：
#   /bin/bash -x scripts/build.sh

set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_SRC="$ROOT_DIR/apps/analytics-server"
WEB_DIR="$ROOT_DIR/apps/analytics-web"
HARNESS_HOST_DIR="$ROOT_DIR/apps/analytics-harness-host"
HARNESS_BROKER_DIR="$ROOT_DIR/apps/analytics-harness-broker"
TARGET_DIR="$ROOT_DIR/target"

log() {
  echo "[build] $1"
}

# 生成单个后端服务部署目录（server 或 ingestor）
# 参数：目标子目录名（如 server / ingestor）、源启动脚本名（如 server-run.sh / run_ingestor.sh）、目标启动脚本名（如 run.sh / run_ingestor.sh）
collect_backend_artifacts() {
  local subdir="$1"
  local src_script="$2"
  local dst_script="$3"
  local dest="$TARGET_DIR/$subdir"

  log "收集后端产物到 $subdir ..."
  mkdir -p "$dest/dist"
  cp -r "$SERVER_SRC/dist/src/." "$dest/dist/src/"

  # 运行元数据（服务器端 npm ci --production 用）
  cp "$SERVER_SRC/package.json" "$dest/"
  cp "$SERVER_SRC/package-lock.json" "$dest/"

  # prisma schema 与迁移（运行时 init 需要）
  if [ -d "$SERVER_SRC/prisma" ]; then
    cp -r "$SERVER_SRC/prisma" "$dest/"
  fi

  # 部署配置：config_server.yaml -> configs/config.yaml
  mkdir -p "$dest/configs"
  if [ -f "$SERVER_SRC/config_server.yaml" ]; then
    cp "$SERVER_SRC/config_server.yaml" "$dest/configs/config.yaml"
  else
    cp "$SERVER_SRC/config_dev.yaml" "$dest/configs/config.yaml" 2>/dev/null || true
  fi

  # 启动脚本：源脚本名（仓库 scripts/ 下）-> 目标脚本名（部署目录内）
  if [ -n "$src_script" ] && [ -f "$ROOT_DIR/scripts/$src_script" ]; then
    cp "$ROOT_DIR/scripts/$src_script" "$dest/$dst_script"
    chmod +x "$dest/$dst_script"
  fi

  # 环境变量模板
  if [ -f "$ROOT_DIR/scripts/env.example" ]; then
    cp "$ROOT_DIR/scripts/env.example" "$dest/env.example"
  fi
}

# 清空并初始化 target 目录
rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"
mkdir -p "$TARGET_DIR/ops"
cp "$ROOT_DIR/puppet/clklog/files/install-node24.sh" "$TARGET_DIR/ops/"
cp "$ROOT_DIR/puppet/clklog/files/install-harness-user.sh" "$TARGET_DIR/ops/"
cp "$ROOT_DIR/puppet/clklog/files/install-analytics-node24-supervisor.sh" "$TARGET_DIR/ops/"
cp "$ROOT_DIR/scripts/install-harness-runtime.sh" "$TARGET_DIR/ops/"
cp "$ROOT_DIR/scripts/supervisord-harness-broker.conf" "$TARGET_DIR/ops/"
cp "$ROOT_DIR/scripts/supervisord-clklog-manager.conf" "$TARGET_DIR/ops/"
cp "$ROOT_DIR/scripts/nginx-clklog-manager.conf" "$TARGET_DIR/ops/"
cp "$ROOT_DIR/scripts/ai-workspace-sync.sh" "$TARGET_DIR/ops/"
cp "$ROOT_DIR/scripts/repair-session-log.py" "$TARGET_DIR/ops/"
chmod +x "$TARGET_DIR/ops/ai-workspace-sync.sh"
chmod +x "$TARGET_DIR/ops/install-node24.sh"
chmod +x "$TARGET_DIR/ops/install-harness-user.sh"
chmod +x "$TARGET_DIR/ops/install-analytics-node24-supervisor.sh"
chmod +x "$TARGET_DIR/ops/install-harness-runtime.sh"
chmod +x "$TARGET_DIR/ops/repair-session-log.py"

# 写入版本号：优先使用 CI_PIPELINE_ID，缺失则用时间戳
if [ -n "$CI_PIPELINE_ID" ]; then
  echo "$CI_PIPELINE_ID" > "$TARGET_DIR/.version"
else
  date +%Y%m%d%H%M%S > "$TARGET_DIR/.version"
fi
log "版本号: $(cat "$TARGET_DIR/.version")"

# 安装依赖：node_modules 缺失时才执行 npm ci（CI 中由 cache 提供 node_modules，跳过可加速）
install_deps() {
  local dir=$1
  if [ -d "$dir/node_modules" ]; then
    log "$(basename "$dir") 依赖已存在，跳过 npm ci"
  else
    log "安装 $(basename "$dir") 依赖..."
    (cd "$dir" && npm ci)
  fi
}

# ---- 构建后端 analytics-server ----
log "构建后端 analytics-server ..."
install_deps "$SERVER_SRC"
# Prisma client 生成（@prisma/client 需先 generate，nest build 才能通过类型检查）
log "生成 Prisma client ..."
(cd "$SERVER_SRC" && npx prisma generate)
(cd "$SERVER_SRC" && npm run build)
# 后端单测：**全量**（2026-09-15 起）。此前是显式白名单，原因是部分 spec 顶层加载 YAML 配置
# （clickhouse/card 等），CI 无密钥 / APP_CONFIG_PATH 时会崩；现已在所有相关 spec 中隔离
# `src/config/configuration`，全量在 CI 条件下（清空四个密钥变量 + APP_CONFIG_PATH 指向不存在文件）
# 实跑 71 suites / 417 tests 全绿。新增 spec 自动纳入门禁，不必再登记。
(cd "$SERVER_SRC" && npm test -- --runInBand)
log "后端构建完成"

# ---- 许可白名单检查（开源分发要求：只允许宽松许可）----
log "依赖许可检查 ..."
node "$ROOT_DIR/scripts/license-check.mjs"

# ---- 演示工程 zip（接入指南的「下载示例工程」按钮）----
# 必须在 npm run build 之前：zip 落在 apps/analytics-web/public/sdk-demos/，由 vite 拷进产物。
if [ -f "$ROOT_DIR/scripts/build-sdk-demos.sh" ]; then
  bash "$ROOT_DIR/scripts/build-sdk-demos.sh"
fi

# ---- 构建前端 analytics-web ----
log "构建前端 analytics-web ..."
install_deps "$WEB_DIR"
(cd "$WEB_DIR" && npm run build)
# 前端单测：**全量**（2026-09-17 起）。此前只跑子集，原因是整页渲染类用例在 5s 默认超时下
# 随机器负载随机失败（SqlReportPage.chart-config 等）；现已在 vite.config.ts 统一放宽到 30s，
# 全量 97 文件 / 436 用例在本地与 CI 条件均全绿，因此不再维护白名单。
log "前端单测（全量）..."
(cd "$WEB_DIR" && npx vitest run)

# i18n 门禁：资源一致性（键集/占位符/残留中文/跨层 messageKey）+ 覆盖率棘轮（只减不增）
# 依赖 python3；镜像里没有 python3 时降级为告警（前端单测里的 resources.spec.ts 仍会兜底校验语言键集一致）。
if command -v python3 >/dev/null 2>&1; then
  log "i18n 资源与覆盖率门禁 ..."
  python3 "$ROOT_DIR/scripts/i18n_check.py"
  python3 "$ROOT_DIR/scripts/i18n_scan.py" --check
else
  log "⚠️ 跳过 i18n 门禁：镜像内没有 python3（前端 resources.spec.ts 仍会校验语言键集一致）"
fi
log "前端构建完成"

# ---- 校验并收集隔离 Harness Host / Runtime Broker ----
log "校验 Harness Host 与 Runtime Broker ..."
install_deps "$HARNESS_HOST_DIR"
(cd "$HARNESS_HOST_DIR" && npm test)
(cd "$HARNESS_BROKER_DIR" && npm test)
node --check "$HARNESS_HOST_DIR/runtime-wrapper.mjs"
node --check "$HARNESS_HOST_DIR/workspace-registry.mjs"
node --check "$HARNESS_HOST_DIR/plugins/analytics-tools/index.mjs"
node --check "$HARNESS_BROKER_DIR/src/server.mjs"
mkdir -p "$TARGET_DIR/harness-host" "$TARGET_DIR/harness-broker"
cp "$HARNESS_HOST_DIR/package.json" "$HARNESS_HOST_DIR/package-lock.json" "$TARGET_DIR/harness-host/"
cp "$HARNESS_HOST_DIR/runtime-wrapper.mjs" "$HARNESS_HOST_DIR/workspace-registry.mjs" "$TARGET_DIR/harness-host/"
cp -r "$HARNESS_HOST_DIR/profile" "$HARNESS_HOST_DIR/plugins" "$TARGET_DIR/harness-host/"
# AI 工作区内容（模板 default + 项目空间 app）：随发布产物到目标机，供 ai-workspace-sync.sh 使用
cp -a "$ROOT_DIR/ai_workspace" "$TARGET_DIR/ai_workspace"
cp "$HARNESS_BROKER_DIR/package.json" "$HARNESS_BROKER_DIR/package-lock.json" "$TARGET_DIR/harness-broker/"
cp -r "$HARNESS_BROKER_DIR/src" "$TARGET_DIR/harness-broker/"
log "Harness 产物收集完成"

# ---- 收集后端产物（server 与 ingestor 各自独立目录）----
# server：源脚本 server-run.sh -> 部署为 run.sh
collect_backend_artifacts server server-run.sh run.sh
# ingestor：源脚本 run_ingestor.sh -> 部署为 run_ingestor.sh
collect_backend_artifacts ingestor run_ingestor.sh run_ingestor.sh

# ---- 收集前端产物到 target/web ----
# vite base=/sa/，产物挂在 /sa/ 前缀下；nginx root 指向 web 即可命中，
# 无需在 nginx 中配置 /sa/ 的 alias。根目录再放一份 index.html 供 SPA 回退。
log "收集前端产物到 target/web ..."
mkdir -p "$TARGET_DIR/web/sa"
cp -r "$WEB_DIR/dist/." "$TARGET_DIR/web/sa/"
cp "$WEB_DIR/dist/index.html" "$TARGET_DIR/web/index.html"

# ---- 预压缩前端静态资源 ----
# 服务器 nginx 已开 `gzip_static on`：产物里带 `.gz` 时自动按 gzip 传输，**无需改任何 nginx 配置**，
# 客户端不支持 gzip 时自动回落原文件（已实测：入口分片 1,132,673 → 356,535 字节，-68%）。
# 2026-09-19 事故背景：nginx 全局 gzip_types 缺 application/javascript，线上 JS 全部未压缩，
# 跨区域链路下首屏要传 1.2MB 未压缩内容，页面 43 秒才可用。
if command -v gzip >/dev/null 2>&1; then
  log "预压缩前端静态资源（.gz，随产物发布）..."
  find "$TARGET_DIR/web" -type f \( -name '*.js' -o -name '*.css' -o -name '*.svg' -o -name '*.json' -o -name '*.html' \) -size +1k \
    -exec sh -c 'gzip -9 -c "$1" > "$1.gz"' _ {} \;
  # 统计只用于日志：统计失败不影响构建（用 wc -c 而非 -printf，BSD/GNU find 都可用）
  (
    set +e
    orig_kb=$(( $(find "$TARGET_DIR/web" -type f ! -name '*.gz' -exec wc -c {} + 2>/dev/null | awk '{s+=$1} END {print s+0}') / 1024 ))
    gz_kb=$(( $(find "$TARGET_DIR/web" -type f -name '*.gz' -exec wc -c {} + 2>/dev/null | awk '{s+=$1} END {print s+0}') / 1024 ))
    log "预压缩完成：原始 ${orig_kb:-0} KB → .gz ${gz_kb:-0} KB（支持 gzip 的客户端按后者传输）"
  )
else
  log "⚠️ 跳过预压缩：镜像内没有 gzip"
fi

log "构建产物汇总到 $TARGET_DIR："
find "$TARGET_DIR" -maxdepth 2 -type f | sed "s#$ROOT_DIR/##" | sort | head -50
log "build.sh 完成"
