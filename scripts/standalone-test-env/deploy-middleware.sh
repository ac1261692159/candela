#!/usr/bin/env bash
# deploy-middleware.sh — ClkLog 独立测试环境：中间件层部署（幂等）
#
# 部署内容：Docker CE + MySQL 8.0 + Redis 7 + Kafka(KRaft) + ClickHouse 23.2
# 与生产环境的差异（有意为之，见 docs/architecture/standalone-test-env-design.md）：
#   * 生产用云托管 MySQL/Redis/CKafka；本环境全部容器化自建。
#   * 生产把 ClickHouse 放在 ClkLog compose 里；本环境归入中间件栈，便于独立启停。
#
# 幂等保证：
#   * 口令首次生成后写入 deploy.env，重复执行复用旧值（改口令会与已初始化数据不一致）。
#   * 目录/网络/容器/topic/表结构全部按"存在即跳过"处理。
#   * MySQL 表结构用 CREATE TABLE IF NOT EXISTS + INSERT IGNORE，可反复执行。
#   * 数据目录不重建，重复执行不丢数据。
#
# 用法：
#   bash deploy-middleware.sh                 # 使用默认 BASE_DIR=/data/clklog-oss-test
#   BASE_DIR=/opt/xx bash deploy-middleware.sh
#   ASSETS_DIR=/data/clklog-oss-test/assets   # 需含 init/mysql_clklog.sql

set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SELF_DIR/lib.sh"

BASE_DIR="${BASE_DIR:-/data/clklog-oss-test}"
ASSETS_DIR="${ASSETS_DIR:-$BASE_DIR/assets}"
MW_DIR="$BASE_DIR/middleware"

require_root
init_env_file
ensure_dnf_mirrors
ensure_docker
ensure_sysctl

log "=============================================================="
log " 中间件层部署（BASE_DIR=${BASE_DIR}）"
log "=============================================================="

# ---------------------------------------------------------------- 1. 口令
MYSQL_ROOT_PASSWORD="$(ensure_secret MYSQL_ROOT_PASSWORD)"
REDIS_PASSWORD="$(ensure_secret REDIS_PASSWORD)"
CK_USER_PWD="$(ensure_secret CK_USER_PWD)"
set_env_once KAFKA_CLUSTER_ID "$(gen_kafka_cluster_id)"
set_env_once CK_USER_NAME "default"
set_env_once CLKLOG_LOG_DB "clklog"
set_env_once PROJECT_NAME "clklogapp"
load_env

# ---------------------------------------------------------------- 2. 镜像
log "解析镜像来源（候选列表逐个尝试，命中后写入 ${ENV_FILE}）"
ensure_image MYSQL_IMAGE \
  "public.ecr.aws/docker/library/mysql:8.0" \
  "hub.rat.dev/library/mysql:8.0" \
  "docker.m.daocloud.io/library/mysql:8.0" >/dev/null
ensure_image REDIS_IMAGE \
  "public.ecr.aws/docker/library/redis:7-alpine" \
  "hub.rat.dev/library/redis:7-alpine" \
  "docker.m.daocloud.io/library/redis:7-alpine" >/dev/null
ensure_image KAFKA_IMAGE \
  "apache/kafka:3.7.0" \
  "hub.rat.dev/apache/kafka:3.7.0" \
  "docker.m.daocloud.io/apache/kafka:3.7.0" >/dev/null
# ClickHouse 只从 ClkLog 官方镜像源取，保证与生产同版本同配置项
ensure_image CLICKHOUSE_IMAGE \
  "registry.cn-shanghai.aliyuncs.com/clklog/clickhouse_clickhouse-server:23.2.1" >/dev/null
load_env
log "  mysql      = $MYSQL_IMAGE"
log "  redis      = $REDIS_IMAGE"
log "  kafka      = $KAFKA_IMAGE"
log "  clickhouse = $CLICKHOUSE_IMAGE"

# ---------------------------------------------------------------- 3. 目录与属主
# 属主对齐生产红线：ClickHouse 数据/日志目录必须 101:101。
ensure_dir "$BASE_DIR/data/mysql"              999:999
ensure_dir "$BASE_DIR/data/redis"              999:999
ensure_dir "$BASE_DIR/data/kafka"              1000:1000
ensure_dir "$BASE_DIR/data/clickhouse"         101:101
ensure_dir "$BASE_DIR/data/clickhouse/log"     101:101
mkdir -p "$MW_DIR/clickhouse/config.d" "$MW_DIR/clickhouse/users.d" "$MW_DIR/redis" "$MW_DIR/mysql-init"

# ---------------------------------------------------------------- 4. 渲染配置
# ClickHouse：日志 TTL 收敛（与生产 config.d 一致，避免小盘被系统日志写满）
cat > "$MW_DIR/clickhouse/config.d/default-config.xml" <<'XML'
<clickhouse>
    <logger>
        <level>notice</level>
    </logger>
    <query_log><ttl>event_date + INTERVAL 3 DAY</ttl></query_log>
    <trace_log><ttl>event_date + INTERVAL 3 DAY</ttl></trace_log>
    <query_thread_log><ttl>event_date + INTERVAL 3 DAY</ttl></query_thread_log>
    <query_views_log><ttl>event_date + INTERVAL 3 DAY</ttl></query_views_log>
    <part_log><ttl>event_date + INTERVAL 3 DAY</ttl></part_log>
    <text_log><ttl>event_date + INTERVAL 3 DAY</ttl></text_log>
    <metric_log><ttl>event_date + INTERVAL 3 DAY</ttl></metric_log>
    <asynchronous_metric_log><ttl>event_date + INTERVAL 3 DAY</ttl></asynchronous_metric_log>
</clickhouse>
XML

# ClickHouse：default 口令（double_sha1 存储）+ 插入行为 profile
cat > "$MW_DIR/clickhouse/users.d/default-password.xml" <<XML
<clickhouse>
    <profiles>
        <default>
            <max_partitions_per_insert_block>200</max_partitions_per_insert_block>
        </default>
    </profiles>
    <users>
        <default>
            <password remove='1' />
            <password_double_sha1_hex>$(ck_double_sha1 "$CK_USER_PWD")</password_double_sha1_hex>
            <access_management>1</access_management>
        </default>
    </users>
</clickhouse>
XML
chmod 0644 "$MW_DIR/clickhouse/config.d/default-config.xml" "$MW_DIR/clickhouse/users.d/default-password.xml"

# Redis：口令走配置文件（避免出现在容器 Args 里被 docker inspect 看见）
cat > "$MW_DIR/redis/redis.conf" <<CONF
bind 0.0.0.0
protected-mode yes
port 6379
requirepass $REDIS_PASSWORD
dir /data
appendonly yes
appendfsync everysec
maxmemory 128mb
maxmemory-policy allkeys-lru
CONF
# 容器以 redis(999) 身份运行，配置文件必须对它可读，否则启动即 Permission denied
chown 999:999 "$MW_DIR/redis/redis.conf"
chmod 0640 "$MW_DIR/redis/redis.conf"

# MySQL 初始化 SQL：把 INSERT 改写成 INSERT IGNORE，使反复执行为幂等
if [ -f "$ASSETS_DIR/init/mysql_clklog.sql" ]; then
  sed 's/^INSERT INTO/INSERT IGNORE INTO/' "$ASSETS_DIR/init/mysql_clklog.sql" > "$MW_DIR/mysql-init/01-clklog-schema.sql"
else
  warn "未找到 $ASSETS_DIR/init/mysql_clklog.sql，跳过自动建表（可稍后手工导入）"
fi

# ---------------------------------------------------------------- 5. compose 文件
cat > "$MW_DIR/docker-compose.yml" <<'YAML'
# 由 deploy-middleware.sh 生成，请勿手工修改（重新执行脚本会覆盖）
name: clklog-testenv-mw

services:
  mysql:
    image: ${MYSQL_IMAGE}
    container_name: clklog-mysql
    restart: always
    command:
      - --character-set-server=utf8mb4
      - --collation-server=utf8mb4_general_ci
      - --default-time-zone=+08:00
      - --max-connections=300
    environment:
      TZ: Asia/Shanghai
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD}
    volumes:
      - ../data/mysql:/var/lib/mysql
      # 刻意不挂 /docker-entrypoint-initdb.d：entrypoint 导入无法指定客户端字符集，
      # 容器内 mysql 客户端默认 latin1 会把中文写成双重编码。建表统一由脚本显式导入。
    ports:
      - "127.0.0.1:3306:3306"
    networks: [clklog-net]
    healthcheck:
      test: ["CMD-SHELL", "mysqladmin ping -h127.0.0.1 -uroot -p\"$$MYSQL_ROOT_PASSWORD\" --silent"]
      interval: 10s
      timeout: 5s
      retries: 15
      start_period: 40s
    deploy:
      resources:
        limits: { cpus: '0.5', memory: 640M }

  redis:
    image: ${REDIS_IMAGE}
    container_name: clklog-redis
    restart: always
    command: ["redis-server", "/usr/local/etc/redis/redis.conf"]
    environment:
      TZ: Asia/Shanghai
      # 仅供健康检查取用（口令本体在挂载的 redis.conf 内）
      REDIS_PASSWORD: ${REDIS_PASSWORD}
    volumes:
      - ../data/redis:/data
      - ./redis/redis.conf:/usr/local/etc/redis/redis.conf:ro
    ports:
      - "127.0.0.1:6379:6379"
    networks: [clklog-net]
    healthcheck:
      test: ["CMD-SHELL", "redis-cli --no-auth-warning -a \"$$REDIS_PASSWORD\" ping | grep -q PONG"]
      interval: 10s
      timeout: 5s
      retries: 10
    deploy:
      resources:
        limits: { cpus: '0.2', memory: 192M }

  kafka:
    image: ${KAFKA_IMAGE}
    container_name: clklog-kafka
    restart: always
    environment:
      TZ: Asia/Shanghai
      CLUSTER_ID: ${KAFKA_CLUSTER_ID}
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_LISTENERS: INTERNAL://:9092,CONTROLLER://:9093,EXTERNAL://:19092
      KAFKA_ADVERTISED_LISTENERS: INTERNAL://kafka:9092,EXTERNAL://127.0.0.1:19092
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: INTERNAL:PLAINTEXT,CONTROLLER:PLAINTEXT,EXTERNAL:PLAINTEXT
      KAFKA_INTER_BROKER_LISTENER_NAME: INTERNAL
      KAFKA_CONTROLLER_QUORUM_VOTERS: 1@kafka:9093
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 1
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: 0
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: "true"
      KAFKA_LOG_DIRS: /var/lib/kafka/data
      KAFKA_HEAP_OPTS: -Xmx512m -Xms512m
    volumes:
      - ../data/kafka:/var/lib/kafka/data
    ports:
      - "127.0.0.1:19092:19092"
    networks: [clklog-net]
    healthcheck:
      # 只用 TCP 探活：kafka-broker-api-versions.sh 每次探测都要起一个 JVM 客户端，
      # 在 0.5 CPU 限额下经常超过 timeout 被判 unhealthy（2026-10-10 实测：容器长期
      # unhealthy 但功能正常，代价是中间件重跑时的"等容器就绪"会误报超时）。
      # broker 可用性由 verify.sh 的端到端链路验证，不靠健康检查承担。
      test: ["CMD-SHELL", "bash -c 'exec 3<>/dev/tcp/127.0.0.1/9092' 2>/dev/null || exit 1"]
      interval: 15s
      timeout: 5s
      retries: 10
      start_period: 30s
    deploy:
      resources:
        limits: { cpus: '0.5', memory: 768M }

  clickhouse:
    image: ${CLICKHOUSE_IMAGE}
    container_name: clklog-clickhouse
    restart: always
    environment:
      TZ: Asia/Shanghai
    volumes:
      # 必须挂"单个文件"而不是整个 config.d 目录：
      # 官方镜像的 config.d/docker_related_config.xml 负责把 listen_host 设为 0.0.0.0，
      # 挂目录会把该文件一起遮掉，导致 ClickHouse 只监听 127.0.0.1/::1，
      # 表现为容器间与宿主端口映射全部 Connection refused。生产 Puppet 同样是按文件挂载。
      - ./clickhouse/config.d/default-config.xml:/etc/clickhouse-server/config.d/default-config.xml:rw
      # users.d 反过来必须挂"整个目录"：镜像自带的 users.d 是空的（实测 ls 为空），
      # 挂目录不会遮掉任何官方配置；而 clklog_manager 需要在其中追加只读账号
      # sa_readonly.xml（分析平台 SQL 查询/AI 只读账号）。config.d 不能这样挂，原因见上。
      - ./clickhouse/users.d:/etc/clickhouse-server/users.d:rw
      - ../data/clickhouse/log:/var/log/clickhouse-server
      - ../data/clickhouse:/var/lib/clickhouse:rw
    ports:
      - "8123:8123"
      - "9000:9000"
    networks: [clklog-net]
    ulimits:
      nofile: { soft: 262144, hard: 262144 }
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8123/ping"]
      interval: 15s
      timeout: 5s
      retries: 10
      start_period: 20s
    deploy:
      resources:
        limits: { cpus: '1.0', memory: 5G }

networks:
  clklog-net:
    external: true
    name: clklog-net
YAML

# ---------------------------------------------------------------- 6. 启动
ensure_network
log "启动中间件容器（docker compose up -d）"
dc "$MW_DIR" up -d

log "等待容器就绪"
for c in clklog-mysql clklog-redis clklog-kafka clklog-clickhouse; do
  wait_container_healthy "$c" 300 && log "  $c 就绪" || warn "  $c 未在超时内就绪"
done

# ---------------------------------------------------------------- 7. 初始化
log "应用 MySQL 表结构（幂等）"
if [ -f "$MW_DIR/mysql-init/01-clklog-schema.sql" ]; then
  # 必须显式指定 --default-character-set=utf8mb4：容器内 mysql 客户端的默认字符集是 latin1，
  # 不指定会把种子数据里的中文（管理员 / 已保存）按 latin1 解释后双重编码写库（实测 HEX 变
  # C3A7C2AE...），表现为管理后台显示乱码。
  docker exec -i -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" clklog-mysql \
    mysql --default-character-set=utf8mb4 -uroot < "$MW_DIR/mysql-init/01-clklog-schema.sql"
  n=$(docker exec -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" clklog-mysql \
      mysql -uroot -N -B -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='clklog'")
  log "  clklog 库表数量：$n"
fi

log "校正常见中文列（幂等；仅修正种子数据被双重编码的历史写入）"
docker exec -e MYSQL_PWD="$MYSQL_ROOT_PASSWORD" clklog-mysql \
  mysql --default-character-set=utf8mb4 -uroot clklog -e "
    UPDATE tbl_project SET status = '已保存'
      WHERE project_name = 'clklogapp' AND status <> '已保存';
    UPDATE sys_user SET display_name = '管理员'
      WHERE user_name = 'admin' AND display_name <> '管理员';" 2>/dev/null | tail -1 || true

log "创建 Kafka topic（幂等）"
docker exec clklog-kafka /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 --create --if-not-exists \
  --topic clklog --partitions 6 --replication-factor 1 >/dev/null
# 用 sed 而不是 `| head -1`：head 读到一行就关管道，kafka-topics.sh 收到 SIGPIPE，
# 配合 set -o pipefail 会让整个部署脚本以 141 提前退出（2026-10-10 实测两次踩到，
# 表现为「日志停在创建 topic 处、汇总不打印」，但前面的部署其实已完成）。
docker exec clklog-kafka /opt/kafka/bin/kafka-topics.sh \
  --bootstrap-server localhost:9092 --describe --topic clklog | sed -n '1p'

# ---------------------------------------------------------------- 8. 汇总
log "--------------------------------------------------------------"
log "中间件层部署完成。连接信息（口令见 ${ENV_FILE}）："
log "  MySQL      127.0.0.1:3306  user=root              db=clklog"
log "  Redis      127.0.0.1:6379  requirepass 已启用"
log "  Kafka      127.0.0.1:19092 (宿主调试用) / kafka:9092 (容器内)  topic=clklog"
log "  ClickHouse 0.0.0.0:8123    user=default           db=clklog（由 clklog-init 创建）"
log "--------------------------------------------------------------"
