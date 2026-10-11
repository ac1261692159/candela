#!/usr/bin/env bash
# verify.sh — candela 端到端验证（幂等，可反复执行）
#
# 覆盖：进程 / HTTP 入口 / MySQL 元数据 / ClickHouse 事件库与只读账号 / Kafka 消费 /
#       上报链路（社区 receiver → Kafka → 社区 Flink 落 clklog；manager ingestor 落 clklog_sa）
#
# 用法：bash verify.sh

set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$SELF_DIR/lib.sh"

require_root
load_manager_secrets
# 验证脚本对两套流程通用：端点按当前生效的部署形态自动判断
if docker ps --format '{{.Names}}' | grep -qx candela-server; then
  set_endpoints docker
  MODE="docker"
else
  set_endpoints native
  MODE="native"
fi

PASS=0; FAIL=0
ok()  { echo "  [OK]   $*"; PASS=$((PASS+1)); }
bad() { echo "  [FAIL] $*"; FAIL=$((FAIL+1)); }

echo "=============================================================="
echo " Candela 验证（当前形态：$MODE）"
echo "=============================================================="

echo
echo "1. 进程 / 容器"
if [ "$MODE" = "native" ]; then
  for p in candela_server candela_ingestor; do
    st="$(supervisorctl status "$p" 2>/dev/null | awk '{print $2}')"
    [ "$st" = "RUNNING" ] && ok "supervisor $p = RUNNING" || bad "supervisor $p = ${st:-未知}"
  done
else
  for c in candela-server candela-ingestor candela-web; do
    st="$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo missing)"
    [ "$st" = "running" ] && ok "容器 $c = running" || bad "容器 $c = $st"
  done
fi

echo
echo "1b. AI Harness（仅当目标机装了运行时；未装则 SKIP）"
# 判定"已装"用 supervisor 单元是否存在（install-harness.sh 安装即写该单元）。
# broker 是宿主 rootless podman 进程，与【常规/容器】形态无关，因此不按 $MODE 区分。
# broker 的 root 从 /etc/clklog/harness-broker.json 读——它是 broker 与平台共用的唯一真相。
if [ -f "$SUPERVISOR_DIR/clklog-harness-broker.ini" ]; then
  st="$(supervisorctl status clklog_harness_broker 2>/dev/null | awk '{print $2}' || true)"
  [ "$st" = "RUNNING" ] && ok "supervisor clklog_harness_broker = RUNNING" || bad "supervisor clklog_harness_broker = ${st:-未知}"
  hroot="$(python3 -c 'import json;print(json.load(open("/etc/clklog/harness-broker.json"))["root"])' 2>/dev/null || true)"
  if [ -n "$hroot" ] && curl -s -m 5 --unix-socket "$hroot/gateway/control/broker.sock" http://localhost/v1/health 2>/dev/null | grep -q '"ok":true'; then
    ok "broker socket 探活 /v1/health → ok"
  else
    bad "broker socket 探活失败（${hroot:-配置缺失}/gateway/control/broker.sock）"
  fi
  grep -A3 '^deepseek_harness:' "$BASE_DIR/configs/config.yaml" | grep -q 'enabled: true' \
    && ok "config.yaml deepseek_harness.enabled: true" \
    || bad "已装 harness 运行时但 config.yaml 仍是 enabled: false（重跑部署：HARNESS_ENABLED=1 bash deploy-native.sh --skip-build）"
else
  echo "  [SKIP] 未安装 harness 运行时（测试环境默认关闭；启用见 docs/architecture/standalone-test-env-harness-design.md）"
fi

echo
echo "2. HTTP 入口（经宿主 nginx，无域名按 IP）"
# /sa/api/health 受 AuthGuard 保护：未带 token 返回 401，能返回 401 即说明服务在监听
for path in /sa/api/health /sa/ /sa/index.html; do
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 "http://127.0.0.1${path}" || echo 000)"
  case "$path:$code" in
    "/sa/api/health:401"|"/sa/api/health:200"|"/sa/:200"|"/sa/index.html:200") ok "$path → $code" ;;
    *) bad "$path → $code" ;;
  esac
done
# 静态资源带 gzip 预压缩产物（nginx gzip_static on 时才走 .gz）
gzip_hit="$(curl -s -o /dev/null -w '%{size_download}' -m 10 -H 'Accept-Encoding: gzip' "http://127.0.0.1/sa/" || echo 0)"
[ "${gzip_hit:-0}" -gt 0 ] && ok "经 nginx 取到 /sa/（gzip 通道，${gzip_hit} 字节）" || bad "经 nginx 取 /sa/ 失败"
# 直连后端端口（绕过 nginx，确认服务本身可用）
code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 "http://127.0.0.1:3100/sa/api/health" || echo 000)"
[ "$code" = "401" ] || [ "$code" = "200" ] && ok "后端直连 :3100/sa/api/health → $code" || bad "后端直连 :3100 → $code"

echo
echo "3. MySQL"
n="$(mg_mysql_db "$RUNTIME_DB" -N -B -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${RUNTIME_DB}'" 2>/dev/null || echo 0)"
[ "${n:-0}" -gt 20 ] 2>/dev/null && ok "元数据库 ${RUNTIME_DB} 表数量：$n（Prisma 迁移）" || bad "元数据库 ${RUNTIME_DB} 表数量异常：${n:-0}"
tbl_user="$(db_table SaUser)"
admin="$(mg_mysql_db "$RUNTIME_DB" -N -B -e "SELECT CONCAT(username,'/',platform_role,'/',status) FROM \`${tbl_user}\` WHERE username='admin'" 2>/dev/null || true)"
[ -n "$admin" ] && ok "超管账号：$admin" || bad "超管账号缺失（init-admin.js 未执行）"
n2="$(mg_mysql -N -B -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${COMMUNITY_DB}'" 2>/dev/null || echo 0)"
[ "${n2:-0}" -ge 8 ] && ok "社区版库 ${COMMUNITY_DB} 表数量：$n2" || bad "社区版库 ${COMMUNITY_DB} 表数量异常：${n2:-0}"

echo
echo "4. ClickHouse"
nt="$(mg_ck "SELECT count() FROM system.tables WHERE database='${RUNTIME_CH_DB}'" 2>/dev/null || echo 0)"
[ "${nt:-0}" -ge 4 ] && ok "事件库 ${RUNTIME_CH_DB} 表数量：$nt" || bad "事件库 ${RUNTIME_CH_DB} 表数量异常：${nt:-0}"
echo "    核心表：$(mg_ck "SELECT name FROM system.tables WHERE database='${RUNTIME_CH_DB}' ORDER BY name FORMAT TSV" 2>/dev/null | tr '\n' ' ')"
# 只读账号：能查、不能写（红线 4）
ro_q="$(curl -sS -m 20 --data-binary "SELECT 1" "http://${OPS_CH_HOST}:${OPS_CH_PORT}/?user=sa_readonly&password=$(printf '%s' "$READONLY_CH_PASSWORD" | python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read()))')" 2>/dev/null || true)"
[ "$ro_q" = "1" ] && ok "sa_readonly 可查询" || bad "sa_readonly 查询失败：$ro_q"
ro_w="$(curl -sS -m 20 --data-binary "CREATE TABLE ${RUNTIME_CH_DB}.__probe_write (x UInt8) ENGINE=Memory" "http://${OPS_CH_HOST}:${OPS_CH_PORT}/?user=sa_readonly&password=$(printf '%s' "$READONLY_CH_PASSWORD" | python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read()))')" 2>/dev/null || true)"
echo "$ro_w" | grep -qi "readonly\|not allowed\|ACCESS_DENIED" && ok "sa_readonly 写入被拒（只读生效）" || bad "sa_readonly 竟可写入！返回：$ro_w"

echo
echo "5. Kafka"
topics="$(docker exec clklog-kafka /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:9092 --list 2>/dev/null | tr '\n' ' ')"
echo "$topics" | grep -q "clklog" && ok "topic 存在：$topics" || bad "topic clklog 缺失"
lag="$(docker exec clklog-kafka /opt/kafka/bin/kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --group clklog-sa-ingestor 2>/dev/null | awk 'NR>1{sum+=$6} END{print sum+0}')"
[ "${lag:-0}" -ge 0 ] 2>/dev/null && ok "Candela 消费组 clklog-sa-ingestor 当前 LAG：${lag:-0}" || warn "消费组尚未建立（首次上报后会创建）"

echo
echo "6. 上报链路（receiver → Kafka → Flink/ingestor → ClickHouse）"
before_sa="$(mg_ck "SELECT count() FROM ${RUNTIME_CH_DB}.sa_events" 2>/dev/null || echo 0)"
before_log="$(mg_ck "SELECT count() FROM ${COMMUNITY_DB}.log_analysis" 2>/dev/null || echo 0)"
TS="$(date +%s)"
python3 - "$TS" <<'PY'
import base64, json, sys, time, urllib.parse, urllib.request, uuid
ts = int(sys.argv[1])
ev = [{
    "type": "track",
    "distinct_id": f"mgr-verify-{ts}",
    "event": "PageView",
    "time": int(time.time() * 1000),
    "lib": "js",                     # 必须是字符串：对象形式会让 ClkLog 丢 properties（实测）
    "properties": {
        "$url": "http://127.0.0.1/sa/", "$url_path": "/sa/", "$title": "分析平台验证",
        "$os": "Linux", "$browser": "Chrome",
        "$is_first_day": True, "$is_first_time": True,
        "$event_session_id": str(uuid.uuid4()),
        "verify_source": "verify.sh",
    },
}]
data = urllib.parse.quote(base64.b64encode(json.dumps(ev, ensure_ascii=False).encode()).decode())
body = urllib.parse.urlencode({"project": "clklogapp",
                               "token": "ddf51db3-7c99-1310-a44f-79feb7b63c69",
                               "data": data}).encode()
req = urllib.request.Request("http://127.0.0.1/receiver/api/gp", data=body,
                             headers={"Content-Type": "application/x-www-form-urlencoded"})
try:
    with urllib.request.urlopen(req, timeout=15) as r:
        print(f"    上报 HTTP {r.status}")
except Exception as e:
    print(f"    上报异常：{e}")
PY
echo "    等待链路处理（最多 120s）..."
deadline=$(( $(date +%s) + 120 )); sa_ok=0; log_ok=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  now_sa="$(mg_ck "SELECT count() FROM ${RUNTIME_CH_DB}.sa_events" 2>/dev/null || echo 0)"
  now_log="$(mg_ck "SELECT count() FROM ${COMMUNITY_DB}.log_analysis" 2>/dev/null || echo 0)"
  [ "${now_sa:-0}" -gt "${before_sa:-0}" ] 2>/dev/null && sa_ok=1
  [ "${now_log:-0}" -gt "${before_log:-0}" ] 2>/dev/null && log_ok=1
  [ "$sa_ok" -eq 1 ] && [ "$log_ok" -eq 1 ] && break
  sleep 5
done
[ "$log_ok" -eq 1 ] && ok "社区链路人库：log_analysis $before_log → $now_log" || bad "社区链路未入库（$before_log → ${now_log:-?}）"
[ "$sa_ok" -eq 1 ] && ok "分析平台入库：sa_events $before_sa → $now_sa" || bad "分析平台未入库（$before_sa → ${now_sa:-?}），请查 $LOG_DIR/analytics-ingestor.log"

echo
echo "7. 分析平台登录接口"
tok="$(curl -s -m 15 -X POST "http://127.0.0.1/sa/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$ADMIN_INIT_PASSWORD\"}" 2>/dev/null \
  | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin); print((d.get("data") or {}).get("token") or d.get("token") or "")
except Exception: print("")' 2>/dev/null || true)"
[ -n "$tok" ] && ok "admin 登录返回 token（长度 ${#tok}）" || bad "admin 登录失败（口令见 $ENV_FILE 的 ADMIN_INIT_PASSWORD）"

echo
echo "=============================================================="
echo " 结果：$PASS 项通过，$FAIL 项失败"
echo "=============================================================="
[ "$FAIL" -eq 0 ]
