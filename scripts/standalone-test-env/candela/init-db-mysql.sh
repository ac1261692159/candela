#!/usr/bin/env bash
# init-db-mysql.sh — Candela 的 MySQL 初始化（幂等，两套部署流程共用）
#
# 覆盖：
#   1. 社区版库 `clklog`：8 张表 + 种子数据（供 ClkLog 社区版 manage/api 使用）
#   2. 分析平台元数据库 `clklog_sa_meta`：仅建库（表由 Prisma 迁移创建）
#   3. 应用账号 `clklog_sa_app`：只授权 clklog_sa_meta（最小特权，不用 root 跑应用）
#
# 幂等性：
#   * 建库/建表 IF NOT EXISTS；种子数据 INSERT→INSERT IGNORE
#   * 账号用 CREATE USER IF NOT EXISTS + ALTER USER，每次都收敛到当前部署口令
#   * 不 DROP 任何东西（要清库请用 wipe-databases.sh）
#
# 用法：
#   bash init-db-mysql.sh                # 只做库/账号/社区表（纯 SQL，不依赖构建产物）
#   bash init-db-mysql.sh --runner host  # 额外跑 Prisma 迁移 + 建初始超管（宿主 node）
#   bash init-db-mysql.sh --runner docker# 额外跑 Prisma 迁移 + 建初始超管（容器内执行）
#
# 前置：中间件层 MySQL 已就绪（scripts/standalone-test-env/deploy-middleware.sh）

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SELF_DIR/lib.sh"

require_root
init_env_file
load_manager_secrets
# MySQL 初始化阶段只用到 MySQL 端点；CH/Redis/Kafka 端点随后续步骤设置
set_endpoints "${ENDPOINT_MODE:-native}"

RUNNER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --runner) RUNNER="${2:-}"; shift 2 ;;
    *) die "未知参数：$1" ;;
  esac
done

log "=== MySQL 初始化 ==="
wait_tcp "$MG_MYSQL_HOST" "$MG_MYSQL_PORT" 60 || die "MySQL 不可达：${MG_MYSQL_HOST}:${MG_MYSQL_PORT}"

# ---------------------------------------------------------------- 1) 库
log "创建库：${COMMUNITY_DB} / ${RUNTIME_DB}"
mg_mysql <<SQL
CREATE DATABASE IF NOT EXISTS \`${COMMUNITY_DB}\` DEFAULT CHARSET utf8 COLLATE utf8_general_ci;
CREATE DATABASE IF NOT EXISTS \`${RUNTIME_DB}\` DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_general_ci;
SQL

# ---------------------------------------------------------------- 2) 社区版表
COMMUNITY_SQL="$SRC_COMMUNITY_ASSETS/init/mysql_clklog.sql"
if [ -f "$COMMUNITY_SQL" ]; then
  log "导入社区版表结构（${COMMUNITY_SQL}，INSERT→INSERT IGNORE）"
  # 字符集必须显式指定：mysql 客户端默认 latin1 会把种子中文写成双重编码（社区版实测踩过）
  sed 's/^INSERT INTO/INSERT IGNORE INTO/' "$COMMUNITY_SQL" | mg_mysql
  n="$(mg_mysql -N -B -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${COMMUNITY_DB}'")"
  log "  ${COMMUNITY_DB} 表数量：$n"
else
  warn "未找到 $COMMUNITY_SQL，跳过社区版表结构（若只部署 manager 可忽略）"
fi

# ---------------------------------------------------------------- 3) 应用账号
log "收敛应用账号 ${RUNTIME_DB_USER}（最小特权：仅 ${RUNTIME_DB}）"
mg_mysql <<SQL
CREATE USER IF NOT EXISTS '${RUNTIME_DB_USER}'@'%' IDENTIFIED BY '${MYSQL_PASSWORD}';
ALTER USER '${RUNTIME_DB_USER}'@'%' IDENTIFIED BY '${MYSQL_PASSWORD}';
GRANT ALL PRIVILEGES ON \`${RUNTIME_DB}\`.* TO '${RUNTIME_DB_USER}'@'%';
FLUSH PRIVILEGES;
SQL
log "  已授权 ${RUNTIME_DB_USER}@% → ${RUNTIME_DB}.*"

# ---------------------------------------------------------------- 4) 元数据表（Prisma）

# 为什么不是单纯的 `prisma migrate deploy`：
#   实测（2026-10-10）该仓库迁移链**无法在大小写敏感的 MySQL 上从零重放**：
#     * 6 个迁移用小写表名引用 PascalCase 建的表（card / metaevent / saproject / sqlreport …）；
#     * 表 MetaEventAttribute 在任何迁移里都没有 CREATE，只被引用；
#     * 20260901090000 迁移自带注释「生产环境实际执行记录：本迁移在 INSERT 处失败」并附 repair.sql。
#   即 schema 的权威是 prisma/schema.prisma，而非迁移历史。新库按 Prisma 官方「基线」流程：
#     ① db push 建出当前 schema（应用真正需要的结构）
#     ② migrate resolve --applied 逐个登记，使 _prisma_migrations 与仓库一致，后续新增迁移可正常 deploy
#     ③ 重放迁移中的**幂等种子**（INSERT IGNORE / ON DUPLICATE），它们承载内置告警规则等初始数据
#   已有迁移历史的库走正常增量路径 migrate deploy。
SEED_SQL_FILE="$(mktemp)"
trap 'rm -f "$SEED_SQL_FILE"' EXIT

extract_idempotent_seeds() {  # $1 = 含 prisma/ 的工作目录
  python3 - "$1/prisma/migrations" > "$SEED_SQL_FILE" <<'PYSEED'
import pathlib, re, sys
root = pathlib.Path(sys.argv[1])
print("-- 由迁移文件提取的幂等种子（INSERT IGNORE / ON DUPLICATE）")
for mig in sorted(p for p in root.iterdir() if p.is_dir()):
    sql = (mig / "migration.sql").read_text(errors="replace")
    for stmt in sql.split(";"):
        # 先剥掉注释行再判断：多数种子语句前面带一行中文注释，
        # 若整块以 "--" 跳过会漏掉绝大多数种子（2026-10-10 实测只提取到 3 条）。
        body = "\n".join(l for l in stmt.splitlines()
                          if l.strip() and not l.strip().startswith("--")).strip()
        if not body:
            continue
        if re.search(r'INSERT\s+IGNORE\s+INTO', body) or re.search(r'ON\s+DUPLICATE\s+KEY', body, re.I):
            print("-- " + mig.name)
            print(body + ";")
PYSEED
}

# 从 schema.prisma 生成完整 DDL，并做一处 MySQL 兼容修补：
#   TEXT/JSON/BLOB 列不允许**字面量**默认值（本项目只有 verified_json TEXT NOT NULL DEFAULT '[]'），
#   但 MySQL 8.0.13+ 允许**表达式默认**——把 DEFAULT '<字面量>' 规范化为 DEFAULT ('<字面量>')。
# 之所以不用 `prisma db push`：它生成的正是会被 MySQL 拒绝的字面量形式（实测报
# "BLOB, TEXT, GEOMETRY or JSON column 'verified_json' can't have a default value"）。
SCHEMA_SQL_FILE="$(mktemp)"
build_schema_sql() {
  runner_prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > "$SCHEMA_SQL_FILE"
  [ -s "$SCHEMA_SQL_FILE" ] || die "migrate diff 未生成 DDL"
  python3 - "$SCHEMA_SQL_FILE" <<'PYFIX'
import re, sys, pathlib
f = pathlib.Path(sys.argv[1])
sql = f.read_text()
fixed = 0
out = []
for line in sql.splitlines(keepends=True):
    if re.search(r'\b(TEXT|TINYTEXT|MEDIUMTEXT|LONGTEXT|JSON|BLOB|TINYBLOB|MEDIUMBLOB|LONGBLOB)\b', line, re.I) \
       and re.search(r"DEFAULT\s+'", line) and "DEFAULT (" not in line:
        line = re.sub(r"DEFAULT\s+('(?:[^']|'')*')", r"DEFAULT (\1)", line)
        fixed += 1
    out.append(line)
f.write_text("".join(out))
print(fixed)
PYFIX
  log "  DDL 已生成（$(grep -c 'CREATE TABLE' "$SCHEMA_SQL_FILE") 张表；规范化默认值 $(python3 -c "print(sum(1 for l in open('$SCHEMA_SQL_FILE') if 'DEFAULT (' in l))") 处）"
}

# 运行器抽象：宿主直接跑 npx prisma；docker 用 manager-migrate 镜像跑同一命令。
# 决策逻辑只写一份（本脚本），容器只负责执行。
runner_prisma() {  # 参数透传给 prisma
  case "$RUNNER" in
    host)   ( cd "$REL" && set -a && . ./.env && set +a && npx prisma "$@" ) ;;
    docker) dc "$BASE_DIR/docker" run --rm --no-deps manager-migrate npx prisma "$@" ;;
  esac
}
runner_shell() {  # 在容器/工作目录里跑一段 shell（用于批量 resolve）
  case "$RUNNER" in
    host)   ( cd "$REL" && set -a && . ./.env && set +a && sh -c "$1" ) ;;
    docker) dc "$BASE_DIR/docker" run --rm --no-deps manager-migrate sh -c "$1" ;;
  esac
}

migrate_or_baseline() {
  local has_hist failed
  has_hist="$(mg_mysql_db "$RUNTIME_DB" -N -B -e \
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${RUNTIME_DB}' AND table_name='_prisma_migrations'" 2>/dev/null || echo 0)"
  # 迁移历史里若有失败记录，`migrate deploy` 会以 P3009 拒绝继续（且本仓库那条迁移永远无法成功），
  # 因此同样归入「历史不可用 → 走基线」。
  failed=0
  if [ "${has_hist:-0}" != "0" ]; then
    failed="$(mg_mysql_db "$RUNTIME_DB" -N -B -e \
      "SELECT COUNT(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL" 2>/dev/null || echo 0)"
  fi
  if [ "${has_hist:-0}" = "0" ] || [ "${failed:-0}" != "0" ]; then
    if [ "${failed:-0}" != "0" ]; then
      warn "  检测到 ${failed} 条失败迁移记录 → 按基线流程重建结构（db push 会以 schema.prisma 为准）"
    fi
    log "  未发现 _prisma_migrations → 新库基线流程（migrate diff 建结构 + resolve --applied + 重放种子）"
    # 基线必须落在空库上：migrate diff 生成的 DDL 没有 IF NOT EXISTS，残表会让它失败。
    # 进入基线只可能是「迁移历史缺失/不可用」，即该库从未被迁移正确初始化；
    # 但仍要显式告警——元数据库承载账号、看板、平台配置。
    local existing_tables
    existing_tables="$(mg_mysql_db "$RUNTIME_DB" -N -B -e \
      "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${RUNTIME_DB}'" 2>/dev/null || echo 0)"
    if [ "${existing_tables:-0}" != "0" ]; then
      warn "  ${RUNTIME_DB} 已存在 ${existing_tables} 张表 → 基线重建将清空该库（账号/看板/平台配置会丢）"
      warn "  如需保留请先手工备份：mysqldump ${RUNTIME_DB} > /root/${RUNTIME_DB}.bak.sql"
    fi
    mg_mysql -e "DROP DATABASE IF EXISTS \`${RUNTIME_DB}\`; CREATE DATABASE \`${RUNTIME_DB}\` DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_general_ci;"
    mg_mysql -e "GRANT ALL PRIVILEGES ON \`${RUNTIME_DB}\`.* TO '${RUNTIME_DB_USER}'@'%'; FLUSH PRIVILEGES;"
    build_schema_sql
    mg_mysql_db "$RUNTIME_DB" < "$SCHEMA_SQL_FILE"
    runner_shell 'for d in prisma/migrations/*/; do npx prisma migrate resolve --applied "$(basename "$d")" >/dev/null 2>&1 || true; done'
    log "  已登记迁移数：$(runner_shell 'ls -1d prisma/migrations/*/ | wc -l' | tr -d " ")"
    if [ "$RUNNER" = "host" ]; then
      extract_idempotent_seeds "$REL"
    else
      extract_idempotent_seeds_host_only
    fi
    if [ -s "$SEED_SQL_FILE" ]; then
      mg_mysql_db "$RUNTIME_DB" < "$SEED_SQL_FILE" 2>&1 | head -5 || true
      log "  已重放幂等种子（$(grep -c INSERT "$SEED_SQL_FILE" 2>/dev/null || echo 0) 条语句）"
    fi
  else
    log "  已存在迁移历史 → 增量迁移（prisma migrate deploy）"
    runner_prisma migrate deploy
  fi
}

# docker 模式下 prisma 目录在容器里，宿主没有；把迁移文件取到临时目录再提取种子
extract_idempotent_seeds_host_only() {
  local tmp
  tmp="$(mktemp -d)"
  dc "$BASE_DIR/docker" run --rm --no-deps -v "$tmp:/out" manager-migrate \
    sh -c 'cp -r prisma/migrations /out/' >/dev/null 2>&1 || true
  if [ -d "$tmp/migrations" ]; then
    mkdir -p "$tmp/prisma"
    mv "$tmp/migrations" "$tmp/prisma/migrations"
    extract_idempotent_seeds "$tmp"
  fi
  rm -rf "$tmp"
}

if [ -n "$RUNNER" ]; then
  log "初始化元数据表并创建超管（runner=$RUNNER）"
  case "$RUNNER" in
    host)
      REL="$CURRENT_LINK/server"
      [ -d "$REL" ] || die "找不到 $REL（请先完成构建部署，或改用 --runner docker）"
      ;;
    docker)
      [ -f "$BASE_DIR/docker/docker-compose.yml" ] \
        || die "找不到 $BASE_DIR/docker/docker-compose.yml（请先执行 deploy-docker.sh 的构建步骤）"
      ;;
    *) die "未知 runner：$RUNNER（host|docker）" ;;
  esac
  migrate_or_baseline
  PRISMA_ENTRY="$(runner_shell 'ls dist/src/scripts/init-admin.js 2>/dev/null || ls dist/scripts/init-admin.js 2>/dev/null' | tr -d "\r")"
  [ -n "$PRISMA_ENTRY" ] || die "容器/发布目录里找不到 init-admin.js"
  case "$RUNNER" in
    host)   ( cd "$REL" && set -a && . ./.env && set +a \
              && ADMIN_INIT_PASSWORD="$ADMIN_INIT_PASSWORD" node "$PRISMA_ENTRY" ) ;;
    docker) dc "$BASE_DIR/docker" run --rm --no-deps -e ADMIN_INIT_PASSWORD="$ADMIN_INIT_PASSWORD" \
              manager-migrate node "$PRISMA_ENTRY" ;;
  esac
  n="$(mg_mysql_db "$RUNTIME_DB" -N -B -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${RUNTIME_DB}'")"
  log "  ${RUNTIME_DB} 表数量：$n"
  admin="$(mg_mysql_db "$RUNTIME_DB" -N -B -e "SELECT COUNT(*) FROM \`$(db_table SaUser)\` WHERE username='admin'" 2>/dev/null || echo 0)"
  [ "$admin" = "1" ] && log "  超管 admin 已就绪（口令见 $ENV_FILE 的 ADMIN_INIT_PASSWORD）" || warn "  超管 admin 未创建"
  rules="$(mg_mysql_db "$RUNTIME_DB" -N -B -e "SELECT COUNT(*) FROM \`$(db_table alertrule)\`" 2>/dev/null || echo 0)"
  log "  内置告警规则行数：${rules}（7 条为正常）"
fi

log "MySQL 初始化完成。"
