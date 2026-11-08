import './logSetup.js';
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { handleResponsesRequest } from './responsesAdapter.js';
import { handleChatCompletionRequest } from './chatAdapter.js';
import { handleAnthropicMessagesRequest } from './anthropicAdapter.js';
import { getOrCreateTlsCertificate } from './tlsCertificate.js';
import tokenPool, { SETTINGS_SCHEMA } from './tokenPool.js';
import providerManager from './providers.js';
import { PROVIDER_PRESETS } from './providerPresets.js';
import { setTopLevelTomlKey } from './codexConfig.js';
import { configureCodex, generateCodexToml, CODEX_TOOL_OUTPUT_TOKEN_LIMIT } from './codexInstaller.js';
import { createAdminGuard, extractClientKey, sanitizeHost, sanitizePort } from './security.js';
import { setSecretProvider, readRecentLogs, LOG_FILE } from './logger.js';

dotenv.config();
const rpCliEnvPath = path.join(os.homedir(), '.config', 'rp-cli', '.env');
dotenv.config({ path: rpCliEnvPath, override: false });

setSecretProvider(() => tokenPool.getSecrets());

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
let PROXY_VERSION = '2.5.1';
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
  if (pkg.version) PROXY_VERSION = pkg.version;
} catch {}

const app = express();
const PORT = Number(process.env.PORT) || 18789;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 18790;
const HOST = process.env.HOST || '127.0.0.1';

// Open CORS only for the inference APIs (they require a proxy key); the management API under
// /api stays same-origin so other websites cannot read or change accounts and keys.
const inferenceCors = cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'Accept', 'OpenAI-Beta', 'X-Requested-With', 'X-Conversation-Id', 'Session_id', 'Conversation_id', 'X-Codex-Turn-Metadata', 'x-api-key', 'anthropic-version', 'anthropic-beta'],
  exposedHeaders: ['X-RP-Session-Id']
});
app.use((req, res, next) => (req.path.startsWith('/api/') ? next() : inferenceCors(req, res, next)));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve Web UI static assets
app.use(express.static(PUBLIC_DIR));

// Request logger middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (!req.url.startsWith('/health') && !req.url.endsWith('.css') && !req.url.endsWith('.js') && !req.url.endsWith('.ico')) {
      console.log(`[${new Date().toLocaleTimeString()}] ${req.method} ${req.originalUrl || req.url} - ${res.statusCode} (${Date.now() - start}ms)`);
    }
  });
  next();
});

const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');

function applyCodexLimits(settings, configPath = CODEX_CONFIG_PATH) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  let content = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  content = setTopLevelTomlKey(content, 'model_context_window', settings.contextWindow);
  content = setTopLevelTomlKey(content, 'model_auto_compact_token_limit', settings.autoCompactLimit);
  content = setTopLevelTomlKey(content, 'tool_output_token_limit', CODEX_TOOL_OUTPUT_TOKEN_LIMIT);
  fs.writeFileSync(configPath, content.trim() + '\n', 'utf8');
  return configPath;
}

// Token middleware for protected OpenAI API endpoints
function requireToken(req, res, next) {
  // 1. Validate client Authorization header or x-api-key against proxy keys
  if (!tokenPool.validateProxyKey(extractClientKey(req))) {
    return res.status(401).json({
      error: {
        message: 'Missing or invalid Proxy API Key. Send a key from the dashboard (Proxy Keys) as Authorization: Bearer <key> or x-api-key',
        type: 'authentication_error',
        code: 'invalid_api_key'
      }
    });
  }

  // 2. Ensure token pool has at least one active provider or healthy DeepSeek account
  const hasActive = providerManager.hasActiveProviders() || tokenPool.tokens.some(t => t.status !== 'invalid' && t.status !== 'disabled');
  if (!hasActive) {
    return res.status(503).json({
      error: {
        message: 'No active AI providers or DeepSeek accounts configured in the pool. Open http://127.0.0.1:' + PORT + ' to configure one.',
        type: 'service_unavailable',
        code: 'no_active_providers'
      }
    });
  }

  next();
}

const requireAdmin = createAdminGuard({ getAdminKey: () => tokenPool.getAdminKey() });

// Setup scripts hand out a proxy key, so a client may fetch them with its own proxy key instead of the admin key
function requireAdminOrProxyKey(req, res, next) {
  const clientKey = extractClientKey(req);
  if (clientKey && tokenPool.validateProxyKey(clientKey)) {
    req.proxyKey = clientKey;
    return next();
  }
  return requireAdmin(req, res, next);
}

function setupKey(req) {
  if (req.proxyKey) return req.proxyKey;
  return tokenPool.getProxyKeys()[0]?.key || tokenPool.createProxyKey('Default Codex Key').key;
}

function sendBadRequest(res, err) {
  res.status(err.status || 500).type('text/plain').send(`Error: ${err.message}\n`);
}

// -------------------------------------------------------------
// Web UI REST API Endpoints
// -------------------------------------------------------------

// Web UI Homepage
app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Every /api route is protected; only the public TLS certificate is exempt
const PUBLIC_API_PATHS = new Set(['/cert', '/certificate']);
const SETUP_API_PATHS = new Set(['/codex-setup.sh', '/codex-setup.ps1', '/codex.env', '/codex-config.toml']);
app.use('/api', (req, res, next) => {
  if (PUBLIC_API_PATHS.has(req.path)) return next();
  if (SETUP_API_PATHS.has(req.path)) return requireAdminOrProxyKey(req, res, next);
  return requireAdmin(req, res, next);
});

// Unified Accounts & Providers Pool Management
app.get('/api/tokens', (_req, res) => {
  res.json(tokenPool.getTokens());
});

// Model ids a key can use, for the model picker in the dashboard
app.post('/api/provider-models', async (req, res) => {
  try {
    res.json({ models: await tokenPool.listProviderModels(req.body || {}) });
  } catch (err) {
    res.status(400).json({ error: { message: err.message } });
  }
});

app.get('/api/provider-presets', (_req, res) => {
  res.json(PROVIDER_PRESETS);
});

app.post('/api/tokens', async (req, res) => {
  try {
    const { token, keys, label, type, model, baseUrl, priority, role, rpm, rpd } = req.body || {};
    if (!token && !(Array.isArray(keys) && keys.length)) {
      return res.status(400).json({ error: { message: 'Token or API key string is required' } });
    }
    const created = await tokenPool.addAccount({ token, keys, label, type, model, baseUrl, priority, role, rpm, rpd });
    res.json(created);
  } catch (err) {
    console.error('[WebUI] Add account failed:', err.message);
    res.status(400).json({ error: { message: err.message } });
  }
});

// Bookmarklet on chat.deepseek.com: refresh the token of the same DeepSeek account in place
app.post('/api/tokens/deepseek-sync', async (req, res) => {
  try {
    const result = await tokenPool.syncDeepSeekToken(req.body || {});
    console.log(`[WebUI] DeepSeek token ${result.action} for ${result.label}.`);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[WebUI] DeepSeek token sync failed:', err.message);
    res.status(400).json({ error: { message: err.message } });
  }
});

app.put('/api/tokens/:id', async (req, res) => {
  try {
    const updated = await tokenPool.updateToken(req.params.id, req.body || {});
    res.json(updated);
  } catch (err) {
    console.error('[WebUI] Update account failed:', err.message);
    res.status(400).json({ error: { message: err.message } });
  }
});

app.patch('/api/tokens/:id', async (req, res) => {
  try {
    const updated = await tokenPool.updateToken(req.params.id, req.body || {});
    res.json(updated);
  } catch (err) {
    console.error('[WebUI] Patch account failed:', err.message);
    res.status(400).json({ error: { message: err.message } });
  }
});

app.post('/api/tokens/test-all', async (_req, res) => {
  try {
    const result = await tokenPool.testAllTokens();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/tokens/:id/test', async (req, res) => {
  try {
    const result = await tokenPool.testToken(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Several keys per account: when the active key fails the account moves on to the next one
app.post('/api/tokens/:id/keys', async (req, res) => {
  try {
    res.json(await tokenPool.addKey(req.params.id, req.body?.token ?? req.body?.keys));
  } catch (err) {
    console.error('[WebUI] Add key failed:', err.message);
    res.status(err.status || 400).json({ error: { message: err.message } });
  }
});

app.delete('/api/tokens/:id/keys/:keyId', (req, res) => {
  try {
    res.json(tokenPool.removeKey(req.params.id, req.params.keyId));
  } catch (err) {
    res.status(err.status || 400).json({ error: { message: err.message } });
  }
});

app.post('/api/tokens/:id/keys/:keyId/use', (req, res) => {
  try {
    res.json(tokenPool.useKey(req.params.id, req.params.keyId));
  } catch (err) {
    res.status(err.status || 400).json({ error: { message: err.message } });
  }
});

app.post('/api/tokens/:id/keys/:keyId/move', (req, res) => {
  try {
    res.json(tokenPool.moveKey(req.params.id, req.params.keyId, req.body?.delta));
  } catch (err) {
    res.status(err.status || 400).json({ error: { message: err.message } });
  }
});

app.delete('/api/tokens/:id', (req, res) => {
  const ok = tokenPool.deleteToken(req.params.id);
  res.json({ ok });
});

// Alias for backwards compatibility
app.get('/api/providers', (_req, res) => {
  res.json(tokenPool.getTokens());
});

app.put('/api/providers/:id', async (req, res) => {
  try {
    const updated = await tokenPool.updateToken(req.params.id, req.body || {});
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: { message: err.message } });
  }
});

app.post('/api/providers/:id/test', async (req, res) => {
  try {
    const result = await tokenPool.testToken(req.params.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/providers/test-all', async (_req, res) => {
  try {
    const result = await tokenPool.testAllTokens();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Proxy Keys Management
app.get('/api/proxy-keys', (_req, res) => {
  res.json(tokenPool.getProxyKeys());
});

app.post('/api/proxy-keys', (req, res) => {
  const { label, type } = req.body || {};
  const created = tokenPool.createProxyKey(label, type);
  res.json(created);
});

app.delete('/api/proxy-keys/:id', (req, res) => {
  const ok = tokenPool.deleteProxyKey(req.params.id);
  res.json({ ok });
});

// Recent proxy log (already redacted) for bug reports
app.get('/api/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  if (req.query.download === '1') {
    res.setHeader('Content-Disposition', `attachment; filename="proxy-log-${new Date().toISOString().replace(/[:.]/g, '-')}.log"`);
  }
  res.send(readRecentLogs() || '(log is empty)\n');
});

// Context window / session limit settings
app.get('/api/settings', (_req, res) => {
  res.json({ settings: tokenPool.getSettings(), schema: SETTINGS_SCHEMA });
});

app.post('/api/settings', (req, res) => {
  try {
    const { applyToCodex, ...partial } = req.body || {};
    const settings = tokenPool.updateSettings(partial);
    let configPath = null;
    if (applyToCodex) configPath = applyCodexLimits(settings);
    console.log(`[Settings] Updated: ${JSON.stringify(settings)}${configPath ? ` (applied to ${configPath})` : ''}`);
    res.json({ ok: true, settings, appliedTo: configPath });
  } catch (err) {
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// Host/port end up inside config.toml and shell/PowerShell scripts, so both are strictly validated
const resolveClientHostAndPort = (req) => {
  const hostHeader = req.headers.host || '';
  const headerHost = hostHeader.startsWith('[') ? hostHeader.slice(0, hostHeader.indexOf(']') + 1) : hostHeader.split(':')[0];
  const headerPort = hostHeader.startsWith('[') ? hostHeader.slice(hostHeader.indexOf(']') + 2) : hostHeader.split(':')[1];
  const rawHost = req.body?.host || req.query?.host || headerHost.trim() || '127.0.0.1';
  const host = rawHost === 'localhost' ? '127.0.0.1' : sanitizeHost(rawHost);

  const requestedPort = req.body?.port || req.query?.port;
  const port = requestedPort ? sanitizePort(requestedPort) : sanitizePort(headerPort, PORT);

  return { host, port };
};

// 1-Click Codex Configuration Endpoint
app.post('/api/apply-codex-config', async (req, res) => {
  try {
    const { host, port } = resolveClientHostAndPort(req);
    const result = await configureCodex({ host, port });
    console.log(`[Config] Codex configuration applied successfully. Host: ${host}, Port: ${port}, Active Key: ${result.activeKey}`);
    res.json(result);
  } catch (err) {
    console.error('[Apply Codex Config Error]', err.message);
    res.status(err.status || 500).json({ ok: false, error: err.message });
  }
});

// Downloadable or viewable config.toml
app.get('/api/codex-config.toml', (req, res) => {
  let host, port;
  try { ({ host, port } = resolveClientHostAndPort(req)); } catch (err) { return sendBadRequest(res, err); }
  const toml = generateCodexToml({ host, port });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  if (req.query.download === '1') {
    res.setHeader('Content-Disposition', 'attachment; filename="config.toml"');
  }
  res.send(toml);
});

// Downloadable .env file
app.get('/api/codex.env', (req, res) => {
  const activeKey = setupKey(req);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=".env"');
  res.send(`CODEX_PROXY_KEY="${activeKey}"\n`);
});

// 1-Line Setup Script for Linux / macOS clients
app.get('/api/codex-setup.sh', (req, res) => {
  let host, port;
  try { ({ host, port } = resolveClientHostAndPort(req)); } catch (err) { return sendBadRequest(res, err); }
  const activeKey = setupKey(req);

  const script = `#!/usr/bin/env bash
set -e

TARGET_HOST="${host}"
TARGET_PORT="${port}"
PROXY_KEY="${activeKey}"

echo "=============================================="
echo "⚡ Configuring Codex CLI for DeepSeek Proxy"
echo "🌐 Proxy URL: http://\${TARGET_HOST}:\${TARGET_PORT}/openai/v1"
echo "=============================================="

CODEX_DIR="\$HOME/.codex"
mkdir -p "\$CODEX_DIR"
CONFIG_FILE="\$CODEX_DIR/config.toml"
ENV_FILE="\$CODEX_DIR/.env"

# 1. Update .env
if [ -f "\$ENV_FILE" ]; then
  if grep -q "^CODEX_PROXY_KEY=" "\$ENV_FILE"; then
    sed -i.bak "s|^CODEX_PROXY_KEY=.*|CODEX_PROXY_KEY=\"\$PROXY_KEY\"|" "\$ENV_FILE" && rm -f "\$ENV_FILE.bak"
  else
    echo "CODEX_PROXY_KEY=\"\$PROXY_KEY\"" >> "\$ENV_FILE"
  fi
else
  echo "CODEX_PROXY_KEY=\"\$PROXY_KEY\"" > "\$ENV_FILE"
fi
chmod 600 "\$ENV_FILE" 2>/dev/null || true

# 2. Update config.toml
UPDATE_DONE=0
if command -v node >/dev/null 2>&1; then
  node -e '
const fs = require("fs");
const file = process.argv[1];
const host = process.argv[2];
const port = process.argv[3];
let content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
content = content.replace(/\\[model_providers\\.deepseek_proxy\\][^\\[]*/gs, "");
const providerBlock = \`[model_providers.se_aiproxy]\\nname = "SE-AiProxy"\\nbase_url = "http://\${host}:\${port}/openai/v1"\\nwire_api = "responses"\\nenv_key = "CODEX_PROXY_KEY"\\n\`;
if (/\\[model_providers\\.se_aiproxy\\][^\\[]*/s.test(content)) {
  content = content.replace(/\\[model_providers\\.se_aiproxy\\][^\\[]*/s, providerBlock);
} else {
  content = content.trimEnd() + "\\n\\n" + providerBlock;
}
if (/^model\\s*=\\s*.*/m.test(content)) {
  content = content.replace(/^model\\s*=\\s*.*/m, "model = \\"se-aiproxy-reasoner\\"");
} else {
  content = "model = \\"se-aiproxy-reasoner\\"\\n" + content;
}
if (/^model_provider\\s*=\\s*.*/m.test(content)) {
  content = content.replace(/^model_provider\\s*=\\s*.*/m, "model_provider = \\"se_aiproxy\\"");
} else {
  content = "model_provider = \\"se_aiproxy\\"\\n" + content;
}
fs.writeFileSync(file, content.trim() + "\\n", "utf8");
' "\$CONFIG_FILE" "\$TARGET_HOST" "\$TARGET_PORT" 2>/dev/null && UPDATE_DONE=1
fi

if [ "\$UPDATE_DONE" -eq 0 ] && command -v python3 >/dev/null 2>&1; then
  python3 -c '
import sys, re
file, host, port = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(file, "r", encoding="utf-8") as f: content = f.read()
except Exception: content = ""
content = re.sub(r"\\[model_providers\\.deepseek_proxy\\][^\\[]*", "", content, flags=re.DOTALL)
block = f"[model_providers.se_aiproxy]\\nname = \\"SE-AiProxy\\"\\nbase_url = \\"http://{host}:{port}/openai/v1\\"\\nwire_api = \\"responses\\"\\nenv_key = \\"CODEX_PROXY_KEY\\"\\n"
if re.search(r"\\[model_providers\\.se_aiproxy\\][^\\[]*", content, re.DOTALL):
    content = re.sub(r"\\[model_providers\\.se_aiproxy\\][^\\[]*", block, content, flags=re.DOTALL)
else:
    content = content.rstrip() + "\\n\\n" + block
if re.search(r"^model\\s*=.*", content, re.MULTILINE):
    content = re.sub(r"^model\\s*=.*", "model = \\"se-aiproxy-reasoner\\"", content, flags=re.MULTILINE)
else:
    content = "model = \\"se-aiproxy-reasoner\\"\\n" + content
if re.search(r"^model_provider\\s*=.*", content, re.MULTILINE):
    content = re.sub(r"^model_provider\\s*=.*", "model_provider = \\"se_aiproxy\\"", content, flags=re.MULTILINE)
else:
    content = "model_provider = \\"se_aiproxy\\"\\n" + content
with open(file, "w", encoding="utf-8") as f: f.write(content.strip() + "\\n")
' "\$CONFIG_FILE" "\$TARGET_HOST" "\$TARGET_PORT" 2>/dev/null && UPDATE_DONE=1
fi

if [ "\$UPDATE_DONE" -eq 0 ]; then
  cat <<TOML_EOF > "\$CONFIG_FILE"
model = "se-aiproxy-reasoner"
model_provider = "se_aiproxy"
model_context_window = 1048576
model_auto_compact_token_limit = 400000
tool_output_token_limit = 12000

[model_providers.se_aiproxy]
name = "SE-AiProxy"
base_url = "http://\${TARGET_HOST}:\${TARGET_PORT}/openai/v1"
wire_api = "responses"
env_key = "CODEX_PROXY_KEY"

[desktop]
followUpQueueMode = "steer"
appearanceTheme = "dark"
TOML_EOF
fi

echo ""
echo "✅ Codex successfully configured to use DeepSeek Proxy!"
echo "   Config: \$CONFIG_FILE"
echo "   Auth:   \$ENV_FILE"
echo "🚀 You can now run 'codex' in any terminal."
`;

  res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
  res.send(script);
});

// 1-Line Setup Script for Windows PowerShell clients
app.get('/api/codex-setup.ps1', (req, res) => {
  let host, port;
  try { ({ host, port } = resolveClientHostAndPort(req)); } catch (err) { return sendBadRequest(res, err); }
  const activeKey = setupKey(req);

  const psScript = `$ErrorActionPreference = 'Stop'
$targetHost = "${host}"
$targetPort = "${port}"
$proxyKey = "${activeKey}"

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "⚡ Configuring Codex for DeepSeek Proxy" -ForegroundColor Cyan
Write-Host "🌐 Proxy URL: http://$($targetHost):$($targetPort)/openai/v1" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan

$codexDir = Join-Path $HOME ".codex"
If (!(Test-Path $codexDir)) { New-Item -ItemType Directory -Path $codexDir -Force | Out-Null }
$envFile = Join-Path $codexDir ".env"
$configFile = Join-Path $codexDir "config.toml"

# Update .env
$envContent = ""
If (Test-Path $envFile) { $envContent = Get-Content -Raw -Path $envFile }
If ($envContent -match '(?m)^CODEX_PROXY_KEY\\s*=.*') {
    $envContent = $envContent -replace '(?m)^CODEX_PROXY_KEY\\s*=.*', "CODEX_PROXY_KEY=\`"$proxyKey\`""
} Else {
    $envContent = "$($envContent.Trim())\`r\`nCODEX_PROXY_KEY=\`"$proxyKey\`"\`r\`n"
}
[System.IO.File]::WriteAllText($envFile, $envContent.Trim() + "\`r\`n", [System.Text.Encoding]::UTF8)

# Update config.toml
$configContent = ""
If (Test-Path $configFile) { $configContent = Get-Content -Raw -Path $configFile }
$configContent = $configContent -replace '(?s)\\[model_providers\\.deepseek_proxy\\][^\\[]*', ''
$block = @"
[model_providers.se_aiproxy]
name = "SE-AiProxy"
base_url = "http://$($targetHost):$($targetPort)/openai/v1"
wire_api = "responses"
env_key = "CODEX_PROXY_KEY"
"@

If ($configContent -match '(?s)\\[model_providers\\.se_aiproxy\\][^\\[]*') {
    $configContent = $configContent -replace '(?s)\\[model_providers\\.se_aiproxy\\][^\\[]*', ($block + "\`r\`n")
} Else {
    $configContent = $configContent.TrimEnd() + "\`r\`n\`r\`n" + $block + "\`r\`n"
}

If ($configContent -match '(?m)^model\\s*=.*') {
    $configContent = $configContent -replace '(?m)^model\\s*=.*', 'model = "se-aiproxy-reasoner"'
} Else {
    $configContent = "model = \`"se-aiproxy-reasoner\`"\`r\`n" + $configContent
}

If ($configContent -match '(?m)^model_provider\\s*=.*') {
    $configContent = $configContent -replace '(?m)^model_provider\\s*=.*', 'model_provider = "se_aiproxy"'
} Else {
    $configContent = "model_provider = \`"se_aiproxy\`"\`r\`n" + $configContent
}

[System.IO.File]::WriteAllText($configFile, $configContent.Trim() + "\`r\`n", [System.Text.Encoding]::UTF8)

try {
    [Environment]::SetEnvironmentVariable("CODEX_PROXY_KEY", $proxyKey, "User")
} catch {}

Write-Host ""
Write-Host "✅ Codex successfully configured to use DeepSeek Proxy!" -ForegroundColor Green
Write-Host "   Config: $configFile" -ForegroundColor Green
Write-Host "   Auth:   $envFile" -ForegroundColor Green
Write-Host "🚀 You can now run 'codex' in your PowerShell." -ForegroundColor Green
`;

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(psScript);
});

// -------------------------------------------------------------
// OpenAI Compatible APIs
// -------------------------------------------------------------

// Health check
app.get(['/health', '/openai/health', '/anthropic/health'], (_req, res) => {
  const healthyCount = tokenPool.countAvailable();
  res.json({
    status: 'ok',
    proxy: 'SE-AiProxy',
    vendor: 'shirazelectronic',
    website: 'https://shirazelectronic.ir',
    version: PROXY_VERSION,
    pool: {
      total: tokenPool.tokens.length,
      active: healthyCount
    },
    timestamp: new Date().toISOString()
  });
});

// Download TLS certificate (for importing into Windows/macOS trusted root store)
app.get(['/server.crt', '/api/cert', '/api/certificate'], (_req, res) => {
  const crtPath = path.join(DATA_DIR, 'certs', 'server.crt');
  if (fs.existsSync(crtPath)) {
    res.setHeader('Content-Type', 'application/x-x509-ca-cert');
    res.setHeader('Content-Disposition', 'attachment; filename="server.crt"');
    return res.sendFile(crtPath);
  }
  res.status(404).send('Certificate not generated yet.');
});

// Models list (Compatible with both OpenAI and Anthropic Gateway Discovery)
const MODELS = [
  // Provider-neutral ids: the proxy picks the account; "reasoner" turns on deeper thinking
  { id: 'se-aiproxy-reasoner', type: 'model', object: 'model', display_name: 'SE-AiProxy Reasoner', created: 1794000000, created_at: '2026-11-08T00:00:00Z', owned_by: 'se-aiproxy' },
  { id: 'se-aiproxy', type: 'model', object: 'model', display_name: 'SE-AiProxy Fast', created: 1794000000, created_at: '2026-11-08T00:00:00Z', owned_by: 'se-aiproxy' },
  { id: 'claude-3-7-sonnet-20250219[1m]', type: 'model', object: 'model', display_name: 'Claude 3.7 Sonnet (1M Context)', created: 1740000000, created_at: '2025-02-19T00:00:00Z', owned_by: 'anthropic' },
  { id: 'claude-3-7-sonnet-20250219', type: 'model', object: 'model', display_name: 'Claude 3.7 Sonnet', created: 1740000000, created_at: '2025-02-19T00:00:00Z', owned_by: 'anthropic' },
  { id: 'claude-3-5-sonnet-20241022[1m]', type: 'model', object: 'model', display_name: 'Claude 3.5 Sonnet (1M Context)', created: 1729555200, created_at: '2024-10-22T00:00:00Z', owned_by: 'anthropic' },
  { id: 'claude-3-5-sonnet-20241022', type: 'model', object: 'model', display_name: 'Claude 3.5 Sonnet', created: 1729555200, created_at: '2024-10-22T00:00:00Z', owned_by: 'anthropic' },
  { id: 'sonnet[1m]', type: 'model', object: 'model', display_name: 'Sonnet (1M Context Window)', created: 1729555200, created_at: '2024-10-22T00:00:00Z', owned_by: 'anthropic' },
  { id: 'claude-3-5-haiku-20241022', type: 'model', object: 'model', display_name: 'Claude 3.5 Haiku', created: 1729555200, created_at: '2024-10-22T00:00:00Z', owned_by: 'anthropic' },
  { id: 'claude-3-opus-20240229', type: 'model', object: 'model', display_name: 'Claude 3 Opus', created: 1709164800, created_at: '2024-02-29T00:00:00Z', owned_by: 'anthropic' },
  { id: 'deepseek-reasoner[1m]', type: 'model', object: 'model', display_name: 'DeepSeek Reasoner R1 (1M Context)', created: 1700000000, created_at: '2024-01-01T00:00:00Z', owned_by: 'deepseek' },
  { id: 'deepseek-reasoner', type: 'model', object: 'model', display_name: 'DeepSeek Reasoner (R1)', created: 1700000000, created_at: '2024-01-01T00:00:00Z', owned_by: 'deepseek' },
  { id: 'deepseek-chat[1m]', type: 'model', object: 'model', display_name: 'DeepSeek Chat V3 (1M Context)', created: 1700000000, created_at: '2024-01-01T00:00:00Z', owned_by: 'deepseek' },
  { id: 'deepseek-chat', type: 'model', object: 'model', display_name: 'DeepSeek Chat (V3)', created: 1700000000, created_at: '2024-01-01T00:00:00Z', owned_by: 'deepseek' },
  { id: 'gpt-4o', type: 'model', object: 'model', display_name: 'GPT-4o', created: 1700000000, created_at: '2024-01-01T00:00:00Z', owned_by: 'se-aiproxy' },
  { id: 'gpt-4o-mini', type: 'model', object: 'model', display_name: 'GPT-4o Mini', created: 1700000000, created_at: '2024-01-01T00:00:00Z', owned_by: 'se-aiproxy' }
];

app.get([
  '/anthropic/v1/models',
  '/anthropic/models',
  '/v1/models',
  '/models',
  '/openai/v1/models',
  '/openai/models'
], (_req, res) => {
  res.json({
    data: MODELS,
    object: 'list',
    has_more: false,
    first_id: MODELS[0].id,
    last_id: MODELS[MODELS.length - 1].id
  });
});

app.get([
  '/anthropic/v1/models/:model',
  '/anthropic/models/:model',
  '/v1/models/:model',
  '/models/:model',
  '/openai/v1/models/:model',
  '/openai/models/:model'
], (req, res) => {
  const modelId = req.params.model;
  const found = MODELS.find(m => m.id === modelId);
  if (found) {
    return res.json(found);
  }
  res.json({
    id: modelId,
    type: 'model',
    object: 'model',
    display_name: modelId,
    created: 1700000000,
    created_at: '2024-01-01T00:00:00Z',
    owned_by: 'se-aiproxy'
  });
});

// OpenAI Responses API (Used natively by OpenAI Codex CLI)
app.post(['/openai/v1/responses', '/openai/responses', '/v1/responses', '/responses'], requireToken, async (req, res) => {
  try {
    await handleResponsesRequest(req, res);
  } catch (error) {
    console.error('[Responses API Error]', error);
    if (!res.headersSent) {
      res.status(error.status || 500).json({
        error: {
          message: error.message || 'Internal proxy error',
          type: error.name || 'api_error',
          code: error.code || 'internal_error'
        }
      });
    }
  }
});

// OpenAI Chat Completions API (Used by VSCode plugins, Cursor, Continue, etc.)
app.post(['/openai/v1/chat/completions', '/openai/chat/completions', '/v1/chat/completions', '/chat/completions', '/v1/chat/completions/:sessionId'], requireToken, async (req, res) => {
  try {
    await handleChatCompletionRequest(req, res);
  } catch (error) {
    console.error('[Chat Completions Error]', error);
    if (!res.headersSent) {
      res.status(error.status || 500).json({
        error: {
          message: error.message || 'Internal proxy error',
          type: error.name || 'api_error',
          code: error.code || 'internal_error'
        }
      });
    }
  }
});

// Anthropic Messages API (Used natively by Claude Code CLI & Anthropic Gateway)
app.get(['/anthropic/v1/messages', '/anthropic/messages', '/v1/messages', '/messages'], (_req, res) => {
  res.json({
    status: 'ok',
    message: 'Anthropic Messages API is active. Send POST requests to this endpoint for inference.',
    docs: 'https://docs.anthropic.com/en/api/messages'
  });
});

app.post(['/anthropic/v1/messages', '/anthropic/messages', '/v1/messages', '/messages'], requireToken, async (req, res) => {
  try {
    await handleAnthropicMessagesRequest(req, res);
  } catch (error) {
    console.error('[Anthropic Messages Error]', error);
    if (!res.headersSent) {
      res.status(error.status || 500).json({
        type: 'error',
        error: {
          type: error.name || 'api_error',
          message: error.message || 'Internal proxy error'
        }
      });
    }
  }
});

// JSON parse errors and other middleware failures: answer in OpenAI error shape instead of HTML
app.use((err, _req, res, _next) => {
  console.error('[Express Error]', err.message);
  if (res.headersSent) return res.end();
  res.status(err.status || err.statusCode || 500).json({
    error: {
      message: err.message || 'Internal proxy error',
      type: err.type || 'api_error',
      code: err.code || 'internal_error'
    }
  });
});

process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]', reason);
});

const flushAndExit = () => {
  tokenPool.save();
  process.exit(0);
};
process.on('SIGINT', flushAndExit);
process.on('SIGTERM', flushAndExit);

const tlsCredentials = getOrCreateTlsCertificate(DATA_DIR);

const httpServer = http.createServer(app);
httpServer.listen(PORT, HOST, () => {
  console.log(`====================================================`);
  console.log(`  🚀 SE-AiProxy v${PROXY_VERSION} is running!`);
  console.log(`  🏷️  Developed & provided by shirazelectronic — https://shirazelectronic.ir`);
  if (process.env.NODE_ENV !== 'test') tokenPool.backfillIdentities().catch(() => {});
  console.log(`  🌐 Web UI Dashboard: http://${HOST}:${PORT}`);
  console.log(`  🤖 Codex / OpenAI:   http://${HOST}:${PORT}/openai/v1`);
  console.log(`  🧠 Claude / Anthropic: http://${HOST}:${PORT}/anthropic`);
  console.log(`  📋 Health Check:     http://${HOST}:${PORT}/health`);
  console.log(`  📝 Log file:         ${LOG_FILE}`);
  console.log(`  🔐 Remote dashboard access needs the admin key (adminKey in data/config.json or ADMIN_KEY in .env)`);
  if (tlsCredentials) {
    try {
      const httpsServer = https.createServer({
        key: tlsCredentials.key,
        cert: tlsCredentials.cert
      }, app);
      httpsServer.listen(HTTPS_PORT, HOST, () => {
        console.log(`  🔒 HTTPS Server:     https://${HOST}:${HTTPS_PORT}`);
        console.log(`     (Claude Code TLS: https://${HOST}:${HTTPS_PORT}/anthropic)`);
        console.log(`====================================================`);
      });
    } catch (e) {
      console.warn('[TLS] Could not start HTTPS listener:', e.message);
      console.log(`====================================================`);
    }
  } else {
    console.log(`====================================================`);
  }
});
