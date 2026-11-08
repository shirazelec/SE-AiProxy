#!/usr/bin/env bash
set -e

cd "$(dirname "$0")/.."

# Ensure dependencies exist
if [ ! -d "node_modules" ]; then
  echo "[INFO] Dependencies missing. Running installer..."
  ./macos/install.sh
fi

echo "=================================================="
echo "  SE-AiProxy is starting..."
echo "  Dashboard: http://127.0.0.1:18789"
echo "  Codex Wire Port: 18789"
echo "=================================================="

# Try opening the dashboard in default browser in background
(sleep 1.2 && open "http://127.0.0.1:18789" 2>/dev/null || true) &

exec node src/server.js
