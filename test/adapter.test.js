import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BoundedCache } from '../src/sessionCache.js';

// tokenPool persists to DATA_DIR on import; keep tests away from the real data/config.json
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-proxy-test-'));
let resolveConversationKey, estimateUsage, isSessionFullError, isRateLimitedOrBusy;

before(async () => {
  ({ resolveConversationKey, estimateUsage } = await import('../src/responsesAdapter.js'));
  ({ isSessionFullError, isRateLimitedOrBusy } = await import('../src/deepseek.js'));
});

describe('session length limit', () => {
  test('recognizes the DeepSeek web "conversation too long" error', () => {
    assert.equal(isSessionFullError({ message: '达到对话长度上限，请开启新对话', code: 'context_length_exceeded' }), true);
    assert.equal(isSessionFullError({ message: 'x', code: 'context_length_exceeded' }), true);
    assert.equal(isSessionFullError({ message: 'rate limit', code: 'rate_limit_reached' }), false);
  });

  test('recognizes bizCode 11 and message still wip as rate limited / busy', () => {
    assert.equal(isRateLimitedOrBusy({ bizCode: 11, message: 'message still wip' }), true);
    assert.equal(isRateLimitedOrBusy({ bizCode: 11 }), true);
    assert.equal(isRateLimitedOrBusy({ message: 'message still wip' }), true);
    assert.equal(isRateLimitedOrBusy({ status: 429 }), true);
    assert.equal(isRateLimitedOrBusy({ message: 'Server is busy' }), true);
    assert.equal(isRateLimitedOrBusy({ message: 'unrelated error' }), false);
  });

  test('usage reflects the Codex request size, not the upstream session total', () => {
    const u = estimateUsage({ instructions: 'a'.repeat(350), input: [] }, 'b'.repeat(35));
    assert.ok(u.input_tokens >= 100 && u.input_tokens < 120);
    assert.equal(u.output_tokens, 10);
    assert.equal(u.total_tokens, u.input_tokens + u.output_tokens);
  });
});

describe('BoundedCache', () => {
  test('evicts least recently used entries beyond maxEntries', () => {
    const c = new BoundedCache({ maxEntries: 2, ttlMs: 60_000 });
    c.set('a', 1).set('b', 2);
    c.get('a'); // a is now most recent
    c.set('c', 3);
    assert.equal(c.get('b'), undefined);
    assert.equal(c.get('a'), 1);
    assert.equal(c.get('c'), 3);
  });

  test('expires idle entries after ttl', () => {
    const c = new BoundedCache({ maxEntries: 10, ttlMs: -1 });
    c.set('a', 1);
    assert.equal(c.get('a'), undefined);
    assert.equal(c.size, 0);
  });

  test('deleteValue removes every alias of a session', () => {
    const c = new BoundedCache();
    const s = { id: 1 };
    c.set('conv', s).set('resp_1', s).set('other', { id: 2 });
    c.deleteValue(s);
    assert.equal(c.size, 1);
  });
});

describe('resolveConversationKey', () => {
  const req = (headers = {}) => ({ headers });
  const env = { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd=/repo</environment_context>' }] };
  const user = (text) => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });

  test('prefers prompt_cache_key (Codex conversation id)', () => {
    assert.equal(resolveConversationKey(req(), { prompt_cache_key: 'abc', input: [user('x')] }), 'conv_abc');
  });

  test('uses Codex session_id / conversation_id headers', () => {
    assert.equal(resolveConversationKey(req({ session_id: 's1' }), {}), 'conv_s1');
    assert.equal(resolveConversationKey(req({ conversation_id: 'c1' }), {}), 'conv_c1');
  });

  test('decodes base64 x-codex-turn-metadata', () => {
    const meta = Buffer.from(JSON.stringify({ thread_id: 't9' })).toString('base64');
    assert.equal(resolveConversationKey(req({ 'x-codex-turn-metadata': meta }), {}), 'thread_t9');
  });

  test('fingerprint is stable across turns of the same chat', () => {
    const turn1 = { input: [env, user('Build a todo app')] };
    const turn2 = { input: [env, user('Build a todo app'), { type: 'function_call', call_id: 'c', name: 'exec_command', arguments: '{}' }, { type: 'function_call_output', call_id: 'c', output: 'ok' }] };
    assert.equal(resolveConversationKey(req(), turn1), resolveConversationKey(req(), turn2));
  });

  test('different chats in the same repo do not collide on the environment block', () => {
    const a = resolveConversationKey(req(), { input: [env, user('Build a todo app')] });
    const b = resolveConversationKey(req(), { input: [env, user('Fix the login bug')] });
    assert.notEqual(a, b);
  });

  test('uses the first real user message id when present', () => {
    assert.equal(resolveConversationKey(req(), { input: [env, { ...user('hi'), id: 'msg_7' }] }), 'user_msg_msg_7');
  });
});
