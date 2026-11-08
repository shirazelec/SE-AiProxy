#!/usr/bin/env bash
# SE-AiProxy — developed & provided by shirazelectronic (https://shirazelectronic.ir)
#
# Installs SE-AiProxy as a systemd service (se-aiproxy.service) that runs from this folder and starts
# at boot. A service left by an older version ("deepseek-proxy") is stopped and removed first.
#
# Run as your normal user (the script asks for sudo itself):  bash linux/install-service.sh
# Optional: PORT=18789 HTTPS_PORT=18790 HOST=0.0.0.0 bash linux/install-service.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "[-] node was not found in PATH. Run this as your normal user (not with sudo), after installing Node.js."
  exit 1
fi
RUN_USER="${SUDO_USER:-$(id -un)}"
PORT="${PORT:-18789}"
HTTPS_PORT="${HTTPS_PORT:-18790}"
HOST="${HOST:-0.0.0.0}"
UNIT=/etc/systemd/system/se-aiproxy.service
LEGACY=/etc/systemd/system/deepseek-proxy.service

echo "======================================================"
echo "  SE-AiProxy - systemd service installer"
echo "  by shirazelectronic - https://shirazelectronic.ir"
echo "======================================================"
echo "  Folder: $DIR"
echo "  Node:   $NODE"
echo "  User:   $RUN_USER"

if [ ! -d "$DIR/node_modules" ]; then
  echo "[*] Installing dependencies..."
  (cd "$DIR" && npm install --omit=dev)
fi

if [ -f "$LEGACY" ] || systemctl cat deepseek-proxy.service >/dev/null 2>&1; then
  echo "[*] Removing the old deepseek-proxy service..."
  sudo systemctl disable --now deepseek-proxy.service 2>/dev/null || true
  sudo rm -f "$LEGACY"
fi

echo "[*] Writing $UNIT ..."
sudo tee "$UNIT" >/dev/null <<EOF
[Unit]
Description=SE-AiProxy (shirazelectronic.ir)
Documentation=https://shirazelectronic.ir
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$DIR
ExecStart=$NODE src/server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=HTTPS_PORT=$HTTPS_PORT
Environment=HOST=$HOST
Environment=PATH=$(dirname "$NODE"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable se-aiproxy.service >/dev/null
sudo systemctl restart se-aiproxy.service

echo "[*] Waiting for the proxy to answer..."
for _ in $(seq 1 20); do
  if curl -fs "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "[+] SE-AiProxy is running: http://127.0.0.1:$PORT  (service: se-aiproxy)"
    echo "    Logs:    journalctl -u se-aiproxy -f"
    echo "    Restart: sudo systemctl restart se-aiproxy"
    exit 0
  fi
  sleep 1
done
echo "[-] The service did not answer on port $PORT. Check: journalctl -u se-aiproxy -n 50"
exit 1
