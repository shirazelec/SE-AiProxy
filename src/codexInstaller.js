import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tokenPool from './tokenPool.js';
import { setTopLevelTomlKey } from './codexConfig.js';
import { sanitizeHost, sanitizePort } from './security.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

/**
 * Checks if OpenAI Codex / ChatGPT Desktop App is installed.
 */
export function checkDesktopAppInstalled() {
  let appPath = null;

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

    const candidates = [
      path.join(localAppData, 'Programs', 'ChatGPT', 'ChatGPT.exe'),
      path.join(programFiles, 'ChatGPT', 'ChatGPT.exe'),
      path.join(programFilesX86, 'ChatGPT', 'ChatGPT.exe'),
      path.join(localAppData, 'Microsoft', 'WindowsApps', 'ChatGPT.exe')
    ];

    for (const c of candidates) {
      if (fs.existsSync(c)) {
        appPath = c;
        break;
      }
    }

    if (!appPath) {
      try {
        const out = execSync('powershell -Command "Get-AppxPackage -Name *ChatGPT* | Select-Object -ExpandProperty InstallLocation"', {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 4000
        }).trim();
        if (out) appPath = out;
      } catch {}
    }
  } else if (process.platform === 'darwin') {
    const candidates = [
      '/Applications/ChatGPT.app',
      path.join(os.homedir(), 'Applications', 'ChatGPT.app')
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        appPath = c;
        break;
      }
    }
  } else {
    // Linux
    const candidates = [
      '/usr/bin/chatgpt',
      '/usr/lib/chatgpt/ChatGPT',
      '/snap/bin/chatgpt',
      '/usr/local/bin/chatgpt'
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        appPath = c;
        break;
      }
    }
  }

  return {
    installed: Boolean(appPath),
    appPath,
    type: 'desktop_app'
  };
}

/**
 * Installs or launches installer for Codex / ChatGPT Desktop App across platforms.
 */
export async function installDesktopApp() {
  console.log('[Desktop Installer] Checking system environment for Codex Desktop App...');
  const current = checkDesktopAppInstalled();
  if (current.installed) {
    console.log(`[Desktop Installer] Codex Desktop App is already installed at: ${current.appPath}`);
    return { success: true, alreadyInstalled: true, appPath: current.appPath };
  }

  console.log('[Desktop Installer] Attempting to install Codex Desktop App...');

  if (process.platform === 'win32') {
    try {
      console.log('[Desktop Installer] Installing via Windows Package Manager (winget)...');
      execSync('winget install --id 9PLM9XGG6VKS -s msstore --accept-source-agreements --accept-package-agreements', {
        stdio: 'inherit',
        timeout: 240000
      });
      const check = checkDesktopAppInstalled();
      if (check.installed) {
        return { success: true, method: 'winget-msstore', appPath: check.appPath };
      }
    } catch (err) {
      console.warn('[Desktop Installer] winget install warning:', err.message);
    }

    // Fallback: Open official download page
    try {
      console.log('[Desktop Installer] Opening official download page in browser...');
      execSync('start https://chatgpt.com/download', { stdio: 'ignore' });
      return { success: true, method: 'browser-download', manual: true };
    } catch {}
  } else if (process.platform === 'darwin') {
    try {
      console.log('[Desktop Installer] Installing via Homebrew Cask (brew install --cask chatgpt)...');
      execSync('brew install --cask chatgpt', {
        stdio: 'inherit',
        timeout: 240000
      });
      const check = checkDesktopAppInstalled();
      if (check.installed) {
        return { success: true, method: 'brew-cask', appPath: check.appPath };
      }
    } catch (err) {
      console.warn('[Desktop Installer] brew install warning:', err.message);
    }

    try {
      console.log('[Desktop Installer] Opening official macOS download page in browser...');
      execSync('open https://chatgpt.com/download', { stdio: 'ignore' });
      return { success: true, method: 'browser-download', manual: true };
    } catch {}
  } else {
    // Linux
    try {
      if (fs.existsSync('/usr/bin/snap')) {
        console.log('[Desktop Installer] Installing via Snap (sudo snap install chatgpt)...');
        execSync('sudo snap install chatgpt', { stdio: 'inherit', timeout: 240000 });
        const check = checkDesktopAppInstalled();
        if (check.installed) {
          return { success: true, method: 'snap', appPath: check.appPath };
        }
      }
    } catch (err) {
      console.warn('[Desktop Installer] Snap install warning:', err.message);
    }

    try {
      console.log('[Desktop Installer] Opening official Linux download page in browser...');
      execSync('xdg-open https://chatgpt.com/download 2>/dev/null || true', { stdio: 'ignore' });
      return { success: true, method: 'browser-download', manual: true };
    } catch {}
  }

  return {
    success: false,
    error: 'Please download and install ChatGPT Desktop App from: https://chatgpt.com/download'
  };
}

/**
 * Checks if OpenAI Codex CLI is installed on the system.
 */
export function checkCodexInstalled() {
  let binPath = null;
  let version = null;

  // 1. Try finding in current PATH
  try {
    const cmd = process.platform === 'win32' ? 'where codex' : 'command -v codex';
    const out = execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (out) {
      binPath = out.split(/\r?\n/)[0].trim();
    }
  } catch {}

  // 2. Check standard local bin locations if not found in PATH
  if (!binPath) {
    const localCandidates = process.platform === 'win32'
      ? [
          path.join(os.homedir(), '.local', 'bin', 'codex.exe'),
          path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'codex.cmd'),
          path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'codex', 'codex.exe')
        ]
      : [
          path.join(os.homedir(), '.local', 'bin', 'codex'),
          '/usr/local/bin/codex',
          '/usr/bin/codex'
        ];

    for (const c of localCandidates) {
      if (fs.existsSync(c)) {
        binPath = c;
        break;
      }
    }
  }

  // 3. Try obtaining version
  if (binPath) {
    try {
      version = execSync(`"${binPath}" --version`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5000
      }).trim();
    } catch {}
  }

  return {
    installed: Boolean(binPath),
    binPath,
    version: version || (binPath ? 'installed' : null)
  };
}

/**
 * Installs Codex CLI automatically using the official installer or npm fallback.
 */
export async function installCodexCli() {
  console.log('[Codex Installer] Checking system environment for Codex CLI...');
  const current = checkCodexInstalled();
  if (current.installed) {
    console.log(`[Codex Installer] Codex CLI is already installed at: ${current.binPath} (${current.version})`);
    return { success: true, alreadyInstalled: true, binPath: current.binPath, version: current.version };
  }

  console.log('[Codex Installer] Installing OpenAI Codex CLI...');

  // Strategy 1: Official installer script
  if (process.platform === 'win32') {
    try {
      console.log('[Codex Installer] Running official PowerShell installer...');
      execSync('powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"', {
        stdio: 'inherit',
        timeout: 180000
      });
      const check = checkCodexInstalled();
      if (check.installed) {
        return { success: true, method: 'powershell-official', binPath: check.binPath, version: check.version };
      }
    } catch (err) {
      console.warn('[Codex Installer] Official PowerShell installer warning:', err.message);
    }
  } else {
    try {
      console.log('[Codex Installer] Running official shell installer (curl | sh)...');
      execSync('curl -fsSL https://chatgpt.com/codex/install.sh | sh', {
        stdio: 'inherit',
        timeout: 180000
      });
      const check = checkCodexInstalled();
      if (check.installed) {
        return { success: true, method: 'curl-official', binPath: check.binPath, version: check.version };
      }
    } catch (err) {
      console.warn('[Codex Installer] Official shell installer warning:', err.message);
    }
  }

  // Strategy 2: Global npm package fallback
  try {
    console.log('[Codex Installer] Trying npm install -g @openai/codex...');
    execSync('npm install -g @openai/codex', {
      stdio: 'inherit',
      timeout: 180000
    });
    const check = checkCodexInstalled();
    if (check.installed) {
      return { success: true, method: 'npm-global', binPath: check.binPath, version: check.version };
    }
  } catch (err) {
    console.warn('[Codex Installer] npm install -g failed:', err.message);
  }

  // Final check
  const finalCheck = checkCodexInstalled();
  if (finalCheck.installed) {
    return { success: true, method: 'detected', binPath: finalCheck.binPath, version: finalCheck.version };
  }

  return {
    success: false,
    error: 'Could not automatically install Codex CLI. Please install it manually via: npm install -g @openai/codex'
  };
}

/**
 * Generates standard config.toml content for Codex
 */
// Codex truncates tool output to ~10 KB for models it does not know; let the model see ~1000-line reads
export const CODEX_TOOL_OUTPUT_TOKEN_LIMIT = 12000;

export const CODEX_PROVIDER_ID = 'se_aiproxy';
export const CODEX_MODEL = 'se-aiproxy-reasoner';
const LEGACY_PROVIDER_RE = /\[model_providers\.deepseek_proxy\][^\[]*/gs;

export function generateCodexToml({ host = '127.0.0.1', port = 18789, contextWindow, autoCompactLimit } = {}) {
  const cleanHost = (!host || host === 'localhost') ? '127.0.0.1' : sanitizeHost(host);
  port = sanitizePort(port);
  const limits = tokenPool.getSettings ? tokenPool.getSettings() : { contextWindow: 1048576, autoCompactLimit: 400000 };
  const cw = contextWindow || limits.contextWindow || 1048576;
  const acl = autoCompactLimit || limits.autoCompactLimit || 400000;

  return `model = "se-aiproxy-reasoner"
model_provider = "se_aiproxy"
model_context_window = ${cw}
model_auto_compact_token_limit = ${acl}
tool_output_token_limit = ${CODEX_TOOL_OUTPUT_TOKEN_LIMIT}
sandbox = "workspace-write"

[model_providers.se_aiproxy]
name = "SE-AiProxy"
base_url = "http://${cleanHost}:${port}/openai/v1"
wire_api = "responses"
env_key = "CODEX_PROXY_KEY"

[desktop]
followUpQueueMode = "steer"
appearanceTheme = "dark"
`;
}

/**
 * Ensures project configuration, proxy keys, and ~/.codex/config.toml are properly configured.
 * Works seamlessly for BOTH Codex Desktop App and Codex CLI!
 */
export async function configureCodex({ host = '127.0.0.1', port = 18789, keyLabel = 'Default Codex Key' } = {}) {
  const cleanHost = (!host || host === 'localhost') ? '127.0.0.1' : sanitizeHost(host);
  port = sanitizePort(port);

  // 1. Ensure project .env and data exist
  const envPath = path.join(PROJECT_ROOT, '.env');
  const envExamplePath = path.join(PROJECT_ROOT, '.env.example');
  if (!fs.existsSync(envPath) && fs.existsSync(envExamplePath)) {
    fs.copyFileSync(envExamplePath, envPath);
  }

  const dataDir = path.join(PROJECT_ROOT, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // 2. Ensure active proxy key exists
  let keys = tokenPool.getProxyKeys();
  let activeKey = keys[0]?.key;
  if (!activeKey) {
    const created = tokenPool.createProxyKey(keyLabel);
    activeKey = created.key;
  }

  // 3. Ensure ~/.codex directory exists
  const codexDir = process.env.CODEX_DIR || path.join(os.homedir(), '.codex');
  if (!fs.existsSync(codexDir)) {
    fs.mkdirSync(codexDir, { recursive: true });
  }

  // 4. Update ~/.codex/config.toml
  const configPath = path.join(codexDir, 'config.toml');
  let configContent = '';
  if (fs.existsSync(configPath)) {
    configContent = fs.readFileSync(configPath, 'utf8');
  }

  // Older installs (as "Codex Proxy") registered the provider as "deepseek_proxy": drop that block
  configContent = configContent.replace(LEGACY_PROVIDER_RE, '');
  const providerSectionRegex = /\[model_providers\.se_aiproxy\][^\[]*/s;
  const providerBlock = `[model_providers.se_aiproxy]
name = "SE-AiProxy"
base_url = "http://${cleanHost}:${port}/openai/v1"
wire_api = "responses"
env_key = "CODEX_PROXY_KEY"
`;

  if (providerSectionRegex.test(configContent)) {
    configContent = configContent.replace(providerSectionRegex, providerBlock);
  } else {
    // A table header before the top-level keys would swallow them (model = ... would land inside
    // [model_providers.*]), so a new block always goes at the end
    configContent = `${configContent.trimEnd()}\n\n${providerBlock}`;
  }

  if (/^model\s*=\s*.*/m.test(configContent)) {
    configContent = configContent.replace(/^model\s*=\s*.*/m, 'model = "se-aiproxy-reasoner"');
  } else {
    configContent = `model = "se-aiproxy-reasoner"\n${configContent}`;
  }

  const limits = tokenPool.getSettings ? tokenPool.getSettings() : { contextWindow: 1048576, autoCompactLimit: 400000 };
  configContent = setTopLevelTomlKey(configContent, 'model_context_window', limits.contextWindow || 1048576);
  configContent = setTopLevelTomlKey(configContent, 'model_auto_compact_token_limit', limits.autoCompactLimit || 400000);
  configContent = setTopLevelTomlKey(configContent, 'tool_output_token_limit', CODEX_TOOL_OUTPUT_TOKEN_LIMIT);
  // Remove deprecated approval_policy if present (deprecated in latest Codex / ChatGPT Desktop)
  configContent = configContent.replace(/^approval_policy\s*=.*\r?\n?/m, '');
  configContent = setTopLevelTomlKey(configContent, 'sandbox', '"workspace-write"');

  if (/^model_provider\s*=\s*.*/m.test(configContent)) {
    configContent = configContent.replace(/^model_provider\s*=\s*.*/m, 'model_provider = "se_aiproxy"');
  } else {
    configContent = `model_provider = "se_aiproxy"\n${configContent}`;
  }

  // Ensure Desktop App section is present
  if (!configContent.includes('[desktop]')) {
    configContent = `${configContent.trim()}\n\n[desktop]\nfollowUpQueueMode = "steer"\nappearanceTheme = "dark"\n`;
  }

  fs.writeFileSync(configPath, configContent.trim() + '\n', 'utf8');

  // 5. Update ~/.codex/.env
  const codexEnvPath = path.join(codexDir, '.env');
  let codexEnvContent = '';
  if (fs.existsSync(codexEnvPath)) {
    codexEnvContent = fs.readFileSync(codexEnvPath, 'utf8');
  }

  if (/^CODEX_PROXY_KEY\s*=\s*.*/m.test(codexEnvContent)) {
    codexEnvContent = codexEnvContent.replace(/^CODEX_PROXY_KEY\s*=\s*.*/m, `CODEX_PROXY_KEY="${activeKey}"`);
  } else {
    codexEnvContent = `${codexEnvContent.trim()}\nCODEX_PROXY_KEY="${activeKey}"\n`;
  }
  fs.writeFileSync(codexEnvPath, codexEnvContent.trim() + '\n', 'utf8');

  // 6. Update shell configurations (.bashrc, .zshrc, .bash_profile, .profile)
  if (process.platform !== 'win32') {
    const shellConfigFiles = ['.bashrc', '.zshrc', '.bash_profile', '.profile'];
    const localBin = path.join(os.homedir(), '.local', 'bin');

    for (const file of shellConfigFiles) {
      const cfgPath = path.join(os.homedir(), file);
      if (fs.existsSync(cfgPath)) {
        try {
          let content = fs.readFileSync(cfgPath, 'utf8');
          let modified = false;

          // Export proxy key
          if (/^export CODEX_PROXY_KEY\s*=\s*.*/m.test(content)) {
            content = content.replace(/^export CODEX_PROXY_KEY\s*=\s*.*/m, `export CODEX_PROXY_KEY="${activeKey}"`);
            modified = true;
          } else {
            content = `${content.trim()}\nexport CODEX_PROXY_KEY="${activeKey}"\n`;
            modified = true;
          }

          // Ensure ~/.local/bin is in PATH if present
          if (!content.includes('.local/bin')) {
            content = `${content.trim()}\nexport PATH="$HOME/.local/bin:$PATH"\n`;
            modified = true;
          }

          if (modified) {
            fs.writeFileSync(cfgPath, content.trim() + '\n', 'utf8');
          }
        } catch (e) {
          console.warn(`[Config] Note: Could not update ${file}:`, e.message);
        }
      }
    }

    // 7. Desktop wrapper for Linux / macOS if official standalone is available
    const chatgptCandidates = [
      '/usr/lib/chatgpt/resources/codex',
      '/usr/lib/chatgpt/ChatGPT',
      '/Applications/ChatGPT.app/Contents/Resources/codex'
    ];
    const foundCandidate = chatgptCandidates.find(p => p && fs.existsSync(p));
    if (foundCandidate) {
      if (!fs.existsSync(localBin)) {
        fs.mkdirSync(localBin, { recursive: true });
      }
      const codexWrapperPath = path.join(localBin, 'codex');
      const wrapperScript = `#!/usr/bin/env bash\nif [ -f "$HOME/.codex/.env" ]; then\n  set -a\n  source "$HOME/.codex/.env"\n  set +a\nfi\nexec "${foundCandidate}" "$@"\n`;
      fs.writeFileSync(codexWrapperPath, wrapperScript, { mode: 0o755 });
    }
  }

  // 8. Windows environment variables
  if (process.platform === 'win32') {
    try {
      execSync(`setx CODEX_PROXY_KEY "${activeKey}"`, { stdio: 'ignore' });
      console.log('[Config] Set CODEX_PROXY_KEY permanently in Windows User Environment.');
    } catch (e) {
      console.warn('[Config] setx warning:', e.message);
    }
  }

  return {
    ok: true,
    activeKey,
    configPath,
    envPath: codexEnvPath,
    host: cleanHost,
    port
  };
}
