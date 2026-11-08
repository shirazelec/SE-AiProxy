import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { judgeTurnCompletion, buildJudgePrompt } from '../src/turnJudge.js';

describe('judgeTurnCompletion guards', () => {
  test('returns null when text is empty, null, or whitespace', async () => {
    assert.equal(await judgeTurnCompletion({ text: '', token: 'mock' }), null);
    assert.equal(await judgeTurnCompletion({ text: '   ', token: 'mock' }), null);
    assert.equal(await judgeTurnCompletion({ text: null, token: 'mock' }), null);
  });

  test('returns null when no helper account is available (empty test pool)', async () => {
    assert.equal(await judgeTurnCompletion({ text: 'Now I will run the tests.', timeoutMs: 500 }), null);
  });

  test('judge prompt carries the goal, error and tool output', () => {
    const p = buildJudgePrompt({
      text: 'حالا تست‌ها را اجرا می‌کنم',
      goal: 'fix the audio player and run the tests',
      isFollowingTool: true,
      recentError: 'error: undefined reference to foo',
      toolOutputTail: 'make: *** [all] Error 1'
    });
    assert.ok(p.includes('fix the audio player'));
    assert.ok(p.includes('undefined reference to foo'));
    assert.ok(p.includes('make: *** [all] Error 1'));
    assert.ok(p.includes('حالا تست‌ها را اجرا می‌کنم'));
  });
});
