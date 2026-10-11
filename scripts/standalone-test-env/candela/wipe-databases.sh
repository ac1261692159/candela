#!/usr/bin/env bash
# wipe-databases.sh — 铲掉 ClkLog 社区版与分析平台的全部数据库（**破坏性**，需显式确认）
#
# 用途：两套部署流程之间做「从零初始化」验证——铲干净后由部署脚本重新建库，
#       以此证明初始化脚本真的能从空库跑到可用，而不是靠上一次的残留。
#
# 会铲掉：
#   MySQL   : clklog（社区版）、clklog_sa_meta（分析平台元数据）+ 应用账号
#   ClickHouse: clklog（社区版）、clklog_sa、clklog_sa_bak、clklog_sa_staging + 只读/清洗账号
#   Kafka   : topic clklog 及其消费组（含 __consumer_offsets 里对应的组数据）
#
# 不会动：Redis（只放查询缓存，键前缀隔离，无需清）、容器/镜像/挂载目录、MySQL 的其他库。
#
# 用法：
#   bash wipe-databases.sh              # 打印将要删除的内容后退出（dry-run，默认）
#   bash wipe-databases.sh --yes        # 真删

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SELF_DIR/lib.sh"

require_root
init_env_file
load_manager_secrets
set_endpoints "${ENDPOINT_MODE:-native}"

CONFIRM=0
[ "${1:-}" = "--yes" ] && CONFIRM=1

MYSQL_DBS=("$COMMUNITY_DB" "$RUNTIME_DB")
CH_DBS=("$COMMUNITY_DB" "$RUNTIME_CH_DB" "clklog_sa_bak" "clklog_sa_staging")
KAFKA_TOPIC="clklog"

log "=============================================================="
log " 即将删除的数据库对象"
log "=============================================================="
log "  MySQL：$(IFS=' '; echo "${MYSQL_DBS[*]}") + 账号 ${RUNTIME_DB_USER}"
log "  ClickHouse：$(IFS=' '; echo "${CH_DBS[*]}") + 账号 sa_readonly / sa_cleanup"
log "  Kafka：topic ${KAFKA_TOPIC}（含消费组位移）"
log "  保留：Redis 数据、所有容器与镜像、挂载目录（数据文件在各自卷内，库删掉了文件仍在）"
log "=============================================================="

if [ "$CONFIRM" -ne 1 ]; then
  log "当前为 dry-run。确认要删除请加 --yes："
  log "  bash $0 --yes"
  exit 0
fi

log "开始铲库（--yes 已确认）"

# ---------------------------------------------------------------- MySQL
if wait_tcp "$MG_MYSQL_HOST" "$MG_MYSQL_PORT" 10; then
  for db in "${MYSQL_DBS[@]}"; do
    mg_mysql -e "DROP DATABASE IF EXISTS \`${db}\`;"
    log "  已删除 MySQL 库：$db"
  done
  mg_mysql -e "DROP USER IF EXISTS '${RUNTIME_DB_USER}'@'%'; FLUSH PRIVILEGES;"
  log "  已删除 MySQL 账号：$RUNTIME_DB_USER"
else
  warn "MySQL 不可达，跳过"
fi

# ---------------------------------------------------------------- ClickHouse
if wait_tcp "$MG_CH_HOST" "$MG_CH_PORT" 10; then
  for db in "${CH_DBS[@]}"; do
    mg_ck "DROP DATABASE IF EXISTS ${db}" >/dev/null
    log "  已删除 ClickHouse 库：$db"
  done
  # SQL 建的账号要 DROP USER；sa_readonly 来自 users.d 文件，删除文件即消失
  mg_ck "DROP USER IF EXISTS sa_cleanup" >/dev/null 2>&1 || true
  log "  已删除 ClickHouse 账号：sa_cleanup"
  if [ -f "$MW_CH_USERS_D/sa_readonly.xml" ]; then
    rm -f "$MW_CH_USERS_D/sa_readonly.xml"
    docker restart clklog-clickhouse >/dev/null
    wait_tcp "$MG_CH_HOST" "$MG_CH_PORT" 120 || true
    log "  已移除只读账号配置 sa_readonly.xml 并重启 ClickHouse"
  fi
else
  warn "ClickHouse 不可达，跳过"
fi

# ---------------------------------------------------------------- Kafka
if docker ps --format '{{.Names}}' | grep -qx clklog-kafka; then
  if docker exec clklog-kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 \
       --list 2>/dev/null | grep -qx "$KAFKA_TOPIC"; then
    docker exec clklog-kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 \
      --delete --topic "$KAFKA_TOPIC" >/dev/null
    log "  已删除 topic：$KAFKA_TOPIC（等待后台清理完成）"
  else
    log "  topic 不存在，跳过：$KAFKA_TOPIC"
  fi
  # 消费组元数据（Flink 与 ingestor 的组）；组不存在会非 0 退出，忽略
  for g in clklog-group clklog-sa-ingestor; do
    docker exec clklog-kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:9092 \
      --delete --group "$g" >/dev/null 2>&1 && log "  已删除消费组：$g" || true
  done
else
  warn "Kafka 容器不在运行，跳过"
fi

# ---------------------------------------------------------------- 环境级资源重建
# 铲库会把「环境级」资源一起带走：Kafka topic 被删、社区版 ClickHouse 库被删。
# 这里立即补回来，避免留下一个半死环境（下游 Flink/ingestor 会一直报错）。
log "重建环境级资源"
if docker ps --format '{{.Names}}' | grep -qx clklog-kafka; then
  docker exec clklog-kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 \
    --create --if-not-exists --topic "$KAFKA_TOPIC" --partitions 6 --replication-factor 1 >/dev/null
  log "  已重建 Kafka topic：$KAFKA_TOPIC（6 分区）"
fi
# 社区版 ClickHouse 库表由 clklog-init 容器在启动时创建（幂等），重启它即可
if docker ps --format '{{.Names}}' | grep -qx clklog-init; then
  docker restart clklog-init >/dev/null
  log "  已重启 clklog-init（重建社区版 ClickHouse 库表）"
  # clklog-init 是 Spring Boot 应用，冷启约 95s 才会执行建库逻辑（实测 2026-10-10）
  for _ in $(seq 1 60); do
    n="$(mg_ck "SELECT count() FROM system.tables WHERE database='${COMMUNITY_DB}'" 2>/dev/null || echo 0)"
    [ "${n:-0}" -ge 10 ] && break
    sleep 3
  done
  log "  社区版 ClickHouse 表数量：${n:-0}（19 为正常）"
fi

log "铲库完成。下一步："
log "  常规方案：bash deploy-native.sh"
log "  Docker 方案：bash deploy-docker.sh"
