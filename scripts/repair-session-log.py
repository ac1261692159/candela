#!/usr/bin/env python3
"""会话日志修复：`corrupt session log: seq gap in committed region`。

## 背景

Harness 运行时的会话日志（`<dsh-home>/sessions/<cwd>/<session-id>/session.jsonl.zstd`）
由 `@deepseek-ai/dsh-session-persistence-jsonl` 读写，其**硬不变量**是每条事件的
`seq` 必须等于「已接收事件数」（即 0,1,2,… 严格稠密，源码见该包 `SessionLogScanner`）：

```js
if (event.seq !== this.events.length) throw new Error(`corrupt session log: seq gap ...`)
```

2026-09-21 现场：某个会话第 8 行（事件行第 7 行）出现两条 `seq=5`
（`session/end-seed` 空 marker 与其后的 `agent/inbox/spliced`），导致整个会话
无法加载（面板报「历史加载失败」，会话无法恢复）。

## 能力与边界

- `--check`：解压后按 seq 单调性扫描，报告首个异常行（并可选调用运行时解码器做权威校验）。
- `--fix`：**仅修**「重复 seq 且其中一条是空 marker（`data` 为空的 `session/end-seed`）」这一种；
  删除该 marker 后按运行时帧规则重压（第 1 帧只能含头部那一行，
  `assertZstdHeaderFrame`），保留备份并在装回后重新校验。
- 其它形态的损坏（真正的缺号、乱序、不可解析）本脚本**拒绝动手**，只报告，交人工处理。

## 用法（在 Harness 运行时所在机器上执行）

```bash
python3 scripts/repair-session-log.py --check --session-dir <.../session-xxx>
python3 scripts/repair-session-log.py --fix   --session-dir <.../session-xxx>
```

`--validator <path>` 可指向运行时解码器校验脚本（见 HANDOVER「会话日志损坏」一节的写法），
给了就做最终权威校验；没给则只做单调性检查。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from datetime import date

ZSTD = shutil.which("zstd")
LOG_NAME = "session.jsonl.zstd"


def run(cmd: list[str], stdin: bytes | None = None) -> bytes:
    proc = subprocess.run(cmd, input=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise SystemExit(f"命令失败: {' '.join(cmd)}\n{proc.stderr.decode(errors='replace')[:400]}")
    return proc.stdout


def decompress(path: str) -> str:
    if not ZSTD:
        raise SystemExit("需要 zstd 命令（解压/重压会话日志）")
    return run([ZSTD, "-d", "-q", "-c", path]).decode("utf-8")


def compress(text: str) -> bytes:
    return run([ZSTD, "-q", "-c"], stdin=text.encode("utf-8"))


def scan(rows: list[str]) -> tuple[int | None, tuple | None]:
    """返回（首个非单调行的 1-based 行号, 详情）。行 = 含头部的完整行列表。"""
    prev = None
    for idx, row in enumerate(rows[1:], start=2):
        try:
            obj = json.loads(row)
        except Exception:
            return idx, ("unparsable", row[:80])
        seq = obj.get("seq") if obj.get("seq") is not None else obj.get("seq0")
        if seq is None:
            continue
        if prev is not None and seq <= prev:
            return idx, (obj.get("type"), prev, seq)
        prev = seq
    return None, None


def is_empty_marker(row: str) -> bool:
    try:
        obj = json.loads(row)
    except Exception:
        return False
    return obj.get("type") == "session/end-seed" and not (obj.get("data") or {})


def validate(validator: str | None, plaintext_path: str) -> bool:
    if not validator:
        return True
    node = shutil.which("node") or "/opt/clklog/node-v24.20.0-linux-x64/bin/node"
    out = run([node, validator, plaintext_path]).decode(errors="replace").strip()
    print(f"   权威校验：{out}")
    return out.startswith("✅")


def main() -> int:
    ap = argparse.ArgumentParser(description="会话日志 seq 损坏的检查与修复")
    ap.add_argument("--session-dir", required=True, help="含 session.jsonl.zstd 的会话目录")
    ap.add_argument("--check", action="store_true", help="只检查")
    ap.add_argument("--fix", action="store_true", help="修复（重复 seq 且一条为空 marker）")
    ap.add_argument("--validator", help="运行时解码器校验脚本路径（可选，做权威校验）")
    args = ap.parse_args()

    log = os.path.join(args.session_dir, LOG_NAME)
    if not os.path.isfile(log):
        raise SystemExit(f"找不到会话日志: {log}")

    text = decompress(log)
    rows = text.split("\n")
    if rows and rows[-1] == "":
        rows = rows[:-1]
    print(f"会话目录: {args.session_dir}")
    print(f"行数（含头部）: {len(rows)}")

    bad_line, detail = scan(rows)
    if bad_line is None:
        print("✅ 未发现 seq 非单调（本脚本口径）")
        return 0
    print(f"❌ 首个异常：第 {bad_line} 行 {detail}")

    if not args.fix:
        print("（加 --fix 尝试修复）")
        return 1

    dup = rows[bad_line - 1]
    prev_row = rows[bad_line - 2]
    target = None
    if is_empty_marker(prev_row):
        target, why = bad_line - 2, "前一行是空 marker（session/end-seed，data 为空）"
    elif is_empty_marker(dup):
        target, why = bad_line - 1, "本行是空 marker（session/end-seed，data 为空）"
    if target is None:
        print("❌ 重复的两行都不是空 marker，本脚本不猜：请人工判断")
        return 1
    print(f"→ 删除第 {target + 1} 行（{why}）")

    backup = f"{log}.bak-{date.today().strftime('%Y%m%d')}"
    if os.path.exists(backup):
        raise SystemExit(f"备份已存在，先处理它再跑：{backup}")
    shutil.copy2(log, backup)
    print(f"→ 备份: {backup}")

    kept = rows[:target] + rows[target + 1 :]
    fixed_text = "\n".join(kept) + "\n"
    fixed_path = "/tmp/session-log-fixed.jsonl"
    with open(fixed_path, "w", encoding="utf-8") as fh:
        fh.write(fixed_text)

    if scan(kept)[0] is not None:
        print("❌ 删除后仍有非单调行，本脚本不继续（备份已留）")
        return 1

    # 帧规则：第 1 帧必须恰好是头部一行，其余事件放第 2 帧
    header_line = kept[0] + "\n"
    events_text = "\n".join(kept[1:]) + "\n"
    blob = compress(header_line) + compress(events_text)
    tmp_compressed = "/tmp/session-log-fixed.jsonl.zstd"
    with open(tmp_compressed, "wb") as fh:
        fh.write(blob)

    if decompress(tmp_compressed) != fixed_text:
        raise SystemExit("❌ 重压回读不一致，已中止（未动原文件）")

    st = os.stat(log)
    shutil.copyfile(tmp_compressed, log)
    os.chown(log, st.st_uid, st.st_gid)
    os.chmod(log, st.st_mode & 0o777)
    print("→ 已装回原位（属主/权限与原来一致）")

    with open(fixed_path, "w", encoding="utf-8") as fh:
        fh.write(fixed_text)
    ok = validate(args.validator, fixed_path)
    print("✅ 修复完成" if ok else "⚠️ 权威校验未通过，请回滚到备份")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
