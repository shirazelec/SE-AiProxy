import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { retryAfterMsFromHeaders, guardedFetch, guardedRead, upstreamHttpError, firstByteBudgetMs, FIRST_BYTE_TIMEOUT_MS } from '../src/upstreamGuard.js';
import { budgetWaitMs, recordApiRequest, apiUsageSnapshot, normalizeBudget, resetApiBudget } from '../src/apiBudget.js';

const H = obj => new Headers(obj);

describe('Retry-After and rate-limit reset headers', () => {
  const now = Date.parse('2026-11-06T12:00:00Z');

  test('seconds, HTTP date and ms forms', () => {
    assert.equal(retryAfterMsFromHeaders(H({ 'retry-after': '20' }), now), 20000);
    assert.equal(retryAfterMsFromHeaders(H({ 'retry-after': 'Fri, 06 Nov 2026 12:01:00 GMT' }), now), 60000);
    assert.equal(retryAfterMsFromHeaders(H({ 'retry-after-ms': '1500' }), now), 1500);
  });

  test('Groq-style durations take the longest wait', () => {
    assert.equal(retryAfterMsFromHeaders(H({ 'x-ratelimit-reset-requests': '2m59.56s', 'x-ratelimit-reset-tokens': '7.66s' }), now), 179560);
  });

  test('epoch reset values', () => {
    assert.equal(retryAfterMsFromHeaders(H({ 'x-ratelimit-reset': String(now / 1000 + 30) }), now), 30000);
    assert.equal(retryAfterMsFromHeaders(H({ 'x-ratelimit-reset': String(now + 5000) }), now), 5000);
  });

  test('nothing stated, nonsense or past values give 0; huge values are capped', () => {
    assert.equal(retryAfterMsFromHeaders(H({}), now), 0);
    assert.equal(retryAfterMsFromHeaders(H({ 'retry-after': 'soon' }), now), 0);
    assert.equal(retryAfterMsFromHeaders(H({ 'retry-after': 'Fri, 06 Nov 2026 11:00:00 GMT' }), now), 0);
    assert.equal(retryAfterMsFromHeaders(H({ 'retry-after': '999999999' }), now), 24 * 3600_000);
  });

  test('429 errors carry the back-off, other statuses do not', async () => {
    const e429 = await upstreamHttpError('X', new Response('slow down', { status: 429, headers: { 'retry-after': '12' } }));
    assert.equal(e429.status, 429);
    assert.equal(e429.retryAfterMs, 12000);
    const e400 = await upstreamHttpError('X', new Response('bad', { status: 400, headers: { 'retry-after': '12' } }));
    assert.equal(e400.retryAfterMs, undefined);
  });
});

describe('first-byte and stall limits', () => {
  // A server that sends headers, one chunk, then goes silent; or never answers at all
  const server = http.createServer((req, res) => {
    if (req.url === '/silent') return; // never responds
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: first\n\n');
  });
  const ready = new Promise(r => server.listen(0, '127.0.0.1', r));
  after(() => { server.closeAllConnections?.(); server.close(); });
  const url = async p => { await ready; return `http://127.0.0.1:${server.address().port}${p}`; };

  test('NVIDIA gets a longer first-byte budget', () => {
    assert.ok(firstByteBudgetMs({ type: 'nvidia' }) >= firstByteBudgetMs({ type: 'groq' }));
    assert.equal(firstByteBudgetMs({ type: 'groq' }), FIRST_BYTE_TIMEOUT_MS);
  });

  test('a silent endpoint fails fast with upstream_timeout', async () => {
    const target = await url('/silent');
    const { createWatchdog } = await import('../src/upstreamGuard.js');
    // Use a tiny budget through a hand-armed watchdog to keep the test quick
    const guard = createWatchdog();
    guard.arm(150, 'no response within 0s');
    const started = Date.now();
    await assert.rejects(fetch(target, { signal: guard.signal }), { name: 'AbortError' });
    assert.ok(Date.now() - started < 2000);
    assert.equal(guard.firedReason, 'no response within 0s');
    guard.dispose();
  });

  test('a stalled stream turns into upstream_timeout on read', async () => {
    const target = await url('/stream');
    const { res, guard } = await guardedFetch(fetch, target, {}, { name: 'Test', provider: {}, signal: undefined });
    const reader = res.body.getReader();
    const first = await guardedRead(reader, guard, { name: 'Test' });
    assert.equal(first.done, false);
    guard.arm(150, 'stream stalled for 0s');
    await assert.rejects(guardedRead(reader, guard, { name: 'Test' }), err => err.code === 'upstream_timeout' && /stalled/.test(err.message));
    guard.dispose();
  });

  test('a caller abort is not reported as a timeout', async () => {
    const target = await url('/silent');
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    await assert.rejects(guardedFetch(fetch, target, {}, { name: 'Test', provider: {}, signal: ac.signal }), err => err.code !== 'upstream_timeout');
  });
});

describe('API request budgets', () => {
  test('per-minute budget rests the key until the oldest request ages out', () => {
    resetApiBudget();
    const t0 = 1_000_000_000;
    assert.equal(recordApiRequest('k1', { rpm: 2 }, t0), 0);
    assert.equal(recordApiRequest('k1', { rpm: 2 }, t0 + 1000), 60000 - 1000);
    assert.equal(budgetWaitMs('k1', { rpm: 2 }, t0 + 61000), 0);
    // Other keys are separate
    assert.equal(budgetWaitMs('k2', { rpm: 2 }, t0 + 1000), 0);
  });

  test('per-day budget and snapshot', () => {
    resetApiBudget();
    const t0 = 2_000_000_000;
    for (let i = 0; i < 3; i++) recordApiRequest('k3', { rpd: 3 }, t0 + i * 120_000);
    assert.ok(budgetWaitMs('k3', { rpd: 3 }, t0 + 400_000) > 23 * 3600_000);
    assert.deepEqual(apiUsageSnapshot('k3', { rpd: 3 }, t0 + 400_000), { minute: 0, day: 3, limits: { minute: 0, day: 3 } });
  });

  test('no budget means no wait; bad input normalizes to 0', () => {
    resetApiBudget();
    for (let i = 0; i < 100; i++) recordApiRequest('k4', {}, 3_000_000_000 + i);
    assert.equal(budgetWaitMs('k4', {}, 3_000_000_100), 0);
    assert.equal(normalizeBudget(-5), 0);
    assert.equal(normalizeBudget('abc'), 0);
    assert.equal(normalizeBudget('30'), 30);
  });
});

describe('account health for API failures', () => {
  test('timeouts rest the account a minute, a missing model an hour, Retry-After is honored', async () => {
    const { tokenPool } = await import('../src/tokenPool.js');
    const { penalizeAccount, UPSTREAM_TIMEOUT_COOLDOWN_MS, MODEL_GONE_COOLDOWN_MS } = await import('../src/accountHealth.js');
    tokenPool.tokens = [{ id: 'a1', label: 'a1', type: 'groq', token: 'gsk_test', status: 'active', rateLimitedUntil: 0 }];
    const parked = () => tokenPool.tokens[0].rateLimitedUntil - Date.now();

    penalizeAccount('a1', Object.assign(new Error('Groq: no response within 90s'), { code: 'upstream_timeout', status: 504 }));
    assert.ok(parked() > UPSTREAM_TIMEOUT_COOLDOWN_MS - 2000 && parked() <= UPSTREAM_TIMEOUT_COOLDOWN_MS);

    Object.assign(tokenPool.tokens[0], { status: 'active', rateLimitedUntil: 0 });
    penalizeAccount('a1', Object.assign(new Error('Groq HTTP 404: model not found'), { status: 404 }));
    assert.ok(parked() > MODEL_GONE_COOLDOWN_MS - 2000);

    Object.assign(tokenPool.tokens[0], { status: 'active', rateLimitedUntil: 0 });
    penalizeAccount('a1', Object.assign(new Error('Groq HTTP 429: slow down'), { status: 429, retryAfterMs: 42000 }));
    assert.ok(parked() > 40000 && parked() <= 42000);
  });

  test('an account at its request budget rests until the window frees up', async () => {
    resetApiBudget();
    const { tokenPool } = await import('../src/tokenPool.js');
    tokenPool.tokens = [{ id: 'b1', label: 'b1', type: 'groq', token: 'gsk_budget', status: 'active', rateLimitedUntil: 0, rpm: 2 }];
    tokenPool.noteApiRequest('b1');
    assert.equal(tokenPool.tokens[0].rateLimitedUntil, 0);
    tokenPool.noteApiRequest('b1');
    const wait = tokenPool.tokens[0].rateLimitedUntil - Date.now();
    assert.ok(wait > 55000 && wait <= 60000, `wait ${wait}`);
    assert.match(tokenPool.tokens[0].lastError, /Request budget reached \(2\/min\)/);
  });
});
