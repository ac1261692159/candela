#!/usr/bin/env bash
# deploy-remote.sh — 本地入口：推送源码与脚本到目标机并执行指定动作
#
# 不依赖 CI/CD：源码与脚本直接从本地仓库 rsync 上去，构建在目标机完成
# （必须在 Linux 上构建：vite/esbuild/@prisma 引擎都是平台相关的二进制）。
#
# 用法：
#   bash scripts/standalone-test-env/candela/deploy-remote.sh push        # 只推送源码与脚本
#   bash scripts/standalone-test-env/candela/deploy-remote.sh native      # 常规方案部署
#   bash scripts/standalone-test-env/candela/deploy-remote.sh docker      # docker-compose 部署
#   bash scripts/standalone-test-env/candela/deploy-remote.sh verify      # 验证
#   bash scripts/standalone-test-env/candela/deploy-remote.sh wipe        # 铲库（dry-run）
#   bash scripts/standalone-test-env/candela/deploy-remote.sh wipe --yes  # 铲库（真删）
#   HOST=user@your-server bash .../deploy-remote.sh native                # 必填：SSH 目标
#
# 全量（含推送）：bash .../deploy-remote.sh native   # 会先 push 再执行

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
if [ -z "${HOST:-}" ]; then
  echo "必须设置 HOST（SSH 目标），例如：HOST=user@your-server bash $0 native" >&2
  exit 1
fi
BASE_DIR="${BASE_DIR:-/data/app/candela}"
MW_BASE_DIR="${MW_BASE_DIR:-/data/clklog-oss-test}"
SSH="ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o LogLevel=ERROR"
RSYNC="rsync -a --no-perms --no-owner --no-group"

ACTION="${1:-push}"; shift || true

push_all() {
  echo "[local] 目标机 ${HOST}  BASE_DIR=${BASE_DIR}"
  $SSH "$HOST" "mkdir -p ${BASE_DIR}/src/apps/analytics-server ${BASE_DIR}/src/apps/analytics-web ${BASE_DIR}/src/apps/analytics-harness-host ${BASE_DIR}/src/scripts ${BASE_DIR}/src/examples ${BASE_DIR}/src/clklog_dc_config ${BASE_DIR}/ops/candela"

  echo "[local] 推送后端源码（排除 node_modules/dist/test）"
  $RSYNC --delete \
    --exclude 'node_modules' --exclude 'dist' --exclude 'test' --exclude '.env' \
    --exclude 'dlq' --exclude 'harness' --exclude '.DS_Store' \
    "$REPO_ROOT/apps/analytics-server/" "$HOST:${BASE_DIR}/src/apps/analytics-server/"

  echo "[local] 推送前端源码（排除 node_modules/dist）"
  $RSYNC --delete \
    --exclude 'node_modules' --exclude 'dist' --exclude '.DS_Store' \
    "$REPO_ROOT/apps/analytics-web/" "$HOST:${BASE_DIR}/src/apps/analytics-web/"

  echo "[local] 推送 harness 运行时源码与工作区种子"
  # 两个用途：
  #   1) 前端 tsc 类型检查需要 apps/analytics-harness-host/plugins/**（analysis-cases.json 等）；
  #   2) 目标机 install-harness.sh 需要完整 host + broker 源码组装运行时 release。
  # 即「前端构建与 harness 安装都依赖 apps/analytics-harness-host」——CI 在整仓构建所以看不出，
  # 单独部署时必须一并提供（详见部署文档的已知耦合）。
  $SSH "$HOST" "mkdir -p ${BASE_DIR}/src/apps/analytics-harness-host ${BASE_DIR}/src/apps/analytics-harness-broker ${BASE_DIR}/src/ai_workspace"
  $RSYNC --delete \
    --exclude 'node_modules' --exclude 'dist' --exclude '.DS_Store' \
    "$REPO_ROOT/apps/analytics-harness-host/" "$HOST:${BASE_DIR}/src/apps/analytics-harness-host/"
  $RSYNC --delete \
    --exclude 'node_modules' --exclude '.DS_Store' \
    "$REPO_ROOT/apps/analytics-harness-broker/" "$HOST:${BASE_DIR}/src/apps/analytics-harness-broker/"
  # AI 工作区种子（ai-workspace-sync.sh init --from-release 的内容源）
  $RSYNC --delete --exclude '.DS_Store' \
    "$REPO_ROOT/ai_workspace/" "$HOST:${BASE_DIR}/src/ai_workspace/"
  $RSYNC \
    "$REPO_ROOT/scripts/ai-workspace-sync.sh" "$REPO_ROOT/scripts/supervisord-harness-broker.conf" \
    "$HOST:${BASE_DIR}/src/scripts/"

  echo "[local] 推送前端 sdk-demos 打包所需输入（examples/report-sdk + 打包脚本）"
  # 前端 onboarding 页的示例下载包由 scripts/build-sdk-demos.sh 从 examples/report-sdk 现打，
  # 产物 public/sdk-demos/*.zip 不入库；构建前必须把这些输入一起提供。
  $SSH "$HOST" "mkdir -p ${BASE_DIR}/src/examples"
  $RSYNC --delete "$REPO_ROOT/examples/report-sdk/" "$HOST:${BASE_DIR}/src/examples/report-sdk/"
  $RSYNC "$REPO_ROOT/scripts/build-sdk-demos.sh" "$HOST:${BASE_DIR}/src/scripts/build-sdk-demos.sh"
  $SSH "$HOST" "chmod +x ${BASE_DIR}/src/scripts/build-sdk-demos.sh"

  echo "[local] 推送社区版初始化资产（init SQL 等）"
  $RSYNC --delete \
    "$REPO_ROOT/deploy-assets/clklog-community/" "$HOST:${BASE_DIR}/src/clklog_dc_config/"

  echo "[local] 推送部署脚本"
  # 目标机布局必须与仓库同构，否则 candela 的 lib.sh 会与上层公共 lib.sh 撞名：
  #   <BASE_DIR>/ops/lib.sh            ← scripts/standalone-test-env/lib.sh（公共函数）
  #   <BASE_DIR>/ops/candela/*.sh      ← scripts/standalone-test-env/candela/*（本产品脚本）
  #   candela 的 lib.sh 用 `../lib.sh` 引用公共库，靠这层目录关系成立。
  # （2026-10-10 实测：扁平化推送时两个 lib.sh 同名互相覆盖，服务起不来。）
  $SSH "$HOST" "mkdir -p ${BASE_DIR}/ops/candela"
  $RSYNC --delete \
    "$REPO_ROOT/scripts/standalone-test-env/candela/" "$HOST:${BASE_DIR}/ops/candela/"
  $RSYNC "$REPO_ROOT/scripts/standalone-test-env/lib.sh" "$HOST:${BASE_DIR}/ops/lib.sh"

  # 推送后断言：目标机上脚本必须齐（否则后续动作会在远端报"找不到脚本"，
  # 而 rsync 的失败容易被调用方的管道/日志过滤掩盖——2026-10-10 实测踩到过）
  local missing
  missing="$($SSH "$HOST" "for f in deploy-native.sh deploy-docker.sh deploy-remote.sh init-db-mysql.sh init-db-clickhouse.sh verify.sh wipe-databases.sh install-harness.sh lib.sh; do [ -f ${BASE_DIR}/ops/candela/\$f ] || echo \$f; done; [ -f ${BASE_DIR}/ops/lib.sh ] || echo 'ops/lib.sh'")"
  [ -z "$missing" ] || { echo "[local] 推送不完整，目标机缺少：${missing}" >&2; exit 1; }
  echo "[local] 推送校验通过（10 个文件就位）"
}

run() { echo "[local] === $* ==="; $SSH "$HOST" "bash ${BASE_DIR}/ops/candela/$*"; }

case "$ACTION" in
  push)   push_all ;;
  native) push_all; run deploy-native.sh ;;
  docker) push_all; run deploy-docker.sh ;;
  verify) run verify.sh ;;
  wipe)   run "wipe-databases.sh $*" ;;
  shell)  $SSH -t "$HOST" "bash -l" ;;
  *) echo "未知动作：$ACTION（push|native|docker|verify|wipe|shell）" >&2; exit 2 ;;
esac
