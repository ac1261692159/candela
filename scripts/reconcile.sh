#!/usr/bin/env bash
# reconcile.sh — ClkLog 分析平台数据一致性对拍（只读）
#
# 比对 clklog_sa.sa_events（旁路分析库）与 clklog.log_analysis（社区版）的数据一致性，
# 用于发现 ingestor 静默丢数据/停转/重复。本脚本只读，不写任何库表。
#
# 用法：
#   ./reconcile.sh --type=count [--from=YYYY-MM-DD] [--to=YYYY-MM-DD] [--threshold=0.1]
#   ./reconcile.sh --type=event [--from=...] [--to=...] [--threshold=0.1]
#   ./reconcile.sh --type=crc   [--from=...] [--to=...]
#   ./reconcile.sh --type=detail [--from=...] [--to=...] [--sample=1000] [--side=sa|raw] [--event=NAME]
#   ./reconcile.sh --type=range [--from=...] [--to=...] [--threshold=0.1] [--max-days=90] [--sleep=2]
#   ./reconcile.sh --help
#
# 类型：
#   count   粗粒度总量对拍（sa_events vs log_analysis 非空 event 行数），默认
#   event   按事件名对拍
#   crc     sa_events 内 CRC 唯一性检查（重复检测）
#   detail  抽样细对拍（按伪键 distinct_id+event+log_time 双向回查比对一致率）
#   range   低峰期大范围专项：按天逐日跑 count，最后给一张逐日表（内存护栏：单日 + 间隔）
#
# 参数：
#   --from / --to   时间范围（YYYY-MM-DD），默认昨日
#   --threshold     计数偏差阈值（0~1 比例），默认 0.1（即 10%）
#   --sample        抽样条数（detail 用），默认 1000
#   --side          抽样方向（detail 用）：sa（默认，查我方多记）/ raw（查对侧少记）
#   --event         只抽样指定事件（detail 用）
#   --project       sa 侧项目名，默认 clklogapp（红线：必须有界）
#   --max-days      range 上限天数，默认 90
#   --sleep         range 每天间隔秒数，默认 2
#   --host          服务端 SSH host（可选），本地直连时省略
#
# 环境变量（可注入，复用 .env）：
#   CLICKHOUSE_HOST        CK 地址，默认 127.0.0.1
#   CLICKHOUSE_PORT        CK HTTP 端口，默认 8123
#   CLICKHOUSE_USER        CK 用户，默认 default（建议只读账号 sa_readonly）
#   CLICKHOUSE_PASSWORD    CK 密码（必填）
#   CLICKHOUSE_DB          sa_events 所在库，默认 clklog_sa（通常无需改）
#
# 退出码：
#   0   通过（偏差在阈值内 / 无重复 / 一致率达标）
#   1   发现差异（偏差超阈值 / 检出重复 / 一致率低于阈值）
#   2   参数或环境错误
#   3   连接 / 查询失败
#
# 设计契约见 docs/architecture/clklog-analytics-design-data-governance.md §4。

set -uo pipefail

# ---------- 默认值 ----------
CK_HOST="${CLICKHOUSE_HOST:-127.0.0.1}"
CK_PORT="${CLICKHOUSE_PORT:-8123}"
CK_USER="${CLICKHOUSE_USER:-default}"
CK_PASSWORD="${CLICKHOUSE_PASSWORD:-}"
CK_DB="${CLICKHOUSE_DB:-clklog_sa}"

TYPE="count"
THRESHOLD=0.1
SAMPLE=1000
FROM=""
TO=""
SSH_HOST=""
# R3（quality-ops-v1）：抽样方向 / 事件过滤 / 大范围专项参数
SIDE="sa"              # detail 抽样方向：sa=从 sa_events 抽样回查 log_analysis；raw=反向
EVENT_FILTER=""        # detail 只抽样指定事件（结构性差异事件定向核查）
PROJECT="${CLICKHOUSE_PROJECT:-clklogapp}"   # sa 侧强制项目过滤（红线 4）
MAX_DAYS=90            # range 类型一次最多覆盖的天数（内存/时长护栏）
SLEEP_SEC=2            # range 类型每天之间的间隔（给 CH 留 merge/写入窗口）

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$SCRIPT_DIR/logs/reconcile"
TS="$(date +%Y%m%d_%H%M%S)"

# ---------- 工具函数 ----------
log() { echo "[reconcile] $1" >&2; }
die() { log "错误: $1"; exit "$2"; }

usage() {
  cat <<EOF
用法: $0 [--type=count|event|crc|detail|range] [--from=YYYY-MM-DD] [--to=YYYY-MM-DD]
            [--threshold=0.1] [--sample=1000] [--side=sa|raw] [--event=NAME]
            [--project=clklogapp] [--max-days=90] [--sleep=2] [--ssh-host=host]

只读数据一致性对拍（sa_events vs log_analysis）。详见脚本头注释。
环境变量: CLICKHOUSE_HOST/PORT/USER/PASSWORD/DB（可复用 .env）
EOF
  exit 0
}

# 加载同目录 .env（若存在）
load_env() {
  local env_file="$SCRIPT_DIR/.env"
  if [ -f "$env_file" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$env_file"
    set +a
  fi
}

# 解析命令行参数
parse_args() {
  for arg in "$@"; do
    case "$arg" in
      --help|-h) usage ;;
      --type=*) TYPE="${arg#*=}" ;;
      --from=*) FROM="${arg#*=}" ;;
      --to=*)   TO="${arg#*=}" ;;
      --threshold=*) THRESHOLD="${arg#*=}" ;;
      --sample=*) SAMPLE="${arg#*=}" ;;
      --side=*) SIDE="${arg#*=}" ;;
      --event=*) EVENT_FILTER="${arg#*=}" ;;
      --project=*) PROJECT="${arg#*=}" ;;
      --max-days=*) MAX_DAYS="${arg#*=}" ;;
      --sleep=*) SLEEP_SEC="${arg#*=}" ;;
      --ssh-host=*) SSH_HOST="${arg#*=}" ;;
      *) die "未知参数: $arg（用 --help 查看用法）" 2 ;;
    esac
  done
}

# 校验参数
validate() {
  case "$TYPE" in
    count|event|crc|detail|range) ;;
    *) die "未知类型: $TYPE（可选 count|event|crc|detail|range）" 2 ;;
  esac
  case "$SIDE" in
    sa|raw) ;;
    *) die "未知抽样方向: $SIDE（可选 sa|raw）" 2 ;;
  esac

  # 时间默认昨日
  if [ -z "$TO" ]; then
    TO="$(date -v-1d +%F 2>/dev/null || date -d 'yesterday' +%F)"
  fi
  if [ -z "$FROM" ]; then
    FROM="$TO"
  fi

  if ! [[ "$THRESHOLD" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
    die "阈值必须为数字: $THRESHOLD" 2
  fi

  if [ -z "$CK_PASSWORD" ]; then
    die "未设置 CLICKHOUSE_PASSWORD（请 source .env 或 export）" 2
  fi

  mkdir -p "$LOG_DIR"
}

# 执行 CK 查询：ck_sql <SQL>，输出到 stdout；失败退出 3
ck_sql() {
  local sql="$1"
  local out
  # 服务器上可经 SSH 隧道访问（ssh -p 2223 root@localhost），或本脚本在服务器本地执行
  if [ -n "$SSH_HOST" ]; then
    out="$(ssh "$SSH_HOST" "curl -s -u '$CK_USER:$CK_PASSWORD' 'http://$CK_HOST:$CK_PORT/' --data-binary \"$sql\" FORMAT TSVWithNames" 2>&1)"
  else
    out="$(curl -s -u "$CK_USER:$CK_PASSWORD" "http://$CK_HOST:$CK_PORT/" --data-binary "$sql" 2>&1)"
  fi
  local rc=$?
  if [ $rc -ne 0 ]; then
    log "查询失败 (curl rc=$rc): $out"
    return 3
  fi
  # 检测 ClickHouse 错误返回（HTTP 200 但 body 含异常栈）
  if printf '%s' "$out" | grep -qiE 'Code: [0-9]+|DB::Exception'; then
    log "ClickHouse 返回异常: $out"
    return 3
  fi
  printf '%s\n' "$out"
}

# ---------- 各类型对拍 ----------

# 粗粒度总量对拍（R-1）
reconcile_count() {
  local from="$1" to="$2" thr="$3"
  local sa_sql raw_sql sa_out raw_out
  sa_sql="SELECT stat_date AS d, count() AS sa_cnt, count(DISTINCT crc) AS sa_uniq FROM clklog_sa.sa_events WHERE project_name = '$PROJECT' AND stat_date BETWEEN '$from' AND '$to' AND event != '' GROUP BY stat_date ORDER BY d FORMAT TSVWithNames"
  raw_sql="SELECT stat_date AS d, count() AS raw_cnt FROM clklog.log_analysis WHERE stat_date BETWEEN '$from' AND '$to' AND event != '' GROUP BY d ORDER BY d FORMAT TSVWithNames"

  sa_out="$(ck_sql "$sa_sql")" || return $?
  raw_out="$(ck_sql "$raw_sql")" || return $?

  log "--- 总量对拍 [$from ~ $to] 阈值 ${thr} ---"
  echo "date|sa_cnt|sa_uniq|raw_cnt|deviation_pct|status"
  local alert=0
  # 用临时文件做按日期 join（awk 双文件）；TSVWithNames 首行为列名，从第2行取数据
  # 注意：sa_out/raw_out 的列名行已由调用处输出；此处各文件数据行从第一行开始
  # 第一个文件 sa（3 列：date, sa_cnt, sa_uniq）；第二个文件 raw（2 列：date, raw_cnt）
  awk -F'\t' -v thr="$thr" '
    function dev(a,b){ if(b==0) return (a==0?0:999); return (a-b)/b*100 }
    NR==FNR {                             # 第一个文件：sa_events
      sa[$1] = $2; sauniq[$1] = $3;
      next;
    }
    {                                     # 第二个文件：log_analysis
      sv = sa[$1] + 0;                    # sa_events 行数
      rv = $2 + 0;                        # log_analysis 行数
      devv = dev(sv, rv);
      absv = (devv < 0) ? -devv : devv;   # 绝对值判断，双向偏差都要报警
      status = (absv > thr*100) ? "ALERT" : "ok";
      if (status=="ALERT") alert=1;
      printf "%s|%s|%s|%s|%.2f|%s\n", $1, sv, sauniq[$1], rv, devv, status;
    }
    END { if (alert) exit 1 }
  ' <(printf '%s\n' "$sa_out" | tail -n +2) <(printf '%s\n' "$raw_out" | tail -n +2)
  local rc=$?
  if [ $rc -eq 1 ]; then
    log "存在超阈值偏差（>${thr}），请排查 ingestor 丢数据或口径差异"
  fi
  return $rc
}

# 按事件对拍（R-2）
reconcile_event() {
  local from="$1" to="$2" thr="$3"
  local sa_sql raw_sql sa_out raw_out
  sa_sql="SELECT event, count() AS sa_cnt FROM clklog_sa.sa_events WHERE project_name = '$PROJECT' AND stat_date BETWEEN '$from' AND '$to' AND event != '' GROUP BY event ORDER BY event FORMAT TSVWithNames"
  raw_sql="SELECT event, count() AS raw_cnt FROM clklog.log_analysis WHERE stat_date BETWEEN '$from' AND '$to' AND event != '' GROUP BY event ORDER BY event FORMAT TSVWithNames"

  sa_out="$(ck_sql "$sa_sql")" || return $?
  raw_out="$(ck_sql "$raw_sql")" || return $?

  log "--- 按事件对拍 [$from ~ $to] ---"
  echo "source|event|cnt"
  # 两侧分别输出，tsv 列名行跳过
  printf '%s\n' "$sa_out" | tail -n +2 | awk -F'\t' '{print "sa_events|"$1"|"$2}'
  printf '%s\n' "$raw_out" | tail -n +2 | awk -F'\t' '{print "log_analysis|"$1"|"$2}'
  log "（请人工核对两侧事件计数；如需自动差集可扩展）"
  # 事件维度差异不做硬性退出，供人工判断（口径差异常见）
  return 0
}

# CRC 唯一性（R-3）
reconcile_crc() {
  local from="$1" to="$2"
  local sql out
  sql="SELECT count() AS total, count(DISTINCT crc) AS uniq FROM clklog_sa.sa_events WHERE stat_date BETWEEN '$from' AND '$to' FORMAT TSVWithNames"
  out="$(ck_sql "$sql")" || return $?
  local total uniq
  total="$(echo "$out" | awk 'NR==2{print $1}')"
  uniq="$(echo "$out" | awk 'NR==2{print $2}')"
  log "--- CRC 唯一性 [$from ~ $to] ---"
  echo "total|uniq|dup_rows"
  echo "${total:-0}|${uniq:-0}|$(( ${total:-0} - ${uniq:-0} ))"
  if [ "${total:-0}" -ne "${uniq:-0}" ]; then
    log "检测到重复 CRC（${total} 行 vs ${uniq} 唯一），可能存在重复数据"
    return 1
  fi
  return 0
}

# 抽样细对拍（R-4）
reconcile_detail() {
  local from="$1" to="$2" sample="$3"
  local side="$SIDE" evf="$EVENT_FILTER"
  local ev_clause=""
  [ -n "$evf" ] && ev_clause=" AND event='${evf//\'/\\\'}'"
  local sql out
  if [ "$side" = "sa" ]; then
    # 从 sa_events 抽样 → 回查 log_analysis（查「我方多记」：+1.2% 就是这一方向）
    sql="SELECT crc, distinct_id, event, toString(toDateTime(log_time)) AS lt FROM clklog_sa.sa_events WHERE project_name = '$PROJECT' AND stat_date BETWEEN '$from' AND '$to'$ev_clause ORDER BY rand() LIMIT $sample FORMAT TSVWithNames"
  else
    # 从 log_analysis 抽样 → 回查 sa_events（查「对侧少记/我方漏记」）
    # ⚠️ 第一列不能是空字符串：bash `read` 的 IFS 制表符会吃掉行首分隔符，
    # 导致字段整体错位（反向抽样曾因此报 0%）。用 'raw' 占位，输出时还原成 '-'
    sql="SELECT 'raw' AS crc, distinct_id, event, toString(log_time) AS lt FROM clklog.log_analysis WHERE stat_date BETWEEN '$from' AND '$to'$ev_clause ORDER BY rand() LIMIT $sample FORMAT TSVWithNames"
  fi
  out="$(ck_sql "$sql")" || return $?
  local total=0 matched=0
  log "--- 抽样细对拍 [$from ~ $to] side=$side sample=$sample${evf:+ event=$evf} ---"
  echo "crc|distinct_id|event|log_time|match_on_other_side"
  local data
  data="$(printf '%s\n' "$out" | tail -n +2)"
  while IFS=$'\t' read -r crc did ev lt; do
    [ -z "$did" ] && continue
    total=$((total+1))
    local hit n
    if [ "$side" = "sa" ]; then
      # 伪键回查社区版侧
      # ⚠️ 必须按**秒级**比对：sa 侧是 DateTime64(3)（毫秒），raw 侧是 DateTime（秒），
      # 直接比字符串永远不命中（2026-10-09 实测命中率 0% 就是此因）
      hit="$(ck_sql "SELECT count() FROM clklog.log_analysis WHERE distinct_id='${did//\'/\\\'}' AND event='${ev//\'/\\\'}' AND toString(log_time)='$lt' FORMAT TSVWithNames")" || return $?
    else
      # 伪键回查我方侧（必须带 project_name）
      hit="$(ck_sql "SELECT count() FROM clklog_sa.sa_events WHERE project_name = '$PROJECT' AND distinct_id='${did//\'/\\\'}' AND event='${ev//\'/\\\'}' AND toString(toDateTime(log_time))='$lt' FORMAT TSVWithNames")" || return $?
    fi
    n="$(echo "$hit" | awk 'NR==2{print $1}')"
    [ "$crc" = "raw" ] && crc="-"
    if [ "${n:-0}" -ge 1 ]; then
      matched=$((matched+1))
      echo "$crc|$did|$ev|$lt|yes"
    else
      echo "$crc|$did|$ev|$lt|no"
    fi
  done <<< "$data"

  if [ "$total" -eq 0 ]; then
    log "抽样范围内无数据，跳过一致率判定"
    return 0
  fi
  local rate; rate="$(awk -v m="$matched" -v t="$total" 'BEGIN{printf "%.2f", m/t*100}')"
  if [ "$side" = "sa" ]; then
    log "方向=sa→raw：抽样 $total 条，对侧命中 $matched 条，命中率 ${rate}%（低 = 我方多记/对侧丢弃）"
  else
    log "方向=raw→sa：抽样 $total 条，我方命中 $matched 条，命中率 ${rate}%（低 = 我方漏记/消费滞后）"
  fi
  # 一致率低于 90% 视为异常（口径差异容忍）
  if awk -v r="$rate" 'BEGIN{exit !(r<90)}'; then
    return 1
  fi
  return 0
}

# 低峰期大范围专项（R3-c）：按天逐日跑 count，单日护栏不变，天与天之间留间隔
reconcile_range() {
  local from="$1" to="$2" thr="$3"
  local from_ms to_ms days
  from_ms="$(date -j -f '%Y-%m-%d' "$from" +%s 2>/dev/null || date -d "$from" +%s)"
  to_ms="$(date -j -f '%Y-%m-%d' "$to" +%s 2>/dev/null || date -d "$to" +%s)"
  days=$(( (to_ms - from_ms) / 86400 + 1 ))
  if [ "$days" -le 0 ]; then
    die "范围非法（from 晚于 to）：$from ~ $to" 2
  fi
  if [ "$days" -gt "$MAX_DAYS" ]; then
    die "范围 $days 天超过上限 $MAX_DAYS（用 --max-days 显式放大）" 2
  fi
  log "--- 低峰期大范围专项：$from ~ $to（$days 天，逐日 count，间隔 ${SLEEP_SEC}s，阈值 ${thr}）---"
  echo "date|sa_cnt|sa_uniq|raw_cnt|deviation_pct|status"
  local failed=0 d rc
  for ((i = 0; i < days; i++)); do
    d="$(date -j -v+${i}d -f '%Y-%m-%d' "$from" +%F 2>/dev/null || date -d "$from +$i day" +%F)"
    # 单日对拍：复用 count（其输出含表头，此处只取数据行）
    local day_out
    day_out="$(reconcile_count "$d" "$d" "$thr" 2>/dev/null | tail -n +2)"
    rc=$?
    if [ -z "$day_out" ]; then
      printf '%s|%s|%s|%s|%s|%s\n' "$d" "-" "-" "-" "-" "NO_DATA"
      log "  $d 无数据或查询失败"
      failed=1
    else
      printf '%s\n' "$day_out"
      case "$day_out" in *"|ALERT"*) failed=1;; esac
    fi
    [ "$i" -lt $((days - 1)) ] && sleep "$SLEEP_SEC"
  done
  if [ "$failed" -eq 1 ]; then
    log "大范围专项：存在异常日（ALERT/NO_DATA），见上表"
    return 1
  fi
  log "大范围专项：$days 天全部在阈值内"
  return 0
}

# ---------- 主流程 ----------
load_env
parse_args "$@"
validate

log "对拍类型=$TYPE 范围=[$FROM ~ $TO] 阈值=$THRESHOLD sample=$SAMPLE"
log "CK: $CK_USER@$CK_HOST:$CK_PORT db=$CK_DB"

case "$TYPE" in
  count)  reconcile_count  "$FROM" "$TO" "$THRESHOLD";;
  event)  reconcile_event  "$FROM" "$TO" "$THRESHOLD";;
  crc)    reconcile_crc    "$FROM" "$TO";;
  detail) reconcile_detail "$FROM" "$TO" "$SAMPLE";;
  range)  reconcile_range  "$FROM" "$TO" "$THRESHOLD";;
esac
rc=$?

log "对拍完成，退出码=$rc"
exit $rc
