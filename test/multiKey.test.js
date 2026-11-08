import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import tokenPool, { ensureKeys, sessionKeyMatches, splitKeys } from '../src/tokenPool.js';
import { penalizeAccount } from '../src/accountHealth.js';
import { AccountBudgetError } from '../src/webAccountPolicy.js';

// Builds a pool account with the given keys straight in memory (no live test)
function account(id, keys, extra = {}) {
  const t = ensureKeys({
    id,
    type: 'chabokan',
    label: id,
    priority: 1,
    role: 'all',
    status: 'active',
    rateLimitedUntil: 0,
    keys: keys.map((token, i) => ({ id: `${id}_k${i + 1}`, token, status: 'active', rateLimitedUntil: 0 })),
    ...extra
  });
  return t;
}

describe('several keys per account', () => {
  beforeEach(() => {
    tokenPool.tokens = [];
  });

  test('a legacy single-token account becomes a one-key account', () => {
    const t = ensureKeys({ id: 'a', token: 'sk-legacy', status: 'active' });
    assert.equal(t.keys.length, 1);
    assert.equal(t.keys[0].token, 'sk-legacy');
    assert.equal(t.activeKeyId, t.keys[0].id);
    assert.equal(t.token, 'sk-legacy');
  });

  test('a rate-limited key switches the account to its next key and keeps it available', () => {
    const t = account('a', ['key-1', 'key-2', 'key-3']);
    tokenPool.tokens = [t];
    const switched = tokenPool.markTokenRateLimited('a', 60_000, 'HTTP 429');
    assert.equal(switched, true);
    assert.equal(t.token, 'key-2');
    assert.equal(t.status, 'active');
    assert.equal(t.rateLimitedUntil, 0);
    assert.equal(t.keys[0].status, 'rate_limited');
    assert.equal(tokenPool.selectAccountForTurn({}).account.id, 'a');
  });

  test('an invalid key is skipped for the next one; the account stays active', () => {
    const t = account('a', ['key-1', 'key-2']);
    tokenPool.tokens = [t];
    assert.equal(tokenPool.markTokenInvalid('a', '401 Unauthorized'), true);
    assert.equal(t.token, 'key-2');
    assert.equal(t.status, 'active');
    assert.equal(t.keys[0].status, 'invalid');
  });

  test('when every key is down the account is parked on the key that recovers first', () => {
    const t = account('a', ['key-1', 'key-2']);
    tokenPool.tokens = [t];
    const now = Date.now();
    tokenPool.markTokenRateLimited('a', 120_000, 'busy'); // key-1 out for 2 min -> key-2
    assert.equal(t.token, 'key-2');
    assert.equal(tokenPool.markTokenRateLimited('a', 600_000, 'busy'), false); // key-2 out for 10 min
    assert.equal(t.token, 'key-1');
    assert.equal(t.status, 'rate_limited');
    assert.ok(t.rateLimitedUntil >= now + 110_000 && t.rateLimitedUntil <= now + 130_000);
  });

  test('all keys invalid marks the account invalid', () => {
    const t = account('a', ['key-1', 'key-2']);
    tokenPool.tokens = [t];
    tokenPool.markTokenInvalid('a', '401');
    assert.equal(tokenPool.markTokenInvalid('a', '401'), false);
    assert.equal(t.status, 'invalid');
  });

  test('an invalid key with another key only resting parks the account instead of invalidating it', () => {
    const t = account('a', ['key-1', 'key-2']);
    tokenPool.tokens = [t];
    tokenPool.markTokenRateLimited('a', 60_000, 'busy'); // -> key-2
    tokenPool.markTokenInvalid('a', '401'); // key-2 dead, key-1 resting
    assert.equal(t.status, 'rate_limited');
    assert.equal(t.token, 'key-1');
  });

  test('a single-key account behaves as before', () => {
    const t = account('a', ['only']);
    tokenPool.tokens = [t];
    assert.equal(tokenPool.markTokenRateLimited('a', 30_000, 'busy'), false);
    assert.equal(t.status, 'rate_limited');
    assert.ok(t.rateLimitedUntil > Date.now());
  });

  test('penalizeAccount reports a key switch so the caller retries the same account', () => {
    const t = account('a', ['key-1', 'key-2']);
    tokenPool.tokens = [t, account('b', ['other'], { priority: 2 })];
    const err = Object.assign(new Error('HTTP 429: rate limit'), { status: 429 });
    assert.equal(penalizeAccount('a', err), true);
    assert.equal(t.token, 'key-2');
    assert.equal(penalizeAccount('a', err), false);
    assert.equal(t.status, 'rate_limited');
    assert.equal(tokenPool.selectAccountForTurn({}).account.id, 'b');
  });

  test('a DeepSeek Web budget pause moves on to the next key', () => {
    const t = account('w', ['ds-1', 'ds-2'], { type: 'deepseek_web' });
    tokenPool.tokens = [t];
    assert.equal(penalizeAccount('w', new AccountBudgetError(90_000, 'completion')), true);
    assert.equal(t.token, 'ds-2');
  });

  test('a chat opened on one key is not continued on another', () => {
    const t = account('w', ['ds-1', 'ds-2'], { type: 'deepseek_web' });
    tokenPool.tokens = [t];
    const session = { tokenId: 'w', keyId: t.activeKeyId };
    assert.ok(sessionKeyMatches(session, t));
    tokenPool.markTokenRateLimited('w', 60_000, 'busy');
    assert.ok(!sessionKeyMatches(session, t));
  });

  test('removing, using and reordering keys', () => {
    const t = account('a', ['key-1', 'key-2', 'key-3']);
    tokenPool.tokens = [t];
    tokenPool.save = () => {};
    tokenPool.useKey('a', 'a_k3');
    assert.equal(t.token, 'key-3');
    tokenPool.moveKey('a', 'a_k3', -1);
    assert.deepEqual(t.keys.map(k => k.token), ['key-1', 'key-3', 'key-2']);
    tokenPool.removeKey('a', 'a_k3');
    assert.equal(t.keys.length, 2);
    assert.notEqual(t.token, 'key-3');
    tokenPool.removeKey('a', 'a_k1');
    tokenPool.removeKey('a', 'a_k2');
    assert.equal(t.token, '');
    assert.equal(t.status, 'disabled');
    delete tokenPool.save;
  });

  test('every key is listed masked, and every key is redacted from logs', () => {
    const t = account('a', ['sk-aaaaaaaaaaaaaaaaaaaa', 'sk-bbbbbbbbbbbbbbbbbbbb']);
    tokenPool.tokens = [t];
    const [row] = tokenPool.getTokens();
    assert.equal(row.keyCount, 2);
    assert.equal(row.activeKeyIndex, 1);
    assert.ok(row.keys.every(k => k.token.includes('...')));
    assert.ok(tokenPool.getSecrets().includes('sk-bbbbbbbbbbbbbbbbbbbb'));
    assert.equal(tokenPool.countKeys(), 2);
  });

  test('the retry after a key switch stays on that account even while it counts as busy', () => {
    // Same priority, the switching account still holds the in-flight request that just failed
    const web = account('w', ['ds-1', 'ds-2'], { type: 'deepseek_web', priority: 2, activeRequests: 1, lastUsed: Date.now() });
    const peer = account('n', ['nv'], { type: 'nvidia', priority: 2, activeRequests: 0, lastUsed: 0 });
    tokenPool.tokens = [web, peer];
    const switched = penalizeAccount('w', new Error('CHALLENGE_REQUIRED'));
    assert.equal(switched, true);
    assert.equal(web.token, 'ds-2');
    // Plain load balancing would pick the idle peer: this is what sent the retry to NVIDIA
    assert.equal(tokenPool.selectAccountForTurn({ conversationKey: 'c1' }).account.id, 'n');
    assert.equal(tokenPool.selectAccountForTurn({ conversationKey: 'c1', preferId: 'w' }).account.id, 'w');
  });

  test('preferId is ignored once that account is excluded or parked', () => {
    const web = account('w', ['ds-1'], { type: 'deepseek_web', priority: 2 });
    const peer = account('n', ['nv'], { type: 'nvidia', priority: 2 });
    tokenPool.tokens = [web, peer];
    assert.equal(tokenPool.selectAccountForTurn({ preferId: 'w', excludeIds: new Set(['w']) }).account.id, 'n');
    tokenPool.markTokenRateLimited('w', 60_000, 'busy');
    assert.equal(tokenPool.selectAccountForTurn({ preferId: 'w' }).account.id, 'n');
  });

  test('keys are split one per line', () => {
    assert.deepEqual(splitKeys(' a \n\nb\r\nc '), ['a', 'b', 'c']);
    assert.deepEqual(splitKeys(['a\nb', 'c']), ['a', 'b', 'c']);
  });
});
