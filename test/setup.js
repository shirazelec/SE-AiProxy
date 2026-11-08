// Loaded into every test process (node --import): tokenPool reads and rewrites DATA_DIR/config.json
// on import, so tests must never see the real data/ directory or its live accounts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-proxy-tests-'));
}
// codexInstaller writes CODEX_PROXY_KEY into ~/.bashrc, ~/.zshrc, ~/.profile and ~/.local/bin: give the
// tests their own home so they never touch the real shell config
if (!process.env.TEST_KEEP_HOME) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-proxy-home-'));
  for (const f of ['.bashrc', '.zshrc', '.profile']) fs.writeFileSync(path.join(home, f), '# test home\n');
  process.env.HOME = home;
  process.env.USERPROFILE = home;
}
// Defined-but-empty keeps dotenv from loading the real DeepSeek token from .env into the test pool
process.env.DEEPSEEK_TOKEN = '';
