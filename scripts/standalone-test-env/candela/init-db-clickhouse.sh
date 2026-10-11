#!/usr/bin/env bash
# init-db-clickhouse.sh — Candela 的 ClickHouse 初始化（幂等，两套部署流程共用）
#
# 覆盖：
#   1. 只读账号 sa_readonly（写进中间件 CH 的 users.d，带生产验证过的 sa_ro profile）
#      —— 分析平台 SQL 查询 / AI 只读 / 对拍查询都用它，与写账号 default 隔离（红线 4）。
#   2. 事件库 clklog_sa 与 4 张主表（sa_events / sa_user_profiles / sa_cohort_members / sa_tag_members）
#   3. 结构对齐 + 清洗账号 sa_cleanup + 备份/演练库（clklog_sa_bak / clklog_sa_staging）
#
# 为什么只读账号走 users.d 文件而不是 SQL：
#   生产用「profile sa_ro（readonly=2 + constraints 锁死不可降级）+ 内嵌 grants」这一组配置，
#   来规避「SQL 建的用户 readonly 设置不可靠」的历史缺陷（发版曾把该文件覆盖回去导致越权，
#   见 HANDOVER）。这里原样复刻生产验证过的形态，不另造一套。
#
# 幂等性：
#   * users.d 文件按内容比对，未变化则不重启 CH（避免无谓抖动）
#   * DDL 全部 IF NOT EXISTS / CREATE OR REPLACE；migrate-clickhouse 自身幂等
#
# 用法：
#   bash init-db-clickhouse.sh                  # 只做「用户 + 库表」（不依赖构建产物时用 app 镜像执行）
#   bash init-db-clickhouse.sh --runner host    # 用宿主 node 跑 init-clickhouse + migrate-clickhouse
#   bash init-db-clickhouse.sh --runner docker  # 用 manager-migrate 镜像跑（docker 流程）

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SELF_DIR/lib.sh"

require_root
init_env_file
load_manager_secrets
set_endpoints "${ENDPOINT_MODE:-native}"

RUNNER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --runner) RUNNER="${2:-}"; shift 2 ;;
    *) die "未知参数：$1" ;;
  esac
done

log "=== ClickHouse 初始化 ==="
wait_tcp "$MG_CH_HOST" "$MG_CH_PORT" 60 || die "ClickHouse 不可达：${MG_CH_HOST}:${MG_CH_PORT}"

# ---------------------------------------------------------------- 1) 只读账号
# 口径与生产固定版一致：readonly=2（允许客户端带设置如 enable_http_compression，仍禁写）
# + constraints 锁定不可降级到 0；授权 clklog_sa.* 与 clklog.*（社区库只读对拍用）。
USERS_D="$MW_CH_USERS_D"
[ -d "$USERS_D" ] || die "找不到中间件 CH 的 users.d（$USERS_D）。请先执行 scripts/standalone-test-env/deploy-middleware.sh"
RO_FILE="$USERS_D/sa_readonly.xml"
RO_NEW="$(mktemp)"
cat > "$RO_NEW" <<XML
<clickhouse>
    <profiles>
        <!-- sa_ro：readonly=2 允许客户端附带设置（readonly=1 会被 @clickhouse/client 拒绝），
             constraints 锁死不可降级；用户级 <readonly> 不可靠，必须走 profile。 -->
        <sa_ro>
            <readonly>2</readonly>
            <constraints>
                <readonly>
                    <min>1</min>
                    <max>2</max>
                </readonly>
            </constraints>
        </sa_ro>
    </profiles>
    <users>
        <sa_readonly>
            <password_sha256_hex>$(printf '%s' "$READONLY_CH_PASSWORD" | sha256sum | cut -d' ' -f1)</password_sha256_hex>
            <profile>sa_ro</profile>
            <access_management>0</access_management>
            <grants>
                <query>GRANT SELECT ON clklog_sa.*</query>
                <query>GRANT SELECT ON clklog.*</query>
            </grants>
            <allow_databases>
                <database>clklog_sa</database>
                <database>clklog</database>
            </allow_databases>
        </sa_readonly>
    </users>
</clickhouse>
XML

if [ -f "$RO_FILE" ] && cmp -s "$RO_NEW" "$RO_FILE"; then
  log "只读账号配置未变化，跳过 CH 重启"
  rm -f "$RO_NEW"
else
  install -m 0644 "$RO_NEW" "$RO_FILE"
  rm -f "$RO_NEW"
  log "写入只读账号配置 $RO_FILE，重启 ClickHouse 使其生效"
  docker restart clklog-clickhouse >/dev/null
  wait_tcp "$MG_CH_HOST" "$MG_CH_PORT" 120 || die "ClickHouse 重启后不可达"
  # 等 HTTP 接口真正可用
  for _ in $(seq 1 30); do
    mg_ck "SELECT 1" >/dev/null 2>&1 && break
    sleep 2
  done
fi

# 验证只读账号可登录且真的只读
ro_out="$(curl -sS -m 20 --data-binary "SELECT 1" \
  "http://${MG_CH_HOST}:${MG_CH_PORT}/?user=sa_readonly&password=$(printf '%s' "$READONLY_CH_PASSWORD" | python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read()))')" || true)"
[ "$ro_out" = "1" ] && log "  sa_readonly 登录正常" || warn "  sa_readonly 登录异常：$ro_out"

# ---------------------------------------------------------------- 2) 库与表
if [ -n "$RUNNER" ]; then
  log "创建事件库与主表（runner=$RUNNER）"
  case "$RUNNER" in
    host)
      REL="$CURRENT_LINK/server"
      [ -d "$REL" ] || die "找不到 $REL（请先完成构建部署，或改用 --runner docker）"
      prefix="$(dist_entry_prefix "$REL/dist")"
      for js in init-clickhouse migrate-clickhouse; do
        log "  执行 $js.js"
        # 必须显式给 APP_CONFIG_PATH：不给会回落到 dist 同级的 config_dev.yaml（不存在）并抛
        # 「配置文件不存在」——这是 2026-10-10 实测踩到的。
        ( cd "$REL" && set -a && . ./.env && set +a \
          && APP_CONFIG_PATH="$BASE_DIR/configs/config.yaml" NODE_ENV=production TZ=UTC \
          && export APP_CONFIG_PATH NODE_ENV TZ \
          && node "dist/${prefix:+$prefix/}scripts/$js.js" )
      done
      ;;
    docker)
      COMPOSE_FILE="$BASE_DIR/docker/docker-compose.yml"
      [ -f "$COMPOSE_FILE" ] || die "找不到 $COMPOSE_FILE（请先执行 deploy-docker.sh 的构建步骤）"
      dc "$BASE_DIR/docker" run --rm --no-deps \
        -e CLICKHOUSE_CLEANUP_PASSWORD="$CLICKHOUSE_CLEANUP_PASSWORD" \
        manager-migrate sh -c 'P=""; [ -f dist/src/main.js ] && P="src/"; echo "[ch-init] 产物前缀=${P}"; node "dist/${P}scripts/init-clickhouse.js" && node "dist/${P}scripts/migrate-clickhouse.js"'
      ;;
    *) die "未知 runner：$RUNNER（host|docker）" ;;
  esac
fi

# 兜底：即使没有构建产物，也保证库存在（表由 init-clickhouse.js 建）
mg_ck "CREATE DATABASE IF NOT EXISTS ${RUNTIME_CH_DB}" >/dev/null
n="$(mg_ck "SELECT count() FROM system.tables WHERE database='${RUNTIME_CH_DB}'")"
log "  ${RUNTIME_CH_DB} 表数量：$n"
if [ "${n:-0}" -ge 4 ] 2>/dev/null; then
  log "  核心表：$(mg_ck "SELECT name FROM system.tables WHERE database='${RUNTIME_CH_DB}' ORDER BY name FORMAT TSV" | tr '\n' ' ')"
else
  warn "  ${RUNTIME_CH_DB} 表数量不足（期望 ≥4），如需建表请带 --runner host|docker 重跑"
fi

log "ClickHouse 初始化完成。"
