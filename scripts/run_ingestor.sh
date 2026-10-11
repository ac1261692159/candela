#!/usr/bin/env bash
# run_ingestor.sh — ClkLog analytics-server ingestor 启动脚本（Kafka 消费者进程）
#
# ingestor 与 HTTP 主服务（run.sh）分开管理，消费 CKafka 数据写入 ClickHouse。
#
# 用法：
#   ./run_ingestor.sh                    启动 ingestor（前台）
#   ./run_ingestor.sh start              后台启动（从当前 offset 正常消费）
#   ./run_ingestor.sh start --replay     后台启动并从 topic 最早位点回灌一次
#   ./run_ingestor.sh replay             等同于 start --replay（历史回灌）
#   ./run_ingestor.sh stop               停止
#   ./run_ingestor.sh restart            重启
#   ./run_ingestor.sh status             查看状态
#
# 说明：
#   - 首次运行自动 npm ci --production 安装生产依赖
#   - 启动前始终执行 prisma generate，确保 Prisma Client 与随发版更新的 schema 同步
#     （发版新增/修改模型后必须 regenerate，node_modules 已存在时不会自动更新）
#   - 与 run.sh 共用 configs/config.yaml 及 .env 环境变量注入
#   - replay 模式：通过 INGESTOR_REPLAY=true 注入，使用独立 consumer group
#     （clklog-sa-ingestor-replay-{时间戳}）从 topic 最早位点重新消费一次，
#     用于补历史数据；crc 幂等保证重放不产生重复行。
#     ⚠️ 只能补 Kafka topic 保留期内的数据；早于 retention 的消息已被删除无法补回。
#
# 环境变量（可注入）：
#   NODE_ENV       运行环境，默认 production
#   INGESTOR_REPLAY 设为 true 时从头回灌（start --replay / replay 命令会自动注入）

set -e

SERVER_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_PATH="$SERVER_DIR/configs/config.yaml"
PID_FILE="$SERVER_DIR/.ingestor.pid"
LOG_FILE="$SERVER_DIR/logs/ingestor.log"

log() {
  echo "[ingestor] $1"
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

# start 支持可选回灌参数：start --replay 时设置 INGESTOR_REPLAY=true 从头消费
start() {
  local replay=false
  if [ "${1:-}" = "--replay" ]; then
    replay=true
  fi

  install_deps_if_needed
  load_env

  if [ ! -f "$CONFIG_PATH" ]; then
    log "错误: 配置文件不存在: $CONFIG_PATH"
    exit 1
  fi

  if ! check_env; then
    exit 1
  fi

  mkdir -p "$SERVER_DIR/logs"
  export APP_CONFIG_PATH="$CONFIG_PATH"
  export NODE_ENV="${NODE_ENV:-production}"

  if [ "$replay" = true ]; then
    export INGESTOR_REPLAY=true
  fi

  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    log "ingestor 已在运行 (pid=$(cat "$PID_FILE"))"
    return 0
  fi

  if [ "$replay" = true ]; then
    log "启动 ingestor（回灌模式，从 topic 最早位点消费一次）..."
  else
    log "启动 ingestor (Kafka 消费者) ..."
  fi
  nohup node "$SERVER_DIR/dist/src/scripts/run-ingestor.js" >> "$LOG_FILE" 2>&1 &
  echo $! > "$PID_FILE"
  log "已启动，pid=$(cat "$PID_FILE")，日志: $LOG_FILE"
}

# replay：历史回灌（等价于 start --replay）
replay() {
  start --replay
}

stop() {
  if [ ! -f "$PID_FILE" ]; then
    log "未运行"
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE")"
  if kill -0 "$pid" 2>/dev/null; then
    log "停止 ingestor (pid=$pid) ..."
    kill "$pid"
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
  start)   start "$2" ;;
  replay)  replay ;;
  stop)    stop ;;
  restart) stop; start "$2" ;;
  status)  status ;;
  *)
    echo "用法: $0 {start [--replay]|replay|stop|restart [--replay]|status}" >&2
    exit 1
    ;;
esac
