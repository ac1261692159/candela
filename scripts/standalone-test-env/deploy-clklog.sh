#!/usr/bin/env bash
# deploy-clklog.sh — ClkLog 独立测试环境：应用层部署（幂等）
#
# 部署内容：ClkLog 社区版 1.3.0 标准模式（receiver → Kafka → Flink → ClickHouse）
#           clklog-ui / clklog-receiver / clklog-api / clklog-manage /
#           jobmanager + taskmanager(Flink) / clklog-init
#           + 宿主 nginx（单机入口，替代生产的域名 vhost）
#
# 前置：先执行 deploy-middleware.sh（MySQL/Redis/Kafka/ClickHouse 与本脚本共享 clklog-net 网络，
#       容器间通过服务名互访）。本脚本自身也做前置检查，缺哪层会明确报错。
#
# 与按域名拆分的多机部署相比，本环境是单机：
#   * 同一个 server 块内按路径分流，不依赖额外域名。
#   * 中间件用 compose 服务名寻址，不把云上地址写进仓库。
#
# 幂等保证：
#   * 所有配置由脚本渲染覆盖（脚本即可执行真相），重复执行结果一致。
#   * 容器 up -d 幂等；数据卷不重建；MySQL/Kafka 初始化可反复执行。
#   * nginx 配置写入后先 nginx -t 再 reload，配置非法不会打断已有服务。

set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SELF_DIR/lib.sh"

BASE_DIR="${BASE_DIR:-/data/clklog-oss-test}"
ASSETS_DIR="${ASSETS_DIR:-$BASE_DIR/assets}"
CLK_DIR="$BASE_DIR/clklog"
DC_CONFIG="$CLK_DIR/clklog_dc_config"
DC_DATA="$CLK_DIR/clklog_dc_data"
NGINX_CONF="/etc/nginx/conf.d/clklog-testenv.conf"

require_root
ensure_docker
[ -f "$ENV_FILE" ] || die "未找到 ${ENV_FILE}，请先执行 deploy-middleware.sh"
load_env

log "=============================================================="
log " ClkLog 应用层部署（BASE_DIR=${BASE_DIR}）"
log "=============================================================="

# ---------------------------------------------------------------- 0. 前置检查
for c in clklog-mysql clklog-redis clklog-kafka clklog-clickhouse; do
  docker inspect -f '{{.State.Status}}' "$c" >/dev/null 2>&1 || die "中间件容器 $c 不存在，请先执行 deploy-middleware.sh"
  [ "$(docker inspect -f '{{.State.Status}}' "$c")" = "running" ] || die "中间件容器 $c 未运行"
done
log "中间件容器检查通过"

# ---------------------------------------------------------------- 1. 镜像
# 版本与生产 Puppet 模板一致（ui 1.3.0 / receiver 1.2.0 / api 1.3.0 / manage 1.3.0 / init 1.2.3 / processing 1.2.0）
CK_REG="registry.cn-shanghai.aliyuncs.com/clklog"
ensure_image CLKLOG_UI_IMAGE        "$CK_REG/ui:1.3.0"         >/dev/null
ensure_image CLKLOG_RECEIVER_IMAGE  "$CK_REG/receiver:1.2.0"   >/dev/null
ensure_image CLKLOG_API_IMAGE       "$CK_REG/api:1.3.0"        >/dev/null
ensure_image CLKLOG_MANAGE_IMAGE    "$CK_REG/manage:1.3.0"     >/dev/null
ensure_image CLKLOG_INIT_IMAGE      "$CK_REG/init:1.2.3"       >/dev/null
ensure_image CLKLOG_PROCESSING_IMAGE "$CK_REG/processing:1.2.0" >/dev/null
load_env
log "镜像就绪：ui=$CLKLOG_UI_IMAGE receiver=$CLKLOG_RECEIVER_IMAGE api=$CLKLOG_API_IMAGE"
log "          manage=$CLKLOG_MANAGE_IMAGE init=$CLKLOG_INIT_IMAGE processing=$CLKLOG_PROCESSING_IMAGE"

# Flink job id：生产用一个固定值以保证 checkpoint 可恢复；本环境同样固定（写入 deploy.env）
set_env_once PROCESSING_JOB_ID "$(openssl rand -hex 16)"
load_env

# ---------------------------------------------------------------- 2. 目录与属主
# Flink checkpoints 属主必须 9999:9999（与生产红线一致）
ensure_dir "$DC_DATA/processing/checkpoints" 9999:9999
ensure_dir "$DC_DATA/receiver"               root:root
ensure_dir "$DC_DATA/initlog"                root:root
mkdir -p "$DC_CONFIG/ui" "$DC_CONFIG/manage" "$DC_CONFIG/processing"

# ---------------------------------------------------------------- 3. 静态配置（取自仓库 puppet 资产，单一来源）
if [ -f "$ASSETS_DIR/ui/config.js" ]; then
  cp -f "$ASSETS_DIR/ui/config.js" "$DC_CONFIG/ui/config.js"
else
  warn "缺少 $ASSETS_DIR/ui/config.js，使用内置默认值"
  printf 'window.globalConfig = {\n  BASE_API: "/api",\n  BASE_API_MANAGE: "/manage"\n};\n' > "$DC_CONFIG/ui/config.js"
fi
if [ -f "$ASSETS_DIR/manage/project-setting.json" ]; then
  cp -f "$ASSETS_DIR/manage/project-setting.json" "$DC_CONFIG/manage/"
fi
for f in city-eng-chs-map.txt country-eng-chs-map.txt; do
  [ -f "$ASSETS_DIR/manage/$f" ] && cp -f "$ASSETS_DIR/manage/$f" "$DC_CONFIG/manage/"
done

# Flink 作业配置：容器内服务名寻址 + 本环境随机口令
cat > "$DC_CONFIG/processing/config.properties" <<CONF
clickhouse.host=clickhouse:8123
clickhouse.database=$CLKLOG_LOG_DB
clickhouse.username=$CK_USER_NAME
clickhouse.password=$CK_USER_PWD
kafka.bootstrap.server=kafka:9092
#clklog conf
kafka.clklog-topic=clklog
kafka.clklog-group-id=clklog-group
flink.clklog-data-source-name=ClklogKafkaSource
#flink conf
flink.checkpoint=file:///opt/flink/usrlib/checkpoints
flink.parallelism=1
processing-file-location=/opt/flink/usrlib
redis.host=redis
redis.port=6379
redis.password=$REDIS_PASSWORD
redis.database=0
redis.pool.max-active=3
redis.pool.max-idle=3
redis.pool.min-idle=0
redis.pool.max-wait=-1
CONF
# Flink 容器以 flink(9999) 身份运行，文件必须对它可读，否则作业启动即 FileNotFoundException
chown 9999:9999 "$DC_CONFIG/processing/config.properties"
chmod 0640 "$DC_CONFIG/processing/config.properties"

# ---------------------------------------------------------------- 4. compose 文件
cat > "$CLK_DIR/docker-compose.yml" <<'YAML'
# 由 deploy-clklog.sh 生成，请勿手工修改（重新执行脚本会覆盖）
# 与生产 Puppet 模板（puppet/clklog/templates/docker-compose.yml.epp）结构一致，
# 差异：中间件地址改为 clklog-net 上的服务名；资源限制按 4C/15G 测试机下调。
name: clklog-testenv

services:
  clklog-ui:
    image: ${CLKLOG_UI_IMAGE}
    container_name: clklog-ui
    restart: always
    environment:
      TZ: Asia/Shanghai
    ports:
      - "127.0.0.1:8081:80"
    volumes:
      - ./clklog_dc_config/ui/config.js:/usr/share/nginx/html/config.js:ro
    networks: [clklog-net]
    deploy:
      resources:
        limits: { cpus: '0.3', memory: 64M }

  clklog-receiver:
    image: ${CLKLOG_RECEIVER_IMAGE}
    container_name: clklog-receiver
    restart: always
    # 跨 compose 栈的服务不在本项目内，不能用 depends_on；就绪性由脚本前置检查保证
    ports:
      - "127.0.0.1:8082:8080"
    volumes:
      - ./clklog_dc_data/receiver:/log
    environment:
      TZ: Asia/Shanghai
      SERVER_PORT: "8080"
      SPRING_REDIS_HOST: redis
      SPRING_REDIS_PORT: "6379"
      SPRING_REDIS_PASSWORD: ${REDIS_PASSWORD}
      SPRING_KAFKA_BOOTSTRAP_SERVERS: kafka:9092
      SPRING_DATASOURCE_CLICKHOUSE_JDBC_URL: jdbc:clickhouse://clickhouse/${CLKLOG_LOG_DB}
      SPRING_DATASOURCE_CLICKHOUSE_USERNAME: ${CK_USER_NAME}
      SPRING_DATASOURCE_CLICKHOUSE_PASSWORD: ${CK_USER_PWD}
      RECEIVER_RESOURCE_PATH: ""
      # false = 标准模式（写 Kafka 由 Flink 落库）；true = 快速模式（直写 ClickHouse）
      RECEIVER_ENABLE_SIMPLE_VERSION: "false"
      JAVA_OPTS: "-XX:+UseContainerSupport -XX:MaxRAMPercentage=70.0"
    networks: [clklog-net]
    deploy:
      resources:
        limits: { cpus: '0.5', memory: 640M }

  clklog-api:
    image: ${CLKLOG_API_IMAGE}
    container_name: clklog-api
    restart: always
    # 跨 compose 栈的服务不在本项目内，不能用 depends_on；就绪性由脚本前置检查保证
    ports:
      - "127.0.0.1:8083:8080"
    environment:
      TZ: Asia/Shanghai
      SERVER_PORT: "8080"
      SPRINGDOC_API_DOCS_PATH: /api/v3/api-docs
      SPRING_REDIS_HOST: redis
      SPRING_REDIS_PORT: "6379"
      SPRING_REDIS_PASSWORD: ${REDIS_PASSWORD}
      SPRING_DATASOURCE_CLICKHOUSE_JDBC_URL: jdbc:clickhouse://clickhouse/${CLKLOG_LOG_DB}
      SPRING_DATASOURCE_CLICKHOUSE_USERNAME: ${CK_USER_NAME}
      SPRING_DATASOURCE_CLICKHOUSE_PASSWORD: ${CK_USER_PWD}
      CLKLOG_COMMON_ACCESS_CONTROL_ALLOW_ORIGIN_PATTERNS: "*"
      CLKLOG_API_PROJECT_NAME: ${PROJECT_NAME}
      JAVA_OPTS: "-XX:+UseContainerSupport -XX:MaxRAMPercentage=70.0"
    networks: [clklog-net]
    deploy:
      resources:
        limits: { cpus: '0.5', memory: 640M }

  clklog-manage:
    image: ${CLKLOG_MANAGE_IMAGE}
    container_name: clklog-manage
    restart: always
    # 跨 compose 栈的服务不在本项目内，不能用 depends_on；就绪性由脚本前置检查保证
    ports:
      - "127.0.0.1:8084:8080"
    volumes:
      - ./clklog_dc_data/receiver:/receiverlog
      - ./clklog_dc_config/manage:/setting
    environment:
      TZ: Asia/Shanghai
      SERVER_PORT: "8080"
      SPRINGDOC_API_DOCS_PATH: /api/v3/api-docs
      SPRING_REDIS_HOST: redis
      SPRING_REDIS_PORT: "6379"
      SPRING_REDIS_PASSWORD: ${REDIS_PASSWORD}
      # 社区版由外部（init SQL）管理表结构，不用 Flyway 自动迁移
      SPRING_FLYWAY_ENABLED: "false"
      SPRING_DATASOURCE_CLICKHOUSE_JDBC_URL: jdbc:clickhouse://clickhouse/${CLKLOG_LOG_DB}
      SPRING_DATASOURCE_CLICKHOUSE_USERNAME: ${CK_USER_NAME}
      SPRING_DATASOURCE_CLICKHOUSE_PASSWORD: ${CK_USER_PWD}
      SPRING_DATASOURCE_MYSQL_JDBC_URL: jdbc:mysql://mysql:3306/clklog?characterEncoding=UTF-8&useTimezone=true&serverTimezone=GMT%2B8
      SPRING_DATASOURCE_MYSQL_USERNAME: root
      SPRING_DATASOURCE_MYSQL_PASSWORD: ${MYSQL_ROOT_PASSWORD}
      CLKLOG_COMMON_ACCESS_CONTROL_ALLOW_ORIGIN_PATTERNS: "*"
      CLKLOG_COMMON_ANONYMOUS_METHOD_LIST: /auth/login
      CLKLOG_MANAGE_LOG_STORE_PATH: /receiverlog
      JAVA_OPTS: "-XX:+UseContainerSupport -XX:MaxRAMPercentage=70.0"
    networks: [clklog-net]
    deploy:
      resources:
        limits: { cpus: '0.5', memory: 640M }

  clklog-init:
    image: ${CLKLOG_INIT_IMAGE}
    container_name: clklog-init
    restart: always
    # 跨 compose 栈的服务不在本项目内，不能用 depends_on；就绪性由脚本前置检查保证
    volumes:
      - ./clklog_dc_data/initlog:/log
    environment:
      TZ: Asia/Shanghai
      SERVER_PORT: "8080"
      SPRING_DATASOURCE_CLICKHOUSE_JDBC_URL: jdbc:clickhouse://clickhouse/default
      SPRING_DATASOURCE_CLICKHOUSE_USERNAME: ${CK_USER_NAME}
      SPRING_DATASOURCE_CLICKHOUSE_PASSWORD: ${CK_USER_PWD}
      JAVA_OPTS: "-XX:+UseContainerSupport -XX:MaxRAMPercentage=70.0"
    networks: [clklog-net]
    deploy:
      resources:
        limits: { cpus: '0.3', memory: 384M }

  jobmanager:
    image: ${CLKLOG_PROCESSING_IMAGE}
    container_name: clklog-jobmanager
    restart: always
    # 跨 compose 栈的服务不在本项目内，不能用 depends_on；就绪性由脚本前置检查保证
    ports:
      - "127.0.0.1:8085:8081"
    command: >
      standalone-job --job-classname com.zcunsoft.clklog.analysis.entry.JieXiJson
      --job-id ${PROCESSING_JOB_ID} --allowNonRestoredState
    volumes:
      - ./clklog_dc_data/processing/checkpoints:/opt/flink/usrlib/checkpoints:rw
      - ./clklog_dc_config/processing/config.properties:/opt/flink/config.properties:ro
    environment:
      TZ: Asia/Shanghai
      PROCESSING_JOB_ID: ${PROCESSING_JOB_ID}
      FLINK_PROPERTIES: |
        jobmanager.rpc.address: jobmanager
        parallelism.default: 2
        # process.size 不是堆大小：需扣除 metaspace(256m)+overhead+jvm-off-heap 才是堆。
        # 768m 时堆只剩 192m，作业起不来（实测反复重启）；1024m 起留出 ~448m 堆。
        jobmanager.memory.process.size: 1024m
    networks: [clklog-net]
    deploy:
      resources:
        limits: { cpus: '0.5', memory: 1280M }

  taskmanager:
    image: ${CLKLOG_PROCESSING_IMAGE}
    container_name: clklog-taskmanager
    restart: always
    depends_on: [jobmanager]
    command: taskmanager
    volumes:
      - ./clklog_dc_data/processing/checkpoints:/opt/flink/usrlib/checkpoints:rw
      - ./clklog_dc_config/processing/config.properties:/opt/flink/config.properties:ro
    environment:
      TZ: Asia/Shanghai
      PROCESSING_JOB_ID: ${PROCESSING_JOB_ID}
      FLINK_PROPERTIES: |
        jobmanager.rpc.address: jobmanager
        taskmanager.numberOfTaskSlots: 4
        # 同上：process.size 含框架/网络/托管内存，扣除后才是堆。
        # 1536m 时 task heap 仅约 400m：LogRichMapper 初始化 Yauaa UA 规则库本身就要几百 MiB，
        # 作业在 INITIALIZING 阶段反复 OOM 重启、数据始终不入库（2026-10-10 实测）。
        # 3072m 切出约 1.1 GiB 堆，初始化可过。
        taskmanager.memory.process.size: 3072m
    networks: [clklog-net]
    deploy:
      resources:
        limits: { cpus: '1.0', memory: 3328M }

networks:
  clklog-net:
    external: true
    name: clklog-net
YAML

# ---------------------------------------------------------------- 5. 启动
log "启动 ClkLog 容器（docker compose up -d）"
dc "$CLK_DIR" up -d

# 这些是 Java 应用，容器 "running" 不等于服务可用（Tomcat 要 30~90s 才监听端口）。
# 就绪判定必须打到真实端口，否则会把"刚起来"误报成就绪。
wait_http_ok() {
  local name="$1" url="$2" deadline=$(( $(date +%s) + ${3:-180} )) code
  while [ "$(date +%s)" -lt "$deadline" ]; do
    docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null | grep -q running || { warn "  ${name} 已退出"; return 1; }
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$url" 2>/dev/null || echo 000)
    [ "$code" != "000" ] && return 0
    sleep 5
  done
  warn "  ${name} 在超时内未监听端口（请查 docker logs ${name}）"
  return 1
}

# 单项失败不中断：把后面的 nginx 入口配完，问题留给 verify.sh 复查
wait_http_ok clklog-ui         "http://127.0.0.1:8081/"                   120 && log "  clklog-ui 就绪" || warn "  clklog-ui 未就绪"
wait_http_ok clklog-receiver   "http://127.0.0.1:8082/receiver/api/gp"    240 && log "  clklog-receiver 就绪" || warn "  clklog-receiver 未就绪"
wait_http_ok clklog-api        "http://127.0.0.1:8083/api/v3/api-docs"    300 && log "  clklog-api 就绪" || warn "  clklog-api 未就绪"
wait_http_ok clklog-manage     "http://127.0.0.1:8084/manage/v3/api-docs" 300 && log "  clklog-manage 就绪" || warn "  clklog-manage 未就绪"
wait_http_ok clklog-jobmanager "http://127.0.0.1:8085/"                   180 && log "  clklog-jobmanager 就绪" || warn "  clklog-jobmanager 未就绪"

# clklog-init 负责建 ClickHouse 库表，等它把库建出来再往下走
log "等待 clklog-init 建库（clklog.clickhouse）..."
deadline=$(( $(date +%s) + 300 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ "$(ck_query "SELECT count() FROM system.databases WHERE name='$CLKLOG_LOG_DB'" 2>/dev/null)" = "1" ]; then
    log "  ClickHouse 数据库 $CLKLOG_LOG_DB 已创建"
    break
  fi
  sleep 5
done

# ---------------------------------------------------------------- 6. 宿主 nginx
if ! command -v nginx >/dev/null 2>&1; then
  ensure_dnf_mirrors
  dnf -y install nginx
fi
# 单机入口：按路径分流（对应生产 clklog-admin vhost 的 5 个 location + 上报路径）
cat > "$NGINX_CONF" <<'NGINX'
# 由 deploy-clklog.sh 生成。路径分流对应生产 nginx 的 clklog-admin / receiver-* 两个 vhost。
server {
    listen 80 default_server;
    server_name _;

    # SDK 批量上报体较大（base64 批次），放宽默认 1m 限制
    client_max_body_size 20m;

    # clklog_manager（分析平台）的 /sa/ 路由片段目录：由 manager 的部署脚本维护，
    # 目录为空时不影响本配置。写死这一行是为了让「重跑社区版部署」不会抹掉 /sa/ 入口。
    include /etc/nginx/mgr-locations/*.inc;

    # --- 数据上报 --- /receiver/api/gp
    location /receiver/ {
        proxy_pass http://127.0.0.1:8082/;
        proxy_set_header Host $host:$server_port;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # --- swagger（保留前缀）---
    location /api/v3/ {
        proxy_pass http://127.0.0.1:8083/api/v3/;
        proxy_set_header Host $host:$server_port;
    }
    location /manage/v3/ {
        proxy_pass http://127.0.0.1:8084/manage/v3/;
        proxy_set_header Host $host:$server_port;
    }

    # --- 统计查询 / 管理接口（去前缀）---
    location /api/ {
        proxy_pass http://127.0.0.1:8083/;
        proxy_set_header Host $host:$server_port;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
    location /manage/ {
        proxy_pass http://127.0.0.1:8084/;
        proxy_set_header Host $host:$server_port;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # --- 前端单页应用 ---
    location / {
        proxy_pass http://127.0.0.1:8081/;
        proxy_set_header Host $host:$server_port;
    }
}
NGINX
mkdir -p /etc/nginx/mgr-locations
systemctl enable nginx >/dev/null 2>&1 || true
if nginx -t >/dev/null 2>&1; then
  systemctl reload nginx 2>/dev/null || systemctl restart nginx
  log "nginx 配置已生效（${NGINX_CONF}）"
else
  nginx -t || true
  die "nginx 配置校验失败，未 reload（已有服务未受影响）"
fi

# ---------------------------------------------------------------- 7. 汇总
log "--------------------------------------------------------------"
log "ClkLog 应用层部署完成。入口：http://$(hostname -I | awk '{print $1}')/"
log "  前端 UI   /            → clklog-ui:80"
log "  上报      /receiver/   → clklog-receiver:8080（标准模式：写 Kafka）"
log "  统计 API  /api/        → clklog-api:8080"
log "  管理 API  /manage/     → clklog-manage:8080"
log "  Flink UI  127.0.0.1:8085（仅宿主，SSH 隧道访问）"
log "  默认账号  admin / 见社区版 init SQL 内置口令；建库后可在管理后台改密"
log "--------------------------------------------------------------"
