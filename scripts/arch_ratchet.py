#!/usr/bin/env python3
"""Architecture ratchet: over-limit directories may only shrink."""
from __future__ import annotations

import argparse
import fnmatch
import json
import sys
from datetime import date
from pathlib import Path

# Only this block may be changed during initialization.
CONFIG = {
    "roots": ["../apps"],
    "sourceGlobs": ["*.ts", "*.tsx"],
    "testGlobs": ["*.test.ts", "*.test.tsx", "*.spec.ts", "*.spec.tsx"],
    "entryPrefixes": ["analytics-server/src/config", "analytics-server/src/scripts"],
    "envMarkers": ["process.env"],
    "skipDirs": [".git", "node_modules", "dist", "build", "coverage", "testdata", "data", "docs", "export", "dlq", "harness", "public", ".turbo", ".vite"],
    "limits": {
        "packageFiles": 30,
        "packageLines": 8000,
        "packageTestFiles": 30,
        "packageTestLines": 8000,
        "fileLines": 1200,
    },
}

HERE = Path(__file__).resolve().parent
BASELINE = HERE / "arch_ratchet.json"
LIMITS = CONFIG["limits"]


def matches(name: str, globs: list[str]) -> bool:
    return any(fnmatch.fnmatch(name, pattern) for pattern in globs)


def sources():
    skip = set(CONFIG["skipDirs"])
    for root_spec in CONFIG["roots"]:
        root = (HERE / root_spec).resolve()
        if not root.is_dir():
            sys.exit(f"scan root does not exist: {root}")
        for path in root.rglob("*"):
            if not path.is_file() or not matches(path.name, CONFIG["sourceGlobs"]):
                continue
            rel = path.relative_to(root)
            if not (skip & set(rel.parts)):
                yield path, rel


def measure() -> dict:
    packages: dict[str, dict[str, int]] = {}
    test_packages: dict[str, dict[str, int]] = {}
    oversized: dict[str, int] = {}
    env_readers: dict[str, int] = {}
    entry_prefixes = tuple(CONFIG["entryPrefixes"])
    for path, rel in sources():
        package = rel.parent.as_posix()
        package = "" if package == "." else package
        text = path.read_text(encoding="utf-8", errors="ignore")
        lines = text.count("\n") + (0 if not text or text.endswith("\n") else 1)
        is_test = matches(path.name, CONFIG["testGlobs"])
        if is_test:
            stats = test_packages.setdefault(package, {"files": 0, "lines": 0})
            stats["files"] += 1
            stats["lines"] += lines
        else:
            stats = packages.setdefault(package, {"files": 0, "lines": 0})
            stats["files"] += 1
            stats["lines"] += lines
            if not entry_prefixes or not package.startswith(entry_prefixes):
                hits = sum(text.count(marker) for marker in CONFIG["envMarkers"])
                if hits:
                    env_readers[rel.as_posix()] = hits
        if lines > LIMITS["fileLines"]:
            oversized[rel.as_posix()] = lines
    over_limit = {
        package: stats
        for package, stats in packages.items()
        if stats["files"] > LIMITS["packageFiles"] or stats["lines"] > LIMITS["packageLines"]
    }
    test_debt = {
        package: stats
        for package, stats in test_packages.items()
        if package in over_limit
        or stats["files"] > LIMITS["packageTestFiles"]
        or stats["lines"] > LIMITS["packageTestLines"]
    }
    return {
        "limits": dict(LIMITS),
        "overLimitPackages": dict(sorted(over_limit.items())),
        "testDebtPackages": dict(sorted(test_debt.items())),
        "oversizedFiles": dict(sorted(oversized.items())),
        "envReaders": dict(sorted(env_readers.items())),
    }


def load_baseline() -> dict:
    if not BASELINE.is_file():
        sys.exit(f"missing baseline: {BASELINE}; initialize with --update")
    return json.loads(BASELINE.read_text(encoding="utf-8"))


def failures(current: dict, baseline: dict) -> list[str]:
    result: list[str] = []
    old_packages = baseline.get("overLimitPackages", {})
    for package, stats in current["overLimitPackages"].items():
        old = old_packages.get(package)
        if old is None:
            result.append(f"new over-limit package {package}: {stats}")
            continue
        for key in ("files", "lines"):
            if stats[key] > old[key]:
                result.append(f"{package} {key} increased: {old[key]} -> {stats[key]}")
    old_test_debt = baseline.get("testDebtPackages", {})
    for package, stats in current["testDebtPackages"].items():
        old = old_test_debt.get(package)
        if old is None:
            result.append(f"new test-debt package {package}: {stats}")
            continue
        for key in ("files", "lines"):
            if stats[key] > old[key]:
                result.append(f"{package} test {key} increased: {old[key]} -> {stats[key]}")
    for path, lines in current["oversizedFiles"].items():
        old = baseline.get("oversizedFiles", {}).get(path)
        if old is None:
            result.append(f"new oversized file {path}: {lines} lines")
        elif lines > old:
            result.append(f"oversized file grew {path}: {old} -> {lines}")
    for path, hits in current["envReaders"].items():
        old = baseline.get("envReaders", {}).get(path, 0)
        if hits > old:
            result.append(f"environment reads increased {path}: {old} -> {hits}")
    return result


def report(current: dict) -> None:
    print(json.dumps(current, ensure_ascii=False, indent=2))


def update(current: dict, force: bool) -> int:
    if BASELINE.is_file() and not force:
        regressions = failures(current, load_baseline())
        if regressions:
            print("baseline may only decrease; refusing update", file=sys.stderr)
            for item in regressions:
                print(f"  - {item}", file=sys.stderr)
            return 1
    payload = {"updatedAt": date.today().isoformat(), **current}
    BASELINE.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"baseline updated: {BASELINE}")
    return 0


def check(current: dict) -> int:
    regressions = failures(current, load_baseline())
    if not regressions:
        print("architecture ratchet passed")
        return 0
    print("architecture ratchet failed:", file=sys.stderr)
    for item in regressions:
        print(f"  - {item}", file=sys.stderr)
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description="architecture structure ratchet")
    parser.add_argument("--report", action="store_true")
    parser.add_argument("--update", action="store_true")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    current = measure()
    if args.report:
        report(current)
        return 0
    if args.update:
        return update(current, args.force)
    return check(current)


if __name__ == "__main__":
    raise SystemExit(main())
