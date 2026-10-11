#!/usr/bin/env bash
# run_dev.sh — ClkLog 分析平台本地开发启动脚本
#
# 用法：
#   ./run_dev.sh          同时启动后端（:3100）、前端（:8180）和 ingestor
#   ./run_dev.sh server   只启动后端
#   ./run_dev.sh web      只启动前端
#
# 约定：
#   - 使用项目本地 node_modules，不依赖全局 npm 包
#   - 后端端口 3100，前端端口 8180
#   - 启动前会自动检查并安装依赖
#   - 任一子进程异常退出时，整个脚本会立即终止其他子进程并退出（fail-fast）

set -e

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$ROOT_DIR/apps/analytics-server"
WEB_DIR="$ROOT_DIR/apps/analytics-web"
SERVER_PORT=3100
WEB_PORT=8180

MODE="${1:-all}"

log() {
  echo "[run_dev] $1"
}

install_deps_if_needed() {
  local dir=$1
  if [ ! -d "$dir/node_modules" ]; then
    log "安装 $dir 依赖..."
    (cd "$dir" && npm install)
  else
    log "$dir 依赖已存在，跳过安装"
  fi
}

ensure_server_env() {
  if [ -f "$SERVER_DIR/.env" ]; then
    return
  fi

  if [ -f "$SERVER_DIR/.env.example" ]; then
    log "首次运行：从 .env.example 创建 $SERVER_DIR/.env"
    cp "$SERVER_DIR/.env.example" "$SERVER_DIR/.env"
    log "请检查 $SERVER_DIR/.env 中的值是否正确，本次将使用示例值启动"
  else
    log "错误: 未找到 $SERVER_DIR/.env 且不存在 .env.example"
    exit 1
  fi
}

start_server() {
  log "启动后端服务（端口 $SERVER_PORT）..."
  install_deps_if_needed "$SERVER_DIR"
  ensure_server_env

  (
    # 子进程收到终止信号时，连带清理 nest/node 子进程
    trap 'kill 0 2>/dev/null || true' TERM INT

    cd "$SERVER_DIR"
    # 本地开发使用 config_dev.yaml 作为配置源
    set -a
    # shellcheck source=/dev/null
    source "$SERVER_DIR/.env"
    set +a
    export NODE_ENV=development
    export APP_CONFIG_PATH="$SERVER_DIR/config_dev.yaml"
    export PORT=$SERVER_PORT
    # 本地开发：Kafka broker 地址通过 socketFactory 映射到 SSH 转发端口
    export KAFKA_LOCAL_FORWARD=true
    npm run start:dev
  )
}

start_web() {
  log "启动前端服务（端口 $WEB_PORT）..."
  install_deps_if_needed "$WEB_DIR"
  (
    trap 'kill 0 2>/dev/null || true' TERM INT

    cd "$WEB_DIR"
    export VITE_PORT=$WEB_PORT
    npm run dev
  )
}

start_ingestor() {
  log "启动 ingestor..."
  install_deps_if_needed "$SERVER_DIR"
  ensure_server_env

  (
    trap 'kill 0 2>/dev/null || true' TERM INT

    cd "$SERVER_DIR"
    set -a
    # shellcheck source=/dev/null
    source "$SERVER_DIR/.env"
    set +a
    export NODE_ENV=development
    export APP_CONFIG_PATH="$SERVER_DIR/config_dev.yaml"
    # 本地开发：Kafka broker 地址通过 socketFactory 映射到 SSH 转发端口
    export KAFKA_LOCAL_FORWARD=true
    npm run start:ingestor:dev
  )
}

# 等待任一子进程退出；返回时 EXIT_CODE 已记录退出码
wait_for_any_child_exit() {
  local server_pid=$1
  local web_pid=$2
  local ingestor_pid=$3
  local exit_code=0

  while true; do
    for pid in "$server_pid" "$web_pid" "$ingestor_pid"; do
      if ! kill -0 "$pid" 2>/dev/null; then
        wait "$pid" || exit_code=$?
        log "子进程 $pid 已退出（退出码 $exit_code）"
        echo "$exit_code"
        return
      fi
    done
    sleep 1
  done
}

# 终止其余仍存活的子进程
kill_remaining_children() {
  local exited_pid=$1
  shift
  for pid in "$@"; do
    if [ "$pid" != "$exited_pid" ] && kill -0 "$pid" 2>/dev/null; then
      log "终止子进程 $pid..."
      kill "$pid" 2>/dev/null || true
    fi
  done
  # 等待它们真正结束，避免孤儿进程
  for pid in "$@"; do
    if [ "$pid" != "$exited_pid" ]; then
      wait "$pid" 2>/dev/null || true
    fi
  done
}

case "$MODE" in
  server)
    start_server
    ;;
  web)
    start_web
    ;;
  all)
    # 先安装两边依赖，再并行启动
    install_deps_if_needed "$SERVER_DIR"
    install_deps_if_needed "$WEB_DIR"

    # 脚本退出时兜底清理所有子进程
    trap 'log "正在终止子进程..."; kill 0 2>/dev/null || true' EXIT

    start_server &
    SERVER_PID=$!
    start_web &
    WEB_PID=$!
    start_ingestor &
    INGESTOR_PID=$!

    log "后端 PID: $SERVER_PID, 前端 PID: $WEB_PID, ingestor PID: $INGESTOR_PID"

    EXIT_CODE=$(wait_for_any_child_exit "$SERVER_PID" "$WEB_PID" "$INGESTOR_PID")
    kill_remaining_children "" "$SERVER_PID" "$WEB_PID" "$INGESTOR_PID"
    exit "$EXIT_CODE"
    ;;
  *)
    echo "未知参数: $MODE"
    echo "用法: $0 [server|web|all]"
    exit 1
    ;;
esac
