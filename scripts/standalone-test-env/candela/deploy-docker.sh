#!/usr/bin/env bash
# deploy-docker.sh — candela「docker-compose 方案」部署（幂等）
#
# 形态：
#   镜像：public.ecr.aws/docker/library/node:24-bookworm-slim（构建/运行）
#         public.ecr.aws/docker/library/nginx:1.27-alpine（前端静态）
#   栈名：candela，接入中间件共享网络 clklog-net（服务名寻址 mysql/redis/kafka/clickhouse）
#   容器：manager-server(:3100) / manager-ingestor / manager-web(:8086) / manager-migrate(仅 run --rm)
#   入口：宿主 nginx 仍为统一入口（/sa/ → 8086 静态，/sa/api|harness → 3100）
#
# 与常规方案的差异只在「怎么加载」：数据库初始化脚本、配置渲染、密钥契约完全共用。
#
# 幂等与可回滚：
#   * 镜像按内容哈希打 tag（candela-server:<短哈希>）：内容不变则复用已有镜像，不重建
#   * deploy.env 记录当前 tag；回滚=改回上一个 tag 再 up -d
#   * compose up -d 幂等；数据卷不重建；DB 初始化脚本自身幂等
#
# 用法：
#   bash deploy-docker.sh              # 构建 + 初始化 + 起栈 + nginx
#   bash deploy-docker.sh --skip-build # 复用当前 tag 的镜像，只重发配置/重启

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SELF_DIR/lib.sh"

SKIP_BUILD=0
[ "${1:-}" = "--skip-build" ] && SKIP_BUILD=1

require_root
ensure_docker
init_env_file
load_manager_secrets
set_endpoints docker   # 容器内用服务名寻址

DOCKER_DIR="$BASE_DIR/docker"
CFG_DIR="$BASE_DIR/configs"
SERVICE_ENV="$ENV_FILE"
STABLE_CONFIG="$CFG_DIR/config.yaml"
COMPOSE_FILE="$DOCKER_DIR/docker-compose.yml"
NODE_IMAGE="${NODE_IMAGE:-public.ecr.aws/docker/library/node:24-bookworm-slim}"
NGINX_IMAGE="${NGINX_IMAGE:-public.ecr.aws/docker/library/nginx:1.27-alpine}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"
APT_MIRROR="${APT_MIRROR:-mirrors.aliyun.com}"   # 国内构建环境用阿里云 Debian 源；海外可置空

log "=============================================================="
log " Candela Docker 方案部署（docker-compose）"
log " BASE_DIR=$BASE_DIR  栈名=candela  网络=clklog-net"
log "=============================================================="

# ---------------------------------------------------------------- 0. 前置
for c in clklog-mysql clklog-clickhouse clklog-redis clklog-kafka; do
  [ "$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null)" = "running" ] || die "中间件容器 $c 未运行"
done
command -v nginx >/dev/null 2>&1 || die "宿主 nginx 未安装（统一入口需要）"
ensure_network
log "前置检查通过：中间件 4 容器 running、nginx 已装、网络 clklog-net 就绪"

# ---------------------------------------------------------------- 1. 镜像
# 互斥：常规方案（supervisord）与 docker 方案都占用 :3100 与 /sa/ 路由，不能同时跑
if command -v supervisorctl >/dev/null 2>&1; then
  if supervisorctl status candela_server 2>/dev/null | grep -q RUNNING; then
    log "检测到常规方案进程仍在运行（同端口/同路由）→ 先停掉"
    supervisorctl stop candela_server candela_ingestor >/dev/null 2>&1 || true
  fi
fi

mkdir -p "$DOCKER_DIR" "$CFG_DIR" "$BASE_DIR/dlq" "$BASE_DIR/logs"
# 说明：migrate 容器通过 compose 的 `../ops:/app/ops:ro` 直接看到宿主上的整套脚本
# （$BASE_DIR/ops），不需要再往 $DOCKER_DIR 里复制一份。

# 镜像源：先确保基础镜像在本地（ECR 公共库；docker.io 在本环境不可达）
for img in "$NODE_IMAGE" "$NGINX_IMAGE"; do
  if ! docker image inspect "$img" >/dev/null 2>&1; then
    log "拉取基础镜像 $img"
    timeout 600 docker pull -q "$img" >/dev/null || die "基础镜像拉取失败：$img"
  fi
done

# 内容哈希必须包含 Dockerfile 与 nginx 配置：改构建配方（例如补 OpenSSL）而不改源码时，
# 也必须重建镜像，否则会误判"镜像已存在"而复用旧镜像（2026-10-10 实测踩到）。
CODE_HASH="$(find "$SRC_SERVER/src" "$SRC_SERVER/prisma" "$SRC_SERVER/package-lock.json" \
                  "$SRC_SERVER/Dockerfile" \
                  "$SRC_WEB/src" "$SRC_WEB/package-lock.json" \
                  "$SRC_WEB/Dockerfile" "$SRC_WEB/docker" \
                  "$SRC_DIR/apps/analytics-harness-host/plugins" -type f 2>/dev/null \
             | sort | xargs sha256sum 2>/dev/null | sha256sum | cut -d' ' -f1)"
SHORT_HASH="${CODE_HASH:0:12}"
SERVER_TAG="candela-server:${SHORT_HASH}"
INGESTOR_TAG="$SERVER_TAG"
WEB_TAG="candela-web:${SHORT_HASH}"
MIGRATE_TAG="candela-migrate:${SHORT_HASH}"

if [ "$SKIP_BUILD" -eq 0 ]; then
  if docker image inspect "$SERVER_TAG" >/dev/null 2>&1 && docker image inspect "$WEB_TAG" >/dev/null 2>&1; then
    log "内容哈希 ${SHORT_HASH} 对应镜像已存在 → 跳过构建"
  else
    log "构建后端镜像（target=runtime / migrate，tag=${SHORT_HASH}）"
    # 注意：后端构建上下文是 apps/analytics-server（自包含）
    docker build --target runtime -t "$SERVER_TAG" -f "$SRC_SERVER/Dockerfile" \
      --build-arg "NODE_IMAGE=$NODE_IMAGE" --build-arg "NPM_REGISTRY=$NPM_REGISTRY" --build-arg "APT_MIRROR=$APT_MIRROR" "$SRC_SERVER"
    docker build --target migrate -t "$MIGRATE_TAG" -f "$SRC_SERVER/Dockerfile" \
      --build-arg "NODE_IMAGE=$NODE_IMAGE" --build-arg "NPM_REGISTRY=$NPM_REGISTRY" --build-arg "APT_MIRROR=$APT_MIRROR" "$SRC_SERVER"
    log "构建前端镜像（上下文=含 apps/ 的目录；前端构建依赖兄弟应用，见 Dockerfile 注释）"
    docker build --target runtime -t "$WEB_TAG" -f "$SRC_WEB/Dockerfile" \
      --build-arg "NODE_IMAGE=$NODE_IMAGE" --build-arg "NGINX_IMAGE=$NGINX_IMAGE" \
      --build-arg "NPM_REGISTRY=$NPM_REGISTRY" "$SRC_DIR"
  fi
else
  log "跳过构建（--skip-build）"
  SERVER_TAG="$(get_env DOCKER_SERVER_TAG)"
  [ -n "$SERVER_TAG" ] || die "deploy.env 里没有 DOCKER_SERVER_TAG，无法 --skip-build"
  INGESTOR_TAG="$SERVER_TAG"; MIGRATE_TAG="$(get_env DOCKER_MIGRATE_TAG)"; WEB_TAG="$(get_env DOCKER_WEB_TAG)"
fi

# ---------------------------------------------------------------- 2. 配置与密钥
render_config_yaml "$SRC_SERVER/config_server.yaml" "$STABLE_CONFIG"
write_service_env
log "配置已渲染：$STABLE_CONFIG + 密钥：$SERVICE_ENV（0600）"

# ---------------------------------------------------------------- 2b. 记录镜像 tag
# 必须在 write_service_env **之后**：它覆盖写整个 env 文件（只含密钥与派生键），
# 之前写进去的 DOCKER_*_TAG 会被抹掉，`--skip-build`（回滚路径）随之读不到 tag —— 
# 2026-10-10 实测踩到（首次部署成功、回滚命令却报"deploy.env 里没有 DOCKER_SERVER_TAG"）。
set_env_once DOCKER_SERVER_TAG "$SERVER_TAG"
set_env_once DOCKER_MIGRATE_TAG "$MIGRATE_TAG"
set_env_once DOCKER_WEB_TAG "$WEB_TAG"
# 内容变了则更新记录
sed -i "s|^DOCKER_SERVER_TAG=.*|DOCKER_SERVER_TAG=$SERVER_TAG|; s|^DOCKER_MIGRATE_TAG=.*|DOCKER_MIGRATE_TAG=$MIGRATE_TAG|; s|^DOCKER_WEB_TAG=.*|DOCKER_WEB_TAG=$WEB_TAG|" "$ENV_FILE"
export DOCKER_SERVER_TAG="$SERVER_TAG" DOCKER_MIGRATE_TAG="$MIGRATE_TAG" DOCKER_WEB_TAG="$WEB_TAG"

# ---------------------------------------------------------------- 3. compose 文件
cat > "$COMPOSE_FILE" <<'YAML'
# 由 deploy-docker.sh 渲染，请勿手工修改
# 网络 clklog-net 为外部网络（由中间件栈创建），因此这里服务名 mysql/redis/kafka/clickhouse 可解析
name: candela

x-manager-env: &manager-env
  TZ: UTC
  NODE_ENV: production
  APP_CONFIG_PATH: /app/configs/config.yaml
  # DLQ 显式落独立卷：默认路径由 __dirname 推导，会随产物布局变化（dist/ 与 dist/src/ 不同），
  # 落在发布目录内还会随版本切换丢失（生产同源缺陷，见部署文档）
  DLQ_DIR: /app/dlq

services:
  manager-server:
    image: ${DOCKER_SERVER_TAG}
    container_name: candela-server
    restart: always
    env_file: [../configs/candela.env]
    environment:
      <<: *manager-env
      ENABLE_INGESTOR: "false"     # 本容器只做 HTTP；后台 worker 由它承担
    command: ["node", "dist/main.js"]
    # 资源上限：同机还跑着 ClickHouse(5G)/社区版等，跑飞的 Node 会拖垮整机
    deploy:
      resources:
        limits: { cpus: '0.8', memory: 768M }
    volumes:
      - ../configs/config.yaml:/app/configs/config.yaml:ro
      - ../dlq:/app/dlq
      - ../logs:/app/logs
    ports:
      - "127.0.0.1:3100:3100"
    networks: [clklog-net]
    healthcheck:
      # 用 node 自检而不是 wget/curl：node:*-slim 里没有 wget/curl（实测健康检查因此一直 unhealthy，
      # 而服务其实正常）。/sa/api/health 受 AuthGuard 保护，401 也算"进程在监听"。
      test: ["CMD-SHELL", "node -e \"require('http').get('http://127.0.0.1:3100/sa/api/health',r=>process.exit([200,401,403].includes(r.statusCode)?0:1)).on('error',()=>process.exit(1))\""]
      interval: 15s
      timeout: 5s
      retries: 10
      start_period: 40s

  manager-ingestor:
    image: ${DOCKER_INGESTOR_TAG}
    container_name: candela-ingestor
    restart: always
    env_file: [../configs/candela.env]
    environment:
      <<: *manager-env
      ENABLE_INGESTOR: "true"      # 该进程只做 Kafka 消费与写入，不启用后台 worker
    command: ["node", "dist/scripts/run-ingestor.js"]
    deploy:
      resources:
        limits: { cpus: '0.5', memory: 512M }
    volumes:
      - ../configs/config.yaml:/app/configs/config.yaml:ro
      - ../dlq:/app/dlq
      - ../logs:/app/logs
    networks: [clklog-net]

  manager-web:
    image: ${DOCKER_WEB_TAG}
    container_name: candela-web
    restart: always
    ports:
      - "127.0.0.1:8086:80"
    deploy:
      resources:
        limits: { cpus: '0.2', memory: 64M }
    networks: [clklog-net]
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1/lbcheck >/dev/null 2>&1 || exit 1"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 5s

  # 迁移/初始化专用（不随 up 启动；用 docker compose run --rm manager-migrate …）
  manager-migrate:
    image: ${DOCKER_MIGRATE_TAG}
    container_name: candela-migrate
    profiles: ["tools"]
    env_file: [../configs/candela.env]
    environment:
      <<: *manager-env
    volumes:
      - ../configs/config.yaml:/app/configs/config.yaml:ro
      - ../ops:/app/ops:ro
    networks: [clklog-net]

networks:
  clklog-net:
    external: true
    name: clklog-net
YAML

# ---------------------------------------------------------------- 4. 起栈（显式服务名，排除 migrate）
# 注意 DOCKER_INGESTOR_TAG 由 --env-file 注入；compose 变量替换用 ${VAR}
grep -q "^DOCKER_INGESTOR_TAG=" "$ENV_FILE" || printf 'DOCKER_INGESTOR_TAG=%s\n' "$INGESTOR_TAG" >> "$ENV_FILE"
sed -i "s|^DOCKER_INGESTOR_TAG=.*|DOCKER_INGESTOR_TAG=$INGESTOR_TAG|" "$ENV_FILE"

log "启动 manager 容器"
dc "$DOCKER_DIR" up -d manager-server manager-ingestor manager-web
# compose 只对「镜像 tag / env 变化」重建容器；挂载的 config.yaml / candela.env **内容**变化
# 不在其判定内 → 显式 restart 一次，保证新渲染的配置一定生效（2026-10-10 与 native 同源的坑：
# 配置改了但容器没重启，日志却显示"部署完成"）。web 是 tag 驱动的静态，无需 restart。
dc "$DOCKER_DIR" restart manager-server manager-ingestor

# ---------------------------------------------------------------- 5. 数据库初始化（与常规方案共用同一套脚本）
log "初始化数据库（runner=docker）"
bash "$SELF_DIR/init-db-mysql.sh" --runner docker
bash "$SELF_DIR/init-db-clickhouse.sh" --runner docker

# ---------------------------------------------------------------- 6. nginx（统一入口）
render_nginx_and_reload docker "" "127.0.0.1:8086" "127.0.0.1:3100"

# ---------------------------------------------------------------- 7. 就绪与汇总
log "等待服务就绪"
if wait_http_code "http://127.0.0.1:3100/sa/api/health" '^(200|401|403)$' 240; then
  log "  后端就绪：GET /sa/api/health → 401（受鉴权保护，能返回即已监听）"
else
  warn "  后端未就绪，请查：docker logs candela-server"
fi
if wait_http_code "http://127.0.0.1/sa/" '^200$' 60; then
  log "  经 nginx 可达：http://<本机IP>/sa/ → 200"
else
  warn "  经 nginx 访问异常，请查 /data/weblogs/candela.access.err.log"
fi

IP="$(hostname -I | awk '{print $1}')"
log "--------------------------------------------------------------"
log "Docker 方案部署完成（栈 candela，镜像 tag=${SHORT_HASH}）"
log "  入口       http://${IP}/sa/    登录 admin / 见 $ENV_FILE 的 ADMIN_INIT_PASSWORD"
log "  容器       docker compose -f $COMPOSE_FILE ps"
log "  日志       docker logs -f candela-server | candela-ingestor"
log "  回滚       改 deploy.env 的 DOCKER_SERVER_TAG/DOCKER_INGESTOR_TAG/DOCKER_WEB_TAG 为上一个 tag，再："
log "             bash $SELF_DIR/deploy-docker.sh --skip-build"
log "  下一步      bash $SELF_DIR/verify.sh"
log "--------------------------------------------------------------"
