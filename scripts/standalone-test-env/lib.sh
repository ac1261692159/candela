#!/usr/bin/env bash
# lib.sh — 独立测试环境部署共享库
#
# 被 deploy-middleware.sh / deploy-clklog.sh / verify.sh source。
# 约定：
#   * 所有操作必须幂等：重复执行不产生重复资源、不覆盖已有口令、不丢数据。
#   * 口令只写入 ${ENV_FILE}（0600），不打印到标准输出、不写进仓库。
#   * 镜像不写死单一来源：按候选列表逐个尝试，命中的引用写入 ${ENV_FILE}。

set -euo pipefail

BASE_DIR="${BASE_DIR:-/data/clklog-oss-test}"
ENV_FILE="$BASE_DIR/config/deploy.env"
NETWORK_NAME="${NETWORK_NAME:-clklog-net}"
PULL_TIMEOUT="${PULL_TIMEOUT:-900}"
LOG_TAG="[clklog-testenv]"

log()  { echo "$LOG_TAG $*"; }
warn() { echo "$LOG_TAG [WARN] $*" >&2; }
die()  { echo "$LOG_TAG [ERROR] $*" >&2; exit 1; }

require_root() { [ "$(id -u)" -eq 0 ] || die "请以 root 执行"; }

# ---------------------------------------------------------------- 口令与配置

# 32 位十六进制（128 bit）。仅字母数字，避免 JDBC URL / XML / shell 转义问题。
gen_password() { openssl rand -hex 16; }

# Kafka KRaft 需要的 22 字符 base64url cluster id（16 字节去 padding）
gen_kafka_cluster_id() {
  python3 -c 'import base64,uuid;print(base64.urlsafe_b64encode(uuid.uuid4().bytes).decode().rstrip("="))'
}

# 读取 $ENV_FILE 中某个键（不存在则空）
get_env() {
  local key="$1"
  sed -n "s/^${key}=//p" "$ENV_FILE" 2>/dev/null | tail -1
}

# 幂等写入键值：已存在则保留旧值（口令不轮换，否则会与已初始化数据不一致）
set_env_once() {
  local key="$1" value="$2"
  if [ -z "$(get_env "$key")" ]; then
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

# 幂等生成随机口令并回显
# 契约：stdout 只允许输出口令本身（调用方一律 `X="$(ensure_secret KEY)"` 捕获）。
# 提示必须走 stderr——走 stdout 会被命令替换一起捕获进变量，口令值从此多出一行，
# 拼进 DATABASE_URL 等派生值时把文件写坏（2026-10-10 实测：init-db source .env 失败）。
ensure_secret() {
  local key="$1" cur
  cur="$(get_env "$key")"
  if [ -z "$cur" ]; then
    cur="$(gen_password)"
    set_env_once "$key" "$cur"
    log "生成随机口令 $key" >&2
  fi
  printf '%s' "$cur"
}

init_env_file() {
  mkdir -p "$(dirname "$ENV_FILE")"
  if [ ! -f "$ENV_FILE" ]; then
    cat > "$ENV_FILE" <<'EOF'
# ClkLog 独立测试环境部署参数（由 deploy 脚本生成，请勿提交到仓库）
#
# 本文件同时保存：
#   - 随机口令（首次部署生成，之后保持不变）
#   - 各组件的镜像引用（由候选列表解析后写入）
# 权限 0600，仅 root 可读。

# ---- 口令（首次生成后不要手工改动，改了要与数据卷一起重建）----
EOF
  fi
  chmod 0600 "$ENV_FILE"
}

# 载入全部键到当前环境
load_env() { set -a; . "$ENV_FILE"; set +a; }

# ---------------------------------------------------------------- 系统前置

# AlmaLinux 官方源在部分网络下不可达（mirrorlist 域名解析失败）。
# 仅在官方源确实不可用时才切换，避免无谓修改系统配置。
ensure_dnf_mirrors() {
  if dnf -q makecache >/dev/null 2>&1; then
    return 0
  fi
  warn "dnf 官方源不可用，切换 AlmaLinux 仓库到 mirrors.aliyun.com"
  sed -i \
    -e 's|^mirrorlist=|#mirrorlist=|' \
    -e 's|^#\s*baseurl=https://repo.almalinux.org/almalinux/|baseurl=https://mirrors.aliyun.com/almalinux/|' \
    -e 's|^baseurl=https://repo.almalinux.org/almalinux/|baseurl=https://mirrors.aliyun.com/almalinux/|' \
    /etc/yum.repos.d/almalinux-*.repo
  dnf -q makecache || die "切换到阿里云镜像后 dnf 仍不可用"
}

# 安装 docker-ce + compose 插件；已安装则跳过。
# 优先阿里云 docker-ce 镜像（国内可达），失败退回官方源。
ensure_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    :
  else
    ensure_dnf_mirrors
    if [ ! -f /etc/yum.repos.d/docker-ce.repo ]; then
      if curl -fsSL -o /etc/yum.repos.d/docker-ce.repo \
           https://mirrors.aliyun.com/docker-ce/linux/centos/docker-ce.repo; then
        sed -i 's|download.docker.com|mirrors.aliyun.com/docker-ce|g' /etc/yum.repos.d/docker-ce.repo
      else
        warn "阿里云 docker-ce 源不可用，改用官方源"
        curl -fsSL -o /etc/yum.repos.d/docker-ce.repo https://download.docker.com/linux/centos/docker-ce.repo
      fi
    fi
    dnf -y install docker-ce docker-ce-cli containerd.io docker-compose-plugin
  fi

  mkdir -p /data/docker /etc/docker
  if [ ! -f /etc/docker/daemon.json ]; then
    cat > /etc/docker/daemon.json <<'JSON'
{
  "data-root": "/data/docker",
  "registry-mirrors": ["https://hub.rat.dev"],
  "log-driver": "json-file",
  "log-opts": { "max-size": "50m", "max-file": "3" },
  "live-restore": true
}
JSON
  fi
  systemctl enable --now docker >/dev/null 2>&1 || true
  systemctl is-active --quiet docker || systemctl start docker
  docker info >/dev/null 2>&1 || die "docker 未能启动"
}

# Redis 建议开启 overcommit（否则后台存盘时会打警告/失败）
ensure_sysctl() {
  local f=/etc/sysctl.d/90-clklog-testenv.conf
  if [ ! -f "$f" ]; then
    printf 'vm.overcommit_memory = 1\n' > "$f"
    sysctl -q -p "$f"
    log "写入 $f"
  fi
}

# ---------------------------------------------------------------- 镜像

# 按候选列表解析镜像：本地已有直接用，否则逐个 pull（每个候选重试 2 次），
# 命中即把引用写入 ${ENV_FILE}。国内网络下 pull 偶发超时，重试可避免误判"镜像不存在"。
# 用法：ensure_image MYSQL_IMAGE "ref1" "ref2" ...
ensure_image() {
  local key="$1"; shift
  local existing ref attempt
  existing="$(get_env "$key")"
  if [ -n "$existing" ] && docker image inspect "$existing" >/dev/null 2>&1; then
    printf '%s' "$existing"; return 0
  fi
  for ref in "$@"; do
    if docker image inspect "$ref" >/dev/null 2>&1; then
      set_env_once "$key" "$ref"; printf '%s' "$ref"; return 0
    fi
    for attempt in 1 2; do
      if timeout "$PULL_TIMEOUT" docker pull -q "$ref" >/dev/null 2>&1; then
        set_env_once "$key" "$ref"; printf '%s' "$ref"; return 0
      fi
      warn "第 $attempt 次拉取失败：$ref"
    done
    warn "镜像来源不可用，尝试下一个：$ref"
  done
  die "镜像 $key 的所有候选来源都不可用：$*"
}

# ---------------------------------------------------------------- 挂载目录

# 创建目录并固定 owner（对齐生产：ClickHouse 数据目录必须 101:101）
ensure_dir() {
  local path="$1" owner="$2"
  mkdir -p "$path"
  chown "$owner" "$path"
}

# ---------------------------------------------------------------- 等待

# wait_tcp <host> <port> <timeout_sec>
wait_tcp() {
  local host="$1" port="$2" deadline=$(( $(date +%s) + ${3:-120} ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; then exec 3>&- 3<&-; return 0; fi
    sleep 2
  done
  return 1
}

# wait_container_healthy <container> <timeout_sec>
wait_container_healthy() {
  local name="$1" deadline=$(( $(date +%s) + ${2:-180} ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    local st
    st="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$name" 2>/dev/null || echo missing)"
    case "$st" in
      healthy|running) return 0 ;;
      exited|dead) die "容器 $name 状态为 ${st}，请查看 docker logs $name" ;;
    esac
    sleep 3
  done
  warn "容器 $name 在超时前未进入 healthy/running"
  return 1
}

# ---------------------------------------------------------------- ClickHouse

# ClickHouse password_double_sha1_hex = sha1(sha1(password) 的原始字节)
ck_double_sha1() {
  python3 -c 'import hashlib,sys;print(hashlib.sha1(hashlib.sha1(sys.argv[1].encode()).digest()).hexdigest())' "$1"
}

# 在 clickhouse 容器内执行 SQL（HTTP 接口，走容器本地回环，不需要宿主端口）。
# 不要加 docker exec -i：SQL 已走参数传入，加了 -i 会把调用方 stdin（例如
# `ssh host 'bash -s' < script` 的脚本体）吞掉，表现为脚本执行到第二条查询就中断。
ck_query() {
  local sql="$1"
  docker exec "${CK_CONTAINER:-clklog-clickhouse}" \
    sh -c 'wget -qO- --header="X-ClickHouse-User: default" --header="X-ClickHouse-Key: '"$CK_USER_PWD"'" --post-data="$0" http://localhost:8123/' "$sql"
}

# ---------------------------------------------------------------- compose

# dc <compose_dir> <compose 子命令...>
dc() {
  local dir="$1"; shift
  ( cd "$dir" && docker compose --env-file "$ENV_FILE" "$@" )
}

# 共享网络：两个 compose 栈都接它，服务名（mysql/redis/kafka/clickhouse）跨栈可解析
ensure_network() {
  if ! docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
    docker network create "$NETWORK_NAME" >/dev/null
    log "创建 docker 网络 $NETWORK_NAME"
  fi
}
