#!/usr/bin/env bash
set -e

# Change directory to project root
cd "$(dirname "$0")/.."

echo "=================================================="
echo "  SE-AiProxy - Linux Installer"
echo "  Automated Setup for Linux"
echo "=================================================="
echo ""

# 1. Check Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "[!] Node.js was not found."
  echo "    Checking system package manager to install Node.js..."

  if command -v apt-get >/dev/null 2>&1; then
    echo "    Running: sudo apt-get update && sudo apt-get install -y nodejs npm"
    sudo apt-get update && sudo apt-get install -y nodejs npm
  elif command -v pacman >/dev/null 2>&1; then
    echo "    Running: sudo pacman -Sy --noconfirm nodejs npm"
    sudo pacman -Sy --noconfirm nodejs npm
  elif command -v dnf >/dev/null 2>&1; then
    echo "    Running: sudo dnf install -y nodejs npm"
    sudo dnf install -y nodejs npm
  else
    echo "[ERROR] Please install Node.js (v18 or higher) from https://nodejs.org"
    exit 1
  fi
fi

NODE_VER=$(node -v 2>/dev/null || echo "unknown")
echo "[OK] Node.js is ready: $NODE_VER"

# 2. Check npm dependencies
if [ ! -d "node_modules" ]; then
  echo "[INFO] Installing proxy npm dependencies..."
  npm install
else
  echo "[OK] Dependencies are already installed."
fi

# 3. Create .env from template if missing
if [ ! -f ".env" ]; then
  cp .env.example .env
  echo "[OK] Created .env file."
fi

# 4. Create data directory & initial config if missing
mkdir -p data
if [ ! -f "data/config.json" ]; then
  echo '{"tokens":[],"proxyKeys":[]}' > data/config.json
  echo "[OK] Initialized data directory."
fi

# 5. Make helper scripts executable
chmod +x linux/*.sh 2>/dev/null || true
chmod +x bin/install.js 2>/dev/null || true

# 6. Run interactive installer (asks Desktop App vs CLI)
node bin/install.js

# 7. Prompt to launch
echo ""
echo -n "Do you want to start the proxy server now? (Y/n): "
read -r choice || choice="Y"
choice=${choice:-Y}
if [[ "$choice" =~ ^[Yy]$ ]]; then
  echo ""
  exec ./linux/start.sh
fi
