import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { tokenPool } from '../src/tokenPool.js';
import { orderAuxCandidates, hasRoleAccount } from '../src/auxModel.js';

const acc = (id, role, extra = {}) => ({
  id, label: id, type: 'chabokan', token: `sk-${id}`, role, priority: 1, status: 'active',
  rateLimitedUntil: 0, activeRequests: 0, lastUsed: 0, totalRequests: 0, ...extra
});

describe('account roles (A prompt / B work / C debug)', () => {
  test('the task runs only on work accounts, split between them', () => {
    tokenPool.tokens = [acc('a1', 'prompt'), acc('b1', 'work'), acc('b2', 'work'), acc('c1', 'debug')];
    const first = tokenPool.selectAccountForTurn().account.id;
    const second = tokenPool.selectAccountForTurn().account.id;
    assert.deepEqual([first, second].sort(), ['b1', 'b2']);
  });

  test('when every work account is down the task falls back to the others', () => {
    tokenPool.tokens = [acc('a1', 'prompt'), acc('b1', 'work', { rateLimitedUntil: Date.now() + 3600000 }), acc('c1', 'debug')];
    assert.ok(['a1', 'c1'].includes(tokenPool.selectAccountForTurn().account.id));
  });

  test('helper calls go to their role first, then shared accounts, never work accounts', () => {
    const tokens = [acc('b1', 'work'), acc('x', 'all'), acc('c1', 'debug', { lastUsed: 5 }), acc('c2', 'debug', { lastUsed: 1 }), acc('a1', 'prompt')];
    assert.deepEqual(orderAuxCandidates(tokens, 'b1', 'debug').map(t => t.id), ['c2', 'c1', 'x', 'a1']);
    assert.equal(orderAuxCandidates(tokens, 'b1', 'prompt')[0].id, 'a1');
  });

  test('role accounts are detected only when usable', () => {
    assert.equal(hasRoleAccount('debug', [acc('c1', 'debug')]), true);
    assert.equal(hasRoleAccount('debug', [acc('c1', 'debug', { rateLimitedUntil: Date.now() + 60000 })]), false);
    assert.equal(hasRoleAccount('prompt', [acc('x', 'all')]), false);
  });
});

describe('disabled accounts', () => {
  test('a disabled account is never picked for work or helper calls', () => {
    tokenPool.tokens = [acc('off', 'all', { status: 'disabled' }), acc('on', 'all')];
    assert.equal(tokenPool.selectAccountForTurn().account.id, 'on');
    assert.deepEqual(orderAuxCandidates(tokenPool.tokens, null, 'debug').map(t => t.id), ['on']);
  });

  test('with only disabled accounts the pool reports none available', () => {
    tokenPool.tokens = [acc('off', 'all', { status: 'disabled' })];
    assert.throws(() => tokenPool.selectAccountForTurn(), /No valid AI accounts/);
  });
});

test('helpers stay off work accounts when the role has its own account', () => {
  const tokens = [acc('b1', 'work'), acc('c1', 'debug')];
  assert.deepEqual(orderAuxCandidates(tokens, null, 'debug').map(t => t.id), ['c1']);
  assert.deepEqual(orderAuxCandidates([acc('b1', 'work')], null, 'debug').map(t => t.id), ['b1']);
});

describe('fallback when DeepSeek work accounts are down', () => {
  test('a healthy DeepSeek helper takes the task before the Kimi backup', () => {
    tokenPool.tokens = [
      acc('w1', 'work', { type: 'deepseek_web', status: 'invalid' }),
      acc('k1', 'work', { type: 'kimi_web', priority: 2 }),
      acc('c1', 'debug', { type: 'deepseek_web' })
    ];
    assert.equal(tokenPool.selectAccountForTurn().account.id, 'c1');
  });

  test('with a strong worker alive, Kimi stays the backup by priority', () => {
    tokenPool.tokens = [
      acc('w1', 'work', { type: 'deepseek_web' }),
      acc('k1', 'work', { type: 'kimi_web', priority: 2 }),
      acc('c1', 'debug', { type: 'deepseek_web' })
    ];
    assert.equal(tokenPool.selectAccountForTurn().account.id, 'w1');
  });

  test('Kimi works when it is the only worker and no DeepSeek helper is left', () => {
    tokenPool.tokens = [acc('k1', 'work', { type: 'kimi_web' }), acc('c1', 'debug', { type: 'deepseek_web', status: 'invalid' })];
    assert.equal(tokenPool.selectAccountForTurn().account.id, 'k1');
  });
});

test('helper calls never use a DeepSeek Web account unless it is dedicated to that role', () => {
  const webWork = acc('w1', 'work', { type: 'deepseek_web' });
  assert.deepEqual(orderAuxCandidates([webWork], null, 'debug').map(t => t.id), []);
  assert.deepEqual(orderAuxCandidates([webWork, acc('x', 'all', { type: 'deepseek_web' })], null, 'prompt').map(t => t.id), []);
  assert.deepEqual(orderAuxCandidates([webWork, acc('p', 'prompt', { type: 'deepseek_web' })], null, 'prompt').map(t => t.id), ['p']);
});
