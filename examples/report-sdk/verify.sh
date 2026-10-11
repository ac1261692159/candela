#!/usr/bin/env bash
# ClkLog 上报验收器：查 ClickHouse 确认某个 run_id 的 5 步事件链是否落库。
#
# 用法：
#   examples/report-sdk/verify.sh <run_id> [--wait=<秒>]
#
# 说明：
# - 查询经 2223 SSH 隧道在服务器上执行（ClickHouse 只监听内网），凭据从**运行中的服务进程环境**
#   读取，不落盘、不打印（AGENTS.md 红线 3）。
# - 数据链路 SDK → nginx → receiver → CKafka → Flink → ClickHouse 有秒级到分钟级延迟，
#   因此默认轮询等待（--wait 默认 180 秒，每 10 秒查一次）。
# - 判定标准（与《数据上报规范与流程.md》§9/§10.1 一致）：同一 run_id 下应有 5 行——
#   track(匿名, is_logined=0) / track_signup($SignUp, 绑定 original_id) / user_set / track ×2(登录态)。
#
# 退出码：0 = 5 行齐全且字段正确；1 = 超时或字段不符（会打印实际行）。
set -uo pipefail

RUN_ID="${1:-}"
WAIT_SECONDS="${2:-}"
WAIT_SECONDS="${WAIT_SECONDS#--wait=}"
RUN_ID="${RUN_ID#--wait=}"
if [ -z "${RUN_ID}" ]; then
  echo "用法: $0 <run_id> [--wait=秒]" >&2
  exit 2
fi
WAIT_SECONDS="${WAIT_SECONDS:-300}"

TUNNEL_PORT="${CLKLOG_TUNNEL_PORT:-2223}"
TUNNEL_HOST="${CLKLOG_TUNNEL_HOST:-root@localhost}"

query_rows() {
  # 在服务器上取凭据并查询；只回传查询结果，不回传任何凭据。
  ssh -q -o BatchMode=yes -o ConnectTimeout=5 -o LogLevel=QUIET -p "${TUNNEL_PORT}" "${TUNNEL_HOST}" \
    "RUN_ID='${RUN_ID}' bash -s" <<'EOS'
set -uo pipefail
PID=$(supervisorctl pid clklog_analytics_server 2>/dev/null)
if [ -z "${PID}" ] || [ ! -r "/proc/${PID}/environ" ]; then
  echo "ERROR: 取不到 clklog_analytics_server 进程环境（服务未运行？）" >&2
  exit 3
fi
PW=$(tr '\0' '\n' < "/proc/${PID}/environ" | sed -n 's/^CLICKHOUSE_PASSWORD=//p')
if [ -z "${PW}" ]; then
  echo "ERROR: 进程环境里没有 CLICKHOUSE_PASSWORD" >&2
  exit 3
fi
# 有界查询：只按 run_id 精确匹配（distinct_id 带了 run_id），带 LIMIT。
SQL="SELECT typeContext, event, position(distinct_id, '${RUN_ID}') > 0, user_key, is_logined, track_signup_original_id, toString(log_time) FROM clklog.log_analysis WHERE distinct_id LIKE '%${RUN_ID}%' ORDER BY log_time LIMIT 20 FORMAT TSV"
curl -s -u "default:${PW}" 'http://localhost:8123/' --data-binary "${SQL}"
EOS
}

deadline=$(( $(date +%s) + WAIT_SECONDS ))
attempt=0
while :; do
  attempt=$((attempt + 1))
  OUT="$(query_rows 2>&1)" || true
  case "${OUT}" in
    ERROR:*|*"AUTHENTICATION_FAILED"*|*"Connection refused"*|*"Operation timed out"*)
      echo "[verify] 查询失败：${OUT}" >&2
      exit 1
      ;;
  esac
  ROWS=$(printf '%s\n' "${OUT}" | grep -c . || true)
  if [ "${ROWS}" -ge 5 ]; then
    break
  fi
  if [ "$(date +%s)" -ge "${deadline}" ]; then
    echo "[verify] 超时：等待 ${WAIT_SECONDS}s 后 run_id=${RUN_ID} 只有 ${ROWS} 行落库" >&2
    printf '%s\n' "${OUT}"
    exit 1
  fi
  sleep 10
done

printf '%-12s %-14s %-9s %-22s %-10s %-28s %s\n' typeContext event distinct_id user_key is_logined signup_original_id log_time
printf '%s\n' "${OUT}"

# ---- 断言：5 步链齐全 ----
fail=0
check() { if [ "$1" = "0" ]; then echo "[verify] ✗ $2" >&2; fail=1; else echo "[verify] ✓ $2"; fi }

track_rows=$(printf '%s\n' "${OUT}" | awk -F'\t' '$1=="track"' | wc -l | tr -d ' ')
signup_rows=$(printf '%s\n' "${OUT}" | awk -F'\t' '$1=="track_signup"' | wc -l | tr -d ' ')
userset_rows=$(printf '%s\n' "${OUT}" | awk -F'\t' '$1=="user_set"' | wc -l | tr -d ' ')
anon_track=$(printf '%s\n' "${OUT}" | awk -F'\t' '$1=="track" && $5=="0"' | wc -l | tr -d ' ')
logged_track=$(printf '%s\n' "${OUT}" | awk -F'\t' '$1=="track" && $5=="1" && $4!=""' | wc -l | tr -d ' ')
bind_ok=$(printf '%s\n' "${OUT}" | awk -F'\t' '$1=="track_signup" && $6!=""' | wc -l | tr -d ' ')

check "$([ "${track_rows}" -ge 3 ] && echo 1 || echo 0)" "track 行 ≥3（实际 ${track_rows}）"
check "$([ "${signup_rows}" -eq 1 ] && echo 1 || echo 0)" "track_signup 行 = 1（实际 ${signup_rows}）"
check "$([ "${userset_rows}" -ge 1 ] && echo 1 || echo 0)" "user_set 行 ≥1（实际 ${userset_rows}）"
check "$([ "${anon_track}" -ge 1 ] && echo 1 || echo 0)" "存在登录前匿名事件（is_logined=0，实际 ${anon_track}）"
check "$([ "${logged_track}" -ge 2 ] && echo 1 || echo 0)" "登录后事件 ≥2（user_key 非空，实际 ${logged_track}）"
check "$([ "${bind_ok}" -eq 1 ] && echo 1 || echo 0)" "track_signup 已绑定 original_id（实际 ${bind_ok}）"

if [ "${fail}" -eq 0 ]; then
  echo "[verify] PASS run_id=${RUN_ID}（5 步链完整）"
  exit 0
fi
echo "[verify] FAIL run_id=${RUN_ID}" >&2
exit 1
