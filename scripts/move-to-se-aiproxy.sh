#!/usr/bin/env bash
# One-time move of this machine from "Codex Proxy" (deepseek-proxy service) to "SE-AiProxy".
#   1. puts the real CODEX_PROXY_KEY (from ~/.codex/.env) back into ~/.bashrc, ~/.zshrc, ~/.profile
#   2. stops the old deepseek-proxy service
#   3. renames ~/Desktop/Codex Proxy -> ~/Desktop/SE-AiProxy (accounts, keys and settings move with it)
#   4. installs and starts the se-aiproxy service from the new folder
# Run as your normal user:  bash "$HOME/Desktop/Codex Proxy/scripts/move-to-se-aiproxy.sh"
set -euo pipefail

OLD="$HOME/Desktop/Codex Proxy"
NEW="$HOME/Desktop/SE-AiProxy"

if [ -e "$NEW" ]; then
  echo "[-] $NEW already exists; nothing was changed."
  exit 1
fi
if [ ! -d "$OLD" ]; then
  echo "[-] $OLD was not found; nothing was changed."
  exit 1
fi

echo "[1/4] Restoring CODEX_PROXY_KEY in shell startup files..."
node -e '
const fs = require("fs"), os = require("os"), path = require("path");
const env = fs.readFileSync(path.join(os.homedir(), ".codex/.env"), "utf8");
const m = /CODEX_PROXY_KEY\s*=\s*"?([^"\n]+)"?/.exec(env);
if (!m) { console.log("      no key in ~/.codex/.env, skipped"); process.exit(0); }
for (const f of [".bashrc", ".zshrc", ".profile"]) {
  const p = path.join(os.homedir(), f);
  if (!fs.existsSync(p)) continue;
  const s = fs.readFileSync(p, "utf8");
  const n = s.replace(/^export CODEX_PROXY_KEY\s*=.*$/m, `export CODEX_PROXY_KEY="${m[1]}"`);
  if (n !== s) { fs.writeFileSync(p, n); console.log("      " + f + " fixed"); }
}'

echo "[2/4] Stopping the old deepseek-proxy service..."
sudo systemctl disable --now deepseek-proxy.service 2>/dev/null || true

echo "[3/4] Renaming the folder to $NEW ..."
mv "$OLD" "$NEW"

echo "[4/4] Installing the se-aiproxy service..."
bash "$NEW/linux/install-service.sh"

echo
echo "[+] Done. Open a new terminal (so the restored key is loaded) and restart Codex."
