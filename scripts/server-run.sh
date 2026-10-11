#!/usr/bin/env bash
# run.sh — ClkLog analytics-server 部署启动脚本（由 build.sh 复制到 target/server/）
#
# 用法：
#   ./run.sh              启动 HTTP 主服务（前台）
#   ./run.sh start        后台启动
#   ./run.sh stop         停止
#   ./run.sh restart      重启
#   ./run.sh status       查看状态
#
# 说明：
#   - 首次运行自动 npm ci --production 安装生产依赖
#   - 启动前始终执行 prisma generate，确保 Prisma Client 与随发版更新的 schema 同步
#     （发版新增/修改模型后必须 regenerate，node_modules 已存在时不会自动更新）
#   - 配置读取 configs/config.yaml，敏感值通过同目录 .env 或系统环境变量注入
#   - 仅启动 HTTP 主服务；ingestor 由外部单独管理
#
# 环境变量（可注入）：
#   PORT           监听端口，默认 3100
#   NODE_ENV       运行环境，默认 production

set -e

SERVER_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_PATH="$SERVER_DIR/configs/config.yaml"
PID_FILE="$SERVER_DIR/.server.pid"
LOG_FILE="$SERVER_DIR/logs/server.log"
DEFAULT_PORT=3100

log() {
  echo "[run] $1"
}

# 加载同目录 .env（若存在）
load_env() {
  local env_file="$SERVER_DIR/.env"
  if [ -f "$env_file" ]; then
    log "加载环境变量: $env_file"
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
  fi
}

install_deps_if_needed() {
  if [ ! -d "$SERVER_DIR/node_modules" ]; then
    log "安装生产依赖 (npm ci --production) ..."
    (cd "$SERVER_DIR" && npm ci --production)
  fi
  # 始终重新生成 Prisma Client，确保与随发版更新的 prisma/schema.prisma 同步。
  # node_modules 已存在时 npm ci 不会执行，但 schema 变化后 client 必须 regenerate，
  # 否则新增模型/字段（如 MetaDiscoveryLog）在运行时不可用。generate 幂等且快。
  log "生成 Prisma Client (与 schema 同步) ..."
  (cd "$SERVER_DIR" && npx prisma generate)
}

# 检查 config.yaml 中引用的所有 ${ENV_VAR} 环境变量是否已注入（忽略注释行）
check_env() {
  local missing=""
  local var
  for var in $(grep -vE '^\s*#' "$CONFIG_PATH" 2>/dev/null \
      | grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*\}' \
      | sed -E 's/\$\{|\}//g' | sort -u); do
    if [ -z "${!var:-}" ]; then
      missing="$missing $var"
    fi
  done
  if [ -n "$missing" ]; then
    log "错误: 以下环境变量未设置: $missing"
    log "请通过 'export VAR=xxx' 或创建 $SERVER_DIR/.env 注入密钥后重试（参考 .env.example）"
    return 1
  fi
}

start() {
  install_deps_if_needed
  load_env

  # 确保配置存在
  if [ ! -f "$CONFIG_PATH" ]; then
    log "错误: 配置文件不存在: $CONFIG_PATH"
    exit 1
  fi

  # 校验环境变量
  if ! check_env; then
    exit 1
  fi

  mkdir -p "$SERVER_DIR/logs"
  export APP_CONFIG_PATH="$CONFIG_PATH"
  export NODE_ENV="${NODE_ENV:-production}"

  # 已在运行则退出
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    log "服务已在运行 (pid=$(cat "$PID_FILE"))"
    return 0
  fi

  log "启动 HTTP 主服务 (端口 ${PORT:-$DEFAULT_PORT}) ..."
  nohup node "$SERVER_DIR/dist/src/main.js" >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  log "已启动，pid=$(cat "$PID_FILE")，日志: $LOG_FILE"
}

stop() {
  if [ ! -f "$PID_FILE" ]; then
    log "未运行"
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  if kill -0 "$pid" 2>/dev/null; then
    log "停止服务 (pid=$pid) ..."
    kill "$pid"
    # 等待优雅退出
    for _ in $(seq 1 15); do
      if ! kill -0 "$pid" 2>/dev/null; then
        break
      fi
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
      log "强制结束 (pid=$pid)"
      kill -9 "$pid"
    fi
  fi
  rm -f "$PID_FILE"
  log "已停止"
}

status() {
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    log "运行中 (pid=$(cat "$PID_FILE"))"
  else
    log "未运行"
  fi
}

case "${1:-start}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; start ;;
  status)  status ;;
  *)
    echo "用法: $0 {start|stop|restart|status}" >&2
    exit 1
    ;;
esac
