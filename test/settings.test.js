import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTopLevelTomlKey } from '../src/codexConfig.js';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-proxy-settings-'));
let normalizeSettings, tokenPool;

before(async () => {
  const mod = await import('../src/tokenPool.js');
  ({ normalizeSettings } = mod);
  tokenPool = mod.default;
});

describe('settings', () => {
  test('defaults target the 1M DeepSeek V4 window', () => {
    const { settings, errors } = normalizeSettings();
    assert.deepEqual(errors, []);
    assert.equal(settings.contextWindow, 1048576);
    assert.ok(settings.autoCompactLimit < settings.contextWindow);
  });

  test('rejects out-of-range values and compact >= window', () => {
    assert.ok(normalizeSettings({ contextWindow: 10 }).errors.length > 0);
    assert.ok(normalizeSettings({ contextWindow: 128000, autoCompactLimit: 200000 }).errors.length > 0);
  });

  test('updateSettings persists to config.json and keeps old values on error', () => {
    tokenPool.updateSettings({ contextWindow: 128000, autoCompactLimit: 100000 });
    const saved = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'config.json'), 'utf8'));
    assert.equal(saved.settings.contextWindow, 128000);
    assert.throws(() => tokenPool.updateSettings({ autoCompactLimit: 999999 }), /smaller than contextWindow/);
    assert.equal(tokenPool.getSettings().autoCompactLimit, 100000);
  });

  test('updateToken updates label and preserves token when token string omitted', async () => {
    tokenPool.tokens.push({
      id: 'tok_test123',
      token: 'dummy_token_abc_xyz',
      label: 'Original Label',
      status: 'active',
      rateLimitedUntil: 0
    });
    const updated = await tokenPool.updateToken('tok_test123', { label: 'New Label' });
    assert.equal(updated.label, 'New Label');
    assert.equal(tokenPool.getFullToken('tok_test123').label, 'New Label');
    assert.equal(tokenPool.getFullToken('tok_test123').token, 'dummy_token_abc_xyz');
  });

  test('testAllTokens tests all registered accounts and returns summary', async () => {
    const res = await tokenPool.testAllTokens();
    assert.equal(res.ok, true);
    assert.equal(typeof res.total, 'number');
    assert.equal(typeof res.active, 'number');
    assert.equal(typeof res.invalid, 'number');
    assert.equal(res.total, res.active + (res.rateLimited || 0) + res.invalid);
    assert.ok(Array.isArray(res.results));
  });
});

describe('setTopLevelTomlKey', () => {
  const toml = 'model = "x"\nmodel_context_window = 128000\n\n[profiles.a]\nmodel_context_window = 5\n';

  test('replaces an existing top-level key but not one inside a table', () => {
    const out = setTopLevelTomlKey(toml, 'model_context_window', 1048576);
    assert.match(out, /^model_context_window = 1048576$/m);
    assert.match(out, /\[profiles\.a\]\nmodel_context_window = 5/);
  });

  test('adds a missing key before the first table', () => {
    const out = setTopLevelTomlKey(toml, 'model_auto_compact_token_limit', 400000);
    assert.ok(out.indexOf('model_auto_compact_token_limit = 400000') < out.indexOf('[profiles.a]'));
  });

  test('works on empty and table-only files', () => {
    assert.equal(setTopLevelTomlKey('', 'k', 2), 'k = 2\n');
    assert.equal(setTopLevelTomlKey('[a]\nx=1\n', 'k', 2), 'k = 2\n\n[a]\nx=1\n');
  });
});
