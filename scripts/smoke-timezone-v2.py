#!/usr/bin/env python3
"""时区系统 v2 生产闭环冒烟（phase: clklog-analytics-timezone-v2）。

凭据只从环境变量或 apps/analytics-server/.env 读 USERNAME/PASSWORD，不打印 token/密码。
探针动作全部可逆：用户偏好置空、项目时区置空、探针联系人删除。

  python3 scripts/smoke-timezone-v2.py
"""

from __future__ import annotations

import json
import os
from zoneinfo import ZoneInfo
import sys
import urllib.error
import urllib.request
from datetime import date, timedelta, datetime, timezone as _dt_tz
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
ENV_FILE = REPO / "apps/analytics-server/.env"
RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    RESULTS.append((name, cond, detail))
    print(f"[{'PASS' if cond else 'FAIL'}] {name}", detail)


def load_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        out[key.strip()] = value.strip().strip('"').strip("'")
    return out


class Client:
    def __init__(self) -> None:
        env = load_env(ENV_FILE)
        self.base = (os.environ.get("SMOKE_BASE_URL") or env.get("CLKLOG_BASE_URL") or "http://127.0.0.1").rstrip("/")
        self.user = os.environ.get("SMOKE_USERNAME") or env.get("USERNAME") or "admin"
        self.password = os.environ.get("SMOKE_PASSWORD") or env.get("PASSWORD") or ""
        self.token = ""

    def http(self, method: str, path: str, body: object | None = None) -> tuple[int, dict]:
        data = json.dumps(body).encode() if body is not None else None
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as e:
            try:
                payload = json.loads(e.read())
            except Exception:
                payload = {}
            return e.code, payload

    def data(self, method: str, path: str, body: object | None = None, expect: tuple = (200, 201)) -> dict:
        status, payload = self.http(method, path, body)
        assert status in expect, f"{path} → {status}: {str(payload)[:200]}"
        return payload.get("data", payload)

    def login(self) -> None:
        data = self.data("POST", "/sa/api/auth/login", {"username": self.user, "password": self.password})
        self.token = str(data.get("token") or "")


def main() -> int:
    c = Client()
    c.login()
    event = "clothes_display_trigger"
    end = date.today()
    start = end - timedelta(days=2)

    def event_sql(tz: str | None) -> str:
        tr: dict = {"start": start.isoformat(), "end": end.isoformat()}
        if tz:
            tr["timezone"] = tz
        q = {
            "event": event,
            "metrics": [{"id": "m_0", "kind": "event", "analysis": "total_times", "event": event}],
            "groups": [{"scope": "time", "granularity": "day"}],
            "time_range": tr,
        }
        res = c.data("POST", "/sa/api/query/event?refresh=true", q)
        sql = str(res.get("sql") or "")
        return sql

    # ---------- SC-1 用户显示时区偏好 ----------
    pref = c.data("PUT", "/sa/api/auth/preferences", {"timezone": "Pacific/Honolulu"})
    check("SC1.preferences写入", pref.get("timezone") == "Pacific/Honolulu")
    me = c.data("GET", "/sa/api/auth/me")
    check("SC1.me下发", me.get("timezone") == "Pacific/Honolulu", str(me.get("timezone")))
    sql_by_user = event_sql(None)
    check("SC1.查询默认随用户", "display_tz" in sql_by_user, "SQL 携带 display_tz 参数")
    _ = c.data("PUT", "/sa/api/auth/preferences", {"timezone": None})
    me_after = c.data("GET", "/sa/api/auth/me")
    sql_back = event_sql(None)
    check("SC1.清除即回落平台", me_after.get("timezone") in (None, "") and "display_tz" not in sql_back, f"me={me_after.get('timezone')!r}")

    # ---------- SC-2 项目级时区 ----------
    put = c.data("PUT", "/sa/api/iam/ops/projects/clklogapp/timezone", {"timezone": "Pacific/Honolulu"})
    check("SC2.项目时区写入", put.get("timezone") == "Pacific/Honolulu")
    # 生效瞬判：项目 calendar 跟随（模板/校验链在 validator 阶段解析，relative today 的解析日随之）
    import time as _time
    resolved = None
    for _ in range(10):
        res = c.data(
            "POST",
            "/sa/api/report/sql/execute",
            {
                "mode": "sql",
                "sql": "SELECT count() AS cnt FROM sa_events",
                "time_range": {"start": "", "end": "", "relative": {"kind": "past_n", "n": 1}},
            },
        )
        resolved = res.get("applied_time_range") or {}
        if resolved.get("timezone") == "Pacific/Honolulu":
            break
        _time.sleep(1)
    hnl_today = (datetime.now(_dt_tz.utc).astimezone(ZoneInfo('Pacific/Honolulu')) - timedelta(days=1)).date().isoformat()
    check(
        "SC2.查询默认随项目（解析历）",
        resolved.get("timezone") == "Pacific/Honolulu" and (resolved or {}).get("end") == hnl_today,
        f"applied={resolved} expected_end={hnl_today}",
    )
    _ = c.data("PUT", "/sa/api/iam/ops/projects/clklogapp/timezone", {"timezone": None})
    put_back = (c.data("GET", "/sa/api/iam/ops/projects") or {})
    row = next((p for p in (put_back if isinstance(put_back, list) else []) if p.get("name") == "clklogapp"), None)
    res_back = c.data(
        "POST",
        "/sa/api/report/sql/execute",
        {"mode": "sql", "sql": "SELECT count() AS cnt FROM sa_events", "time_range": {"start": "", "end": "", "relative": {"kind": "past_n", "n": 1}}},
    )
    back = res_back.get("applied_time_range") or {}
    check("SC2.清除即回落平台", (row is None or row.get("timezone") in (None, "")) and back.get("timezone") == "Asia/Shanghai", f"back={back}")

    # ---------- SC-2 维护端点校验 ----------
    status, bad = c.http("PUT", "/sa/api/iam/ops/projects/clklogapp/timezone", {"timezone": "Mars/Olympus"})
    check("SC2.非法时区400", status == 400, f"status={status}")

    # ---------- SC-3 通知按收件人时区 ----------
    probe = c.data(
        "POST",
        "/sa/api/ops/alerts/contacts",
        {"name": "tz_v2_sc3_probe", "kind": "feishu_webhook", "webhook_url": "https://open.feishu.cn/invalid-probe/tz_v2_probe", "timezone": "UTC"},
    )
    probe_id = probe.get("id") or probe.get("contact", {}).get("id")
    check("SC3.建UTC联系人", bool(probe_id), f"id={probe_id}")
    _ = c.data(
        "POST",
        "/sa/api/ops/alerts/contacts",
        {"name": "tz_v2_sc3_probe_sh", "kind": "feishu_webhook", "webhook_url": "https://open.feishu.cn/invalid-probe/tz_v2_probe_sh"},
    )
    probe2 = (c.data("GET", "/sa/api/ops/alerts/contacts") or {}).get("items") or []
    probe_b = next((i for i in probe2 if i.get("name") == "tz_v2_sc3_probe_sh"), None)
    probe_b_id = (probe_b or {}).get("id")
    check("SC3.建平台口径联系人", bool(probe_b_id), f"id={probe_b_id}")

    import re as _re
    def wall_of(contact_id_arg):
        pv = c.data("POST", "/sa/api/ops/alerts/templates/preview", {"kind": "fire", "channel": "chat", "contact_id": contact_id_arg})
        hit = _re.search(r"\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}", str(pv.get("body", "")) + str(pv.get("subject", "")))
        assert hit, f"preview 无时区文本: {str(pv)[:200]}"
        return datetime.strptime(hit.group(0), "%Y-%m-%d %H:%M:%S")
    wall_utc = wall_of(probe_id)
    wall_sh = wall_of(probe_b_id)
    delta_hours = abs((wall_sh - wall_utc).total_seconds()) / 3600
    check("SC3.预览按联系人时区（8h 差）", 7.9 <= delta_hours <= 8.1, f"utc={wall_utc} sh={wall_sh} delta_h={round(delta_hours, 3)}")
    for cid in [probe_id, probe_b_id]:
        if cid:
            c.data("DELETE", f"/sa/api/ops/alerts/contacts/{cid}")
    left = c.data("GET", "/sa/api/ops/alerts/contacts")
    left_items = left.get("items") if isinstance(left, dict) else []
    check("SC3.探针联系人清尘", all(str(i.get("id")) not in (str(probe_id), str(probe_b_id)) for i in (left_items or [])))

    # ---------- SC-4 非法联系人时区 ----------
    status2, bad2 = c.http("POST", "/sa/api/ops/alerts/contacts", {"name": "tz_v2_sc5_bad", "kind": "feishu_webhook", "webhook_url": "https://open.feishu.cn/invalid-probe/x", "timezone": "Mars"})
    check("SC5.联系人时区400", status2 == 400, f"status={status2}")

    failures = sum(1 for _, ok, _ in RESULTS if not ok)
    print(f"== {'FAIL' if failures else 'PASS'}: {len(RESULTS) - failures}/{len(RESULTS)} 通过 ==")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
