#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ClkLog 批量回补（文件导入）CLI —— 把历史日志 / CSV 补报成 ClkLog 事件。

用途
====
把离线导出的历史行为数据（CSV / JSONL）按《数据上报规范与流程.md》§1 的上报协议补报给
ClkLog receiver：

    表单 POST（application/x-www-form-urlencoded）
      project = <项目名>
      token   = <项目 token>            # 只从 --token / 环境变量 / ../.env 读取，禁止硬编码
      data    = base64(JSON 数组) → urlencode

事件结构遵循 §2，用户标识遵循 §3（**ClkLog 口径，不是神策原生口径**）：

    - 登录ID          → 顶层 `identities.user_key`（落库 user_key，非空则 is_logined=1）
    - 登录绑定匿名ID  → `properties.$track_signup_original_id`（落库 track_signup_original_id）
    - `distinct_id` 全程稳定（登录前后都不切换）

CSV 列规范
==========
表头必需四列（顺序不限）：

    type, event, distinct_id, time

| 列 | 必填 | 说明 |
|----|------|------|
| `type` | 是 | 仅支持 `track` / `track_signup` / `user_set`；其它值该行跳过并记原因 |
| `event` | track 必填 | 事件名；`track_signup` 留空时默认 `$SignUp`；`user_set` 行忽略该列 |
| `distinct_id` | 是 | 访客ID（匿名/设备ID），登录前后保持稳定 |
| `time` | 是 | **毫秒**时间戳，或可解析的时间字符串（ISO 8601 / `YYYY-MM-DD HH:MM:SS[.SSS]` / `YYYY/MM/DD`）；10 位秒级整数会自动 ×1000 |
| `user_key` | 否 | 映射为 `identities.user_key`；`track_signup` 行留空时按 §3 口径回填为 `distinct_id` |
| `properties_json` | 否 | 一段 JSON 对象，先整体合并进 `properties`（同名属性以独立列为准） |
| `original_id`（别名） | 否 | 映射为 `properties.$track_signup_original_id`；等价列名：`$track_signup_original_id` / `track_signup_original_id` / `$original_id` / `signup_original_id` |
| 其它列 | 否 | 一律作为 `properties` 的属性；列名以 `$` 开头即预置属性（如 `$url`、`$os`、`$utm_source`）；空单元格忽略 |

取值规则：单元格先按 JSON 字面量解析（`123`→数字、`true`→布尔、`["a"]`→数组、`{"k":1}`→对象），
解析失败则保持字符串——所以 `product_id=P1001` 仍是字符串，`amount=99.5` 是数字，`0012` 因前导零仍是字符串。

JSONL 格式
==========
每行一个事件对象（已经是接收端结构，允许直接出现 `identities` / `properties`），逐行规范化。
兼容性垫片：对象顶层出现 `login_id` / `user_key` → 转 `identities.user_key`；
`original_id` → `properties.$track_signup_original_id`（会打印提示，避免踩神策口径的坑）。

两种格式都会给每个事件的 `properties` 注入 `backfill_run_id=<run_id>`，
便于按 run 核对落库（社区版 `clklog.log_analysis` 不物化自定义属性，核对主要看 distinct_id；
分析平台 `clklog_sa.sa_events.properties` 可直接查到该键）。

命令行示例
==========
    cd examples/report-sdk/backfill

    # 1) 先小批量试跑（不发网络，只做读取/规范化/编码与体积校验）
    python3 backfill.py --input /tmp/history.csv --limit 5 --dry-run

    # 2) 小批量真跑（limit + 默认 batch-size=50）
    python3 backfill.py --input /tmp/history.csv --limit 5

    # 3) 正式回补并限速 20 条/秒
    python3 backfill.py --input /tmp/history.csv --batch-size 50 --rate 20

    # 4) 断点续跑（进度写 <input>.backfill-progress.json，失败行写 <input>.failed.jsonl）
    python3 backfill.py --input /tmp/history.csv --resume

    # 5) JSONL 输入
    python3 backfill.py --input /tmp/history.jsonl --format jsonl --rate 10

    # 6) 显式指定端点/token（一般用环境变量 CLKLOG_TOKEN / CLKLOG_ENDPOINT / CLKLOG_PROJECT，
    #    或 ../.env；命令行 --token 只适合临时调试，注意不要写进 shell 历史）
    python3 backfill.py --input /tmp/history.csv --endpoint https://... --project clklogapp --token "$CLKLOG_TOKEN"

退出码：0 = 全部发送成功；1 = 有失败行；2 = 参数或凭据错误；130 = 被 Ctrl-C 中断（已发送批次已落进度，用 --resume 继续）。

历史数据回补的注意事项（重要）
==============================
1. **时间必须是原始毫秒**：`time` 用历史事件发生时的毫秒时间戳（不要用「现在」）。秒级时间戳
   会被链路按 1970 年处理，落库时间错乱；本工具仅在 10 位整数时自动 ×1000 兜底。
2. **`track_signup` 的绑定顺序**：`track_signup`（`$SignUp`）是匿名ID ↔ 登录ID 的绑定动作，
   历史回补时应保证它落在「登录前匿名事件」之后、「登录后事件」之前（按 `time` 排序）；
   绑定缺失会让登录后事件在分析侧归并不到用户。
3. **重复回补会产生重复事件——本工具不做去重**：receiver 只做格式解析，没有幂等键；
   同一行补报两次就会落两条。请用 `--dry-run` / `--limit` 先验证，再用 `--resume` 续跑，
   不要对同一文件重复执行不带 `--resume` 的全量回补（那会重新生成 run_id 并重发全部行）。
4. 断点续跑只信任 `<input>.backfill-progress.json` 的「已完成行号」；该文件丢失或输入文件被改动时，
   已发送的行会被重发。输入文件大小/修改时间变化时工具会拒绝续跑（除非 `--force-resume`）。
5. 单批次 ≤50 条且表单 body ≤1MB（base64 + urlencode 后的实际字节数），超限自动切分；
   单条事件本身就超 1MB 时该行记失败。
6. 上限与礼貌：默认批次 50、失败按 0.5s/1s/2s 退避重试 3 次（共 4 次尝试）、HTTP 200 才算成功；
   生产回补请用 `--rate` 限速，避免压垮 receiver。
"""

import argparse
import base64
import collections
import csv
import datetime
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

VERSION = "1.0.0"

DEFAULT_ENDPOINT = "https://example.com/receiver/api/gp"
DEFAULT_PROJECT = "clklogapp"

MAX_BATCH_SIZE = 50                 # 协议建议单条 data ≤ 50 事件
MAX_BODY_BYTES = 1024 * 1024        # 表单 body ≤ 1MB
SUPPORTED_TYPES = ("track", "track_signup", "user_set")
RETRY_BACKOFF = (0.5, 1.0, 2.0)     # 失败重试退避：0.5s / 1s / 2s（共重试 3 次）
REQUIRED_CSV_COLUMNS = ("type", "event", "distinct_id", "time")

ORIGINAL_ID_ALIASES = (
    "original_id",
    "$track_signup_original_id",
    "track_signup_original_id",
    "$original_id",
    "signup_original_id",
)
RESERVED_CSV_COLUMNS = set(REQUIRED_CSV_COLUMNS) | {"user_key", "properties_json"} | set(ORIGINAL_ID_ALIASES)

PROGRESS_SUFFIX = ".backfill-progress.json"
FAILED_SUFFIX = ".failed.jsonl"

RUN_ID_PREFIX = "backfill-"
TIME_FORMATS = (
    "%Y-%m-%d %H:%M:%S.%f",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%d %H:%M",
    "%Y/%m/%d %H:%M:%S",
    "%Y-%m-%d",
    "%Y/%m/%d",
    "%Y%m%d%H%M%S",
    "%Y%m%d",
)


class CliError(Exception):
    """参数 / 环境 / 输入文件级错误（退出码 2）。"""


class RowSkip(Exception):
    """单行不可回补（缺字段、类型不支持、时间不可解析等），计入「跳过」并带原因。"""


class SendError(Exception):
    """批次发送失败（重试耗尽 / 单条超体积）。"""


# --------------------------------------------------------------------------- #
# 编码与发送（协议硬要求：base64 + urlencode 表单，见规范 §1.3）
# --------------------------------------------------------------------------- #

def encode_body(project, token, events):
    """构造表单 body：data = base64(JSON 数组) → urlencode；返回 bytes。"""
    payload = base64.b64encode(
        json.dumps(events, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ).decode("ascii")
    return urllib.parse.urlencode(
        {"project": project, "token": token, "data": payload}
    ).encode("ascii")


def redact(text, token):
    """错误信息脱敏：绝不让 token 出现在输出或失败文件里（AGENTS.md 红线 3）。"""
    if token and text:
        return str(text).replace(token, "***")
    return str(text)


def post_body(endpoint, body, timeout):
    """单次 POST，返回 HTTP 状态码；非 200 由调用方决定是否重试。"""
    request = urllib.request.Request(
        endpoint,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "*/*",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as resp:
        resp.read()
        return resp.status


def send_with_retry(endpoint, body, timeout, token, sleep=time.sleep):
    """发送一个批次；HTTP 200 才算成功，失败按 0.5s/1s/2s 退避重试 3 次。

    返回 (True, None) 或 (False, 最后一次错误信息)。
    """
    last_error = None
    for attempt in range(1, len(RETRY_BACKOFF) + 2):  # 1 次首发 + 3 次重试
        try:
            status = post_body(endpoint, body, timeout)
            if status == 200:
                return True, None
            last_error = "http {}".format(status)
        except urllib.error.HTTPError as exc:
            try:
                detail = exc.read().decode("utf-8", "replace")
            except Exception:  # pragma: no cover - 读 body 失败
                detail = ""
            last_error = "http {}: {}".format(exc.code, detail.strip()[:300])
        except Exception as exc:  # 网络错误 / 超时 / DNS
            last_error = "{}: {}".format(type(exc).__name__, exc)
        if attempt <= len(RETRY_BACKOFF):
            sleep(RETRY_BACKOFF[attempt - 1])
    return False, redact(last_error, token)


def split_by_size(project, token, token_batch, max_bytes):
    """按实际表单 body 字节数切分：返回 body ≤ max_bytes 的子批次列表。

    单条事件本身超限时抛 SendError（调用方记该行失败）。
    """
    batches = []
    current = []
    for item in token_batch:
        trial = current + [item]
        body = encode_body(project, token, [ev for _, ev in trial])
        if len(body) <= max_bytes:
            current = trial
            continue
        if not current:
            raise SendError(
                "单条事件编码后 {} 字节，超过 --max-body-bytes={}".format(len(body), max_bytes)
            )
        batches.append(current)
        current = [item]
        body = encode_body(project, token, [ev for _, ev in current])
        if len(body) > max_bytes:
            raise SendError(
                "单条事件编码后 {} 字节，超过 --max-body-bytes={}".format(len(body), max_bytes)
            )
    if current:
        batches.append(current)
    return batches


# --------------------------------------------------------------------------- #
# 行规范化：CSV 行 / JSONL 对象 → 接收端事件结构
# --------------------------------------------------------------------------- #

def parse_time_ms(value):
    """把 time 解析为毫秒整数；支持毫秒时间戳 / 秒级整数（自动 ×1000）/ 常见时间字符串。"""
    if isinstance(value, bool):
        raise RowSkip("time 不能是布尔值")
    if isinstance(value, (int, float)):
        return _int_to_ms(int(value))

    text = "" if value is None else str(value).strip()
    if not text:
        raise RowSkip("缺少 time")
    if re.fullmatch(r"[+-]?\d+(\.\d+)?", text):
        number = float(text)
        return _int_to_ms(int(number) if number.is_integer() else number)

    iso = text[:-1] + "+00:00" if text.endswith("Z") else text
    try:
        return int(datetime.datetime.fromisoformat(iso).timestamp() * 1000)
    except ValueError:
        pass
    for fmt in TIME_FORMATS:
        try:
            return int(datetime.datetime.strptime(text, fmt).timestamp() * 1000)
        except ValueError:
            continue
    raise RowSkip("无法解析 time={!r}（需毫秒时间戳或可解析时间字符串）".format(text))


def _int_to_ms(number):
    """10 位秒级整数自动换算为毫秒（其余按毫秒原样使用）。"""
    if 100000000 <= abs(number) < 100000000000:
        return int(number) * 1000
    return int(number)


def coerce_value(value):
    """JSON 字面量能解析就用解析结果（数字/布尔/数组/对象），否则保持字符串。"""
    text = "" if value is None else str(value).strip()
    if text == "":
        return None
    try:
        return json.loads(text)
    except ValueError:
        return text



def _bump(mapping, key):
    """警告计数 +1（对 dict/defaultdict 都安全）。"""
    mapping[key] = mapping.get(key, 0) + 1


def _pick(mapping, keys):
    for key in keys:
        value = mapping.get(key)
        if value is not None and str(value).strip() != "":
            return str(value).strip()
    return ""


def _base_event(event_type, distinct_id, time_ms, event_name, user_key, properties, run_id):
    """组装接收端事件结构（§2）+ 注入 run 标识 + lib 标识（仅在缺失时补）。"""
    event = {
        "type": event_type,
        "distinct_id": distinct_id,
        "time": time_ms,
        "properties": properties,
    }
    if event_name:
        event["event"] = event_name
    if user_key:
        event["identities"] = {"user_key": user_key}
    event.setdefault("lib", {"$lib": "clklog-backfill", "$lib_version": VERSION})
    properties["backfill_run_id"] = run_id
    return event


def event_from_csv(row, line_no, run_id, warnings):
    """CSV 行 → 事件对象；不可回补的行抛 RowSkip。"""
    event_type = (row.get("type") or "").strip()
    if not event_type:
        raise RowSkip("缺少 type")
    if event_type not in SUPPORTED_TYPES:
        raise RowSkip("不支持的 type={!r}（仅 {}）".format(event_type, "/".join(SUPPORTED_TYPES)))

    distinct_id = (row.get("distinct_id") or "").strip()
    if not distinct_id:
        raise RowSkip("缺少 distinct_id")

    event_name = (row.get("event") or "").strip()
    if event_type == "track" and not event_name:
        raise RowSkip("track 行缺少 event")
    if event_type == "track_signup" and not event_name:
        event_name = "$SignUp"
    if event_type == "user_set":
        event_name = ""  # 用户属性行不带事件名

    time_ms = parse_time_ms(row.get("time"))

    properties = {}
    raw_json = (row.get("properties_json") or "").strip()
    if raw_json:
        try:
            parsed = json.loads(raw_json)
        except ValueError as exc:
            raise RowSkip("properties_json 不是合法 JSON：{}".format(exc))
        if not isinstance(parsed, dict):
            raise RowSkip("properties_json 必须是 JSON 对象")
        properties.update(parsed)

    for key, value in row.items():
        if key is None:
            continue
        key = key.strip()
        if not key or key in RESERVED_CSV_COLUMNS:
            continue
        coerced = coerce_value(value)
        if coerced is not None:
            properties[key] = coerced

    original_id = _pick(row, ORIGINAL_ID_ALIASES)
    if original_id:
        properties["$track_signup_original_id"] = original_id
    elif event_type == "track_signup":
        _bump(warnings, "track_signup 行缺少 original_id（未能绑定匿名ID）")

    user_key = (row.get("user_key") or "").strip()
    if not user_key and event_type == "track_signup":
        # §3 口径：track_signup 的 distinct_id 就是登录ID，user_key 为空会让 is_logined=0
        user_key = distinct_id
        _bump(warnings, "track_signup 行 user_key 为空，已按 §3 口径回填为 distinct_id")

    return _base_event(event_type, distinct_id, time_ms, event_name, user_key, properties, run_id)


def event_from_jsonl(obj, run_id, warnings):
    """JSONL 对象（已是接收端结构）→ 规范化事件；不可回补的行抛 RowSkip。"""
    if not isinstance(obj, dict):
        raise RowSkip("JSONL 行不是 JSON 对象")

    event_type = str(obj.get("type") or "").strip()
    if not event_type:
        raise RowSkip("缺少 type")
    if event_type not in SUPPORTED_TYPES:
        raise RowSkip("不支持的 type={!r}（仅 {}）".format(event_type, "/".join(SUPPORTED_TYPES)))

    distinct_id = str(obj.get("distinct_id") or "").strip()
    if not distinct_id:
        raise RowSkip("缺少 distinct_id")

    event_name = str(obj.get("event") or "").strip()
    if event_type == "track" and not event_name:
        raise RowSkip("track 行缺少 event")
    if event_type == "track_signup" and not event_name:
        event_name = "$SignUp"
    if event_type == "user_set":
        event_name = ""

    if obj.get("time") is None:
        raise RowSkip("缺少 time")
    time_ms = parse_time_ms(obj.get("time"))

    raw_props = obj.get("properties")
    if raw_props is None:
        properties = {}
    elif isinstance(raw_props, dict):
        properties = dict(raw_props)
    else:
        raise RowSkip("properties 必须是 JSON 对象")

    identities = obj.get("identities")
    if identities is not None and not isinstance(identities, dict):
        raise RowSkip("identities 必须是 JSON 对象")
    identities = dict(identities or {})

    if not identities.get("user_key"):
        login_id = str(obj.get("login_id") or obj.get("user_key") or "").strip()
        if login_id:
            identities["user_key"] = login_id
            _bump(warnings, "顶层 login_id/user_key 已转换为 identities.user_key（ClkLog §3 口径）")
    user_key = str(identities.get("user_key") or "").strip()

    if not properties.get("$track_signup_original_id"):
        original_id = str(obj.get("original_id") or obj.get("track_signup_original_id") or "").strip()
        if original_id:
            properties["$track_signup_original_id"] = original_id
            _bump(warnings, "顶层 original_id 已转换为 properties.$track_signup_original_id（ClkLog §3 口径）")
        elif event_type == "track_signup":
            _bump(warnings, "track_signup 行缺少 original_id（未能绑定匿名ID）")
    if not user_key and event_type == "track_signup":
        user_key = distinct_id
        _bump(warnings, "track_signup 行 user_key 为空，已按 §3 口径回填为 distinct_id")

    event = _base_event(event_type, distinct_id, time_ms, event_name, user_key, properties, run_id)
    if isinstance(obj.get("lib"), dict):
        event["lib"] = obj["lib"]
    return event


# --------------------------------------------------------------------------- #
# 输入流：按行产出 (行号, 记录)
# --------------------------------------------------------------------------- #

def guess_format(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".jsonl", ".ndjson"):
        return "jsonl"
    if ext in (".csv", ".tsv", ".txt"):
        return "csv"
    return "csv"


def iter_csv(path):
    """流式产出 (物理行号, dict)。表头必需列缺失时抛 CliError。"""
    handle = open(path, "r", encoding="utf-8-sig", newline="")
    try:
        reader = csv.DictReader(handle)
        header = reader.fieldnames or []
        missing = [col for col in REQUIRED_CSV_COLUMNS if col not in header]
        if missing:
            raise CliError(
                "CSV 表头缺少必需列 {}（当前表头：{}）".format(",".join(missing), ",".join(header))
            )
        for row in reader:
            yield reader.line_num, row
    finally:
        handle.close()


def iter_jsonl(path):
    """流式产出 (物理行号, 解析后的对象)；空行跳过，JSON 解析失败抛 RowSkip。"""
    handle = open(path, "r", encoding="utf-8-sig")
    try:
        for line_no, line in enumerate(handle, start=1):
            text = line.strip()
            if not text:
                continue
            try:
                yield line_no, json.loads(text)
            except ValueError as exc:
                raise RowSkip("JSONL 第 {} 行不是合法 JSON：{}".format(line_no, exc))
    finally:
        handle.close()


# --------------------------------------------------------------------------- #
# 进度文件
# --------------------------------------------------------------------------- #

def progress_path_for(input_path):
    return os.path.abspath(input_path) + PROGRESS_SUFFIX


def failed_path_for(input_path):
    return os.path.abspath(input_path) + FAILED_SUFFIX


def load_progress(path):
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        if not isinstance(data, dict):
            return None
        data["completed_lines"] = set(int(x) for x in data.get("completed_lines") or [])
        return data
    except (ValueError, OSError):
        raise CliError("进度文件损坏，无法解析：{}（删除后可重新全量回补）".format(path))


def save_progress(path, data):
    """原子写进度（临时文件 + os.replace），保证 Ctrl-C 也不会写出半个文件。"""
    payload = dict(data)
    payload["completed_lines"] = sorted(payload.get("completed_lines") or [])
    payload["updated_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    os.replace(tmp, path)


# --------------------------------------------------------------------------- #
# 统计与摘要
# --------------------------------------------------------------------------- #

class Stats(object):
    def __init__(self):
        self.read_lines = 0
        self.accepted = 0
        self.sent = 0
        self.failed = 0
        self.batches = 0
        self.skipped_reasons = {}
        self.skip_examples = []
        self.failed_examples = []
        self.warnings = {}

    def skip(self, line_no, reason):
        self.skipped_reasons[reason] = self.skipped_reasons.get(reason, 0) + 1
        if len(self.skip_examples) < 5:
            self.skip_examples.append((line_no, reason))

    @property
    def skipped(self):
        return sum(self.skipped_reasons.values())


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #

class BackfillRunner(object):
    def __init__(self, args, env):
        self.args = args
        self.endpoint = args.endpoint or env.get("CLKLOG_ENDPOINT") or DEFAULT_ENDPOINT
        self.project = args.project or env.get("CLKLOG_PROJECT") or DEFAULT_PROJECT
        self.token = args.token or env.get("CLKLOG_TOKEN") or ""
        self.stats = Stats()
        self.warnings = collections.defaultdict(int)
        self.started = time.monotonic()
        self.progress_file = progress_path_for(args.input)
        self.failed_file = failed_path_for(args.input)
        self.progress = None
        self.run_ids = []
        self.failed_handle = None
        self.input_stat = None
        self.attempted = 0
        self.unsent_pending = 0

    # ---------- 准备 ----------

    def prepare(self):
        args = self.args
        if not args.dry_run and not self.token:
            raise CliError(
                "缺少 token：请设置环境变量 CLKLOG_TOKEN、写入 ../.env，或用 --token 传入（勿写进代码）"
            )
        if not os.path.isfile(args.input):
            raise CliError("输入文件不存在：{}".format(args.input))
        if args.rate < 0:
            raise CliError("--rate 不能为负数（0 表示不限速）")
        if args.batch_size < 1:
            raise CliError("--batch-size 至少为 1")
        if args.max_body_bytes < 1024:
            raise CliError("--max-body-bytes 至少 1024")
        self.input_stat = os.stat(args.input)

        progress = load_progress(self.progress_file)
        if args.resume:
            if progress is None:
                print("[backfill] --resume 未找到进度文件 {}，按全新回补开始".format(self.progress_file))
            elif os.path.abspath(progress.get("input") or "") != os.path.abspath(args.input):
                print("[backfill] 进度文件不属于当前输入文件，忽略并全新开始：{}".format(self.progress_file))
                progress = None
            elif (
                progress.get("input_size") != self.input_stat.st_size
                or progress.get("input_mtime") != int(self.input_stat.st_mtime)
            ) and not args.force_resume:
                raise CliError(
                    "输入文件与进度文件不一致（大小/修改时间已变化）: {}；"
                    "确认文件未变可加 --force-resume，或删除进度文件重新全量回补".format(args.input)
                )
            elif progress.get("finished"):
                print(
                    "[backfill] 进度文件标记该文件已回补完成（sent_events={}）；"
                    "如需重发请删除 {} 或另存输入文件".format(progress.get("sent_events", 0), self.progress_file)
                )
        else:
            if progress is not None:
                print(
                    "[backfill] 发现已存在的进度文件但未使用 --resume，本次将全新回补并覆盖进度：{}".format(
                        self.progress_file
                    )
                )
            progress = None

        if args.run_id:
            run_id = args.run_id
        elif progress is not None and progress.get("run_ids"):
            run_id = progress["run_ids"][-1]
        else:
            run_id = "{}{}".format(RUN_ID_PREFIX, int(time.time()))

        if progress is not None:
            self.run_ids = [str(x) for x in progress.get("run_ids") or []]
        if not self.run_ids:
            self.run_ids = [run_id]
        elif self.run_ids[-1] != run_id:
            self.run_ids.append(run_id)

        if progress is None:
            progress = {
                "version": 1,
                "input": os.path.abspath(args.input),
                "input_size": self.input_stat.st_size,
                "input_mtime": int(self.input_stat.st_mtime),
                "run_ids": list(self.run_ids),
                "completed_lines": set(),
                "sent_events": 0,
                "failed_events": 0,
                "batches": 0,
                "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "finished": False,
            }
        else:
            progress["run_ids"] = list(self.run_ids)
            progress.setdefault("completed_lines", set())
            progress.setdefault("sent_events", 0)
            progress.setdefault("failed_events", 0)
            progress.setdefault("batches", 0)
        self.progress = progress
        self.run_id = run_id
        # 续跑时进度里的 sent_events/batches 是上次的累计值，本次只在其上累加
        self.base_sent = int(progress.get("sent_events") or 0)
        self.base_batches = int(progress.get("batches") or 0)

        if args.batch_size > MAX_BATCH_SIZE:
            print(
                "[backfill] --batch-size={} 超过协议建议上限 {}，已收敛为 {}".format(
                    args.batch_size, MAX_BATCH_SIZE, MAX_BATCH_SIZE
                )
            )
            args.batch_size = MAX_BATCH_SIZE
        if not args.dry_run and self.progress["completed_lines"]:
            print(
                "[backfill] 续跑：进度文件已完成 {} 行 / 已发送 {} 条，本次跳过已发送批次".format(
                    len(self.progress["completed_lines"]), self.progress["sent_events"]
                )
            )
        return progress

    # ---------- 主循环 ----------

    def run(self):
        args = self.args
        fmt = args.format or guess_format(args.input)
        print("[backfill] 输入：{}（{}）".format(os.path.abspath(args.input), fmt))
        if args.dry_run:
            print("[backfill] DRY-RUN：只做读取/规范化/编码与体积校验，不发网络、不写进度、不写失败文件")
        else:
            print(
                "[backfill] 目标：{} project={} batch_size={} limit={} rate={} run_id={}".format(
                    self.endpoint, self.project, args.batch_size, args.limit or "全部",
                    args.rate or "不限", self.run_id,
                )
            )
        self.save_progress_maybe()

        iterator = iter_csv(args.input) if fmt == "csv" else iter_jsonl(args.input)
        pending = []
        stopped_by_limit = False
        interrupted = False
        try:
            for line_no, record in iterator:
                self.stats.read_lines += 1
                if not args.dry_run and line_no in self.progress["completed_lines"]:
                    self.stats.skip(line_no, "已完成（--resume 跳过）")
                    continue
                try:
                    if fmt == "csv":
                        event = event_from_csv(record, line_no, self.run_id, self.warnings)
                    else:
                        event = event_from_jsonl(record, self.run_id, self.warnings)
                except RowSkip as exc:
                    self.stats.skip(line_no, str(exc))
                    continue
                self.stats.accepted += 1
                pending.append((line_no, event))
                if len(pending) >= args.batch_size:
                    self.flush(pending)
                    pending = []
                if args.limit and self.stats.accepted >= args.limit:
                    stopped_by_limit = True
                    break
        except KeyboardInterrupt:
            interrupted = True
            print("\n[backfill] 收到中断信号：已发送批次已写进度，未发送行下次 --resume 继续", file=sys.stderr)
        finally:
            try:
                iterator.close()
            except Exception:
                pass
            if pending and not interrupted:
                self.flush(pending)
            elif pending:
                # 中断时保留当前未完成批次，让下次 --resume 重发（进度只记已完成批次）
                self.unsent_pending = len(pending)
                print(
                    "[backfill] 中断：{} 条待发送事件未发送（不计入进度）".format(self.unsent_pending),
                    file=sys.stderr,
                )

        if self.failed_handle is not None:
            self.failed_handle.close()
        if not args.dry_run:
            self.progress["finished"] = (
                not interrupted and not stopped_by_limit and self.stats.failed == 0
            )
            save_progress(self.progress_file, self.progress)

        self.print_summary(fmt, stopped_by_limit, interrupted)
        if self.stats.failed:
            return 1
        if interrupted:
            return 130  # 与 shell 约定一致：被 Ctrl-C 中断；用 --resume 继续
        return 0

    # ---------- 批次发送 ----------

    def flush(self, pending):
        """切分 + 发送 + 进度落盘 + 失败记录。"""
        args = self.args
        try:
            batches = split_by_size(self.project, self.token, pending, args.max_body_bytes)
        except SendError as exc:
            for line_no, event in pending:
                self.record_failure(line_no, str(exc), event)
            return

        for batch in batches:
            events = [ev for _, ev in batch]
            body = encode_body(self.project, self.token, events)
            if len(body) > args.max_body_bytes:  # 理论上 split_by_size 已保证，兜底
                for line_no, event in batch:
                    self.record_failure(line_no, "批次 body 超限（{} 字节）".format(len(body)), event)
                continue

            if args.dry_run:
                self.attempted += len(batch)
                self.stats.sent += len(batch)
                self.stats.batches += 1
                self.throttle()
                continue

            ok, error = send_with_retry(self.endpoint, body, args.timeout, self.token)
            self.attempted += len(batch)
            if ok:
                self.stats.sent += len(batch)
                self.stats.batches += 1
                for line_no, _ in batch:
                    self.progress["completed_lines"].add(line_no)
                self.progress["sent_events"] = self.base_sent + self.stats.sent
                self.progress["batches"] = self.base_batches + self.stats.batches
            else:
                self.progress["failed_events"] = self.progress.get("failed_events", 0) + len(batch)
                for line_no, event in batch:
                    self.record_failure(line_no, error, event)
            self.save_progress_maybe()
            self.throttle()

    def throttle(self):
        """--rate：按「已尝试条数 / 目标速率」对齐时间，0 不限速。"""
        rate = self.args.rate
        if rate <= 0:
            return
        target = self.attempted / float(rate)
        elapsed = time.monotonic() - self.started
        if target > elapsed:
            time.sleep(target - elapsed)

    def save_progress_maybe(self):
        if self.args.dry_run:
            return
        save_progress(self.progress_file, self.progress)

    def record_failure(self, line_no, error, event):
        self.stats.failed += 1
        if len(self.stats.failed_examples) < 5:
            self.stats.failed_examples.append((line_no, error))
        if self.args.dry_run:
            return
        if self.failed_handle is None:
            self.failed_handle = open(self.failed_file, "w", encoding="utf-8")
            print("[backfill] 失败行写入：{}".format(self.failed_file), file=sys.stderr)
        entry = {"line": line_no, "error": redact(error, self.token), "event": event}
        self.failed_handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
        self.failed_handle.flush()

    # ---------- 摘要 ----------

    def print_summary(self, fmt, stopped_by_limit, interrupted):
        stats = self.stats
        elapsed = time.monotonic() - self.started
        first_run = self.run_ids[0] if self.run_ids else self.run_id
        last_run = self.run_ids[-1] if self.run_ids else self.run_id
        mode = "DRY-RUN（未联网）" if self.args.dry_run else "真实发送"

        print("")
        print("==================== 批量回补摘要（{}） ====================".format(mode))
        print("输入文件    : {}（{}）".format(os.path.abspath(self.args.input), fmt))
        print("读入        : {} 行".format(stats.read_lines))
        if self.args.dry_run:
            print("发送        : {} 条（dry-run 仅校验编码与体积，未发网络）".format(stats.sent))
        else:
            print("发送        : {} 条（成功批次 {} 个）".format(stats.sent, stats.batches))
        print("跳过        : {} 行".format(stats.skipped))
        if stats.skipped_reasons:
            for reason, count in sorted(stats.skipped_reasons.items(), key=lambda kv: -kv[1]):
                print("              - {} × {}".format(count, reason))
            if stats.skip_examples:
                print(
                    "              示例行号: {}".format(
                        ", ".join("{} ({})".format(line, reason) for line, reason in stats.skip_examples[:5])
                    )
                )
        else:
            print("              - （无）")
        print("失败        : {} 行".format(stats.failed))
        if stats.failed_examples:
            for line, error in stats.failed_examples[:5]:
                print("              - 行 {}: {}".format(line, error))
            if not self.args.dry_run:
                print("              全部失败行见: {}".format(self.failed_file))
        if self.warnings:
            for message, count in sorted(self.warnings.items(), key=lambda kv: -kv[1]):
                print("提示        : {} × {}".format(count, message))
        if self.unsent_pending:
            print("未发送      : {} 条（中断时留在内存的待发送批次，下次 --resume 会重发）".format(self.unsent_pending))
        if stopped_by_limit:
            print("说明        : 达到 --limit={} 提前停止（未发送的剩余行未读入）".format(self.args.limit))
        if interrupted:
            print("说明        : 被中断，已发送批次已写入进度文件；用 --resume 继续")
        if not self.args.dry_run:
            print("进度文件    : {}（累计已完成 {} 行 / 累计发送 {} 条；本次发送 {} 条）".format(
                self.progress_file, len(self.progress["completed_lines"]),
                self.progress["sent_events"], self.stats.sent))
        print("run 标识    : 首个 {} / 最后 {}".format(first_run, last_run))
        print("耗时        : {:.1f}s（平均 {:.1f} 条/秒）".format(
            elapsed, (stats.sent / elapsed) if elapsed > 0 else 0.0))
        print("落库核对    : ClickHouse clklog.log_analysis WHERE distinct_id LIKE '%{}%'".format(last_run))
        print("              （每个事件的 properties.backfill_run_id 均为 {}）".format(last_run))
        print("DONE backfill = {}".format(self.run_id))


# --------------------------------------------------------------------------- #
# 环境与入口
# --------------------------------------------------------------------------- #

def load_dotenv(paths):
    """按需加载 .env（不覆盖已存在的环境变量），仅取 CLKLOG_* 键；返回加载到的文件。"""
    for path in paths:
        path = os.path.abspath(path)
        if not os.path.isfile(path):
            continue
        loaded = []
        with open(path, "r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key, value = key.strip(), value.strip()
                if key.startswith("CLKLOG_") and value and not os.environ.get(key):
                    os.environ[key] = value
                    loaded.append(key)
        return path, loaded
    return None, []


def build_parser():
    parser = argparse.ArgumentParser(
        prog="backfill.py",
        description="ClkLog 批量回补（文件导入）：CSV/JSONL → base64+urlencode 表单批量补报",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例：\n"
            "  python3 backfill.py --input history.csv --limit 5 --dry-run\n"
            "  python3 backfill.py --input history.csv --batch-size 50 --rate 20\n"
            "  python3 backfill.py --input history.csv --resume\n"
            "  python3 backfill.py --input history.jsonl --format jsonl\n"
        ),
    )
    parser.add_argument("--input", required=True, help="输入文件（CSV 或 JSONL）")
    parser.add_argument("--format", choices=("csv", "jsonl"), default=None,
                        help="输入格式，默认按扩展名猜测（.jsonl/.ndjson → jsonl，其余 → csv）")
    parser.add_argument("--batch-size", type=int, default=MAX_BATCH_SIZE,
                        help="单批事件数，默认 50，协议上限 50（超出自动收敛）")
    parser.add_argument("--limit", type=int, default=0,
                        help="最多处理 N 条事件后停止（0 = 全部），用于先小批量试跑")
    parser.add_argument("--dry-run", action="store_true",
                        help="只做读取/规范化/编码与体积校验，不发网络、不写进度与失败文件")
    parser.add_argument("--resume", action="store_true",
                        help="按 <input>.backfill-progress.json 断点续跑，跳过已完成行号")
    parser.add_argument("--rate", type=float, default=0.0,
                        help="限速（条/秒），0 = 不限速；批量回补建议设置以避免压垮 receiver")
    parser.add_argument("--endpoint", default=None,
                        help="上报地址（优先级：--endpoint > $CLKLOG_ENDPOINT > ../.env > 默认生产地址）")
    parser.add_argument("--project", default=None,
                        help="项目名（优先级：--project > $CLKLOG_PROJECT > ../.env > clklogapp）")
    parser.add_argument("--token", default=None,
                        help="项目 token（优先级：--token > $CLKLOG_TOKEN > ../.env；请勿写进代码或 shell 历史）")
    parser.add_argument("--timeout", type=float, default=10.0, help="单次 HTTP 超时秒数，默认 10")
    parser.add_argument("--max-body-bytes", type=int, default=MAX_BODY_BYTES,
                        help="表单 body 上限（字节），默认 1MB；超限自动切分批次")
    parser.add_argument("--run-id", default=None,
                        help="强制指定 run 标识（默认 backfill-<unix 秒>；续跑时沿用进度文件里的值）")
    parser.add_argument("--force-resume", action="store_true",
                        help="输入文件大小/修改时间变化时仍按进度续跑（危险，可能漏行或重发）")
    parser.add_argument("--version", action="version", version="backfill.py {}".format(VERSION))
    return parser


def main(argv=None):
    args = build_parser().parse_args(argv)
    here = os.path.dirname(os.path.abspath(__file__))
    env_path, loaded = load_dotenv([
        os.path.join(here, os.pardir, ".env"),   # examples/report-sdk/.env（与其它示例一致）
        os.path.join(os.getcwd(), ".env"),
    ])
    if loaded:
        print("[backfill] 已从 {} 加载：{}".format(os.path.abspath(env_path), ", ".join(loaded)))

    runner = BackfillRunner(args, dict(os.environ))
    try:
        runner.prepare()
        return runner.run()
    except CliError as exc:
        sys.stderr.write("[backfill] 错误：{}\n".format(exc))
        return 2


if __name__ == "__main__":
    sys.exit(main())
