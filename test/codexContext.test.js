import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseToolCalls, decodeXmlEntities, isSyntheticUserText, buildPromptFromResponsesInput,
  limitCallBatch, isMutatingCall
} from '../src/parser.js';
import { findLatestRealUserMessage } from '../src/promptOptimizer.js';

const APP_CONTEXT = '<app-context>\n# Codex desktop context\n- Use the ::code-comment{...} directive ...\n</app-context>';

describe('XML-escaped tool parameters (Gemini style)', () => {
  test('decodes a consistently escaped command', () => {
    const raw = '<tool_calls>\n<invoke name="exec_command">\n<parameter name="cmd" string="true">cat &lt;&lt; \'EOF\' &gt; t.c\n#include &lt;stdio.h&gt;\nEOF\nmake &amp;&amp; ctest</parameter>\n</invoke>\n</tool_calls>';
    const { calls } = parseToolCalls(raw);
    assert.equal(calls.length, 1);
    const args = typeof calls[0].arguments === 'string' ? JSON.parse(calls[0].arguments) : calls[0].arguments;
    assert.equal(args.cmd, "cat << 'EOF' > t.c\n#include <stdio.h>\nEOF\nmake && ctest");
  });

  test('leaves raw commands and mixed text alone', () => {
    assert.equal(decodeXmlEntities('make && ctest > log'), 'make && ctest > log');
    assert.equal(decodeXmlEntities('echo "&amp;" && ls'), 'echo "&amp;" && ls');
    assert.equal(decodeXmlEntities('<![CDATA[a < b && c]]>'), 'a < b && c');
  });
});

describe('Codex context blocks', () => {
  test('desktop app blocks are recognized as context, not user requests', () => {
    for (const t of [APP_CONTEXT, '<skills_instructions>\n## Skills\n</skills_instructions>',
      '<collaboration_mode>plan</collaboration_mode>', '<codex_apps_client_time_context><timezone>Asia/Tehran</timezone></codex_apps_client_time_context>',
      '<image_resize_notice>resized</image_resize_notice>', '<some_future_block>\nx\n</some_future_block>']) {
      assert.equal(isSyntheticUserText(t), true, t.slice(0, 30));
    }
  });

  test('real user text is not context', () => {
    for (const t of ['فایل `src/a.c` را درست کن', '# Files pasted by the user:\n## a.md', '<div>fix this html</div> please', '<config>a</config>']) {
      assert.equal(isSyntheticUserText(t), false, t.slice(0, 30));
    }
  });

  test('optimizer target skips developer app-context after the user message', () => {
    const input = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'پیاده‌سازی G.19 را ادامه بده' }] },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: APP_CONTEXT }] }
    ];
    const found = findLatestRealUserMessage(input);
    assert.equal(found?.text, 'پیاده‌سازی G.19 را ادامه بده');
  });

  test('a turn that is only app-context has no user request', () => {
    assert.equal(findLatestRealUserMessage([{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: APP_CONTEXT }] }]), null);
  });

  test('continuation prompt labels developer blocks instead of passing them as the user message', () => {
    const input = [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'build it' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: APP_CONTEXT }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'now run the tests' }] }
    ];
    const prompt = buildPromptFromResponsesInput({ input, tools: [], isContinuation: true });
    assert.match(prompt, /\[DEVELOPER INSTRUCTIONS\]:\n<app-context>/);
    assert.match(prompt, /now run the tests/);
  });
});

describe('tool call batches', () => {
  const call = cmd => ({ name: 'exec_command', arguments: JSON.stringify({ cmd }) });

  test('a batch is cut after its first state-changing call', () => {
    const batch = [call('ls'), call('sed -n 1,20p a.c'), call("cat <<'EOF' > t.c"), call('make'), call('ctest')];
    assert.deepEqual(limitCallBatch(batch).map(c => JSON.parse(c.arguments).cmd), ['ls', 'sed -n 1,20p a.c', "cat <<'EOF' > t.c"]);
  });

  test('read-only batches stay parallel up to the cap', () => {
    assert.equal(limitCallBatch(Array.from({ length: 20 }, () => call('cat a.c'))).length, 8);
  });

  test('parallel_tool_calls=false keeps one call', () => {
    assert.equal(limitCallBatch([call('ls'), call('pwd')], { parallel: false }).length, 1);
  });

  test('mutating detection', () => {
    assert.equal(isMutatingCall(call('grep -n x f 2>/dev/null | head')), false);
    assert.equal(isMutatingCall(call('git status && git diff')), false);
    assert.equal(isMutatingCall(call('rm -rf build && mkdir build')), true);
    assert.equal(isMutatingCall(call('echo x >> notes.md')), true);
    assert.equal(isMutatingCall({ name: 'apply_patch', kind: 'custom', input: '*** Begin Patch' }), true);
  });
});
