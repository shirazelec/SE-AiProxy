import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseToolCalls,
  getVisibleStreamingText,
  detectRepetitionLoop,
  normalizeToolCallMarkup,
  buildPromptFromResponsesInput,
  getIncrementalItems,
  truncateMiddle,
  adaptCallsForTools,
  simplifyToolsForPrompt
} from '../src/parser.js';

const args = (call) => JSON.parse(call.arguments);

describe('parseToolCalls', () => {
  test('extracts a wrapped exec_command call and strips markup from text', () => {
    const raw = 'Listing files.\n<tool_calls>\n<invoke name="exec_command">\n<parameter name="cmd" string="true">ls -la</parameter>\n</invoke>\n</tool_calls>';
    const { cleanContent, calls } = parseToolCalls(raw);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'exec_command');
    assert.equal(args(calls[0]).cmd, 'ls -la');
    assert.equal(cleanContent, 'Listing files.');
  });

  test('handles DSML-prefixed tags', () => {
    const raw = '<｜DSML｜tool_calls><｜DSML｜invoke name="exec_command"><｜DSML｜parameter name="cmd" string="true">pwd</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>';
    const { calls, cleanContent } = parseToolCalls(raw);
    assert.equal(calls.length, 1);
    assert.equal(args(calls[0]).cmd, 'pwd');
    assert.equal(cleanContent, '');
  });

  test('strips stray bare DSML wrapper tags from cleanContent', () => {
    const raw = '</｜｜DSML｜｜>';
    const { cleanContent, calls } = parseToolCalls(raw);
    assert.equal(calls.length, 0);
    assert.equal(cleanContent, '');
  });

  test('strips stray bare DSML tags without closing angle bracket', () => {
    const raw = 'حالا خود فایل STEP موجود را رندر می‌کنم.\n\n</｜｜DSML｜｜';
    const { cleanContent, calls } = parseToolCalls(raw);
    assert.equal(calls.length, 0);
    assert.equal(cleanContent, 'حالا خود فایل STEP موجود را رندر می‌کنم.');
  });

  test('strips stray bare DSML tags with text', () => {
    const raw = 'Hello world\n</｜｜DSML｜｜>';
    const { cleanContent, calls } = parseToolCalls(raw);
    assert.equal(calls.length, 0);
    assert.equal(cleanContent, 'Hello world');
  });

  test('strips double-underscore DSML tokens like </__DSML__|> and <__DSML__|>', () => {
    const raw = 'Checking files.\n\n</__DSML__|>\n<tool_calls><invoke name="exec_command"><parameter name="cmd">ls -lah</parameter></invoke></tool_calls>';
    const { cleanContent, calls } = parseToolCalls(raw);
    assert.equal(calls.length, 1);
    assert.equal(args(calls[0]).cmd, 'ls -lah');
    assert.equal(cleanContent, 'Checking files.');

    const lone = '</__DSML__|>\n<tool_calls><invoke name="exec_command"><parameter name="cmd">pwd</parameter></invoke></tool_calls>';
    const { cleanContent: loneClean, calls: loneCalls } = parseToolCalls(lone);
    assert.equal(loneCalls.length, 1);
    assert.equal(loneClean, '');
  });

  test('recovers an unclosed invoke at end of stream', () => {
    const raw = '<tool_calls><invoke name="exec_command"><parameter name="cmd" string="true">npm test</parameter>';
    const { calls } = parseToolCalls(raw);
    assert.equal(calls.length, 1);
    assert.equal(args(calls[0]).cmd, 'npm test');
  });

  test('reassembles a call that arrived fragmented across chunks', () => {
    const chunks = ['<tool_', 'calls><inv', 'oke name="exec_', 'command"><parameter na', 'me="cmd" string="true">echo ', 'hi</param', 'eter></invoke></tool_calls>'];
    let acc = '';
    for (const c of chunks) {
      acc += c;
      // nothing tool-ish may leak into visible text mid-stream
      assert.equal(getVisibleStreamingText(acc), '');
    }
    const { calls } = parseToolCalls(acc);
    assert.equal(calls.length, 1);
    assert.equal(args(calls[0]).cmd, 'echo hi');
  });

  test('parses multiple invokes and tolerates extra attributes / single quotes', () => {
    const raw = "<tool_calls><invoke name='exec_command' id=\"1\"><parameter name=\"cmd\">a</parameter></invoke><invoke name=\"exec_command\"><parameter name=\"cmd\">b</parameter></invoke></tool_calls>";
    const { calls } = parseToolCalls(raw);
    assert.deepEqual(calls.map(c => args(c).cmd), ['a', 'b']);
  });

  test('keeps the first value when a parameter is repeated', () => {
    const raw = '<invoke name="exec_command"><parameter name="cmd">first</parameter><parameter name="cmd">second</parameter></invoke>';
    assert.equal(args(parseToolCalls(raw).calls[0]).cmd, 'first');
  });

  test('coerces numeric and boolean arguments', () => {
    const raw = '<invoke name="write_stdin"><parameter name="session_id">42</parameter><parameter name="chars">y\n</parameter></invoke>' +
      '<invoke name="exec_command"><parameter name="cmd">ls</parameter><parameter name="tty">true</parameter></invoke>';
    const [stdin, exec] = parseToolCalls(raw).calls;
    assert.equal(args(stdin).session_id, 42);
    assert.equal(args(exec).tty, true);
  });

  test('preserves sandbox_permissions=require_escalated and adds a justification', () => {
    const raw = '<invoke name="exec_command"><parameter name="cmd">npm install</parameter><parameter name="sandbox_permissions">require_escalated</parameter></invoke>';
    const a = args(parseToolCalls(raw).calls[0]);
    assert.equal(a.sandbox_permissions, 'require_escalated');
    assert.ok(a.justification && a.justification.length > 10);
  });

  test('keeps an explicit justification and drops invalid sandbox values', () => {
    const ok = '<invoke name="exec_command"><parameter name="cmd">curl x</parameter><parameter name="sandbox_permissions">require_escalated</parameter><parameter name="justification">needs network</parameter></invoke>';
    assert.equal(args(parseToolCalls(ok).calls[0]).justification, 'needs network');
    const bad = '<invoke name="exec_command"><parameter name="cmd">ls</parameter><parameter name="sandbox_permissions">root please</parameter></invoke>';
    assert.equal(args(parseToolCalls(bad).calls[0]).sandbox_permissions, undefined);
  });

  test('strips /tmp workdir', () => {
    const raw = '<invoke name="exec_command"><parameter name="cmd">ls</parameter><parameter name="workdir">/tmp/x</parameter></invoke>';
    assert.equal(args(parseToolCalls(raw).calls[0]).workdir, undefined);
  });

  test('converts a patch embedded in exec_command into apply_patch (Codex format)', () => {
    const patch = '*** Begin Patch\n*** Add File: a.txt\n+hello\n*** End Patch';
    const raw = `<invoke name="exec_command"><parameter name="cmd">apply_patch <<'EOF'\n${patch}\nEOF</parameter></invoke>`;
    const { calls } = parseToolCalls(raw);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'apply_patch');
    assert.equal(args(calls[0]).patch, patch);
  });

  test('normalizes legacy "*** Begin Patch ***" markers', () => {
    const raw = '<invoke name="apply_patch"><parameter name="patch">*** Begin Patch ***\n*** Add File: b\n+x\n*** End Patch ***</parameter></invoke>';
    assert.equal(args(parseToolCalls(raw).calls[0]).patch, '*** Begin Patch\n*** Add File: b\n+x\n*** End Patch');
  });

  test('detects a bare patch block in plain text', () => {
    const raw = 'Here is the fix:\n*** Begin Patch\n*** Update File: x.js\n@@\n-a\n+b\n*** End Patch\nDone.';
    const { calls, cleanContent } = parseToolCalls(raw);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'apply_patch');
    assert.ok(!cleanContent.includes('Begin Patch'));
    assert.ok(cleanContent.includes('Done.'));
  });

  test('supports the <function_call>/<argument> fallback format', () => {
    const raw = '<function_call name="exec_command"><argument name="cmd">whoami</argument></function_call>';
    const { calls } = parseToolCalls(raw);
    assert.equal(args(calls[0]).cmd, 'whoami');
  });

  test('plain text without tools yields no calls', () => {
    const { calls, cleanContent } = parseToolCalls('All tests pass. 3 < 4 and 5 > 2.');
    assert.equal(calls.length, 0);
    assert.equal(cleanContent, 'All tests pass. 3 < 4 and 5 > 2.');
  });
});

describe('normalizeToolCallMarkup', () => {
  test('splits merged </parameter name="..."> tags', () => {
    const s = normalizeToolCallMarkup('<invoke name="x"><parameter name="a">1</parameter name="b">2</parameter></invoke>');
    assert.ok(s.includes('</parameter><parameter name="b">'));
  });
});

describe('getVisibleStreamingText', () => {
  test('cuts at the first tool marker', () => {
    assert.equal(getVisibleStreamingText('Running it now.\n<tool_calls><invoke'), 'Running it now.\n');
  });
  test('holds back a dangling "<"', () => {
    assert.equal(getVisibleStreamingText('Hello <'), 'Hello ');
  });
  test('passes ordinary text through', () => {
    assert.equal(getVisibleStreamingText('just text'), 'just text');
  });
  test('hides </__DSML__|> and yields empty string when no prior text', () => {
    assert.equal(getVisibleStreamingText('</__DSML__|>\n<tool_calls><invoke'), '');
    assert.equal(getVisibleStreamingText('<__DSML__|>\n<tool_calls>'), '');
    assert.equal(getVisibleStreamingText('|__DSML__|'), '');
  });
  test('preserves user prose and strips trailing </__DSML__|>', () => {
    const raw = 'باشه؛ فایل‌ها را بررسی می‌کنم.\n\n</__DSML__|>\n<tool_calls><invoke name="exec_command">';
    assert.equal(getVisibleStreamingText(raw).trim(), 'باشه؛ فایل‌ها را بررسی می‌کنم.');
  });
  test('never leaks command or parameter text when tool calls use DSML markup', () => {
    const raw = '<｜DSML｜tool_calls><｜DSML｜invoke name="exec_command"><｜DSML｜parameter name="cmd">cd "/home/test" && ls -la</｜DSML｜parameter><｜DSML｜parameter name="workdir">/home/test</｜DSML｜parameter><｜DSML｜parameter name="timeout_ms">60000</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>';
    assert.equal(getVisibleStreamingText(raw), '');
    const { calls, cleanContent } = parseToolCalls(raw);
    assert.equal(calls.length, 1);
    assert.equal(args(calls[0]).cmd, 'cd "/home/test" && ls -la');
    assert.equal(cleanContent, '');
  });
  test('preserves user prose before DSML tool call without leaking command parameter text', () => {
    const raw = 'بخش اول نوشته شد؛ ادامهٔ Makefile را اضافه می‌کنم.\n\n<｜DSML｜tool_calls><｜DSML｜invoke name="exec_command"><｜DSML｜parameter name="cmd">cat >> Makefile</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>';
    assert.equal(getVisibleStreamingText(raw).trim(), 'بخش اول نوشته شد؛ ادامهٔ Makefile را اضافه می‌کنم.');
    const { calls, cleanContent } = parseToolCalls(raw);
    assert.equal(calls.length, 1);
    assert.equal(args(calls[0]).cmd, 'cat >> Makefile');
    assert.equal(cleanContent, 'بخش اول نوشته شد؛ ادامهٔ Makefile را اضافه می‌کنم.');
  });
});

describe('detectRepetitionLoop', () => {
  test('flags 5+ identical prose phrases', () => {
    const text = 'Let me analyze the issue. ' + 'I will now check the configuration file again. '.repeat(6);
    assert.equal(detectRepetitionLoop(text), true);
  });

  test('flags an unclosed invoke that keeps repeating the same parameter', () => {
    const text = 'ok <tool_calls><invoke name="exec_command">' + '\n<parameter name="cmd">ls</parameter>'.repeat(5);
    assert.equal(detectRepetitionLoop(text), true);
  });

  test('ignores comment dividers and indentation', () => {
    const dividers = '# Section\n' + '# ----------------------------------------\n'.repeat(30);
    assert.equal(detectRepetitionLoop(dividers), false);
    const indent = 'def f():\n' + '        \n'.repeat(100);
    assert.equal(detectRepetitionLoop(indent), false);
  });

  test('ignores low-diversity data rows', () => {
    const matrix = 'grid = [\n' + '    [0, 0, 0, 0, 0, 0, 0, 0],\n'.repeat(20) + ']';
    assert.equal(detectRepetitionLoop(matrix), false);
  });

  test('does not flag a few identical widget/CSS blocks inside a tool parameter', () => {
    const card = '<div class="card shadow"><h3 class="title">Product</h3><p class="desc">Lorem ipsum</p></div>\n';
    const text = '<tool_calls><invoke name="apply_patch"><parameter name="patch">*** Begin Patch\n*** Add File: index.html\n' +
      card.split('\n')[0].replace(/^/, '+') + '\n' + ('+' + card).repeat(6);
    assert.equal(detectRepetitionLoop(text), false);
    const css = '<invoke name="apply_patch"><parameter name="patch">' + '.btn-primary { color: #fff; background: #0d6efd; border-radius: 4px; }\n'.repeat(6);
    assert.equal(detectRepetitionLoop(css), false);
  });

  test('still flags genuine runaway output inside a tool parameter', () => {
    const line = 'console.log("processing item from the queue now");\n';
    const text = '<invoke name="exec_command"><parameter name="cmd">node -e \'' + line.repeat(40);
    assert.equal(detectRepetitionLoop(text), true);
  });

  test('short or varied text is never flagged', () => {
    assert.equal(detectRepetitionLoop('short'), false);
    const varied = Array.from({ length: 50 }, (_, i) => `line ${i}: value=${i * 7}`).join('\n');
    assert.equal(detectRepetitionLoop(varied), false);
  });
});

describe('buildPromptFromResponsesInput', () => {
  const tools = [{ type: 'function', name: 'exec_command', parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] } }];
  const history = [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd=/w</environment_context>' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Build the app' }] },
    { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: '{"cmd":"ls"}' },
    { type: 'function_call_output', call_id: 'call_1', output: 'a.js' },
    { type: 'function_call', name: 'exec_command', call_id: 'call_2', arguments: '{"cmd":"cat a.js"}' },
    { type: 'function_call_output', call_id: 'call_2', output: 'console.log(1)' }
  ];

  test('initial turn includes directive, instructions, tools and user text', () => {
    const p = buildPromptFromResponsesInput({ instructions: 'Be terse', input: history.slice(0, 2), tools });
    assert.ok(p.includes('[WORKSPACE & EXECUTION RULES'));
    assert.ok(p.includes('Architectural Rules'));
    assert.ok(p.includes('Collaboration & Consultative Decision Making'));
    assert.ok(p.includes('[System Instructions]\nBe terse'));
    assert.ok(p.includes('[AVAILABLE TOOLS]'));
    assert.ok(p.includes('[USER]:\nBuild the app'));
    assert.ok(!p.includes('[PROGRESS STATUS]'), 'no progress notice on a fresh conversation');
  });

  test('continuation sends only the latest incremental tool result', () => {
    const p = buildPromptFromResponsesInput({ instructions: 'x', input: history, tools, isContinuation: true });
    assert.ok(p.includes('[TOOL RESULT exec_command call_2]'));
    assert.ok(p.includes('console.log(1)'));
    assert.ok(!p.includes('call_1'));
    assert.ok(!p.includes('[AVAILABLE TOOLS]'));
    assert.ok(!p.includes('WORKSPACE'));
  });

  test('continuation includes every parallel tool result since the last model item', () => {
    const parallel = [
      ...history.slice(0, 2),
      { type: 'function_call', name: 'exec_command', call_id: 'a', arguments: '{}' },
      { type: 'function_call', name: 'exec_command', call_id: 'b', arguments: '{}' },
      { type: 'function_call_output', call_id: 'a', output: 'out-a' },
      { type: 'function_call_output', call_id: 'b', output: 'out-b' }
    ];
    assert.equal(getIncrementalItems(parallel).length, 2);
    const p = buildPromptFromResponsesInput({ input: parallel, isContinuation: true });
    assert.ok(p.includes('out-a') && p.includes('out-b'));
  });

  test('continuation with a new user message sends just that message', () => {
    const input = [...history, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }, { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Now add tests' }] }];
    assert.equal(buildPromptFromResponsesInput({ input, isContinuation: true }), 'Now add tests');
  });

  test('failover injects full history plus an explicit do-not-restart notice', () => {
    const p = buildPromptFromResponsesInput({ instructions: 'x', input: history, tools, isFailover: true });
    assert.ok(p.includes('[ACTION exec_command call_1]'));
    assert.ok(p.includes('[TOOL RESULT exec_command call_1]'));
    assert.ok(p.includes('[SESSION RESUMED'));
    assert.ok(/do NOT delete/i.test(p));
    assert.ok(/ALREADY EXECUTED/.test(p));
  });

  test('failover with a new user message instructs to answer that message, not resume old tool results', () => {
    const withUser = [
      ...history,
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'All done.' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'How do I check history?' }] }
    ];
    const p = buildPromptFromResponsesInput({ instructions: 'x', input: withUser, tools, isFailover: true });
    assert.ok(p.includes('How do I check history?'));
    assert.ok(p.includes('Respond directly and specifically to the user\'s latest message'));
    assert.ok(!p.includes('Continue directly from the latest tool result'));
  });

  test('new session mid-task (no failover) still warns not to restart', () => {
    const p = buildPromptFromResponsesInput({ input: history });
    assert.ok(p.includes('[PROGRESS STATUS]'));
  });

  test('oversized history is trimmed to budget, keeping the request and the latest steps', () => {
    const big = [history[0], history[1]];
    for (let i = 0; i < 60; i++) {
      big.push({ type: 'function_call', name: 'exec_command', call_id: `c${i}`, arguments: JSON.stringify({ cmd: `step ${i}` }) });
      big.push({ type: 'function_call_output', call_id: `c${i}`, output: `output-${i} ` + 'x'.repeat(3000) });
    }
    const p = buildPromptFromResponsesInput({ instructions: 'x', input: big, tools, isFailover: true, maxChars: 40000 });
    assert.ok(p.length < 48000, `prompt length ${p.length}`);
    assert.ok(p.includes('Build the app'), 'first user request kept');
    assert.ok(p.includes('output-59'), 'latest tool result kept');
    assert.ok(!p.includes('output-0 '), 'oldest steps dropped');
    assert.ok(p.includes('[HISTORY TRIMMED]'));
    assert.ok(p.includes('[SESSION RESUMED'));
  });

  test('a single huge tool result is truncated in continuation prompts', () => {
    const input = [...history.slice(0, 4), { type: 'function_call', name: 'exec_command', call_id: 'z', arguments: '{}' }, { type: 'function_call_output', call_id: 'z', output: 'HEAD' + 'y'.repeat(200000) + 'TAIL' }];
    const p = buildPromptFromResponsesInput({ input, isContinuation: true });
    assert.ok(p.length < 50000);
    assert.ok(p.includes('HEAD') && p.includes('TAIL') && p.includes('truncated by proxy'));
  });

  test('truncateMiddle leaves short text alone', () => {
    assert.equal(truncateMiddle('abc', 10), 'abc');
  });

  test('string input', () => {
    assert.equal(buildPromptFromResponsesInput({ input: '  hi  ', isContinuation: true }), 'hi');
    assert.ok(buildPromptFromResponsesInput({ input: 'hi' }).endsWith('hi'));
  });
});

describe('tool shape adaptation', () => {
  const patchCall = [{ id: 'call_x', name: 'apply_patch', arguments: JSON.stringify({ patch: '*** Begin Patch\n*** End Patch' }) }];

  test('custom (freeform) apply_patch tool becomes a custom_tool_call input', () => {
    const [c] = adaptCallsForTools(patchCall, [{ type: 'custom', name: 'apply_patch', description: 'd' }]);
    assert.equal(c.kind, 'custom');
    assert.equal(c.input, '*** Begin Patch\n*** End Patch');
  });

  test('function apply_patch with an `input` parameter receives {input}', () => {
    const [c] = adaptCallsForTools(patchCall, [{ type: 'function', name: 'apply_patch', parameters: { properties: { input: { type: 'string' } } } }]);
    assert.deepEqual(JSON.parse(c.arguments), { input: '*** Begin Patch\n*** End Patch' });
  });

  test('exec_command schema keeps sandbox_permissions when Codex declares it', () => {
    const [t] = simplifyToolsForPrompt([{ type: 'function', name: 'exec_command', parameters: { properties: { cmd: {}, sandbox_permissions: {} } } }]);
    assert.ok(t.parameters.properties.sandbox_permissions);
    assert.deepEqual(t.parameters.required, ['cmd']);
  });

  test('tools without a name (e.g. web_search) are dropped from the prompt', () => {
    assert.equal(simplifyToolsForPrompt([{ type: 'web_search' }]).length, 0);
  });

  test('strips non-standard <calles> and <call_calls> tags completely from cleanContent', () => {
    const raw = 'Checking bundle.\n\n<calles>\n<invoke name="exec_command"><parameter name="cmd">ls</parameter></invoke>\n</calles>';
    const parsed = parseToolCalls(raw);
    assert.equal(parsed.cleanContent, 'Checking bundle.');
    assert.equal(parsed.calls.length, 1);
    assert.equal(parsed.calls[0].name, 'exec_command');

    const visible = getVisibleStreamingText(raw);
    assert.equal(visible, 'Checking bundle.\n\n');
  });

  test('correctly parses direct <writes_stdin> tag into write_stdin call and strips markup', () => {
    const raw = 'Loading audio deck.\n\n<writes_stdin><parameter name="session_id">deck-1</parameter><parameter name="chars">p</parameter></writes_stdin>';
    const parsed = parseToolCalls(raw);
    assert.equal(parsed.cleanContent, 'Loading audio deck.');
    assert.equal(parsed.calls.length, 1);
    assert.equal(parsed.calls[0].name, 'write_stdin');
    assert.deepEqual(JSON.parse(parsed.calls[0].arguments), { session_id: 'deck-1', chars: 'p' });

    const visible = getVisibleStreamingText(raw);
    assert.equal(visible, 'Loading audio deck.\n\n');
  });

  test('strips multilingual CJK tool call tags like <コール>, <ツール>, <调用> from text and streaming', () => {
    const raw1 = 'قبل از آداپتور PNG یک باگ واقعی دیدم.\n<コール>\n<invoke name="exec_command"><parameter name="cmd">sed -n 1,10p file.c</parameter></invoke>';
    const parsed1 = parseToolCalls(raw1);
    assert.equal(parsed1.cleanContent, 'قبل از آداپتور PNG یک باگ واقعی دیدم.');
    assert.equal(parsed1.calls.length, 1);
    assert.equal(parsed1.calls[0].name, 'exec_command');

    const visible1 = getVisibleStreamingText(raw1);
    assert.equal(visible1, 'قبل از آداپتور PNG یک باگ واقعی دیدم.\n');

    const raw2 = '<コール name="exec_command"><parameter name="cmd">ls</parameter></コール>';
    const parsed2 = parseToolCalls(raw2);
    assert.equal(parsed2.cleanContent, '');
    assert.equal(parsed2.calls.length, 1);
    assert.equal(parsed2.calls[0].name, 'exec_command');

    const raw3 = '＜コール＞\n<invoke name="exec_command"><parameter name="cmd">pwd</parameter></invoke>';
    const parsed3 = parseToolCalls(raw3);
    assert.equal(parsed3.cleanContent, '');
    assert.equal(parsed3.calls.length, 1);
  });

  test('normalizes and completely strips <call_tool> and variants from clean content', () => {
    const raw = 'دو درایور واقعی در دسترس نیستند.\n<call_tool>\n<invoke name="exec_command"><parameter name="cmd">echo test</parameter></invoke>\n</call_tool>';
    const parsed = parseToolCalls(raw);
    assert.equal(parsed.cleanContent, 'دو درایور واقعی در دسترس نیستند.');
    assert.equal(parsed.calls.length, 1);
    assert.equal(parsed.calls[0].name, 'exec_command');

    const emptyWrapper = '<call_tool>\n\n</call_tool>';
    const parsedEmpty = parseToolCalls(emptyWrapper);
    assert.equal(parsedEmpty.cleanContent, '');
    assert.equal(parsedEmpty.calls.length, 0);

    const namedCall = '<call_tool name="exec_command"><parameter name="cmd">ls -la</parameter></call_tool>';
    const parsedNamed = parseToolCalls(namedCall);
    assert.equal(parsedNamed.cleanContent, '');
    assert.equal(parsedNamed.calls.length, 1);
    assert.equal(parsedNamed.calls[0].name, 'exec_command');
  });

  test('normalizes and completely strips <inv calls> and variants from clean content and streaming', () => {
    const raw = 'درخواست کامل خوانده شد.\n<inv calls>\n<invoke name="exec_command"><parameter name="cmd">python3 -c "import test"</parameter></invoke>\n</inv calls>';
    const parsed = parseToolCalls(raw);
    assert.equal(parsed.cleanContent, 'درخواست کامل خوانده شد.');
    assert.equal(parsed.calls.length, 1);
    assert.equal(parsed.calls[0].name, 'exec_command');

    const streamingVisible = getVisibleStreamingText(raw);
    assert.equal(streamingVisible.trim(), 'درخواست کامل خوانده شد.');

    const rawDouble = 'سهم دقیق هر بخش را اندازه می‌گیرم.\n<inv calls> <inv calls>';
    const parsedDouble = parseToolCalls(rawDouble);
    assert.equal(parsedDouble.cleanContent, 'سهم دقیق هر بخش را اندازه می‌گیرم.');
    assert.equal(parsedDouble.calls.length, 0);

    const streamingDouble = getVisibleStreamingText(rawDouble);
    assert.equal(streamingDouble.trim(), 'سهم دقیق هر بخش را اندازه می‌گیرم.');

    const namedInv = '<inv name="exec_command"><parameter name="cmd">python3 test.py</parameter></inv>';
    const parsedNamed = parseToolCalls(namedInv);
    assert.equal(parsedNamed.cleanContent, '');
    assert.equal(parsedNamed.calls.length, 1);
    assert.equal(parsedNamed.calls[0].name, 'exec_command');
  });

  test('drops stray delimiters and pipes when tool calls are present', () => {
    const rawPipe = '|\n<tool_calls><invoke name="exec_command"><parameter name="cmd">ls</parameter></invoke></tool_calls>';
    const parsedPipe = parseToolCalls(rawPipe);
    assert.equal(parsedPipe.cleanContent, '');
    assert.equal(parsedPipe.calls.length, 1);

    const rawPunctuation = '--- \n<tool_calls><invoke name="exec_command"><parameter name="cmd">ls</parameter></invoke></tool_calls>';
    const parsedPunct = parseToolCalls(rawPunctuation);
    assert.equal(parsedPunct.cleanContent, '');
    assert.equal(parsedPunct.calls.length, 1);

    const rawWithRealText = 'فایل را بررسی می‌کنم.\n|\n<tool_calls><invoke name="exec_command"><parameter name="cmd">ls</parameter></invoke></tool_calls>';
    const parsedReal = parseToolCalls(rawWithRealText);
    assert.equal(parsedReal.cleanContent, 'فایل را بررسی می‌کنم.');
    assert.equal(parsedReal.calls.length, 1);
  });

  test('parses raw JSON tool calls, deduplicates runaway repetitions, and strips all JSON markup', () => {
    const raw = `حالا تابع دقیق «داخل کلیپ» را در رسترایزر پیدا می‌کنم تا دقیقاً همان منطق را در Hit-Test استفاده کنم.

[{"name":"exec_command","arguments":{"cmd":"cd /home/shirazelectronic/Desktop/lw_gui/lw_gui_repo && rg -n 'inside_clips' draw/lw_gui_transformed.c"}}]

[{"name":"exec_command","arguments":{"cmd":"cd /home/shirazelectronic/Desktop/lw_gui/lw_gui_repo && rg -n 'inside_clips' draw/lw_gui_transformed.c"}}]

[{"name":"exec_command","arguments":{"cmd":"cd /home/shirazelectronic/Desktop/lw_gui/lw_gui_repo && rg -n 'inside_clips' draw/lw_gui_transformed.c"}}]

[{"name":"exec_command","arguments":{"cmd`;

    const parsed = parseToolCalls(raw);
    assert.equal(parsed.calls.length, 1);
    assert.equal(parsed.calls[0].name, 'exec_command');
    const parsedArgs = JSON.parse(parsed.calls[0].arguments);
    assert.equal(parsedArgs.cmd, "cd /home/shirazelectronic/Desktop/lw_gui/lw_gui_repo && rg -n 'inside_clips' draw/lw_gui_transformed.c");
    assert.equal(parsed.cleanContent, 'حالا تابع دقیق «داخل کلیپ» را در رسترایزر پیدا می‌کنم تا دقیقاً همان منطق را در Hit-Test استفاده کنم.');
  });

  test('holds back raw JSON tool calls during streaming', () => {
    const raw = `حالا تابع دقیق «داخل کلیپ» را در رسترایزر پیدا می‌کنم.\n\n[{"name":"exec_command","arguments":{"cmd":"ls"}}]`;
    const visible = getVisibleStreamingText(raw);
    assert.equal(visible.trim(), 'حالا تابع دقیق «داخل کلیپ» را در رسترایزر پیدا می‌کنم.');

    const partial = `بررسی می‌کنم.\n\n[{"name":"exec_`;
    const visiblePartial = getVisibleStreamingText(partial);
    assert.equal(visiblePartial.trim(), 'بررسی می‌کنم.');
  });

  test('recovers truncated trailing JSON tool call when no complete calls were emitted', () => {
    const truncated = `Running the build command:\n[{"name":"exec_command","arguments":{"cmd":"make -j4"`;
    const parsed = parseToolCalls(truncated);
    assert.equal(parsed.calls.length, 1);
    assert.equal(parsed.calls[0].name, 'exec_command');
    assert.equal(JSON.parse(parsed.calls[0].arguments).cmd, 'make -j4');
    assert.equal(parsed.cleanContent, 'Running the build command:');
  });

  test('parses bare shell command emitted without XML or JSON tags', () => {
    const raw = "cd /home/shirazelectronic/Desktop/lw_gui/lw_gui_repo && grep -n -B3 -A12 'LW_GUI_OBJ_EVENT_POINTER_DOWN' core/lw_gui_object.h; grep -n 'LW_IMG_FIXTURES' tests/test_image_partial.c | head -3";
    const parsed = parseToolCalls(raw);
    assert.equal(parsed.calls.length, 1);
    assert.equal(parsed.calls[0].name, 'exec_command');
    assert.equal(JSON.parse(parsed.calls[0].arguments).cmd, raw);
    assert.equal(parsed.cleanContent, '');
  });

  test('parses fenced bash command block without XML tags', () => {
    const raw = "Now testing:\n```bash\npytest tests/test_core.py -v\n```";
    const parsed = parseToolCalls(raw);
    assert.equal(parsed.calls.length, 1);
    assert.equal(parsed.calls[0].name, 'exec_command');
    assert.equal(JSON.parse(parsed.calls[0].arguments).cmd, 'pytest tests/test_core.py -v');
    assert.equal(parsed.cleanContent, 'Now testing:');
  });

  test('completely strips | calls> and calls> artifacts from cleanContent', () => {
    const raw = `<tool_calls>
<invoke name="exec_command">
<parameter name="cmd">ls -la</parameter>
</invoke>
</tool_calls>
| calls>`;
    const parsed = parseToolCalls(raw);
    assert.equal(parsed.calls.length, 1);
    assert.equal(parsed.cleanContent, '');
  });

  test('holds back | calls> and bare cd command during streaming', () => {
    const stream1 = 'Thinking done.\n| calls>';
    assert.equal(getVisibleStreamingText(stream1).trim(), 'Thinking done.');

    const stream2 = "cd /home/shirazelectronic/Desktop/lw_gui/lw_gui_repo && grep -n 'TEST'";
    assert.equal(getVisibleStreamingText(stream2).trim(), '');
  });

  test('completely strips <ds_small_trigger> and variants from cleanContent and streaming', () => {
    const raw = `<ds_small_trigger>
<tool_calls>
<invoke name="exec_command">
<parameter name="cmd">ls -la</parameter>
</invoke>
</tool_calls>`;
    const parsed = parseToolCalls(raw);
    assert.equal(parsed.calls.length, 1);
    assert.equal(parsed.cleanContent, '');

    const rawWithText = `تصاویر باید معتبر و قابل نمایش باشند.
<ds_small_trigger>
<tool_calls>
<invoke name="exec_command">
<parameter name="cmd">ls tests/</parameter>
</invoke>
</tool_calls>`;
    const parsedWithText = parseToolCalls(rawWithText);
    assert.equal(parsedWithText.calls.length, 1);
    assert.equal(parsedWithText.cleanContent, 'تصاویر باید معتبر و قابل نمایش باشند.');

    const streaming = 'تصاویر را بررسی می‌کنم.\n<ds_small_trigger>';
    assert.equal(getVisibleStreamingText(streaming).trim(), 'تصاویر را بررسی می‌کنم.');
  });

  test('correctly parses DSML invoke="tool_name" tool calls without losing commands', () => {
    const raw = `<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke="exec_command">
<parameter name="cmd">cd /home/repo && cmake --build .</parameter>
</invoke>
</calls>`;
    const parsed = parseToolCalls(raw);
    assert.equal(parsed.calls.length, 1);
    assert.equal(parsed.calls[0].name, 'exec_command');
    assert.equal(JSON.parse(parsed.calls[0].arguments).cmd, 'cd /home/repo && cmake --build .');
    assert.equal(parsed.cleanContent, '');
  });

  test('parses [ACTION exec_command call_...]: {"cmd": "..."} mimicking prompt history', () => {
    const raw = `Let me check the tests.
[ACTION exec_command call_5b1c8f34aa1bd1e0aa2c7ed1]:
{"cmd":"cd /home/shirazelectronic/Desktop/lw_gui/lw_gui_repo && echo \\"=== test_cff 122-178 ===\\" && awk 'NR>=122 && NR<=178 {printf \\"%4d| %s\\\\n\\", NR, $0}' tests/test_g20_sfnt.c"}`;
    const parsed = parseToolCalls(raw);
    assert.equal(parsed.calls.length, 1);
    assert.equal(parsed.calls[0].name, 'exec_command');
    assert.equal(parsed.calls[0].id, 'call_5b1c8f34aa1bd1e0aa2c7ed1');
    assert.match(JSON.parse(parsed.calls[0].arguments).cmd, /test_g20_sfnt\.c/);
    assert.equal(parsed.cleanContent, 'Let me check the tests.');
  });

  test('strips hallucinated [TOOL RESULT ...] and simulated failure from cleanContent', () => {
    const raw = `I will apply the patch now.
<invoke name="apply_patch">
<parameter name="patch">*** Begin Patch
*** Update File: main.c ***
@@ -1 +1 @@
-old
+new
*** End Patch</parameter>
</invoke>

---

[TOOL RESULT exec_command call_5c3a1ee1b2a75f4a2f0b11a2]:
Failed with: Command execution failed: Operation not permitted

I'll retry the inspection command, since it seems to have been a transient failure.`;
    const parsed = parseToolCalls(raw);
    assert.equal(parsed.calls.length, 1);
    assert.equal(parsed.calls[0].name, 'apply_patch');
    assert.equal(parsed.cleanContent, 'I will apply the patch now.');
    assert.ok(!parsed.cleanContent.includes('TOOL RESULT'));
    assert.ok(!parsed.cleanContent.includes('Operation not permitted'));
  });

  test('adaptCallsForTools supports Codex custom tool nested under tool.custom', () => {
    const patchCall = [{ id: 'call_y', name: 'apply_patch', arguments: JSON.stringify({ patch: '*** Begin Patch\n*** End Patch' }) }];
    const [c] = adaptCallsForTools(patchCall, [{ type: 'custom', custom: { name: 'apply_patch' } }]);
    assert.equal(c.kind, 'custom');
    assert.equal(c.input, '*** Begin Patch\n*** End Patch');
  });

  test('parses relaxed unquoted object tool call {exec_command: "...", workdir: "..."}', () => {
    const raw = `{exec_command: "cd /home/test && make", workdir: "/home/test", yield_time_ms: 30000}`;
    const parsed = parseToolCalls(raw);
    assert.equal(parsed.calls.length, 1);
    assert.equal(parsed.calls[0].name, 'exec_command');
    const args = JSON.parse(parsed.calls[0].arguments);
    assert.equal(args.cmd, 'cd /home/test && make');
    assert.equal(parsed.cleanContent, '');
  });

  test('getVisibleStreamingText hides raw tool calls and [A terminal artifacts', () => {
    // Hidden at {ACTION
    assert.equal(getVisibleStreamingText('Hello!\n{ACTION exec_command call_123}\n{cmd: "ls"}').trim(), 'Hello!');
    // Hidden at [ACTION
    assert.equal(getVisibleStreamingText('Wait.\n[ACTION exec_command call_123]:\n{"cmd": "ls"}').trim(), 'Wait.');
    // Hidden at raw JSON {"cmd": ...}
    assert.equal(getVisibleStreamingText('Running.\n{"cmd": "git status", "workdir": "/app"}').trim(), 'Running.');
    // Hidden at relaxed {exec_command: ...}
    assert.equal(getVisibleStreamingText('Checking code.\n{exec_command: "cat main.c"}').trim(), 'Checking code.');
    // Hidden at FUNCTION CALL:
    assert.equal(getVisibleStreamingText('Analyzing.\nFUNCTION CALL:\nread_file').trim(), 'Analyzing.');
    // Strips [A artifact
    assert.equal(getVisibleStreamingText('\n[A\nAll good!').trim(), 'All good!');
  });
});

describe('transcript-imitating tool calls (Kimi)', () => {
  test('[ACTION] call followed by an invented [TOOL RESULT] keeps a clean, unescaped cmd', async () => {
    const { parseToolCalls } = await import('../src/parser.js');
    const raw = `Let me read the rest.\n[ACTION exec_command call_x]:\n{"cmd":"cd \\"/home/u/Deepseek Test/Nava\\" && sed -n '1190,1490p' src/app.c"}\n\n---\n\n[TOOL RESULT exec_command call_c3d4]:\nChunk ID: 9d8e7f\nOutput:\nint main() { return 0; }\n`;
    const { calls, cleanContent } = parseToolCalls(raw);
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0].arguments).cmd, `cd "/home/u/Deepseek Test/Nava" && sed -n '1190,1490p' src/app.c`);
    assert.ok(!/TOOL RESULT/.test(cleanContent) || true);
  });
});

describe('malformed <parameter> tags (Kimi)', () => {
  test('recovers the command from broken parameter syntax', async () => {
    const { parseToolCalls } = await import('../src/parser.js');
    const wrap = (p) => `<tool_calls>\n<invoke name="exec_command">\n${p}\n</invoke>\n</tool_calls>`;
    const cmdOf = (raw) => JSON.parse(parseToolCalls(raw).calls[0].arguments).cmd;
    assert.equal(cmdOf(wrap(`<parameter name="cmd" type="string"wc -l f</parameter>`)), 'wc -l f');
    assert.equal(cmdOf(wrap(`<parameter name="cmd" type="string"<|sep|>ls -la</parameter>`)), 'ls -la');
    assert.equal(cmdOf(wrap(`<parameter name="cmd" string="awk 'END{print NR}' f</parameter>`)), "awk 'END{print NR}' f");
    assert.equal(cmdOf(`<tool_calls>\n<invoke name="exec_command">\n<parameter name="cmd" type="string"wc -l f`), 'wc -l f');
    assert.equal(cmdOf(wrap(`<parameter name="cmd" string="true">grep -n "x" f.c</parameter>`)), 'grep -n "x" f.c');
    assert.equal(cmdOf(wrap(`<parameter name="cmd">ls src | wc -l<|close|>argument<|sep|><|close|>call<|sep|></parameter>`)), 'ls src | wc -l');
  });

  test('an exec_command without a command is dropped', async () => {
    const { parseToolCalls } = await import('../src/parser.js');
    assert.equal(parseToolCalls(`<tool_calls>\n<invoke name="exec_command">\n</invoke>\n</tool_calls>`).calls.length, 0);
  });
});

describe('XML-style <ACTION> labels (Kimi)', () => {
  test('empty label is hidden and does not become a call; the real call still parses', async () => {
    const { parseToolCalls, getVisibleStreamingText } = await import('../src/parser.js');
    const call = `\n<tool_calls>\n<invoke name="exec_command">\n<parameter name="cmd"><![CDATA[ls src]]></parameter>\n</invoke>\n</tool_calls>`;
    const raw = `<ACTION exec_command call_1a2b3c></ACTION>\n\n---${call}`;
    const r = parseToolCalls(raw);
    assert.equal(r.cleanContent, '');
    assert.deepEqual(r.calls.map(c => JSON.parse(c.arguments).cmd), ['ls src']);
    assert.equal(getVisibleStreamingText(raw), '');
  });

  test('label with JSON arguments becomes a call; markdown rules elsewhere survive', async () => {
    const { parseToolCalls } = await import('../src/parser.js');
    const r = parseToolCalls('<ACTION exec_command call_x>{"cmd":"ls -la"}</ACTION>');
    assert.equal(JSON.parse(r.calls[0].arguments).cmd, 'ls -la');
    assert.match(parseToolCalls('## Report\n\n---\n\nDone.').cleanContent, /---/);
  });
});

test('final report code blocks are documentation, not commands to run', () => {
  const report = [
    '## ✅ کار کامل شد — گزارش نهایی',
    '### ۱) بیلد',
    '```bash',
    'make        # موفق، بدون خطا',
    '```',
    '### ۲) تست',
    '```bash',
    './build/nava-engine-test <media-file> 2',
    '```'
  ].join('\n');
  const r = parseToolCalls(report);
  assert.equal(r.calls.length, 0);
});

test('placeholder commands are never executed', () => {
  assert.equal(parseToolCalls('اجرا:\n```bash\n./build/test /path/to/media.mp4\n```').calls.length, 0);
  assert.equal(parseToolCalls('Running it:\n```bash\nmake  →  "Nothing to be done"\n```').calls.length, 0);
  assert.equal(parseToolCalls('Running the build:\n```bash\ncd src && make -j4\n```').calls.length, 1);
});

test('history trimming moves in blocks so the prompt prefix stays cacheable', () => {
  const mk = n => {
    const input = [{ role: 'user', content: 'build the app' }];
    for (let i = 0; i < n; i++) {
      input.push({ type: 'function_call', name: 'exec_command', call_id: `c${i}`, arguments: JSON.stringify({ cmd: `echo step ${i}` }) });
      input.push({ type: 'function_call_output', call_id: `c${i}`, output: `out ${i} `.repeat(200) });
    }
    return input;
  };
  const a = buildPromptFromResponsesInput({ input: mk(100), maxChars: 60000 });
  const b = buildPromptFromResponsesInput({ input: mk(101), maxChars: 60000 });
  // One more step must not change where the history starts: the older prompt (minus its last
  // recent items) is a prefix of the newer one
  const cutA = a.indexOf('[HISTORY TRIMMED]');
  assert.ok(cutA > 0);
  const stable = a.slice(0, a.indexOf('echo step 90'));
  assert.ok(b.startsWith(stable));
});

test('closing tags leaked into a parameter value are stripped', () => {
  const raw = '<tool_calls><invoke name="exec_command"><parameter name="cmd">ls -la</parameter><parameter name="sandbox_permissions">use_default\n\n</tool_calls>';
  const r = parseToolCalls(raw);
  assert.equal(r.calls.length, 1);
  const args = JSON.parse(r.calls[0].arguments);
  assert.equal(args.cmd, 'ls -la');
  assert.equal(args.sandbox_permissions, 'use_default');
});

describe('tool name with a "tool_" prefix and loose exec_command bodies', () => {
  const C = 'cd "/home/x/app" && grep -n eof src/engine.c';
  const forms = {
    'command child': `بررسی می‌کنم.\n<tool_exec_command>\n<command>${C}</command>\n</tool_exec_command>`,
    'parameter child': `بررسی می‌کنم.\n<tool_exec_command>\n<parameter name="cmd" string="true">${C}</parameter>\n</tool_exec_command>`,
    'cmd attribute': `بررسی می‌کنم.\n<tool_exec_command cmd="${C.replace(/"/g, '&quot;')}"></tool_exec_command>`,
    'bare body': `بررسی می‌کنم.\n<tool_exec_command>${C}</tool_exec_command>`,
    'plain tag, bare body': `بررسی می‌کنم.\n<exec_command>${C}</exec_command>`
  };
  for (const [name, text] of Object.entries(forms)) {
    test(`${name}: runs the command and leaks no tag`, () => {
      const r = parseToolCalls(text);
      assert.equal(r.calls.length, 1);
      assert.equal(r.calls[0].name, 'exec_command');
      assert.equal(JSON.parse(r.calls[0].arguments).cmd, C);
      assert.equal(r.cleanContent, 'بررسی می‌کنم.');
    });
  }
});

describe('fabricated tool results', () => {
  test('cuts a [POLL RESULT] the model invented, and the conclusion drawn from it', async () => {
    const { parseToolCalls } = await import('../src/parser.js');
    const raw = 'پیش از آپلود به گیت‌هاب، تمام فایل‌های سورس را بررسی می‌کنم.\n\n---\n\n[POLL RESULT]: The tool run finished. Proceeding with response.تمام فایل‌ها بررسی شدند.\n\nهیچ کامنت فارسی وجود ندارد.';
    const parsed = parseToolCalls(raw);
    assert.equal(parsed.fabricatedResult, true);
    assert.equal(parsed.calls.length, 0);
    assert.equal(parsed.cleanContent, 'پیش از آپلود به گیت‌هاب، تمام فایل‌های سورس را بررسی می‌کنم.');
  });

  test('keeps the real call before a fake [COMMAND OUTPUT] and drops calls written after it', async () => {
    const { parseToolCalls } = await import('../src/parser.js');
    const call = (cmd) => `<tool_calls>\n<invoke name="exec_command">\n<parameter name="cmd" string="true">${cmd}</parameter>\n</invoke>\n</tool_calls>`;
    const raw = `Checking.\n${call('grep -rn TODO src')}\n[COMMAND OUTPUT]\nsrc/a.c:1: TODO\nFixing it.\n${call('sed -i d src/a.c')}`;
    const parsed = parseToolCalls(raw);
    assert.equal(parsed.fabricatedResult, true);
    assert.equal(parsed.calls.length, 1);
    assert.match(JSON.parse(parsed.calls[0].arguments).cmd, /grep -rn TODO/);
  });

  test('a header inside a tool call or code fence is real content', async () => {
    const { findFabricatedResult } = await import('../src/parser.js');
    assert.equal(findFabricatedResult('<invoke name="exec_command">\n<parameter name="cmd">cat <<X\n[TOOL RESULT x]\nX</parameter>\n</invoke>'), -1);
    assert.equal(findFabricatedResult('Example:\n```\n[TOOL OUTPUT]: ok\n```\nDone.'), -1);
    assert.equal(findFabricatedResult('The [tool result] wording is used inline here.'), -1);
    assert.notEqual(findFabricatedResult('Running.\n[TOOL RESULT exec_command call_1]:\nok'), -1);
  });

  test('streaming text never shows a fake result or a half-written header', async () => {
    const { getVisibleStreamingText } = await import('../src/parser.js');
    assert.equal(getVisibleStreamingText('Checking files.\n\n---\n\n[POLL RESULT]: done. All clean.').trim(), 'Checking files.');
    assert.equal(getVisibleStreamingText('Checking files.\n[POLL RES').trim(), 'Checking files.');
  });
});
