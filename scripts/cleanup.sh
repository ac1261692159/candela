#!/usr/bin/env bash
# cleanup.sh — ClkLog 分析平台敏感数据清洗（数据治理 phase: clklog-analytics-v1-data-governance）
#
# 只作用于旁路库 `clklog_sa`（sa_events / sa_user_profiles），**硬拒绝任何指向社区版
# `clklog` 库的写/删/DDL**（红线 1）。强制五步门禁：
#
#   ① 只读预演（生产，SELECT only：影响行数 + 样本）
#   ② 测试库演练（clklog_sa_staging：同构表 → 跑同一条 DML → 核对结果；掩码另做幂等复跑）
#   ③ 备份快照（clklog_sa_bak.<table>_bak_<ts>，INSERT SELECT 受影响行）
#   ④ 审计记录（MySQL clklog_sa_meta.audit_cleanup，staged=1 / 备份表名 / 规则 / 影响行数）
#   ⑤ 生产执行（ALTER TABLE ... DELETE/UPDATE，轮询 system.mutations 至完成）→ 复检
#
# 没给 `--execute` 时只做 ①②（演练模式，不碰生产数据）。②未通过则不执行④。
#
# ⚠️ 代价提示：删除类条件走排序键（event/stat_date/distinct_id），很快；
#    **掩码类条件必须扫 `properties`**（无索引），成本随 --from/--to 线性增长
#    （实测 3 天窗口 CH 估值 327s）。故掩码默认窗口只跑「当天」，宽窗口请显式给
#    --from/--to 并用 --query-timeout 放宽上限。
#
# 用法：
#   ./cleanup.sh --action=delete-user  --distinct-id=<uid> [--from=] [--to=] [--all-time] [--project=] [--execute]
#   ./cleanup.sh --action=delete-event --event=<name>      [--from=] [--to=] [--all-time] [--project=] [--execute]
#   ./cleanup.sh --action=delete-before --before=YYYY-MM-DD                          [--project=] [--execute]
#   ./cleanup.sh --action=mask --json-key=phone --mask=phone|email|idcard [--from=] [--to=] [--all-time] [--project=] [--execute]
#   ./cleanup.sh --self-test        # 校验硬拒绝与 SQL 构造（不连任何库）
#   ./cleanup.sh --help
#
# 环境变量（可用 --ssh-host 时在远端生效；也自动加载 ./scripts/.env 与 /root/.clklog-cleanup.env）：
#   CLICKHOUSE_HOST/PORT/USER/PASSWORD   清洗账号 sa_cleanup（仅 clklog_sa* 权限）
#   MYSQL_HOST/PORT/USER/PASSWORD/DB     审计表所在库（clklog_sa_meta）
#
# 退出码：
#   0 成功（演练通过 / 清洗完成）    1 演练或复检未通过
#   2 参数或环境错误                 3 连接 / 查询失败
#   4 硬拒绝（目标不是 clklog_sa*）  5 执行失败（mutation 报错或超时）
#
# 设计契约见 docs/architecture/clklog-analytics-design-data-governance.md §5。

set -uo pipefail

# ---------- 默认值与环境 ----------
CK_HOST="${CLICKHOUSE_HOST:-127.0.0.1}"
CK_PORT="${CLICKHOUSE_PORT:-8123}"
CK_USER="${CLICKHOUSE_USER:-sa_cleanup}"
CK_PASSWORD="${CLICKHOUSE_PASSWORD:-}"
MY_HOST="${MYSQL_HOST:-127.0.0.1}"
MY_PORT="${MYSQL_PORT:-3306}"
MY_USER="${MYSQL_USER:-root}"
MY_PASSWORD="${MYSQL_PASSWORD:-}"
MY_DB="${MYSQL_DB:-clklog_sa_meta}"

# 允许库白名单（唯一真相）：清洗只允许这四个库（clklog_sa 及其备份/演练库）
readonly ALLOWED_DBS_REGEX='^clklog_sa(_bak|_staging)?$'
readonly FORBIDDEN_DB='clklog'
readonly SRC_DB='clklog_sa'
readonly BAK_DB='clklog_sa_bak'
readonly STAGING_DB='clklog_sa_staging'
readonly TARGET_TABLE='sa_events'
readonly MASK_KEYS='phone|email|idcard'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || pwd)"
LOG_DIR="${CLEANUP_LOG_DIR:-$SCRIPT_DIR/logs/cleanup}"
TS="$(date +%Y%m%d_%H%M%S)"

ACTION=""
DISTINCT_ID=""
EVENT_NAME=""
BEFORE=""
JSON_KEY=""
MASK_KIND=""
PROJECT="clklogapp"
FROM=""
TO=""
ALL_TIME=0
EXECUTE=0
REHEARSAL_MAX=1000
MUTATION_TIMEOUT=300
QUERY_TIMEOUT=120
SSH_HOST=""
SELF_TEST=0
ALLOW_UNCOVERED=0

log() { echo "[cleanup] $1" >&2; }
die() { log "错误: $1"; exit "${2:-2}"; }

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

load_env() {
  for f in "$SCRIPT_DIR/.env" /root/.clklog-cleanup.env; do
    if [ -f "$f" ]; then
      set -a
      # shellcheck disable=SC1090
      . "$f"
      set +a
      log "已加载环境: $f"
    fi
  done
  # 重新套用（.env 可能覆盖了默认值）
  CK_HOST="${CLICKHOUSE_HOST:-$CK_HOST}"; CK_PORT="${CLICKHOUSE_PORT:-$CK_PORT}"
  CK_USER="${CLICKHOUSE_USER:-$CK_USER}"; CK_PASSWORD="${CLICKHOUSE_PASSWORD:-$CK_PASSWORD}"
  MY_HOST="${MYSQL_HOST:-$MY_HOST}"; MY_PORT="${MYSQL_PORT:-$MY_PORT}"
  MY_USER="${MYSQL_USER:-$MY_USER}"; MY_PASSWORD="${MYSQL_PASSWORD:-$MY_PASSWORD}"
  MY_DB="${MYSQL_DB:-$MY_DB}"
}

parse_args() {
  for arg in "$@"; do
    case "$arg" in
      --help|-h) usage ;;
      --self-test) SELF_TEST=1 ;;
      --allow-uncovered) ALLOW_UNCOVERED=1 ;;
      --action=*) ACTION="${arg#*=}" ;;
      --distinct-id=*) DISTINCT_ID="${arg#*=}" ;;
      --event=*) EVENT_NAME="${arg#*=}" ;;
      --before=*) BEFORE="${arg#*=}" ;;
      --json-key=*) JSON_KEY="${arg#*=}" ;;
      --mask=*) MASK_KIND="${arg#*=}" ;;
      --project=*) PROJECT="${arg#*=}" ;;
      --from=*) FROM="${arg#*=}" ;;
      --to=*) TO="${arg#*=}" ;;
      --all-time) ALL_TIME=1 ;;
      --execute) EXECUTE=1 ;;
      --rehearsal-max=*) REHEARSAL_MAX="${arg#*=}" ;;
      --mutation-timeout=*) MUTATION_TIMEOUT="${arg#*=}" ;;
      --query-timeout=*) QUERY_TIMEOUT="${arg#*=}" ;;
      --ssh-host=*) SSH_HOST="${arg#*=}" ;;
      *) die "未知参数: $arg（用 --help 查看用法）" 2 ;;
    esac
  done
}

# ---------- 远程命令封装：给了 --ssh-host 就在远端执行 ----------
run_cmd() { # run_cmd <shell 片段> [stdin 内容]
  if [ -n "$SSH_HOST" ]; then
    ssh -o BatchMode=yes "$SSH_HOST" "$1" <<<"${2:-}"
  else
    bash -c "$1" <<<"${2:-}"
  fi
}

# ---------- ClickHouse 访问 ----------
ch_exec() { # 无输出（DDL/DML），失败返回 3
  local sql="$1" out rc
  # 所有语句都带执行上限：清洗的 WHERE 常含 properties 扫描（无索引），不能无界跑
  out="$(run_cmd "curl -s --max-time $((QUERY_TIMEOUT + 30)) -u '$CK_USER:$CK_PASSWORD' 'http://$CK_HOST:$CK_PORT/' --data-binary @-" "$sql SETTINGS max_execution_time=$QUERY_TIMEOUT" 2>&1)"; rc=$?
  [ $rc -ne 0 ] && { log "ClickHouse 调用失败 (rc=$rc): $out"; return 3; }
  if printf '%s' "$out" | grep -qiE 'Code: [0-9]+|DB::Exception'; then
    if printf '%s' "$out" | grep -qE 'Code: 160|TOO_SLOW|Timeout exceeded'; then
      log "查询超时（${QUERY_TIMEOUT}s）：清洗条件会扫描 properties，请缩小 --from/--to 或用 --query-timeout 放宽"
    else
      log "ClickHouse 返回异常: $out"
    fi
    return 3
  fi
  return 0
}

ch_query() { # 输出 TSV（无表头）
  local sql="$1" out rc
  out="$(run_cmd "curl -s --max-time $((QUERY_TIMEOUT + 30)) -u '$CK_USER:$CK_PASSWORD' 'http://$CK_HOST:$CK_PORT/' --data-binary @-" "$sql FORMAT TSV SETTINGS max_execution_time=$QUERY_TIMEOUT" 2>&1)"; rc=$?
  [ $rc -ne 0 ] && { log "ClickHouse 查询失败 (rc=$rc): $out"; return 3; }
  if printf '%s' "$out" | grep -qiE 'Code: [0-9]+|DB::Exception'; then
    log "ClickHouse 返回异常: $out"; return 3
  fi
  printf '%s\n' "$out"
}

# ---------- MySQL 审计表访问 ----------
my_exec() { # 无输出；失败返回 3（SQL 走 stdin，避免引号/JSON 被 shell 截断）
  local sql="$1" out rc
  out="$(run_cmd "MYSQL_PWD='$MY_PASSWORD' mysql -h '$MY_HOST' -P '$MY_PORT' -u '$MY_USER' '$MY_DB' -N" "$sql" 2>&1)"; rc=$?
  [ $rc -ne 0 ] && { log "MySQL 调用失败 (rc=$rc): $out"; return 3; }
  printf '%s' "$out"
}

# 等待指定表的 mutation 完成（超时返回 1）
wait_mutation() { # wait_mutation <db> <table> <since_ts> [timeout]
  local db="$1" tbl="$2" since="$3" limit="${4:-$MUTATION_TIMEOUT}" waited=0 pend=1
  while [ "$waited" -lt "$limit" ]; do
    sleep 3; waited=$((waited + 3))
    pend="$(ch_query "SELECT count() FROM system.mutations WHERE database='$db' AND table='$tbl' AND create_time >= '$since' AND NOT is_done" | tr -dc '0-9')"
    [ "${pend:-1}" = "0" ] && return 0
  done
  return 1
}

# ---------- 硬拒绝：SQL 只允许引用 clklog_sa* 库 ----------
guard_sql() {
  local sql="$1"
  # clklog.<表> / 反引号形式 / 其它库前缀，一律拒绝
  if printf '%s' "$sql" | grep -qE "(^|[^_a-zA-Z0-9])${FORBIDDEN_DB}\."; then
    die "硬拒绝：语句引用了社区版库 ${FORBIDDEN_DB}（红线 1）" 4
  fi
  # 提取所有 db.table 引用，逐个比对白名单
  local refs db
  refs="$(printf '%s' "$sql" | grep -oE '[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*' | sort -u)"
  while IFS= read -r ref; do
    [ -z "$ref" ] && continue
    db="${ref%%.*}"
    case "$db" in
      system|$SRC_DB|$BAK_DB|$STAGING_DB) continue ;;
      *) die "硬拒绝：语句引用了非白名单库 '$db'（只允许 $SRC_DB / $BAK_DB / $STAGING_DB）" 4 ;;
    esac
  done <<<"$refs"
}

# ---------- 值校验（防注入） ----------
assert_ident() { # 简单标识符（事件名、项目名、JSON 键）
  [[ "$2" =~ ^[A-Za-z0-9_@$.-]{1,128}$ ]] || die "$1 含非法字符: $2" 2
}
assert_uid() { # distinct_id / user_key
  [[ "$2" =~ ^[A-Za-z0-9_@:.$-]{1,128}$ ]] || die "$1 含非法字符: $2" 2
}
assert_date() {
  [[ "$2" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || die "$1 必须是 YYYY-MM-DD: $2" 2
}

# ---------- 构造条件（唯一入口，目标库写死） ----------
build_condition() {
  local parts=("project_name = '$PROJECT'")
  case "$ACTION" in
    delete-user)
      parts+=("(distinct_id = '$DISTINCT_ID' OR user_key = '$DISTINCT_ID')") ;;
    delete-event)
      parts+=("event = '$EVENT_NAME'") ;;
    delete-before)
      parts+=("stat_date < '$BEFORE'") ;;
    mask)
      parts+=("JSONHas(properties, '$JSON_KEY')") ;;
    *) die "未知 action: $ACTION（可选 delete-user|delete-event|delete-before|mask）" 2 ;;
  esac
  if [ "$ACTION" != "delete-before" ] && [ "$ALL_TIME" != "1" ]; then
    parts+=("stat_date BETWEEN '$FROM' AND '$TO'")
  fi
  local out="" part
  for part in "${parts[@]}"; do
    out="${out:+$out AND }$part"
  done
  echo "$out"
}

# 掩码表达式：正则与替换都是**字面量**（键名进正则前已校验），保证幂等（掩码后再跑不匹配）
mask_expression() {
  case "$MASK_KIND" in
    phone)  echo "replaceRegexpAll(properties, '\"$JSON_KEY\":\"([0-9]{3})[0-9]{4}([0-9]{4})\"', '\"$JSON_KEY\":\"\\\\1****\\\\2\"')" ;;
    email)  echo "replaceRegexpAll(properties, '\"$JSON_KEY\":\"([^\"@]{1,2})[^\"@]*(@[^\"]+)\"', '\"$JSON_KEY\":\"\\\\1***\\\\2\"')" ;;
    idcard) echo "replaceRegexpAll(properties, '\"$JSON_KEY\":\"([A-Za-z0-9]{4})[A-Za-z0-9]+([A-Za-z0-9]{4})\"', '\"$JSON_KEY\":\"\\\\1********\\\\2\"')" ;;
    *) die "未知掩码类型: $MASK_KIND（可选 $MASK_KEYS）" 2 ;;
  esac
}

# 未掩码（命中即说明还没被掩码）的计数条件
unmasked_condition() {
  case "$MASK_KIND" in
    phone)  echo "match(properties, '\"$JSON_KEY\":\"[0-9]{3}[0-9]{4}[0-9]{4}\"')" ;;
    email)  echo "match(properties, '\"$JSON_KEY\":\"[^\"@]{1,2}[^\"@]*@[^\"]+\"')" ;;
    idcard) echo "match(properties, '\"$JSON_KEY\":\"[A-Za-z0-9]{4}[A-Za-z0-9]+[A-Za-z0-9]{4}\"')" ;;
  esac
}

# ---------- 自检（不连库）：硬拒绝与 SQL 构造 ----------
self_test() {
  local failed=0
  local i
  for i in "SELECT 1 FROM clklog.log_analysis" \
           "ALTER TABLE clklog.log_analysis DELETE WHERE 1" \
           "DELETE FROM clklog.log_analysis WHERE 1" \
           "ALTER TABLE other_db.t DROP PARTITION '202601'"; do
    if ( guard_sql "$i" ) 2>/dev/null; then
      log "自检失败：未拒绝 → $i"; failed=1
    fi
  done
  for i in "ALTER TABLE clklog_sa.sa_events DELETE WHERE project_name = 'x'" \
           "INSERT INTO clklog_sa_bak.sa_events_bak_1 SELECT * FROM clklog_sa.sa_events" \
           "SELECT count() FROM system.mutations WHERE table = 'sa_events'"; do
    if ! ( guard_sql "$i" ) 2>/dev/null; then
      log "自检失败：误拒 → $i"; failed=1
    fi
  done
  # 条件构造
  ACTION=delete-user DISTINCT_ID=u1 PROJECT=p1 ALL_TIME=0 FROM=2026-01-01 TO=2026-01-02
  local cond; cond="$(build_condition)"
  case "$cond" in
    *"distinct_id = 'u1'"*"stat_date BETWEEN '2026-01-01' AND '2026-01-02'"*) ;;
    *) log "自检失败：delete-user 条件不对 → $cond"; failed=1 ;;
  esac
  ACTION=mask JSON_KEY=phone MASK_KIND=phone
  case "$(mask_expression)" in
    *"replaceRegexpAll"*) ;;
    *) log "自检失败：掩码表达式未生成"; failed=1 ;;
  esac
  [ "$failed" = "0" ] && log "自检通过：硬拒绝 4 例、放行 3 例、条件与掩码构造正常" || return 1
  return 0
}

main() {
  parse_args "$@"
  if [ "$SELF_TEST" = "1" ]; then self_test; exit $?; fi
  load_env
  [ -n "$ACTION" ] || { usage; }
  [ -n "$CK_PASSWORD" ] || die "缺少 CLICKHOUSE_PASSWORD（清洗账号 sa_cleanup；见 /root/.clklog-cleanup.env）" 2

  assert_ident "--project" "$PROJECT"
  [ -n "$FROM" ] && assert_date "--from" "$FROM"
  [ -n "$TO" ] && assert_date "--to" "$TO"
  case "$ACTION" in
    delete-user)  [ -n "$DISTINCT_ID" ] || die "--action=delete-user 需要 --distinct-id" 2; assert_uid "--distinct-id" "$DISTINCT_ID" ;;
    delete-event) [ -n "$EVENT_NAME" ] || die "--action=delete-event 需要 --event" 2; assert_ident "--event" "$EVENT_NAME" ;;
    delete-before) [ -n "$BEFORE" ] || die "--action=delete-before 需要 --before" 2; assert_date "--before" "$BEFORE" ;;
    mask) [ -n "$JSON_KEY" ] || die "--action=mask 需要 --json-key" 2; assert_ident "--json-key" "$JSON_KEY"
          [ -n "$MASK_KIND" ] || die "--action=mask 需要 --mask=$MASK_KEYS" 2 ;;
  esac
  if [ "$ALL_TIME" != "1" ] && [ "$ACTION" != "delete-before" ]; then
    [ -n "$TO" ] || TO="$(date +%F)"
    if [ "$ACTION" = "mask" ]; then
      # 掩码条件要扫 properties（无索引；实测 3 天窗口 CH 估值 327s）→ 默认只跑当天
      [ -n "$FROM" ] || FROM="$(date +%F)"
    else
      [ -n "$FROM" ] || FROM="$(date -v-30d +%F 2>/dev/null || date -d '30 days ago' +%F)"
    fi
    assert_date "--from" "$FROM"; assert_date "--to" "$TO"
  fi
  [[ "$REHEARSAL_MAX" =~ ^[0-9]+$ ]] || die "--rehearsal-max 必须是整数" 2
  [[ "$MUTATION_TIMEOUT" =~ ^[0-9]+$ ]] || die "--mutation-timeout 必须是整数" 2
  [[ "$QUERY_TIMEOUT" =~ ^[0-9]+$ ]] || die "--query-timeout 必须是整数" 2

  mkdir -p "$LOG_DIR" 2>/dev/null || true
  local REPORT="$LOG_DIR/cleanup-$TS.txt"
  : >"$REPORT" 2>/dev/null || REPORT=/dev/null

  local WHERE; WHERE="$(build_condition)"
  local SRC="$SRC_DB.$TARGET_TABLE"
  local SET_SQL DELETE_SQL
  if [ "$ACTION" = "mask" ]; then
    SET_SQL="ALTER TABLE $SRC UPDATE properties = $(mask_expression) WHERE $WHERE"
    DELETE_SQL="$SET_SQL"
  else
    DELETE_SQL="ALTER TABLE $SRC DELETE WHERE $WHERE"
    SET_SQL="$DELETE_SQL"
  fi
  guard_sql "$DELETE_SQL" || exit 4

  {
    echo "== ClkLog 敏感数据清洗 =="
    echo "时间:     $(date '+%F %T')"
    echo "操作:     $ACTION${DISTINCT_ID:+ (distinct_id=$DISTINCT_ID)}${EVENT_NAME:+ (event=$EVENT_NAME)}${BEFORE:+ (before=$BEFORE)}${JSON_KEY:+ (json_key=$JSON_KEY, mask=$MASK_KIND)}"
    echo "项目:     $PROJECT"
    echo "时间范围: $([ "$ALL_TIME" = 1 ] && echo '全时段 ' || echo "${FROM:-} ~ ${TO:-}")"
    echo "条件:     $WHERE"
    echo "模式:     $([ "$EXECUTE" = 1 ] && echo '执行（含备份+审计）' || echo '演练（不碰生产数据）')"
    echo
  } | tee -a "$REPORT" >&2

  # ---------- ① 只读预演（生产） ----------
  log "① 只读预演（生产，SELECT only）"
  local affected; affected="$(ch_query "SELECT count() FROM $SRC WHERE $WHERE")" || exit 3
  affected="$(printf '%s' "$affected" | tr -dc '0-9')"
  echo "① 影响行数: ${affected:-0}" | tee -a "$REPORT" >&2
  [ "${affected:-0}" = "0" ] && { log "匹配 0 行，无事可做"; echo "⑤ 复检: 无需处理" | tee -a "$REPORT" >&2; exit 0; }
  ch_query "SELECT * FROM $SRC WHERE $WHERE LIMIT 3" >/dev/null || exit 3
  log "  样本（前 3 行）:"
  ch_query "SELECT * FROM $SRC WHERE $WHERE LIMIT 3" | cut -c1-160 | sed 's/^/    /' | tee -a "$REPORT" >&2

  # ---------- ② 测试库演练 ----------
  log "② 测试库演练（$STAGING_DB）"
  local stg="$STAGING_DB.${TARGET_TABLE}_rehearsal_$TS"
  ch_exec "DROP TABLE IF EXISTS $stg" || exit 3
  ch_exec "CREATE TABLE $stg AS $SRC" || exit 3
  ch_exec "INSERT INTO $stg SELECT * FROM $SRC WHERE $WHERE LIMIT $REHEARSAL_MAX" || exit 3
  local staged_rows; staged_rows="$(ch_query "SELECT count() FROM $stg" | tr -dc '0-9')"
  log "  已复制 $staged_rows 行到演练表"
  # 覆盖度必须在**掩码前**统计：掩码后值已变形，会被误判成"覆盖不到"
  local uncovered=0
  if [ "$ACTION" = "mask" ]; then
    uncovered="$(ch_query "SELECT count() FROM $stg WHERE JSONHas(properties, '$JSON_KEY') AND NOT ($(unmasked_condition))" | tr -dc '0-9')"
  fi
  local stg_ts; stg_ts="$(date '+%Y-%m-%d %H:%M:%S')"
  ch_exec "$(printf '%s' "$DELETE_SQL" | sed "s#$SRC#$stg#")" || exit 3
  wait_mutation "$STAGING_DB" "${TARGET_TABLE}_rehearsal_$TS" "$stg_ts" 60 || log "  演练 mutation 未在 60s 内完成（继续核对）"
  if [ "$ACTION" = "mask" ]; then
    local left_before left_after
    left_before="$(ch_query "SELECT count() FROM $stg WHERE $(unmasked_condition)" | tr -dc '0-9')"
    # 幂等复跑：再掩一次不应再变化
    local stg_ts2; stg_ts2="$(date '+%Y-%m-%d %H:%M:%S')"
    ch_exec "$(printf '%s' "$DELETE_SQL" | sed "s#$SRC#$stg#")" || exit 3
    wait_mutation "$STAGING_DB" "${TARGET_TABLE}_rehearsal_$TS" "$stg_ts2" 60 || true
    left_after="$(ch_query "SELECT count() FROM $stg WHERE $(unmasked_condition)" | tr -dc '0-9')"
    echo "② 演练结果: 掩码后残留未处理行 ${left_before:-0} → 幂等复跑后 ${left_after:-0}（均应 0）；**掩码前格式不匹配、覆盖不到的行 ${uncovered:-0}**" | tee -a "$REPORT" >&2
    if [ "${left_before:-1}" != "0" ] || [ "${left_after:-1}" != "0" ]; then
      log "  演练未通过：掩码后仍有未掩码行（检查 json-key/mask 是否匹配真实字段）"
      ch_exec "DROP TABLE IF EXISTS $stg" || true
      echo "② 演练: 未通过" | tee -a "$REPORT" >&2
      exit 1
    fi
    if [ "${uncovered:-0}" != "0" ] && [ "$ALLOW_UNCOVERED" != "1" ]; then
      log "  演练未通过：有 ${uncovered} 行带该键但格式不匹配掩码正则，会**保持明文**。"
      log "  请核对 --mask 类型是否选对；确认可接受时加 --allow-uncovered 重新执行。"
      ch_exec "DROP TABLE IF EXISTS $stg" || true
      echo "② 演练: 未通过（覆盖不足 ${uncovered} 行；如需接受请加 --allow-uncovered）" | tee -a "$REPORT" >&2
      exit 1
    fi
    log "  演练样本: $(ch_query "SELECT properties FROM $stg LIMIT 1" | cut -c1-120)"
  else
    local left; left="$(ch_query "SELECT count() FROM $stg" | tr -dc '0-9')"
    echo "② 演练结果: 复制 $staged_rows 行 → 删除后剩余 ${left:-0}（应为 0）" | tee -a "$REPORT" >&2
    if [ "${left:-1}" != "0" ]; then
      log "  演练未通过：删除后仍有剩余行"; ch_exec "DROP TABLE IF EXISTS $stg" || true
      echo "② 演练: 未通过" | tee -a "$REPORT" >&2; exit 1
    fi
  fi
  ch_exec "DROP TABLE IF EXISTS $stg" || true
  echo "② 演练: 通过（表 $stg 已清理）" | tee -a "$REPORT" >&2

  if [ "$EXECUTE" != "1" ]; then
    echo | tee -a "$REPORT" >&2
    echo "演练模式结束：未修改生产数据。确认无误后加 --execute 执行（将备份 + 审计 + 执行 + 复检）。" | tee -a "$REPORT" >&2
    log "报告: $REPORT"
    exit 0
  fi

  # ---------- ③ 备份快照 ----------
  local BAK_TABLE="${TARGET_TABLE}_bak_$TS"
  local BAK="$BAK_DB.$BAK_TABLE"
  log "③ 备份快照 → $BAK"
  ch_exec "DROP TABLE IF EXISTS $BAK" || exit 3
  ch_exec "CREATE TABLE $BAK AS $SRC" || exit 3
  ch_exec "INSERT INTO $BAK SELECT * FROM $SRC WHERE $WHERE" || exit 3
  local bak_rows; bak_rows="$(ch_query "SELECT count() FROM $BAK" | tr -dc '0-9')"
  echo "③ 备份: $BAK（$bak_rows 行，应为 $affected）" | tee -a "$REPORT" >&2
  [ "${bak_rows:-0}" = "$affected" ] || die "备份行数($bak_rows) 与预演影响行数($affected) 不一致，中止" 5

  # ---------- ④ 审计记录 ----------
  local RULE
  RULE="$(printf '{"action":"%s","project":"%s","where":"%s"%s%s%s}' \
    "$ACTION" "$PROJECT" "${WHERE//\"/\\\"}" \
    "${DISTINCT_ID:+,\"distinct_id\":\"$DISTINCT_ID\"}" \
    "${EVENT_NAME:+,\"event\":\"$EVENT_NAME\"}" \
    "${JSON_KEY:+,\"json_key\":\"$JSON_KEY\",\"mask\":\"$MASK_KIND\"}")"
  local RULE_SQL="${RULE//\'/\\\'}"
  local AUDIT_ID
  AUDIT_ID="$(my_exec "INSERT INTO audit_cleanup (operator, action, target_db, target_table, rule_json, backup_table, affected_rows, staged, status) VALUES ('${SUDO_USER:-$(whoami)}', '$ACTION', '$SRC_DB', '$TARGET_TABLE', '$RULE_SQL', '$BAK', $affected, 1, 'running'); SELECT LAST_INSERT_ID();" | tr -dc '0-9')"
  [ -n "$AUDIT_ID" ] || die "审计记录写入失败（红线 6：无审计不执行）" 3
  echo "④ 审计: audit_cleanup id=$AUDIT_ID（staged=1）" | tee -a "$REPORT" >&2

  # ---------- ⑤ 生产执行 + 复检 ----------
  log "⑤ 生产执行"
  local before_ts; before_ts="$(date '+%Y-%m-%d %H:%M:%S')"
  if ! ch_exec "$DELETE_SQL"; then
    my_exec "UPDATE audit_cleanup SET status='failed', error='ClickHouse 执行失败' WHERE id=$AUDIT_ID" >/dev/null || true
    die "生产执行失败（已记审计 id=$AUDIT_ID）" 5
  fi
  log "  等待 mutation 完成（上限 ${MUTATION_TIMEOUT}s）…"
  if ! wait_mutation "$SRC_DB" "$TARGET_TABLE" "$before_ts" "$MUTATION_TIMEOUT"; then
    my_exec "UPDATE audit_cleanup SET status='failed', error='mutation 未在 ${MUTATION_TIMEOUT}s 内完成' WHERE id=$AUDIT_ID" >/dev/null || true
    die "mutation 未在 ${MUTATION_TIMEOUT}s 内完成（审计 id=$AUDIT_ID）" 5
  fi
  local remain
  if [ "$ACTION" = "mask" ]; then
    remain="$(ch_query "SELECT count() FROM $SRC WHERE $(unmasked_condition) AND $WHERE" | tr -dc '0-9')"
    echo "⑤ 复检: 条件下仍为明文模式的行 ${remain:-0}（应为 0；覆盖不到的行见 ② 的提示）" | tee -a "$REPORT" >&2
  else
    remain="$(ch_query "SELECT count() FROM $SRC WHERE $WHERE" | tr -dc '0-9')"
    echo "⑤ 复检: 条件下剩余行 ${remain:-0}（应为 0）" | tee -a "$REPORT" >&2
  fi
  my_exec "UPDATE audit_cleanup SET status='$([ "${remain:-1}" = "0" ] && echo done || echo failed)', affected_rows=$affected WHERE id=$AUDIT_ID" >/dev/null || true

  echo | tee -a "$REPORT" >&2
  echo "完成：$([ "${remain:-1}" = "0" ] && echo '清洗成功' || echo '复检未通过，请人工核查')；审计 id=$AUDIT_ID，备份 $BAK" | tee -a "$REPORT" >&2
  log "报告: $REPORT"
  [ "${remain:-1}" = "0" ] || exit 1
}

main "$@"
