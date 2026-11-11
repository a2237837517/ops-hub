#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="ops-hub-agent"
INSTALL_DIR="${INSTALL_DIR:-/opt/ops-hub-agent}"

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 运行: sudo $0" >&2
  exit 1
fi

systemctl stop "$SERVICE_NAME" 2>/dev/null || true
systemctl disable "$SERVICE_NAME" 2>/dev/null || true
rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
echo "服务已停止并移除。保留目录: $INSTALL_DIR（如需彻底删除: rm -rf $INSTALL_DIR）"
