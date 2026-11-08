import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import tokenPool from '../src/tokenPool.js';
import {
  penalizeAccount, isProviderWideOverload, kimiOverloadCooldownMs, resetKimiOverload,
  KIMI_OVERLOAD_BASE_MS, KIMI_OVERLOAD_MAX_MS
} from '../src/accountHealth.js';

const overload = () => {
  const err = new Error('Kimi resource_exhausted (REASON_SERVER_OVERLOADED_FOR_FREE_USER): Too many people are chatting with Kimi');
  err.status = 429;
  err.kimiReason = 'REASON_SERVER_OVERLOADED_FOR_FREE_USER';
  return err;
};
const kimi = (id, extra = {}) => ({ id, label: id, type: 'kimi_web', token: `rt-${id}`, status: 'active', rateLimitedUntil: 0, ...extra });

describe('Kimi-wide server overload', () => {
  beforeEach(() => resetKimiOverload());

  test('is recognised only for the server-overload reason', () => {
    assert.equal(isProviderWideOverload(overload()), true);
    const other = new Error('Kimi resource_exhausted (REASON_RATE_LIMITED): slow down');
    other.kimiReason = 'REASON_RATE_LIMITED';
    assert.equal(isProviderWideOverload(other), false);
    assert.equal(isProviderWideOverload(null), false);
  });

  test('rests every usable Kimi account, not just the one that failed', () => {
    const later = Date.now() + 3600_000;
    tokenPool.tokens = [
      kimi('k1'), kimi('k2'),
      kimi('k3', { status: 'disabled' }),
      kimi('k4', { status: 'rate_limited', rateLimitedUntil: later }),
      { id: 'g1', label: 'g1', type: 'google', token: 'x', status: 'active', rateLimitedUntil: 0 }
    ];
    const before = Date.now();
    penalizeAccount('k1', overload());
    const byId = Object.fromEntries(tokenPool.tokens.map(t => [t.id, t]));
    for (const id of ['k1', 'k2']) {
      assert.equal(byId[id].status, 'rate_limited', id);
      assert.ok(byId[id].rateLimitedUntil >= before + KIMI_OVERLOAD_BASE_MS - 50, id);
    }
    assert.equal(byId.k3.status, 'disabled');
    assert.equal(byId.k4.rateLimitedUntil, later, 'a longer rest is never shortened');
    assert.equal(byId.g1.status, 'active', 'other providers are untouched');
  });

  test('backs off while the overload keeps going and resets after a quiet spell', () => {
    const t0 = 5_000_000_000;
    const seq = [0, 1, 2, 3, 4, 5].map(i => kimiOverloadCooldownMs(t0 + i * 1000));
    assert.deepEqual(seq, [20, 40, 80, 120, 120, 120].map(s => s * 1000));
    assert.ok(seq.every(ms => ms <= KIMI_OVERLOAD_MAX_MS));
    assert.equal(kimiOverloadCooldownMs(t0 + 5000 + 16 * 60000), KIMI_OVERLOAD_BASE_MS);
  });
});
