import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CODEX_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-dir-'));

import { generateCodexToml, configureCodex } from '../src/codexInstaller.js';

test('generateCodexToml', async (t) => {
  await t.test('generates default TOML with 127.0.0.1 and port 18789', () => {
    const toml = generateCodexToml();
    assert.match(toml, /base_url = "http:\/\/127\.0\.0\.1:18789\/openai\/v1"/);
    assert.match(toml, /model = "se-aiproxy-reasoner"/);
    assert.match(toml, /name = "SE-AiProxy"/);
    assert.match(toml, /model_provider = "se_aiproxy"/);
    assert.match(toml, /model_context_window = 1048576/);
    assert.match(toml, /model_auto_compact_token_limit = 400000/);
  });

  await t.test('maps localhost to 127.0.0.1', () => {
    const toml = generateCodexToml({ host: 'localhost', port: 18789 });
    assert.match(toml, /base_url = "http:\/\/127\.0\.0\.1:18789\/openai\/v1"/);
  });

  await t.test('uses remote IP address when provided', () => {
    const toml = generateCodexToml({ host: '192.168.1.6', port: 18789 });
    assert.match(toml, /base_url = "http:\/\/192\.168\.1\.6:18789\/openai\/v1"/);
  });

  await t.test('uses custom domain and port', () => {
    const toml = generateCodexToml({ host: 'proxy.internal.net', port: 9090 });
    assert.match(toml, /base_url = "http:\/\/proxy\.internal\.net:9090\/openai\/v1"/);
  });

  await t.test('respects custom context window limits', () => {
    const toml = generateCodexToml({ contextWindow: 500000, autoCompactLimit: 250000 });
    assert.match(toml, /model_context_window = 500000/);
    assert.match(toml, /model_auto_compact_token_limit = 250000/);
  });
});

test('configureCodex with custom host', async (t) => {
  await t.test('returns configured host and port', async () => {
    const res = await configureCodex({ host: '192.168.1.6', port: 18789 });
    assert.equal(res.ok, true);
    assert.equal(res.host, '192.168.1.6');
    assert.equal(res.port, 18789);

    // Verify written config.toml has 192.168.1.6 and /openai/v1
    const written = fs.readFileSync(res.configPath, 'utf8');
    assert.match(written, /base_url = "http:\/\/192\.168\.1\.6:18789\/openai\/v1"/);

    // Revert back to 192.168.1.6 for consistency
    const revert = await configureCodex({ host: '192.168.1.6', port: 18789 });
    assert.equal(revert.ok, true);
    const reverted = fs.readFileSync(revert.configPath, 'utf8');
    assert.match(reverted, /base_url = "http:\/\/192\.168\.1\.6:18789\/openai\/v1"/);
  });
});

test('configureCodex replaces the pre-3.0 deepseek_proxy provider', async () => {
  assert.ok(!os.homedir().startsWith('/home/') || os.homedir().includes('ds-proxy-home-'), 'tests must not use the real home');
  const configPath = path.join(process.env.CODEX_DIR, 'config.toml');
  fs.writeFileSync(configPath, `model = "deepseek-reasoner"
model_provider = "deepseek_proxy"

[model_providers.deepseek_proxy]
name = "DeepSeek Web Chat Proxy"
base_url = "http://127.0.0.1:18789/openai/v1"
wire_api = "responses"
env_key = "CODEX_PROXY_KEY"

[desktop]
appearanceTheme = "dark"
`);
  await configureCodex({ host: '127.0.0.1', port: 18789 });
  const written = fs.readFileSync(configPath, 'utf8');
  assert.doesNotMatch(written, /deepseek_proxy|DeepSeek Web Chat Proxy/);
  assert.match(written, /^model_provider = "se_aiproxy"$/m);
  assert.match(written, /^model = "se-aiproxy-reasoner"$/m);
  assert.match(written, /\[model_providers\.se_aiproxy\]\nname = "SE-AiProxy"/);
  assert.match(written, /appearanceTheme = "dark"/);
  assert.equal(written.match(/\[model_providers\./g).length, 1);
  // Top-level keys must come before the first table, or TOML puts them inside it
  assert.ok(written.indexOf('model_provider =') < written.indexOf('['));
  assert.ok(written.indexOf('model =') < written.indexOf('['));
});
