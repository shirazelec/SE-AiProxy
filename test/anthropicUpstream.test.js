import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chatToAnthropic, anthropicToChat, anthropicBaseUrl } from '../src/anthropicUpstream.js';
import { forwardChatCompletions, streamOpenAIChatAsResponsesChunks, adaptOpenAIPayload } from '../src/providerRunner.js';
import { PROVIDER_PRESETS } from '../src/providerPresets.js';
import { tokenPool } from '../src/tokenPool.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function sseResponse(events) {
  const text = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  // Split in odd places to exercise line buffering
  const chunks = [bytes.slice(0, 37), bytes.slice(37, 120), bytes.slice(120)];
  return new Response(new ReadableStream({
    start(c) { for (const ch of chunks) c.enqueue(ch); c.close(); }
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function fakeRes() {
  const r = { chunks: [], headers: null, status: null, body: null, writableEnded: false, destroyed: false };
  r.writeHead = (s, h) => { r.status = s; r.headers = h; };
  r.flushHeaders = () => {};
  r.write = d => { r.chunks.push(String(d)); return true; };
  r.end = () => { r.writableEnded = true; };
  r.json = b => { r.body = b; r.writableEnded = true; return r; };
  return r;
}

const STREAM_EVENTS = [
  { type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: ' world' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'shell', input: {} } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"cmd":' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"ls"}' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } },
  { type: 'message_stop' }
];

describe('Anthropic upstream: request translation', () => {
  test('presets exist for official OpenAI and Anthropic', () => {
    assert.equal(PROVIDER_PRESETS.openai.baseUrl, 'https://api.openai.com/v1');
    assert.equal(PROVIDER_PRESETS.openai.protocol, 'chat_completions');
    assert.equal(PROVIDER_PRESETS.anthropic.baseUrl, 'https://api.anthropic.com/v1');
    assert.equal(PROVIDER_PRESETS.anthropic.protocol, 'anthropic_messages');
  });

  test('base URL accepts with or without /v1', () => {
    assert.equal(anthropicBaseUrl({ baseUrl: 'https://api.anthropic.com' }), 'https://api.anthropic.com/v1');
    assert.equal(anthropicBaseUrl({ baseUrl: 'https://api.anthropic.com/v1/' }), 'https://api.anthropic.com/v1');
  });

  test('maps system, tools, tool calls, tool results and images', () => {
    const out = chatToAnthropic({
      model: 'x',
      max_tokens: 500,
      temperature: 0.2,
      stop: 'END',
      reasoning_effort: 'high',
      tool_choice: 'required',
      parallel_tool_calls: false,
      tools: [{ type: 'function', function: { name: 'shell', description: 'run', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } }],
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'developer', content: 'Use tools.' },
        { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'a.txt' },
        { role: 'tool', tool_call_id: 'call_2', content: 'b.txt' }
      ]
    }, { model: 'claude-opus-5-5' });

    assert.equal(out.model, 'claude-opus-5-5');
    assert.equal(out.max_tokens, 500);
    assert.equal(out.system, 'Be brief.\n\nUse tools.');
    assert.equal(out.temperature, undefined);
    assert.deepEqual(out.stop_sequences, ['END']);
    assert.deepEqual(out.output_config, { effort: 'high' });
    assert.deepEqual(out.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
    assert.equal(out.tools[0].input_schema.properties.cmd.type, 'string');
    assert.equal(out.messages.length, 3);
    assert.deepEqual(out.messages[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
    assert.deepEqual(out.messages[1].content[0], { type: 'tool_use', id: 'call_1', name: 'shell', input: { cmd: 'ls' } });
    // Both tool results go into a single user turn
    assert.equal(out.messages[2].role, 'user');
    assert.equal(out.messages[2].content.length, 2);
    assert.equal(out.messages[2].content[1].tool_use_id, 'call_2');
  });

  test('never starts or ends on an assistant turn', () => {
    const out = chatToAnthropic({ messages: [{ role: 'assistant', content: 'hi' }] }, { model: 'm' });
    assert.equal(out.messages[0].role, 'user');
    assert.equal(out.messages[out.messages.length - 1].role, 'user');
  });

  test('maps a non-streaming reply to chat.completion', () => {
    const chat = anthropicToChat({
      id: 'msg_1', model: 'claude-opus-5-5', stop_reason: 'tool_use',
      content: [{ type: 'text', text: 'Running' }, { type: 'tool_use', id: 'toolu_1', name: 'shell', input: { cmd: 'ls' } }],
      usage: { input_tokens: 5, cache_read_input_tokens: 3, output_tokens: 2 }
    });
    assert.equal(chat.object, 'chat.completion');
    assert.equal(chat.choices[0].finish_reason, 'tool_calls');
    assert.equal(chat.choices[0].message.content, 'Running');
    assert.equal(chat.choices[0].message.tool_calls[0].function.arguments, '{"cmd":"ls"}');
    assert.equal(chat.usage.prompt_tokens, 8);
    assert.equal(chat.usage.total_tokens, 10);
  });
});

describe('Anthropic upstream: forwarding', () => {
  const provider = { id: 'acc_ant', type: 'anthropic', protocol: 'anthropic_messages', token: 'sk-ant-test', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-opus-5-5', label: 'Anthropic test' };

  test('streams chat completions as OpenAI chunks with tool calls', async () => {
    tokenPool.tokens = [{ ...provider, status: 'active' }];
    let sent;
    globalThis.fetch = async (url, opts) => { sent = { url, opts }; return sseResponse(STREAM_EVENTS); };
    const res = fakeRes();
    await forwardChatCompletions({ provider, body: { model: 'gpt', stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hi' }] }, res, isStream: true });

    assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(sent.opts.headers['x-api-key'], 'sk-ant-test');
    assert.equal(sent.opts.headers['anthropic-version'], '2023-06-01');
    assert.equal(JSON.parse(sent.opts.body).model, 'claude-opus-5-5');

    const datas = res.chunks.join('').split('\n\n').filter(Boolean).map(l => l.replace(/^data: /, ''));
    assert.equal(datas.at(-1), '[DONE]');
    const chunks = datas.slice(0, -1).map(d => JSON.parse(d));
    const text = chunks.map(c => c.choices[0]?.delta?.content || '').join('');
    assert.equal(text, 'Hello world');
    assert.equal(chunks.map(c => c.choices[0]?.delta?.reasoning_content || '').join(''), 'hmm');
    const toolArgs = chunks.flatMap(c => c.choices[0]?.delta?.tool_calls || []).map(t => t.function?.arguments || '').join('');
    assert.equal(toolArgs, '{"cmd":"ls"}');
    assert.ok(chunks.some(c => c.choices[0]?.finish_reason === 'tool_calls'));
    assert.equal(chunks.at(-1).usage.completion_tokens, 7);
    assert.ok(res.writableEnded);
  });

  test('non-streaming chat completion is translated back', async () => {
    tokenPool.tokens = [{ ...provider, status: 'active' }];
    globalThis.fetch = async () => new Response(JSON.stringify({
      id: 'msg_2', model: 'claude-opus-5-5', stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 1, output_tokens: 1 }
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    const res = fakeRes();
    await forwardChatCompletions({ provider, body: { messages: [{ role: 'user', content: 'hi' }] }, res, isStream: false });
    assert.equal(res.body.choices[0].message.content, 'OK');
    assert.equal(res.body.choices[0].finish_reason, 'stop');
  });

  test('prompt path (Codex / Claude Code adapters) collects text and thinking', async () => {
    tokenPool.tokens = [{ ...provider, status: 'active' }];
    globalThis.fetch = async () => sseResponse(STREAM_EVENTS);
    const seen = [];
    const result = await streamOpenAIChatAsResponsesChunks({ provider, prompt: 'hi', onChunk: c => seen.push(c) });
    assert.equal(result.content, 'Hello world');
    assert.equal(result.thinkingContent, 'hmm');
    assert.ok(seen.some(c => c.type === 'thinking'));
  });

  test('upstream errors carry the HTTP status for failover', async () => {
    tokenPool.tokens = [{ ...provider, status: 'active' }];
    globalThis.fetch = async () => new Response(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), { status: 529 });
    await assert.rejects(
      forwardChatCompletions({ provider, body: { messages: [{ role: 'user', content: 'hi' }] }, res: fakeRes(), isStream: false }),
      err => err.status === 529
    );
  });
});

describe('OpenAI official: parameter rules', () => {
  test('reasoning models get max_completion_tokens and no sampling params', () => {
    const p = adaptOpenAIPayload({ type: 'openai' }, { model: 'gpt-5-mini', max_tokens: 100, temperature: 0.3 });
    assert.equal(p.max_tokens, undefined);
    assert.equal(p.max_completion_tokens, 100);
    assert.equal(p.temperature, undefined);
  });

  test('other providers are left untouched', () => {
    const p = adaptOpenAIPayload({ type: 'groq' }, { model: 'gpt-5-mini', max_tokens: 100, temperature: 0.3 });
    assert.equal(p.max_tokens, 100);
    assert.equal(p.temperature, 0.3);
  });
});
