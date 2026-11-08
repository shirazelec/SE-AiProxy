import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  configurePolicy, resetPolicyState, beforeRequest, budgetWaitMs, pacingDelayMs,
  recordThrottle, recordSuccess, hasHeadroom, usageSnapshot, AccountBudgetError
} from '../src/webAccountPolicy.js';
import { redact, setSecretProvider } from '../src/logger.js';

const settings = { webMinIntervalSec: 0, webJitterSec: 0, webMaxPerMinute: 3, webMaxPerHour: 5, webMaxPerDay: 8, webMaxSessionsPerHour: 2 };
const parked = [];
configurePolicy({ settingsProvider: () => settings, onCooldown: (token, ms) => parked.push({ token, ms }) });

describe('DeepSeek Web usage policy', () => {
  beforeEach(() => {
    resetPolicyState();
    parked.length = 0;
  });

  test('per-minute budget parks the account and hands off', async () => {
    for (let i = 0; i < 3; i++) await beforeRequest('tokA');
    await assert.rejects(beforeRequest('tokA'), err => err instanceof AccountBudgetError && err.retryAfterMs > 0 && err.retryAfterMs <= 60000);
    assert.equal(parked.length, 1);
    // Other accounts are unaffected
    await beforeRequest('tokB');
  });

  test('new-session budget is separate', async () => {
    await beforeRequest('tokD', 'session');
    await beforeRequest('tokD', 'session');
    await assert.rejects(beforeRequest('tokD', 'session'), AccountBudgetError);
    await beforeRequest('tokD', 'completion');
  });

  test('pacing adds the minimum gap plus jitter', async () => {
    const paced = { ...settings, webMinIntervalSec: 8, webJitterSec: 5 };
    configurePolicy({ settingsProvider: () => paced });
    await beforeRequest('tokE', 'session'); // sessions are not paced
    const now = Date.now();
    assert.equal(pacingDelayMs('tokE', now), 0);
    // simulate a request just now
    configurePolicy({ settingsProvider: () => ({ ...paced, webMinIntervalSec: 0, webJitterSec: 0 }) });
    await beforeRequest('tokE');
    configurePolicy({ settingsProvider: () => paced });
    const delayLow = pacingDelayMs('tokE', Date.now(), () => 0);
    const delayHigh = pacingDelayMs('tokE', Date.now(), () => 1);
    assert.ok(delayLow > 7000 && delayLow <= 8000, `low ${delayLow}`);
    assert.ok(delayHigh > 12000 && delayHigh <= 13000, `high ${delayHigh}`);
    configurePolicy({ settingsProvider: () => settings });
  });

  test('throttle warnings escalate briefly and a clean request forgives them', () => {
    assert.equal(recordThrottle('tokF'), 15000);
    assert.equal(recordThrottle('tokF'), 30000);
    assert.equal(recordThrottle('tokF'), 60000);
    assert.equal(usageSnapshot('tokF').strikes, 3);
    recordSuccess('tokF');
    assert.equal(usageSnapshot('tokF').strikes, 0);
    for (let i = 0; i < 10; i++) recordThrottle('tokF');
    assert.equal(recordThrottle('tokF'), 2 * 60000); // capped
  });

  test('0 means unlimited', async () => {
    configurePolicy({ settingsProvider: () => ({ webMinIntervalSec: 0, webJitterSec: 0, webMaxPerMinute: 0, webMaxPerHour: 0, webMaxPerDay: 0, webMaxSessionsPerHour: 0 }) });
    for (let i = 0; i < 50; i++) { await beforeRequest('tokU'); await beforeRequest('tokU', 'session'); }
    assert.equal(budgetWaitMs('tokU'), 0);
    assert.equal(pacingDelayMs('tokU'), 0);
    assert.equal(hasHeadroom('tokU'), true);
    configurePolicy({ settingsProvider: () => settings });
  });

  test('helper calls need hourly headroom', async () => {
    assert.equal(hasHeadroom('tokG'), true);
    for (let i = 0; i < 3; i++) await beforeRequest('tokG');
    assert.equal(hasHeadroom('tokG'), false);
  });
});

describe('log redaction', () => {
  test('removes known secrets and key shapes', () => {
    setSecretProvider(() => ['my-deepseek-user-token-123456']);
    const line = redact('token=my-deepseek-user-token-123456 auth: Bearer abcdefghijklmnop key sk-proxy-0123456789abcdef {"token": "zzzzzzzzzz"}');
    assert.doesNotMatch(line, /my-deepseek-user-token|abcdefghijklmnop|0123456789abcdef|zzzzzzzzzz/);
    assert.match(line, /Bearer \[REDACTED\]/);
    assert.match(line, /"token": "\[REDACTED\]"/);
  });

  test('keeps ordinary text', () => {
    setSecretProvider(() => []);
    const line = '[Responses] Turn completed. conv_01a192aa-ea88-71a1-8650-3452f2719597 task-list desk_lamp';
    assert.equal(redact(line), line);
  });
});
