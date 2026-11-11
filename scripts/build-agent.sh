#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../agent"

GO_BIN="${GO_BIN:-/usr/local/go1.20/bin/go}"
if ! command -v "$GO_BIN" >/dev/null 2>&1; then
  GO_BIN="go"
fi

export CGO_ENABLED=0
export GOPROXY="${GOPROXY:-https://goproxy.cn,direct}"
OUT_DIR="$(cd .. && pwd)/dist/agent"
mkdir -p "$OUT_DIR"

echo "==> go mod tidy"
"$GO_BIN" mod tidy

build() {
  local goos="$1"
  local goarch="$2"
  local output="$3"
  echo "==> build $goos/$goarch -> $output"
  GOOS="$goos" GOARCH="$goarch" "$GO_BIN" build \
    -trimpath \
    -ldflags "-s -w" \
    -o "$OUT_DIR/$output" \
    .
}

build windows amd64 "ops-agent-windows-amd64.exe"
build windows 386   "ops-agent-windows-386.exe"
build linux   amd64 "ops-agent-linux-amd64"
build linux   arm64 "ops-agent-linux-arm64"
build linux   386   "ops-agent-linux-386"

echo
echo "构建完成，输出目录: $OUT_DIR"
ls -lh "$OUT_DIR"
