#!/usr/bin/env bash
# Source this file to pin local/CI commands to the project Node.js runtime.

set -e

CLKLOG_NODE_VERSION="24.20.0"
CLKLOG_NODE_SYSTEM="$(uname -s)"
CLKLOG_NODE_MACHINE="$(uname -m)"

case "${CLKLOG_NODE_SYSTEM}:${CLKLOG_NODE_MACHINE}" in
  Linux:x86_64)
    CLKLOG_NODE_PLATFORM="linux-x64"
    CLKLOG_NODE_ARCHIVE_EXT="tar.xz"
    CLKLOG_NODE_SHA256="2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2"
    ;;
  Linux:aarch64|Linux:arm64)
    CLKLOG_NODE_PLATFORM="linux-arm64"
    CLKLOG_NODE_ARCHIVE_EXT="tar.xz"
    CLKLOG_NODE_SHA256="5f4ddab610c1ab2016b3c227cebdbf6d9495161487e4739c7b90090595f465f7"
    ;;
  Darwin:arm64)
    CLKLOG_NODE_PLATFORM="darwin-arm64"
    CLKLOG_NODE_ARCHIVE_EXT="tar.gz"
    CLKLOG_NODE_SHA256="40e5607e5ecb3db9192723776da2d75d966260fc74a7a9e731c1bd67dda96bc8"
    ;;
  Darwin:x86_64)
    CLKLOG_NODE_PLATFORM="darwin-x64"
    CLKLOG_NODE_ARCHIVE_EXT="tar.gz"
    CLKLOG_NODE_SHA256="9e5b2644cf107befb6aefca676b96d3296bc10138096f022ed378d6233ed81f4"
    ;;
  *)
    echo "[node-runtime] 不支持的平台: ${CLKLOG_NODE_SYSTEM}/${CLKLOG_NODE_MACHINE}" >&2
    return 1 2>/dev/null || exit 1
    ;;
esac

CLKLOG_NODE_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLKLOG_NODE_RUNTIME_ROOT="${CLKLOG_NODE_REPO_ROOT}/.runtime"
CLKLOG_NODE_DIR="${CLKLOG_NODE_RUNTIME_ROOT}/node-v${CLKLOG_NODE_VERSION}-${CLKLOG_NODE_PLATFORM}"
CLKLOG_NODE_ARCHIVE="node-v${CLKLOG_NODE_VERSION}-${CLKLOG_NODE_PLATFORM}.${CLKLOG_NODE_ARCHIVE_EXT}"
# 归档保存在 .runtime/ 下（不进 git，但进 CI cache）：命中缓存时跳过下载，sha256 校验照旧。
# 缓存里放归档而不是解压后的目录，是为了让载荷停在 ~50MB 单文件，打包与回放都快。
CLKLOG_NODE_ARCHIVE_CACHE="${CLKLOG_NODE_RUNTIME_ROOT}/${CLKLOG_NODE_ARCHIVE}"

if [ ! -x "${CLKLOG_NODE_DIR}/bin/node" ]; then
  mkdir -p "${CLKLOG_NODE_RUNTIME_ROOT}"
  CLKLOG_NODE_TMP_DIR="$(mktemp -d "${CLKLOG_NODE_RUNTIME_ROOT}/node-download.XXXXXX")"
  trap 'rm -rf "${CLKLOG_NODE_TMP_DIR}"' EXIT
  if [ -f "${CLKLOG_NODE_ARCHIVE_CACHE}" ]; then
    echo "[node-runtime] 命中已缓存的 ${CLKLOG_NODE_ARCHIVE}，跳过下载"
  else
    # 直接下到缓存路径：失败时立刻删掉半包，避免下次「命中缓存」拿到残缺文件再失败一轮。
    if ! curl --fail --silent --show-error --location \
      "https://nodejs.org/dist/v${CLKLOG_NODE_VERSION}/${CLKLOG_NODE_ARCHIVE}" \
      --output "${CLKLOG_NODE_ARCHIVE_CACHE}"; then
      rm -f "${CLKLOG_NODE_ARCHIVE_CACHE}"
      echo "[node-runtime] 下载 ${CLKLOG_NODE_ARCHIVE} 失败（已清理半包）" >&2
      return 1 2>/dev/null || exit 1
    fi
  fi
  # 校验失败必须删掉归档：否则坏包会留在 .runtime/ 里，之后每次都「命中缓存」后失败，自己把自己锁死。
  if command -v sha256sum >/dev/null 2>&1; then
    if ! printf '%s  %s\n' "${CLKLOG_NODE_SHA256}" "${CLKLOG_NODE_ARCHIVE_CACHE}" | sha256sum -c - >/dev/null; then
      rm -f "${CLKLOG_NODE_ARCHIVE_CACHE}"
      echo "[node-runtime] ${CLKLOG_NODE_ARCHIVE} 校验失败（已删除缓存副本，请重试）" >&2
      return 1 2>/dev/null || exit 1
    fi
  else
    if [ "$(shasum -a 256 "${CLKLOG_NODE_ARCHIVE_CACHE}" | awk '{print $1}')" != "${CLKLOG_NODE_SHA256}" ]; then
      rm -f "${CLKLOG_NODE_ARCHIVE_CACHE}"
      echo "[node-runtime] ${CLKLOG_NODE_ARCHIVE} 校验失败（已删除缓存副本，请重试）" >&2
      return 1 2>/dev/null || exit 1
    fi
  fi
  tar -xf "${CLKLOG_NODE_ARCHIVE_CACHE}" -C "${CLKLOG_NODE_TMP_DIR}"
  mv "${CLKLOG_NODE_TMP_DIR}/node-v${CLKLOG_NODE_VERSION}-${CLKLOG_NODE_PLATFORM}" "${CLKLOG_NODE_DIR}"
  trap - EXIT
  rm -rf "${CLKLOG_NODE_TMP_DIR}"
fi

export PATH="${CLKLOG_NODE_DIR}/bin:${PATH}"

if [ "$(node --version)" != "v${CLKLOG_NODE_VERSION}" ]; then
  echo "[node-runtime] Node 版本校验失败" >&2
  return 1 2>/dev/null || exit 1
fi

echo "[node-runtime] 使用 $(node --version) ($(command -v node))"
