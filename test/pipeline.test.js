import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { quotaCooldownMs } from '../src/accountHealth.js';
import { orderAuxCandidates } from '../src/auxModel.js';
import { buildOptimizerPrompt, isLosslessBrief, extractLiterals, formatOptimizedUserPrompt } from '../src/promptOptimizer.js';

describe('quota cooldown', () => {
  test('parks an exhausted free quota until its reset time', () => {
    const msg = "Moonmath HTTP 402: You've used today's Free usage. It resets in 6h 33m.";
    assert.equal(quotaCooldownMs(msg), (6 * 60 + 33) * 60000);
  });

  test('parks TokenHarbor allowance until UTC reset date', () => {
    const futureDate = new Date(Date.now() + 5 * 3600 * 1000);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const dStr = `${futureDate.getUTCDate()} ${months[futureDate.getUTCMonth()]} ${futureDate.getUTCFullYear()}`;
    const h = String(futureDate.getUTCHours()).padStart(2, '0');
    const m = String(futureDate.getUTCMinutes()).padStart(2, '0');
    const msg = `TokenHarbor HTTP 429: {"error":{"message":"Your free allowance for ':free' models is used up. It comes back on ${dStr} at ${h}:${m} UTC. Your account is not limited"}}`;
    const cooldown = quotaCooldownMs(msg);
    assert.ok(cooldown > 4.5 * 3600 * 1000 && cooldown <= 5.1 * 3600 * 1000);
  });

  test('checks again in 15 minutes when the reset time is unknown', () => {
    assert.equal(quotaCooldownMs('daily quota exceeded for this key'), 900000);
  });

  test('a depleted prepaid wallet is retried after a few minutes (top-up recovers it)', () => {
    const msg = 'Chabokan-2 HTTP 402: {"error": {"message": "AI credit exhausted. Top up to continue.", "type": "insufficient_credit"}}';
    assert.equal(quotaCooldownMs(msg), 3 * 60000);
  });

  test('numbers in the account label are not read as hours', () => {
    assert.equal(quotaCooldownMs('Chabokan-2 HTTP 429: daily quota exceeded'), 900000);
  });

  test('ignores ordinary errors', () => {
    assert.equal(quotaCooldownMs('HTTP 500 internal error'), 0);
  });
});

describe('helper account selection', () => {
  const tokens = [
    { id: 'web1', type: 'deepseek_web', token: 't', status: 'active', priority: 4 },
    { id: 'api1', type: 'tokenharbor', token: 't', status: 'active', priority: 2 },
    { id: 'api2', type: 'google', token: 't', status: 'active', priority: 3 },
    { id: 'dead', type: 'google', token: 't', status: 'invalid', priority: 1 },
    { id: 'cool', type: 'moonmath', token: 't', status: 'active', priority: 1, rateLimitedUntil: Date.now() + 60000 }
  ];

  test('prefers API accounts and skips the busy main account', () => {
    assert.deepEqual(orderAuxCandidates(tokens, 'api1').map(t => t.id), ['api2', 'api1']);
  });

  test('never sends helper calls to a shared DeepSeek Web account', () => {
    const web = [
      { id: 'main', type: 'deepseek_web', token: 't', status: 'active' },
      { id: 'other', type: 'deepseek_web', token: 't', status: 'active' }
    ];
    assert.deepEqual(orderAuxCandidates(web, 'main').map(t => t.id), []);
    assert.deepEqual(orderAuxCandidates([...web, { id: 'judge', type: 'deepseek_web', role: 'debug', token: 't', status: 'active' }], 'main', 'debug').map(t => t.id), ['judge']);
  });
});

describe('lossless prompt optimizer', () => {
  const original = 'فایل `src/server.js` رو درست کن و پورت 18789 رو نگه دار، بعد npm test --verbose رو اجرا کن';

  test('extracts literal details', () => {
    const lits = extractLiterals(original);
    assert.ok(lits.includes('`src/server.js`'));
    assert.ok(lits.includes('18789'));
  });

  test('accepts a brief that keeps every literal', () => {
    const brief = '[Detected Language]: Persian\n[Goal]: Fix `src/server.js`\n[Requirements]:\n- keep port 18789\n- run npm test --verbose';
    assert.equal(isLosslessBrief(original, brief), true);
  });

  test('rejects a brief that drops details', () => {
    const brief = '[Detected Language]: Persian\n[Goal]: Fix the server\n[Requirements]:\n- run the tests';
    assert.equal(isLosslessBrief(original, brief), false);
  });

  test('rejects output without the required sections', () => {
    assert.equal(isLosslessBrief('fix it please', 'Sure! I can help with that.'), false);
  });

  test('optimizer prompt forbids adding approval steps and keeps the request verbatim', () => {
    const p = buildOptimizerPrompt(original);
    assert.ok(p.includes(original));
    assert.match(p, /Do not add requirements, policies, approval steps/);
    assert.doesNotMatch(p, /ask the user for approval/i);
  });

  test('the original request stays authoritative in the enriched prompt', () => {
    const out = formatOptimizedUserPrompt(original, '[Goal]: x');
    assert.ok(out.startsWith('[USER ORIGINAL REQUEST]:\n' + original));
    assert.match(out, /original request above is authoritative/);
  });
});
