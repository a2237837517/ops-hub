#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-/opt/ops-hub-agent}"
SERVICE_NAME="ops-hub-agent"

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 运行: sudo $0" >&2
  exit 1
fi

if [ ! -f "$DIR/config.json" ]; then
  echo "缺少 $DIR/config.json" >&2
  echo "请先复制 config.example.json 为 config.json 并填写 server/enrollmentToken。" >&2
  exit 1
fi

BIN=""
for candidate in "$DIR"/ops-agent-linux-*; do
  if [ -f "$candidate" ]; then
    BIN="$candidate"
    break
  fi
done
if [ -z "$BIN" ]; then
  echo "找不到 ops-agent-linux-* 二进制" >&2
  exit 1
fi

install -d -m 0755 "$INSTALL_DIR"
install -d -m 0700 "$INSTALL_DIR/logs"
install -m 0755 "$BIN" "$INSTALL_DIR/ops-agent"
install -m 0644 "$DIR/config.json" "$INSTALL_DIR/config.json"

cat >"/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Ops Hub Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${INSTALL_DIR}/ops-agent run --config ${INSTALL_DIR}/config.json
WorkingDirectory=${INSTALL_DIR}
Restart=always
RestartSec=5
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
sleep 2
systemctl --no-pager --lines=10 status "$SERVICE_NAME" || true
echo
echo "安装完成: $INSTALL_DIR"
echo "查看日志: journalctl -u $SERVICE_NAME -f 或 tail -f ${INSTALL_DIR}/logs/agent.log"
