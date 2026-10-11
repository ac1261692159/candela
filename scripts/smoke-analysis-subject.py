#!/usr/bin/env python3
"""分析主体生产/本地冒烟（AS-1～AS-5）。

凭据只从环境变量或 apps/analytics-server/.env 读 USERNAME/PASSWORD，
绝不打印 token、密码或 Authorization。默认打生产。

  python3 scripts/smoke-analysis-subject.py
  SMOKE_BASE_URL=http://127.0.0.1:3100 python3 scripts/smoke-analysis-subject.py
  SMOKE_WRITE=0 python3 scripts/smoke-analysis-subject.py   # 不创建临时主体
"""

from __future__ import annotations

import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[1]
ENV_FILE = REPO / "apps/analytics-server/.env"
UID_EXPR = "if(user_key != '', user_key, distinct_id)"
TEMP_SUBJECT_NAME = "smoke_tmp_os"
AUTH_FILE = Path(os.environ.get("SMOKE_AUTH_FILE", "/tmp/clklog-smoke-auth.json"))


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


def cfg() -> dict[str, str]:
    file_env = load_env(ENV_FILE)
    return {
        "base": (
            os.environ.get("SMOKE_BASE_URL")
            or file_env.get("CLKLOG_BASE_URL")
            or "http://127.0.0.1"
        ).rstrip("/"),
        "user": os.environ.get("SMOKE_USERNAME") or file_env.get("USERNAME") or "admin",
        "password": os.environ.get("SMOKE_PASSWORD") or file_env.get("PASSWORD") or "",
        "project": os.environ.get("SMOKE_PROJECT") or "clklogapp",
        "write": os.environ.get("SMOKE_WRITE", "1"),
    }


class SmokeError(RuntimeError):
    pass


class Client:
    def __init__(self, base: str, project: str) -> None:
        self.base = base.rstrip("/")
        self.project = project
        self.token = ""
        self.ctx = ssl.create_default_context()

    def request(
        self,
        method: str,
        path: str,
        body: Any = None,
        query: dict[str, str] | None = None,
        auth: bool = True,
        expect: int | tuple[int, ...] = 200,
    ) -> tuple[int, dict[str, Any]]:
        url = self.base + path
        if query:
            url += "?" + urllib.parse.urlencode(query)
        data = None
        headers = {"Accept": "application/json", "x-project-name": self.project}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if auth and self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=90, context=self.ctx) as resp:
                raw = resp.read().decode("utf-8")
                status = resp.status
        except urllib.error.HTTPError as err:
            raw = err.read().decode("utf-8", errors="replace")
            status = err.code
        payload: dict[str, Any]
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            payload = {"message": raw[:400], "data": None}
        wanted = expect if isinstance(expect, tuple) else (expect,)
        if min(wanted) >= 400:
            if status not in wanted:
                raise SmokeError(
                    f"{method} {path} HTTP {status} (want {wanted}): {payload.get('message', '')}"
                )
        elif not (200 <= status < 300):
            raise SmokeError(f"{method} {path} HTTP {status} (want 2xx): {payload.get('message', '')}")
        return status, payload

    def data(self, method: str, path: str, **kwargs: Any) -> Any:
        _, payload = self.request(method, path, **kwargs)
        expect = kwargs.get("expect", 200)
        ok_http = min(expect) < 400 if isinstance(expect, tuple) else expect < 400
        if payload.get("code") not in (0, None) and ok_http:
            raise SmokeError(f"{method} {path} code={payload.get('code')}: {payload.get('message')}")
        return payload.get("data", payload)

    def get_text(self, path: str) -> str:
        url = self.base + path
        req = urllib.request.Request(url, headers={"Accept": "text/html"})
        with urllib.request.urlopen(req, timeout=30, context=self.ctx) as resp:
            return resp.read().decode("utf-8", errors="replace")


def metric_value(result: dict[str, Any]) -> float:
    rows = result.get("rows") or []
    if not rows:
        return 0.0
    row = rows[0]
    val = row.get("m_0", next(iter(row.values()), 0))
    try:
        return float(val)
    except (TypeError, ValueError):
        return 0.0


def pick_event(items: list[dict[str, Any]]) -> str:
    scored: list[tuple[int, str]] = []
    for item in items:
        key = str(item.get("event_key") or item.get("name") or "")
        if not key:
            continue
        score = int(item.get("yesterday_count") or item.get("recent_7d_count") or 0)
        scored.append((score, key))
    scored.sort(reverse=True)
    if not scored:
        raise SmokeError("项目没有可用事件，无法跑查询冒烟")
    return scored[0][1]


def pick_event_prop(items: list[dict[str, Any]]) -> str:
    prefer = ("os", "$os", "lib", "$lib", "app_name", "$app_name", "country")
    keys = [str(item.get("prop_key") or "") for item in items]
    keys = [key for key in keys if key and re.match(r"^[A-Za-z_$][A-Za-z0-9_$.-]*$", key)]
    for name in prefer:
        if name in keys:
            return name
    if not keys:
        raise SmokeError("没有可用事件属性，无法创建临时主体")
    return keys[0]


def check(name: str, ok: bool, detail: str = "") -> None:
    mark = "PASS" if ok else "FAIL"
    suffix = f"  {detail}" if detail else ""
    print(f"[{mark}] {name}{suffix}")
    if not ok:
        raise SmokeError(name)


def event_query(event: str, days: int = 7, **extra: Any) -> dict[str, Any]:
    end = date.today()
    start = end - timedelta(days=days - 1)
    body: dict[str, Any] = {
        "event": event,
        "metrics": [{"id": "m_0", "kind": "event", "analysis": "trig_user_num", "event": event}],
        "time_range": {"start": start.isoformat(), "end": end.isoformat()},
        **extra,
    }
    return body


def main() -> int:
    conf = cfg()
    if not conf["password"]:
        print("缺少登录密码：设置 SMOKE_PASSWORD 或 apps/analytics-server/.env 的 PASSWORD", file=sys.stderr)
        return 2
    write = conf["write"] not in ("0", "false", "no")
    client = Client(conf["base"], conf["project"])
    failed = 0
    created_id = ""

    print(f"target={conf['base']} project={conf['project']} write={int(write)}")

    try:
        html = client.get_text("/sa/")
        check("web.spa", "clklog" in html.lower() or "/sa/assets/" in html, "index ok")
        assets = re.findall(r"/sa/assets/[^\"']+", html)
        joined = html
        for href in assets[:12]:
            try:
                joined += "\n" + client.get_text(href)
            except Exception:
                continue
        check(
            "web.subject_chunk",
            "AnalysisSubjectsPage" in joined or "/analysis/subjects" in joined,
            "subjects route in bundle",
        )

        login = client.data(
            "POST",
            "/sa/api/auth/login",
            body={"username": conf["user"], "password": conf["password"]},
            auth=False,
            expect=(200, 201),
        )
        client.token = str(login.get("token") or "")
        user = login.get("user") or {}
        check("auth.login", bool(client.token) and bool(user.get("id")), f"user={user.get('username')}")
        AUTH_FILE.write_text(
            json.dumps(
                {
                    "state": {"token": client.token, "user": user},
                    "version": 0,
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        os.chmod(AUTH_FILE, 0o600)

        subjects = (client.data("GET", "/sa/api/meta/subjects") or {}).get("items") or []
        preset = next((row for row in subjects if row.get("is_preset") or row.get("name") == "user"), None)
        check("AS-1.preset", bool(preset), f"count={len(subjects)}")
        assert preset is not None
        check("AS-1.preset_name", preset.get("display_name") == "用户" and preset.get("name") == "user")
        preset_id = str(preset["subject_id"])
        _, delete_preset = client.request("DELETE", f"/sa/api/meta/subjects/{preset_id}", expect=400)
        check("AS-1.preset_locked", "不可删除" in str(delete_preset.get("message") or ""))

        events = (client.data("GET", "/sa/api/meta/events", query={"pageSize": "100", "exclude_hidden": "true"}) or {}).get(
            "items"
        ) or []
        event = pick_event(events)
        implicit = client.data("POST", "/sa/api/query/event", body=event_query(event), query={"refresh": "true"})
        explicit = client.data(
            "POST",
            "/sa/api/query/event",
            body=event_query(event, subject_id=preset_id),
            query={"refresh": "true"},
        )
        implicit_n = metric_value(implicit)
        explicit_n = metric_value(explicit)
        check("AS-2.default_user", implicit_n == explicit_n, f"event={event} users={implicit_n}")
        check("AS-2.uid_expr", UID_EXPR in str(implicit.get("sql") or ""), "implicit query uses preset expr")
        check("AS-5.nonempty", "!= ''" in str(explicit.get("sql") or "") or UID_EXPR in str(explicit.get("sql") or ""))

        cards = client.data("GET", "/sa/api/report/cards", query={"type": "event"}) or []
        if isinstance(cards, dict):
            cards = cards.get("items") or cards.get("data") or []
        legacy = next(
            (
                card
                for card in cards
                if isinstance(card, dict)
                and isinstance(card.get("dsl"), dict)
                and not card["dsl"].get("subject_id")
                and (card["dsl"].get("event") or (card["dsl"].get("metrics") or [{}])[0].get("event"))
            ),
            None,
        )
        if legacy:
            dsl = dict(legacy["dsl"])
            dsl.pop("subject_id", None)
            if "metrics" not in dsl and dsl.get("event"):
                dsl["metrics"] = [
                    {"id": "m_0", "kind": "event", "analysis": "trig_user_num", "event": dsl["event"]}
                ]
            replayed = client.data("POST", "/sa/api/query/event", body=dsl, query={"refresh": "true"})
            check(
                "AS-2.legacy_card",
                UID_EXPR in str(replayed.get("sql") or ""),
                f"card={legacy.get('card_id')}",
            )
        else:
            print("[SKIP] AS-2.legacy_card  无无 subject_id 的事件卡")

        ready_user = (client.data("GET", "/sa/api/meta/cohorts", query={"status": "ready", "subject_id": preset_id}) or {}).get(
            "items"
        ) or []
        ready_tags = (client.data("GET", "/sa/api/meta/tags", query={"status": "ready", "subject_id": preset_id}) or {}).get(
            "items"
        ) or []
        print(f"[INFO] ready cohorts/tags for 用户: {len(ready_user)}/{len(ready_tags)}")

        prop_subject = next((row for row in subjects if row.get("kind") == "property"), None)
        if write:
            leftover = next((row for row in subjects if row.get("name") == TEMP_SUBJECT_NAME), None)
            if leftover:
                client.request("DELETE", f"/sa/api/meta/subjects/{leftover['subject_id']}", expect=200)
            attrs = (client.data("GET", "/sa/api/meta/event-attributes", query={"pageSize": "200"}) or {}).get("items") or []
            prop = pick_event_prop(attrs)
            created = client.data(
                "POST",
                "/sa/api/meta/subjects",
                body={
                    "name": TEMP_SUBJECT_NAME,
                    "display_name": "冒烟临时-OS",
                    "source": {"scope": "event", "prop": prop},
                },
            )
            created_id = str(created.get("subject_id") or "")
            check("AS-1.create_property", created_id.startswith("asub_"), f"prop={prop}")
            prop_subject = created

            _, did_not = client.request(
                "POST",
                "/sa/api/meta/cohorts",
                body={
                    "name": "smoke_didnot_tmp",
                    "display_name": "冒烟没做过",
                    "kind": "condition",
                    "subject_id": created_id,
                    "definition_json": {
                        "conditions": [
                            {
                                "type": "did_event",
                                "polarity": "did_not",
                                "event": event,
                                "metric": "times",
                                "op": "gte",
                                "value": 1,
                                "time": {"mode": "last_n_days", "n": 7},
                            }
                        ]
                    },
                },
                expect=400,
            )
            check(
                "AS-3.did_not_blocked",
                "没做过" in str(did_not.get("message") or ""),
            )

        if prop_subject:
            other_id = str(prop_subject["subject_id"])
            other_cohorts = (
                client.data("GET", "/sa/api/meta/cohorts", query={"status": "ready", "subject_id": other_id}) or {}
            ).get("items") or []
            other_tags = (
                client.data("GET", "/sa/api/meta/tags", query={"status": "ready", "subject_id": other_id}) or {}
            ).get("items") or []
            leaked_c = [row["cohort_id"] for row in other_cohorts if row.get("subject_id") not in ("", other_id)]
            leaked_t = [row["tag_id"] for row in other_tags if row.get("subject_id") not in ("", other_id)]
            check("AS-4.cohort_filter", not leaked_c, f"other_ready={len(other_cohorts)}")
            check("AS-4.tag_filter", not leaked_t, f"other_ready={len(other_tags)}")
            if created_id:
                check("AS-4.empty_for_new_subject", len(other_cohorts) == 0 and len(other_tags) == 0)

            other_q = client.data(
                "POST",
                "/sa/api/query/event",
                body=event_query(event, subject_id=other_id),
                query={"refresh": "true"},
            )
            sql = str(other_q.get("sql") or "")
            check("AS-2.property_expr", "JSONExtractString" in sql, f"users={metric_value(other_q)}")
            check("AS-5.property_nonempty", "!= ''" in sql or "nullIf" in sql)

            if ready_user:
                cohort_id = str(ready_user[0]["cohort_id"])
                mismatch = client.data(
                    "POST",
                    "/sa/api/query/event",
                    body=event_query(
                        event,
                        subject_id=other_id,
                        filters={"logic": "and", "items": [{"scope": "cohort", "prop": cohort_id, "op": "in"}]},
                    ),
                    query={"refresh": "true"},
                )
                check(
                    "AS-4.mismatch_empty",
                    metric_value(mismatch) == 0,
                    f"cohort={cohort_id}",
                )
        else:
            print("[SKIP] AS-3/AS-4 property subject  SMOKE_WRITE=0 且现网无属性主体")

        print("OK")
        return 0
    except SmokeError as err:
        print(f"FAIL: {err}", file=sys.stderr)
        failed = 1
        return 1
    finally:
        if created_id and client.token:
            try:
                client.request("DELETE", f"/sa/api/meta/subjects/{created_id}", expect=200)
                print(f"[INFO] cleaned temp subject {TEMP_SUBJECT_NAME}")
            except Exception as err:  # noqa: BLE001
                print(f"[WARN] temp subject cleanup failed: {err}", file=sys.stderr)
        if failed:
            sys.stderr.write("")


if __name__ == "__main__":
    sys.exit(main())
