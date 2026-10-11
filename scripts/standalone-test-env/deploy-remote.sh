#!/usr/bin/env bash
# deploy-remote.sh — 从本地仓库推送脚本与资产到目标机并执行部署（本地侧入口）
#
# 用法：
#   bash scripts/standalone-test-env/deploy-remote.sh              # 全流程
#   bash scripts/standalone-test-env/deploy-remote.sh mw           # 只跑中间件
#   bash scripts/standalone-test-env/deploy-remote.sh clklog       # 只跑 ClkLog 层
#   bash scripts/standalone-test-env/deploy-remote.sh verify        # 只跑验证
#   bash scripts/standalone-test-env/deploy-remote.sh teardown      # 清空环境（dry-run）
#   bash scripts/standalone-test-env/deploy-remote.sh teardown --yes# 清空环境（真删）
#   HOST=user@your-server bash .../deploy-remote.sh                # 必填：SSH 目标
#
# 脚本与配置的真相在仓库：每次执行都重新推送，目标机上不手工改文件。
# 资产（init SQL / ui config.js / 字典）取自 deploy-assets/clklog-community，
# 不在本目录另存一份，避免两处漂移。

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ -z "${HOST:-}" ]; then
  echo "必须设置 HOST（SSH 目标），例如：HOST=user@your-server bash $0" >&2
  exit 1
fi
BASE_DIR="${BASE_DIR:-/data/clklog-oss-test}"
SSH="ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o LogLevel=ERROR"
RSYNC="rsync -a"

ACTION="${1:-all}"

echo "[local] 目标机 ${HOST}，部署根目录 ${BASE_DIR}"
$SSH "$HOST" "mkdir -p $BASE_DIR/deploy $BASE_DIR/assets"

echo "[local] 推送部署脚本"
$RSYNC "$REPO_ROOT/scripts/standalone-test-env/" "$HOST:$BASE_DIR/deploy/"

echo "[local] 推送 ClkLog 配置资产（源自 deploy-assets/clklog-community）"
$RSYNC "$REPO_ROOT/deploy-assets/clklog-community/" "$HOST:$BASE_DIR/assets/"

run() { echo "[local] === $1 ==="; $SSH "$HOST" "bash $BASE_DIR/deploy/$1"; }

case "$ACTION" in
  mw)     run deploy-middleware.sh ;;
  clklog) run deploy-clklog.sh ;;
  verify) run verify.sh ;;
  # 清空目标机上的 ClkLog 社区版 + Candela 部署（默认 dry-run，加 --yes 才真删）
  teardown) $SSH "$HOST" "bash $BASE_DIR/deploy/teardown.sh ${2:-}" ;;
  all)
    run deploy-middleware.sh
    run deploy-clklog.sh
    run verify.sh
    ;;
  *) echo "未知动作：${ACTION}（可用：all|mw|clklog|verify|teardown）" >&2; exit 2 ;;
esac
