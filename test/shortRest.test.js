import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shortRestWaitMs, isPauseReason, SHORT_REST_MAX_MS } from '../src/responsesAdapter.js';
import { AccountBudgetError } from '../src/webAccountPolicy.js';

describe('short rest instead of failover', () => {
  const now = 1_000_000;
  const web = (extra) => ({ id: 'w', type: 'deepseek_web', status: 'rate_limited', ...extra });

  test('waits out a short pause on a DeepSeek Web account', () => {
    assert.equal(shortRestWaitMs(web({ rateLimitedUntil: now + 7000 }), now), 7000);
  });

  test('waits out a short pause on a Kimi Web account', () => {
    assert.equal(shortRestWaitMs(web({ type: 'kimi_web', rateLimitedUntil: now + 3000 }), now), 3000);
  });

  test('a long rest (hourly new-chat budget) still fails over', () => {
    assert.equal(shortRestWaitMs(web({ rateLimitedUntil: now + 2000 * 1000 }), now), 0);
    assert.equal(shortRestWaitMs(web({ rateLimitedUntil: now + SHORT_REST_MAX_MS + 1 }), now), 0);
  });

  test('never waits on invalid, disabled or API accounts, or one that is not resting', () => {
    assert.equal(shortRestWaitMs(web({ status: 'invalid', rateLimitedUntil: now + 5000 }), now), 0);
    assert.equal(shortRestWaitMs(web({ status: 'disabled', rateLimitedUntil: now + 5000 }), now), 0);
    assert.equal(shortRestWaitMs(web({ type: 'chabokan', rateLimitedUntil: now + 5000 }), now), 0);
    assert.equal(shortRestWaitMs(web({ rateLimitedUntil: now - 1 }), now), 0);
    assert.equal(shortRestWaitMs(null, now), 0);
  });

  test('budget, throttle and busy reasons count as a pause; a challenge does not', () => {
    assert.ok(isPauseReason(new AccountBudgetError(5000, 'completion').message));
    assert.ok(isPauseReason('Usage budget reached (completion); resting to avoid suspension'));
    assert.ok(isPauseReason('Messages too frequent, please try again later'));
    assert.ok(isPauseReason('Server is busy'));
    assert.ok(!isPauseReason('CHALLENGE_REQUIRED'));
    assert.ok(!isPauseReason('Authorization Failed (invalid token)'));
    assert.ok(!isPauseReason(undefined));
  });

  test('the budget message no longer names DeepSeek (Kimi accounts use it too)', () => {
    assert.match(new AccountBudgetError(1000, 'completion').message, /^Web account is resting/);
  });
});

describe('CHALLENGE_REQUIRED parks the account briefly', () => {
  test('first challenge parks 30 s, repeats never past 1 minute', async () => {
    const { tokenPool } = await import('../src/tokenPool.js');
    const { penalizeAccount, CHALLENGE_MIN_COOLDOWN_MS } = await import('../src/accountHealth.js');
    tokenPool.tokens = [{ id: 'c1', label: 'c1', type: 'deepseek_web', token: 'challenge-test-token', status: 'active', rateLimitedUntil: 0 }];
    const parked = () => tokenPool.tokens[0].rateLimitedUntil - Date.now();
    penalizeAccount('c1', new Error('CHALLENGE_REQUIRED'));
    assert.ok(parked() > CHALLENGE_MIN_COOLDOWN_MS - 2000 && parked() <= CHALLENGE_MIN_COOLDOWN_MS);
    for (let i = 0; i < 6; i++) penalizeAccount('c1', new Error('CHALLENGE_REQUIRED'));
    assert.ok(parked() <= 60000);
  });
});
