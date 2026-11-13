#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
AGENT_DIR="$ROOT/agent"
PKG_DIR="$DIST/packages"
rm -rf "$PKG_DIR"
mkdir -p "$PKG_DIR"

if [ ! -f "$DIST/agent/ops-agent-windows-amd64.exe" ]; then
  "$ROOT/scripts/build-agent.sh"
fi

README_WIN='Ops Hub Agent (Windows)
=========================

1. 把 config.example.json 复制为 config.json，填写：
   - server: wss://ops.example.com/agent
   - enrollmentToken: 管理员提供的注册令牌
   - name/tags: 客户端名称和标签
   - allowedRoots: 允许访问的目录，如 ["C:\\", "D:\\"]

2. 右键 install.bat -> 以管理员身份运行。
   服务名：OpsHubAgent
   日志：C:\ProgramData\OpsHubAgent\logs\agent.log

3. 如果安装服务时报 “A system shutdown is in progress”，先重启系统；
   或者直接运行 run.bat 前台启动（不安装服务，窗口不能关）。
4. 卸载：以管理员身份运行 uninstall.bat。

说明：
- 客户端只主动出站 443，不需要公网 IP，不需要开入站端口。
- Windows Server 2008 R2 请使用 amd64 或 386 版本。
- 不要删除 C:\ProgramData\OpsHubAgent\agent-state.json，否则会重新注册。
'

README_LINUX='Ops Hub Agent (Linux)
======================

1. 复制 config.example.json 为 config.json，填写 server/enrollmentToken。
2. sudo ./install-linux.sh
   服务名：ops-hub-agent
   日志：/opt/ops-hub-agent/logs/agent.log
3. 卸载：sudo ./uninstall-linux.sh

说明：
- 客户端只主动出站 443，不需要公网 IP，不需要开入站端口。
- systemd 管理，开机自启，异常自动重启。
'

make_windows_pkg() {
  local arch="$1"
  local exe="$DIST/agent/ops-agent-windows-${arch}.exe"
  local dir="$PKG_DIR/ops-agent-windows-${arch}"
  mkdir -p "$dir"
  cp "$exe" "$dir/ops-agent.exe"
  cp "$AGENT_DIR/config.example.json" "$dir/config.example.json"
  cp "$AGENT_DIR/install.bat" "$dir/install.bat"
  cp "$AGENT_DIR/run.bat" "$dir/run.bat"
  cp "$AGENT_DIR/uninstall.bat" "$dir/uninstall.bat"
  printf '%s' "$README_WIN" > "$dir/README.txt"
  python3 - "$dir" "$PKG_DIR/ops-agent-windows-${arch}.zip" <<'PY'
import os, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for name in sorted(os.listdir(src)):
        z.write(os.path.join(src, name), name)
print(out)
PY
}

make_linux_pkg() {
  local arch="$1"
  local bin="$DIST/agent/ops-agent-linux-${arch}"
  local dir="$PKG_DIR/ops-agent-linux-${arch}"
  mkdir -p "$dir"
  cp "$bin" "$dir/ops-agent-linux-${arch}"
  cp "$AGENT_DIR/config.example.json" "$dir/config.example.json"
  cp "$ROOT/scripts/install-linux.sh" "$dir/install-linux.sh"
  cp "$ROOT/scripts/uninstall-linux.sh" "$dir/uninstall-linux.sh"
  chmod +x "$dir/ops-agent-linux-${arch}" "$dir/install-linux.sh" "$dir/uninstall-linux.sh"
  printf '%s' "$README_LINUX" > "$dir/README.txt"
  tar -C "$PKG_DIR" -czf "$PKG_DIR/ops-agent-linux-${arch}.tar.gz" "ops-agent-linux-${arch}"
  echo "$PKG_DIR/ops-agent-linux-${arch}.tar.gz"
}

make_windows_pkg amd64
make_windows_pkg 386
make_linux_pkg amd64
make_linux_pkg arm64
make_linux_pkg 386

# 同时复制到 Hub 的静态下载目录，安装后可以直接从管理页面下载
PUBLIC_DOWNLOADS="$ROOT/public/downloads"
mkdir -p "$PUBLIC_DOWNLOADS"
cp "$PKG_DIR"/*.zip "$PKG_DIR"/*.tar.gz "$PUBLIC_DOWNLOADS"/
cp "$AGENT_DIR/config.example.json" "$PUBLIC_DOWNLOADS/config.example.json"

# 远程升级用的原始二进制 + manifest
cp "$DIST/agent/ops-agent-windows-amd64.exe" "$PUBLIC_DOWNLOADS/"
cp "$DIST/agent/ops-agent-windows-386.exe" "$PUBLIC_DOWNLOADS/"
cp "$DIST/agent/ops-agent-linux-amd64" "$PUBLIC_DOWNLOADS/"
cp "$DIST/agent/ops-agent-linux-arm64" "$PUBLIC_DOWNLOADS/"
cp "$DIST/agent/ops-agent-linux-386" "$PUBLIC_DOWNLOADS/"

VERSION="$(grep -m1 'const Version' "$AGENT_DIR/config.go" | sed -E 's/.*"([^"]+)".*/\1/')"
python3 - "$PUBLIC_DOWNLOADS" "$VERSION" <<'PYEOF'
import hashlib, json, os, sys, datetime
root, version = sys.argv[1], sys.argv[2]
files = {
    "windows-amd64": "ops-agent-windows-amd64.exe",
    "windows-386": "ops-agent-windows-386.exe",
    "linux-amd64": "ops-agent-linux-amd64",
    "linux-arm64": "ops-agent-linux-arm64",
    "linux-386": "ops-agent-linux-386",
}
manifest = {"version": version, "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "files": {}}
for key, name in files.items():
    path = os.path.join(root, name)
    digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
    manifest["files"][key] = {"name": name, "sha256": digest, "size": os.path.getsize(path)}
open(os.path.join(root, "manifest.json"), "w").write(json.dumps(manifest, indent=2) + "\n")
print("manifest:", version, len(manifest["files"]), "files")
PYEOF

echo
echo "Agent 安装包:"
ls -lh "$PKG_DIR"
echo
echo "管理页面下载目录: $PUBLIC_DOWNLOADS"
