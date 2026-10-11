#!/usr/bin/env bash
# 把 examples/report-sdk/ 下的示例工程打包成前端可一键下载的 zip。
#
# 产物：apps/analytics-web/public/sdk-demos/*.zip（随前端产物发布，nginx 从 /sa/sdk-demos/ 直出）
# 由 scripts/build.sh 在构建前端之前调用；本文件同时是 zip 命名与「哪个卡对应哪个目录」的真源，
# 前端侧的对应表在 apps/analytics-web/src/features/onboarding/sdk-downloads.ts（改一处要同步另一处）。
#
# 安全：**不打包 .env / token**；排除构建产物与依赖目录（bin/obj/build/.dart_tool/node_modules 等）。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT_DIR/examples/report-sdk"
OUT_DIR="$ROOT_DIR/apps/analytics-web/public/sdk-demos"

if [ ! -d "$SRC_DIR" ]; then
  echo "[sdk-demos] 跳过：$SRC_DIR 不存在"
  exit 0
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[sdk-demos] ⚠️ 跳过：镜像里没有 python3（无法生成 zip；按钮会因文件缺失自动隐藏）"
  exit 0
fi

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

python3 - "$SRC_DIR" "$OUT_DIR" <<'PY'
import os
import sys
import zipfile

src_dir, out_dir = sys.argv[1], sys.argv[2]

# 排除：密钥、依赖与构建产物（任何一项进包都会造成泄漏或体积失控）
EXCLUDE_DIRS = {
    '__pycache__', 'node_modules', 'bin', 'obj', 'build', '.dart_tool',
    '.idea', '.vscode', '.git', 'dist', '.gradle',
}
EXCLUDE_FILES = {'.env', '.env.local', '.DS_Store', 'pubspec.lock', 'package-lock.json'}
EXCLUDE_SUFFIX = ('.pyc', '.backfill-progress.json', '.failed.jsonl', '.gz', '.zip')

# 卡片 → (zip 名, 目录, 包内要包含的条目（相对示例根）, 说明)
# include 写具体条目而不是整个目录，避免把测试用的大文件或无关平台目录打进去。
PACKS = [
    ('php.zip', 'php', ['report.php'], 'PHP 服务端上报示例', 'php report.php'),
    ('go.zip', 'go', ['main.go'], 'Go 服务端上报示例', 'go run main.go'),
    ('unity-csharp-client.zip', 'csharp',
     ['ClkLogClient.cs', 'Program.cs', 'ClkLogDemo.csproj', 'Directory.Build.targets'],
     'Unity (C#) 客户端上报示例', 'dotnet run'),
    ('javascript-h5.zip', 'js',
     ['clklog.js', 'index.html', 'run-on-node.mjs'],
     'Web / H5 上报示例（浏览器 + Node 自测）', 'python3 -m http.server  # 打开 index.html；或 node run-on-node.mjs'),
    ('miniprogram.zip', 'miniprogram', ['clklog.js', 'run-on-node.mjs'],
     '微信小程序上报示例', 'node run-on-node.mjs  # 垫片自测；真机在开发者工具中引入 clklog.js'),
    ('react-native.zip', 'react-native', ['clklog.js', 'run-on-node.mjs'],
     'React Native 上报示例', 'node run-on-node.mjs'),
    ('android-java.zip', 'android', ['ClkLogClient.java', 'Main.java'],
     'Android (Java) 客户端上报核心', 'javac -encoding UTF-8 -d /tmp/x *.java && java -cp /tmp/x Main'),
    ('ios-swift.zip', 'ios', ['ClkLogClient.swift', 'main.swift'],
     'iOS (Swift) 客户端上报核心', 'swiftc -O ClkLogClient.swift main.swift -o /tmp/ios && /tmp/ios'),
    ('cocos2d-x-cpp.zip', 'cpp', ['clklog_report.cpp'],
     'Cocos2d-x (C++) 上报核心', 'clang++ -std=c++17 -I"$(xcrun --show-sdk-path)/usr/include" clklog_report.cpp -L"$(xcrun --show-sdk-path)/usr/lib" -lcurl -o /tmp/cpp-demo && /tmp/cpp-demo'),
    ('flutter.zip', 'flutter',
     ['pubspec.yaml', 'analysis_options.yaml', 'run_dart.dart', 'lib/clklog.dart', 'lib/main.dart', 'test/widget_test.dart', 'web/index.html'],
     'Flutter (Dart) 上报示例', 'flutter pub get && dart run run_dart.dart'),
    ('java.zip', 'java', ['ClkLogReport.java'],
     'Java 服务端上报示例', 'javac -encoding UTF-8 -d /tmp/x ClkLogReport.java && java -cp /tmp/x ClkLogReport'),
    ('python.zip', 'python', ['report.py'], 'Python 服务端上报示例', 'python3 report.py'),
    ('nodejs.zip', 'nodejs', ['report.mjs'], 'Node.js 服务端上报示例', 'node report.mjs'),
    ('csharp-server.zip', 'csharp/ServerReport',
     ['ClkLogClient.cs', 'Program.cs', 'ServerReport.csproj'],
     'C# (.NET) 服务端上报示例', 'dotnet run'),
    ('ruby.zip', 'ruby', ['report.rb'], 'Ruby 服务端上报示例', 'ruby report.rb'),
    ('c.zip', 'c', ['clklog_report.c'],
     'C (libcurl) 服务端上报示例', 'cc -std=c11 -I"$(xcrun --show-sdk-path)/usr/include" clklog_report.c -L"$(xcrun --show-sdk-path)/usr/lib" -lcurl -o /tmp/c-demo && /tmp/c-demo'),
    ('lua.zip', 'lua', ['clklog.lua', 'report.lua'],
     'Lua 服务端上报示例', 'lua report.lua  # 需 luarocks install luasocket luasec'),
    ('backfill-cli.zip', 'backfill', ['backfill.py'],
     '批量回补命令行工具', 'python3 backfill.py --input history.csv --limit 5 --dry-run'),
]

README_TMPL = """# ClkLog 上报演示工程：{title}

This is a runnable ClkLog reporting demo (protocol: form POST with
`data = base64(JSON array)` then urlencoded). Token is read from the
`CLKLOG_TOKEN` environment variable - never hardcode it.

{title}

## 运行 / Run

```bash
export CLKLOG_TOKEN='<项目 token>'   # 见 ClkLog 仓库 HANDOVER.md 第八节
{run}
```

跑完打印 `DONE run_id = <lang>-<ts>`；用仓库里的 `examples/report-sdk/verify.sh <run_id>`
查 ClickHouse 核对该 run 的事件是否落库（数据链路有 1–3 分钟延迟）。

完整协议与各语言踩坑见仓库根目录《数据上报规范与流程.md》§1–§3 与 §9。

> 包内不含任何凭据（`.env` 未被包含）。
"""

written = []
for zip_name, rel_dir, includes, title, run_cmd in PACKS:
    base = os.path.join(src_dir, rel_dir)
    if not os.path.isdir(base):
        print(f'[sdk-demos] 跳过 {zip_name}：目录不存在 {rel_dir}')
        continue
    out_path = os.path.join(out_dir, zip_name)
    added = 0
    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for entry in includes:
            abs_entry = os.path.join(base, entry)
            if not os.path.exists(abs_entry):
                print(f'[sdk-demos] 警告：{rel_dir}/{entry} 不存在，已跳过')
                continue
            if os.path.isfile(abs_entry):
                if os.path.basename(abs_entry) in EXCLUDE_FILES:
                    continue
                zf.write(abs_entry, f'{rel_dir}/{entry}')
                added += 1
            else:
                for dirpath, dirnames, filenames in os.walk(abs_entry):
                    dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
                    for fn in filenames:
                        if fn in EXCLUDE_FILES or fn.endswith(EXCLUDE_SUFFIX):
                            continue
                        full = os.path.join(dirpath, fn)
                        zf.write(full, os.path.join(rel_dir, os.path.relpath(full, base)))
                        added += 1
        zf.writestr(
            'README.md',
            README_TMPL.format(title=title, run=run_cmd),
        )
    written.append((zip_name, added, os.path.getsize(out_path)))

for name, files, size in written:
    print(f'[sdk-demos] {name}: {files} 个文件, {size // 1024} KB')
print(f'[sdk-demos] 完成：{len(written)} 个演示工程 → {out_dir}')
PY

# 保险丝：产物里若出现 token 或 .env，直接失败（红线 3）
if command -v python3 >/dev/null 2>&1; then
  if [ -f "$SRC_DIR/.env" ]; then
    TOKEN_VALUE="$(sed -n 's/^CLKLOG_TOKEN=//p' "$SRC_DIR/.env")"
    if [ -n "${TOKEN_VALUE}" ]; then
      for z in "$OUT_DIR"/*.zip; do
        if unzip -p "$z" 2>/dev/null | grep -q -- "$TOKEN_VALUE"; then
          echo "[sdk-demos] ✗ $z 里出现了 token 值，已中止（检查打包排除规则）" >&2
          rm -rf "$OUT_DIR"
          exit 1
        fi
      done
    fi
  fi
  if unzip -l "$OUT_DIR"/*.zip 2>/dev/null | grep -qE "(^|/)\.env$"; then
    echo "[sdk-demos] ✗ 有包包含了 .env，已中止" >&2
    rm -rf "$OUT_DIR"
    exit 1
  fi
fi

echo "[sdk-demos] 已生成 $(ls -1 "$OUT_DIR"/*.zip | wc -l | tr -d ' ') 个 zip（token 检查通过）"
