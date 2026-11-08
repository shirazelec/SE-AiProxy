import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDER_PRESETS } from '../src/providerPresets.js';
import { tokenPool } from '../src/tokenPool.js';

describe('Unified Provider Accounts Pool', () => {
  test('has all provider presets configured', () => {
    assert.ok(PROVIDER_PRESETS.moonmath);
    assert.ok(PROVIDER_PRESETS.tokenharbor);
    assert.ok(PROVIDER_PRESETS.google);
    assert.ok(PROVIDER_PRESETS.deepseek_web);
    assert.ok(PROVIDER_PRESETS.deepseek_api);
    assert.strictEqual(PROVIDER_PRESETS.deepseek_api.baseUrl, 'https://api.deepseek.com/v1');
    assert.strictEqual(PROVIDER_PRESETS.deepseek_api.protocol, 'chat_completions');
    assert.ok(PROVIDER_PRESETS.kimi_web);
    assert.ok(PROVIDER_PRESETS.openai_custom);

    assert.strictEqual(PROVIDER_PRESETS.moonmath.protocol, 'responses');
    assert.strictEqual(PROVIDER_PRESETS.tokenharbor.protocol, 'chat_completions');
    assert.strictEqual(PROVIDER_PRESETS.google.protocol, 'chat_completions');
    assert.strictEqual(PROVIDER_PRESETS.google.model, 'gemini-3.5-flash-lite');
    assert.strictEqual(PROVIDER_PRESETS.deepseek_web.protocol, 'deepseek_web');
    assert.strictEqual(PROVIDER_PRESETS.kimi_web.protocol, 'kimi_web');
  });

  test('masks tokens/API keys properly in getTokens(true)', () => {
    // Tests run on an empty temp pool (test/setup.js), so add fixtures of both key lengths
    tokenPool.tokens = [
      { id: 'acc_long', type: 'tokenharbor', token: 'thk_test_0123456789abcdefghij', status: 'active' },
      { id: 'acc_short', type: 'google', token: 'short-key', status: 'active' }
    ];
    const list = tokenPool.getTokens(true);
    assert.equal(list.length, 2);
    for (const item of list) {
      if (item.token) {
        assert.ok(item.token.includes('...') || item.token === '••••••••');
      }
    }
  });

  test('smart routing selects highest priority available account and fails over', () => {
    // Mock accounts in pool
    tokenPool.tokens = [
      { id: 'acc_moon_1', type: 'moonmath', priority: 1, status: 'rate_limited', rateLimitedUntil: Date.now() + 60000, totalRequests: 0, activeRequests: 0 },
      { id: 'acc_th_1', type: 'tokenharbor', priority: 2, status: 'active', rateLimitedUntil: 0, totalRequests: 5, activeRequests: 1 },
      { id: 'acc_th_2', type: 'tokenharbor', priority: 2, status: 'active', rateLimitedUntil: 0, totalRequests: 0, activeRequests: 0 },
      { id: 'acc_goog_1', type: 'google', priority: 3, status: 'active', rateLimitedUntil: 0, totalRequests: 0, activeRequests: 0 }
    ];

    // Priority 1 is rate-limited. Between acc_th_1 (busy) and acc_th_2 (idle), acc_th_2 should be picked
    const sel1 = tokenPool.selectAccountForTurn();
    assert.strictEqual(sel1.account.id, 'acc_th_2');

    // If acc_th_2 is excluded, acc_th_1 should be picked
    const sel2 = tokenPool.selectAccountForTurn({ excludeIds: new Set(['acc_th_2']) });
    assert.strictEqual(sel2.account.id, 'acc_th_1');

    // If both TokenHarbor accounts are excluded, Google should be picked
    const sel3 = tokenPool.selectAccountForTurn({ excludeIds: new Set(['acc_th_1', 'acc_th_2']) });
    assert.strictEqual(sel3.account.id, 'acc_goog_1');
  });

  test('records usage and clears rate-limited status after expiry', () => {
    const acc = {
      id: 'acc_test_rec',
      type: 'moonmath',
      status: 'rate_limited',
      rateLimitedUntil: Date.now() - 1000,
      totalRequests: 2
    };
    tokenPool.tokens.push(acc);
    tokenPool.recordUsage('acc_test_rec');

    const found = tokenPool.getFullToken('acc_test_rec');
    assert.strictEqual(found.totalRequests, 3);
    assert.strictEqual(found.status, 'active');
  });

  test('Cloudflare WAF 403 provider-wide exclusion jumps to alternate provider', () => {
    tokenPool.tokens = [
      { id: 'acc_th_1', type: 'tokenharbor', priority: 2, status: 'active', rateLimitedUntil: 0 },
      { id: 'acc_th_2', type: 'tokenharbor', priority: 2, status: 'active', rateLimitedUntil: 0 },
      { id: 'acc_th_3', type: 'tokenharbor', priority: 2, status: 'active', rateLimitedUntil: 0 },
      { id: 'acc_goog_1', type: 'google', priority: 3, status: 'active', rateLimitedUntil: 0 }
    ];

    const currentToken = tokenPool.tokens[0];
    const excludeIds = new Set();
    const mockErr = new Error('elecoman92@gmail.com HTTP 403: <!DOCTYPE html><html lang="en">');
    mockErr.status = 403;

    // Simulate WAF exclusion logic from responsesAdapter.js
    if (mockErr.status === 403 || /<html|<!doctype|403/i.test(mockErr.message)) {
      for (const tok of tokenPool.tokens) {
        if (tok.type === currentToken.type) {
          excludeIds.add(tok.id);
        }
      }
    }

    assert.equal(excludeIds.size, 3);
    assert.ok(excludeIds.has('acc_th_1'));
    assert.ok(excludeIds.has('acc_th_2'));
    assert.ok(excludeIds.has('acc_th_3'));

    // Next selection skips ALL tokenharbor accounts and picks Google Gemini immediately
    const sel = tokenPool.selectAccountForTurn({ excludeIds });
    assert.strictEqual(sel.account.id, 'acc_goog_1');
  });
});

describe('Pool load balancing and quota handling', () => {
  test('API accounts rotate per turn instead of sticking to one conversation', () => {
    tokenPool.tokens = [
      { id: 'a1', type: 'tokenharbor', priority: 2, status: 'active', rateLimitedUntil: 0, lastUsed: 0 },
      { id: 'a2', type: 'tokenharbor', priority: 2, status: 'active', rateLimitedUntil: 0, lastUsed: 0 },
      { id: 'a3', type: 'chabokan', priority: 2, status: 'active', rateLimitedUntil: 0, lastUsed: 0 }
    ];
    const picked = new Set();
    for (let i = 0; i < 3; i++) picked.add(tokenPool.selectAccountForTurn({ conversationKey: 'conv_lb' }).account.id);
    assert.equal(picked.size, 3);
  });

  test('does not fall back to accounts parked for a long quota reset', () => {
    const later = Date.now() + 6 * 24 * 3600 * 1000;
    tokenPool.tokens = [
      { id: 'q1', type: 'tokenharbor', label: 'q1', priority: 2, status: 'rate_limited', rateLimitedUntil: later },
      { id: 'q2', type: 'tokenharbor', label: 'q2', priority: 2, status: 'rate_limited', rateLimitedUntil: later + 1000 }
    ];
    assert.throws(() => tokenPool.selectAccountForTurn(), (err) => err.status === 429 && err.allExhausted === true);

    // An account that is about to recover is still used as a fallback
    tokenPool.tokens.push({ id: 'q3', type: 'tokenharbor', priority: 2, status: 'rate_limited', rateLimitedUntil: Date.now() + 10000 });
    assert.equal(tokenPool.selectAccountForTurn().account.id, 'q3');
  });

  test('chabokan preset is an OpenAI-compatible provider', () => {
    assert.equal(PROVIDER_PRESETS.chabokan.protocol, 'chat_completions');
    assert.equal(PROVIDER_PRESETS.chabokan.baseUrl, 'https://ai.chabokan.net/v1');
  });
});

describe('Quota reset parsing', async () => {
  const { quotaCooldownMs } = await import('../src/accountHealth.js');
  test('parses the rolling 7-day period reset time', () => {
    const ms = quotaCooldownMs("You've used this period's free allowance. Your next rolling 7-day period starts on 10 Nov 2030 at 20:20 UTC.");
    assert.ok(ms > 24 * 3600 * 1000);
  });
});
