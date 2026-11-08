import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findLatestRealUserMessage, formatOptimizedUserPrompt, optimizePromptWithSupervisor } from '../src/promptOptimizer.js';

describe('findLatestRealUserMessage', () => {
  test('returns null when input is empty or not an array', () => {
    assert.equal(findLatestRealUserMessage([]), null);
    assert.equal(findLatestRealUserMessage(null), null);
  });

  test('returns null when the latest item is a tool result or assistant message', () => {
    const input = [
      { role: 'user', content: 'fix the bug' },
      { role: 'assistant', content: 'checking files...' },
      { type: 'tool_result', output: 'ok' }
    ];
    assert.equal(findLatestRealUserMessage(input), null);
  });

  test('returns null on synthetic environment context prompts', () => {
    const input = [
      { role: 'user', content: '<environment_context>cwd=/app</environment_context>' }
    ];
    assert.equal(findLatestRealUserMessage(input), null);
  });

  test('finds the latest real user message and extracts text', () => {
    const input = [
      { role: 'user', content: 'first prompt' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: [{ type: 'input_text', text: 'صدای پلیر رو درست کن' }] }
    ];
    const found = findLatestRealUserMessage(input);
    assert.ok(found);
    assert.equal(found.index, 2);
    assert.equal(found.text, 'صدای پلیر رو درست کن');
  });
});

describe('formatOptimizedUserPrompt', () => {
  test('returns original text if supervisor content is empty', () => {
    assert.equal(formatOptimizedUserPrompt('test text', null), 'test text');
    assert.equal(formatOptimizedUserPrompt('test text', ''), 'test text');
  });

  test('formats enriched prompt with original text and supervisor specification', () => {
    const original = 'صدای پلیر قطع شده';
    const spec = '[Detected Language]: Persian\n[Technical Goal]: Fix audio sink output';
    const formatted = formatOptimizedUserPrompt(original, spec);
    assert.ok(formatted.includes('[USER ORIGINAL REQUEST]:'));
    assert.ok(formatted.includes('صدای پلیر قطع شده'));
    assert.ok(formatted.includes('[SUPERVISOR COGNITIVE INTERPRETATION & SPECIFICATION]:'));
    assert.ok(formatted.includes('Fix audio sink output'));
  });
});

describe('optimizePromptWithSupervisor guards', () => {
  test('skips trivial or very short user inputs', async () => {
    assert.equal(await optimizePromptWithSupervisor({ userText: 'yes' }), null);
    assert.equal(await optimizePromptWithSupervisor({ userText: 'باشه' }), null);
    assert.equal(await optimizePromptWithSupervisor({ userText: '1' }), null);
    assert.equal(await optimizePromptWithSupervisor({ userText: 'ok' }), null);
  });
});
