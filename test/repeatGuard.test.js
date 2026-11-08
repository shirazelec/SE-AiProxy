import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findRepeatedCalls, loopAvoidanceNote, repeatedCallFollowUp } from '../src/repeatGuard.js';

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
});
