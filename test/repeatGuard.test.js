import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findRepeatedCalls, loopAvoidanceNote, repeatedCallFollowUp } from '../src/repeatGuard.js';
import { adaptOpenAIPayload } from '../src/providerRunner.js';

const CAT = JSON.stringify({ cmd: 'cd "/proj/src" && cat src/app.c' });
const truncatedOut = 'Chunk ID: ca7a64\nProcess exited with code 0\nOriginal token count: 25539\nOutput:\nWarning: truncated output (original token count: 25539)\nTotal output lines: 2349\n\n/* app.c */';

function history(n) {
  const input = [{ role: 'user', content: 'fix the player' }];
  for (let i = 0; i < n; i++) {
    input.push({ type: 'function_call', name: 'exec_command', call_id: `c${i}`, arguments: CAT });
    input.push({ type: 'function_call_output', call_id: `c${i}`, output: truncatedOut });
  }
  return input;
}

describe('cross-turn repeat guard', () => {
  test('detects a call identical to one already executed (ignoring volatile args)', () => {
    const next = [{ name: 'exec_command', arguments: JSON.stringify({ cmd: 'cd  "/proj/src" &&  cat src/app.c', yield_time_ms: 10000 }) }];
    const repeats = findRepeatedCalls(next, history(1));
    assert.equal(repeats.length, 1);
    assert.equal(repeats[0].previous.truncated, true);
    assert.match(repeatedCallFollowUp(repeats), /truncated/i);
  });

  test('a different command is not a repeat', () => {
    const next = [{ name: 'exec_command', arguments: JSON.stringify({ cmd: "sed -n '1,300p' src/app.c" }) }];
    assert.equal(findRepeatedCalls(next, history(1)).length, 0);
  });

  test('prompt note warns about truncated output and repeated runs', () => {
    assert.match(loopAvoidanceNote(history(1)), /TRUNCATED/);
    assert.match(loopAvoidanceNote(history(3)), /3 times in a row/);
    assert.equal(loopAvoidanceNote([{ role: 'user', content: 'hi' }]), '');
  });

  test('normalizes cd, trailing echo, and redirects in command signatures', () => {
    const hist = [
      { role: 'user', content: 'check headers' },
      { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: JSON.stringify({ cmd: 'cd /root/proj && cat include/sdk_cfg.h 2>/dev/null; echo "DONE"' }) },
      { type: 'function_call_output', call_id: 'c1', output: '/* config */' }
    ];
    const next = [{ name: 'exec_command', arguments: JSON.stringify({ cmd: 'cat include/sdk_cfg.h' }) }];
    const repeats = findRepeatedCalls(next, hist);
    assert.equal(repeats.length, 1);
    assert.equal(repeats[0].reason, 'unmodified');
  });

  test('detects read-only repeats across multiple intermediate read turns', () => {
    const hist = [
      { role: 'user', content: 'start' },
      { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: JSON.stringify({ cmd: 'cat src/main.c' }) },
      { type: 'function_call_output', call_id: 'c1', output: 'int main() {}' },
      { type: 'function_call', name: 'exec_command', call_id: 'c2', arguments: JSON.stringify({ cmd: 'grep -rn foo .' }) },
      { type: 'function_call_output', call_id: 'c2', output: 'foo found' },
      { type: 'function_call', name: 'exec_command', call_id: 'c3', arguments: JSON.stringify({ cmd: 'find . -name "*.h"' }) },
      { type: 'function_call_output', call_id: 'c3', output: './main.h' }
    ];
    // Now re-running cat src/main.c without any mutating edits in between
    const next = [{ name: 'exec_command', arguments: JSON.stringify({ cmd: 'cat src/main.c' }) }];
    const repeats = findRepeatedCalls(next, hist);
    assert.equal(repeats.length, 1);
  });

  test('allows re-reading after a mutating call like apply_patch', () => {
    const hist = [
      { role: 'user', content: 'start' },
      { type: 'function_call', name: 'exec_command', call_id: 'c1', arguments: JSON.stringify({ cmd: 'cat src/main.c' }) },
      { type: 'function_call_output', call_id: 'c1', output: 'int main() {}' },
      { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: '*** patch' },
      { type: 'custom_tool_call_output', call_id: 'c2', output: 'patch applied' }
    ];
    // Since apply_patch mutated code, reading src/main.c again is legitimate
    const next = [{ name: 'exec_command', arguments: JSON.stringify({ cmd: 'cat src/main.c' }) }];
    const repeats = findRepeatedCalls(next, hist);
    assert.equal(repeats.length, 0);
  });

  const call = (id, name, args) => ({ type: 'function_call', name, call_id: id, arguments: JSON.stringify(args) });
  const out = (id, output) => ({ type: 'function_call_output', call_id: id, output });

  test('allows polling a running command with an empty write_stdin again', () => {
    const hist = [
      { role: 'user', content: 'build it' },
      call('c1', 'exec_command', { cmd: 'make all' }), out('c1', 'Process running with session ID 7'),
      call('c2', 'write_stdin', { session_id: 7, chars: '' }), out('c2', 'compiling 40%...')
    ];
    const next = [{ name: 'write_stdin', arguments: JSON.stringify({ session_id: 7, chars: '' }) }];
    assert.equal(findRepeatedCalls(next, hist).length, 0);
    assert.doesNotMatch(loopAvoidanceNote([...hist, call('c3', 'write_stdin', { session_id: 7, chars: '' }), out('c3', '80%')]), /times in a row/);
  });

  test('allows re-checking time-varying output such as logs', () => {
    const hist = [
      { role: 'user', content: 'start the server' },
      call('a', 'exec_command', { cmd: 'tail -n 20 logs/app.log' }), out('a', 'starting...'),
      call('b', 'exec_command', { cmd: 'grep -n port config.ini' }), out('b', 'port=80')
    ];
    const next = [{ name: 'exec_command', arguments: JSON.stringify({ cmd: 'tail -n 20 logs/app.log' }) }];
    assert.equal(findRepeatedCalls(next, hist).length, 0);
  });

  test('treats running a script as a possible state change', () => {
    const hist = [
      { role: 'user', content: 'generate the table' },
      call('a', 'exec_command', { cmd: 'cat out/table.h' }), out('a', '// empty'),
      call('b', 'exec_command', { cmd: 'python3 tools/gen.py' }), out('b', 'written')
    ];
    const next = [{ name: 'exec_command', arguments: JSON.stringify({ cmd: 'cat out/table.h' }) }];
    assert.equal(findRepeatedCalls(next, hist).length, 0);
  });

  test('OpenAI reasoning models get no stop sequences', () => {
    const payload = adaptOpenAIPayload({ type: 'openai' }, { model: 'gpt-5-mini', max_tokens: 10, stop: ['[TOOL RESULT'] });
    assert.equal(payload.stop, undefined);
    assert.equal(payload.max_completion_tokens, 10);
    const chat = adaptOpenAIPayload({ type: 'openai' }, { model: 'gpt-4.1', stop: ['[TOOL RESULT'] });
    assert.deepEqual(chat.stop, ['[TOOL RESULT']);
  });
});
