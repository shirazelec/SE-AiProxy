// Official Anthropic API (api.anthropic.com) as an upstream provider.
//
// The rest of the proxy talks OpenAI Chat Completions to API providers, so this module translates
// in both directions:
//   - chatToAnthropic():        OpenAI chat request  -> Anthropic Messages request
//   - anthropicToChat():        Anthropic message    -> OpenAI chat.completion
//   - pipeAnthropicStreamAsChat(): Anthropic SSE    -> OpenAI chat.completion.chunk SSE
//   - readAnthropicStream():    Anthropic SSE        -> plain text / thinking deltas (prompt path)
// Raw fetch is used on purpose: every upstream call goes through upstreamFetch (direct / proxy routing).

import { upstreamFetch } from './directFetch.js';
import { guardedRead, STREAM_STALL_TIMEOUT_MS, stallReason } from './upstreamGuard.js';

export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com/v1';
// Enough room for long answers (a whole file in one tool call) on every current Claude model
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 32000;
const USER_AGENT = 'SE-AiProxy/1.0.0 (Anthropic-Messages/1.0)';

export function isAnthropicProvider(provider) {
  return provider?.type === 'anthropic' || provider?.protocol === 'anthropic_messages';
}

export function anthropicBaseUrl(provider) {
  let base = (provider?.baseUrl || ANTHROPIC_DEFAULT_BASE_URL).replace(/\/+$/, '');
  // Accept "https://api.anthropic.com" as well as ".../v1"
  if (!/\/v\d+$/.test(base)) base += '/v1';
  return base;
}

export function anthropicHeaders(apiKey) {
  return {
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': USER_AGENT
  };
}

// ── Request translation ────────────────────────────────────────────────

function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(p => (typeof p === 'string' ? p : p?.text ?? p?.content ?? '')).filter(Boolean).join('\n');
  }
  return String(content.text ?? '');
}

function imageBlock(part) {
  const url = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
  if (!url) return null;
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
  return { type: 'image', source: { type: 'url', url } };
}

function userBlocks(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const part of content) {
    if (typeof part === 'string') {
      if (part) blocks.push({ type: 'text', text: part });
    } else if (part?.type === 'text' || part?.type === 'input_text') {
      if (part.text) blocks.push({ type: 'text', text: part.text });
    } else if (part?.type === 'image_url' || part?.type === 'input_image') {
      const img = imageBlock(part.type === 'input_image' ? { image_url: part.image_url } : part);
      if (img) blocks.push(img);
    } else if (part?.type === 'image' && part.source) {
      blocks.push(part); // already Anthropic-shaped
    }
  }
  return blocks;
}

function parseArgs(args) {
  if (args && typeof args === 'object') return args;
  try {
    const v = JSON.parse(args || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { value: v };
  } catch {
    return { raw: String(args) };
  }
}

function toolChoiceFor(choice, parallel) {
  // Forced choices ("required" / a named function) return 400 on the newest Claude models, so they map
  // to "auto"; the tool list and the prompt still steer the model to call a tool.
  if (choice === 'none') return { type: 'none' };
  const tc = { type: 'auto' };
  if (parallel === false) tc.disable_parallel_tool_use = true;
  return tc;
}

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** OpenAI Chat Completions body -> Anthropic Messages body. */
export function chatToAnthropic(body = {}, { model, maxTokens } = {}) {
  const systemParts = [];
  const messages = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = messages[messages.length - 1];
    // The API wants alternating turns; merge consecutive same-role messages
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: [...blocks] });
  };

  for (const msg of body.messages || []) {
    const role = msg?.role;
    if (role === 'system' || role === 'developer') {
      const t = textOf(msg.content);
      if (t) systemParts.push(t);
    } else if (role === 'user') {
      push('user', userBlocks(msg.content));
    } else if (role === 'assistant') {
      const blocks = [];
      const t = textOf(msg.content);
      if (t) blocks.push({ type: 'text', text: t });
      for (const call of msg.tool_calls || []) {
        if (call?.type && call.type !== 'function') continue;
        blocks.push({
          type: 'tool_use',
          id: call.id || `toolu_${Math.random().toString(36).slice(2, 14)}`,
          name: call.function?.name || 'tool',
          input: parseArgs(call.function?.arguments)
        });
      }
      push('assistant', blocks);
    } else if (role === 'tool' || role === 'function') {
      push('user', [{
        type: 'tool_result',
        tool_use_id: msg.tool_call_id || msg.name || 'tool',
        content: textOf(msg.content) || '(empty)'
      }]);
    }
  }

  if (!messages.length) messages.push({ role: 'user', content: [{ type: 'text', text: '(empty)' }] });
  if (messages[0].role !== 'user') messages.unshift({ role: 'user', content: [{ type: 'text', text: '(continue)' }] });
  // Assistant prefill is rejected by current Claude models: never end on an assistant turn
  if (messages[messages.length - 1].role === 'assistant') {
    messages.push({ role: 'user', content: [{ type: 'text', text: 'Continue.' }] });
  }

  const out = {
    model: model || body.model,
    max_tokens: Number(body.max_completion_tokens || body.max_tokens) || maxTokens || ANTHROPIC_DEFAULT_MAX_TOKENS,
    messages
  };
  if (systemParts.length) out.system = systemParts.join('\n\n');

  const tools = (body.tools || [])
    .filter(t => t && (t.type === 'function' || t.function))
    .map(t => ({
      name: t.function?.name || t.name,
      description: t.function?.description || t.description || '',
      input_schema: t.function?.parameters || t.parameters || { type: 'object', properties: {} }
    }))
    .filter(t => t.name);
  if (tools.length) {
    out.tools = tools;
    out.tool_choice = toolChoiceFor(body.tool_choice, body.parallel_tool_calls);
  }

  if (body.stop) {
    const stops = (Array.isArray(body.stop) ? body.stop : [body.stop]).filter(s => typeof s === 'string' && s.trim());
    if (stops.length) out.stop_sequences = stops;
  }

  const effort = body.reasoning_effort || body.reasoning?.effort;
  if (effort) {
    const e = effort === 'minimal' || effort === 'none' ? 'low' : String(effort).toLowerCase();
    if (EFFORTS.has(e)) out.output_config = { effort: e };
  }
  if (body.user) out.metadata = { user_id: String(body.user).slice(0, 256) };
  // temperature / top_p / top_k are not forwarded: current Claude models reject them with a 400
  if (body.stream) out.stream = true;
  return out;
}

// ── Response translation ───────────────────────────────────────────────

const FINISH = { end_turn: 'stop', stop_sequence: 'stop', max_tokens: 'length', tool_use: 'tool_calls', pause_turn: 'stop', refusal: 'content_filter' };
export const finishReasonFor = reason => FINISH[reason] || (reason ? 'stop' : null);

function chatUsage(u = {}) {
  const prompt = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const completion = u.output_tokens || 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: u.cache_read_input_tokens || 0 }
  };
}

/** Anthropic message -> OpenAI chat.completion. */
export function anthropicToChat(msg = {}, model) {
  let text = '';
  let reasoning = '';
  const toolCalls = [];
  for (const block of msg.content || []) {
    if (block.type === 'text') text += block.text || '';
    else if (block.type === 'thinking') reasoning += block.thinking || '';
    else if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } });
    }
  }
  const message = { role: 'assistant', content: text || (toolCalls.length ? null : '') };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: msg.id ? `chatcmpl-${msg.id}` : `chatcmpl-${Date.now().toString(36)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: msg.model || model,
    choices: [{ index: 0, message, finish_reason: finishReasonFor(msg.stop_reason) || 'stop' }],
    usage: chatUsage(msg.usage)
  };
}

// ── Streaming ──────────────────────────────────────────────────────────

/** Yields each parsed Anthropic SSE event ({type, ...}). Arms the stall watchdog per chunk. */
export async function* anthropicEvents(reader, guard, { name, signal }) {
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  const flush = function* () {
    if (!data.length) return;
    const raw = data.join('\n');
    data = [];
    try {
      yield JSON.parse(raw);
    } catch {}
  };
  while (true) {
    const { done, value } = await guardedRead(reader, guard, { name, signal });
    if (done) break;
    guard.arm(STREAM_STALL_TIMEOUT_MS, stallReason());
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (let line of lines) {
      line = line.replace(/\r$/, '');
      if (line === '') yield* flush();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, ''));
  yield* flush();
}

export function anthropicStreamError(name, event) {
  const e = event?.error || {};
  const err = new Error(`${name}: ${e.type || 'error'}: ${e.message || 'stream error'}`);
  err.status = e.type === 'overloaded_error' ? 529 : e.type === 'rate_limit_error' ? 429 : 502;
  return err;
}

/**
 * Reads an Anthropic stream and reports plain deltas: onDelta('text' | 'thinking', str).
 * onDelta may return true to stop reading early. Returns { stopReason, usage }.
 */
export async function readAnthropicStream(reader, guard, { name, signal, onDelta }) {
  let stopReason = null;
  const usage = {};
  for await (const ev of anthropicEvents(reader, guard, { name, signal })) {
    if (ev.type === 'message_start') Object.assign(usage, ev.message?.usage);
    else if (ev.type === 'content_block_delta') {
      const d = ev.delta || {};
      const stop = d.type === 'text_delta' ? onDelta('text', d.text || '')
        : d.type === 'thinking_delta' ? onDelta('thinking', d.thinking || '')
          : false;
      if (stop) break;
    } else if (ev.type === 'message_delta') {
      if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
      Object.assign(usage, ev.usage);
    } else if (ev.type === 'error') {
      throw anthropicStreamError(name, ev);
    } else if (ev.type === 'message_stop') break;
  }
  return { stopReason, usage };
}

/** Writes an Anthropic stream to res as OpenAI chat.completion.chunk events. */
export async function pipeAnthropicStreamAsChat(reader, guard, res, { name, signal, model, includeUsage }) {
  const created = Math.floor(Date.now() / 1000);
  let id = `chatcmpl-${Date.now().toString(36)}`;
  let modelName = model;
  const toolIndexOf = new Map(); // Anthropic block index -> OpenAI tool_calls index
  let finish = null;
  const usage = {};
  const send = (delta, finishReason = null, extra = {}) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: modelName, choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra })}\n\n`);
  };

  try {
    for await (const ev of anthropicEvents(reader, guard, { name, signal })) {
      if (ev.type === 'message_start') {
        if (ev.message?.id) id = `chatcmpl-${ev.message.id}`;
        if (ev.message?.model) modelName = ev.message.model;
        Object.assign(usage, ev.message?.usage);
        send({ role: 'assistant', content: '' });
      } else if (ev.type === 'content_block_start') {
        const b = ev.content_block || {};
        if (b.type === 'tool_use') {
          const idx = toolIndexOf.size;
          toolIndexOf.set(ev.index, idx);
          send({ tool_calls: [{ index: idx, id: b.id, type: 'function', function: { name: b.name, arguments: '' } }] });
        }
      } else if (ev.type === 'content_block_delta') {
        const d = ev.delta || {};
        if (d.type === 'text_delta' && d.text) send({ content: d.text });
        else if (d.type === 'thinking_delta' && d.thinking) send({ reasoning_content: d.thinking });
        else if (d.type === 'input_json_delta' && d.partial_json && toolIndexOf.has(ev.index)) {
          send({ tool_calls: [{ index: toolIndexOf.get(ev.index), function: { arguments: d.partial_json } }] });
        }
      } else if (ev.type === 'message_delta') {
        if (ev.delta?.stop_reason) finish = finishReasonFor(ev.delta.stop_reason);
        Object.assign(usage, ev.usage);
      } else if (ev.type === 'error') {
        const err = anthropicStreamError(name, ev);
        if (!res.writableEnded) res.write(`data: ${JSON.stringify({ error: { message: err.message, type: 'upstream_error' } })}\n\n`);
        finish = finish || 'stop';
        break;
      } else if (ev.type === 'message_stop') break;
    }
  } catch (err) {
    // Headers already went out, so a stall can only end the stream
    if (err.code !== 'upstream_timeout') throw err;
    console.warn(`[${name}] ${err.message}; closing the stream.`);
  }

  send({}, finish || 'stop');
  if (includeUsage && !res.writableEnded) {
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: modelName, choices: [], usage: chatUsage(usage) })}\n\n`);
  }
  if (!res.writableEnded) res.write('data: [DONE]\n\n');
}

// ── Account test / model list ──────────────────────────────────────────

async function httpError(res) {
  const text = await res.text().catch(() => '');
  let message = text.slice(0, 200);
  try {
    const j = JSON.parse(text);
    if (j?.error?.message) message = `${j.error.type || 'error'}: ${j.error.message}`;
  } catch {}
  const err = new Error(`HTTP ${res.status}: ${message}`);
  err.status = res.status;
  return err;
}

export async function testAnthropicKey(acc) {
  const t0 = Date.now();
  const model = acc.model || 'claude-opus-5-5';
  const res = await upstreamFetch(`${anthropicBaseUrl(acc)}/messages`, {
    method: 'POST',
    headers: anthropicHeaders(acc.token),
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      output_config: { effort: 'low' },
      messages: [{ role: 'user', content: 'Reply with just: OK' }]
    }),
    signal: AbortSignal.timeout(60000)
  });
  if (!res.ok) throw await httpError(res);
  const json = await res.json();
  const text = (json.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ');
  return { ok: true, latencyMs: Date.now() - t0, reply: (text || 'OK').trim().replace(/\n/g, ' ').slice(0, 50) || 'OK', model };
}

export async function listAnthropicModels({ baseUrl, token }) {
  const ids = [];
  let after = null;
  for (let page = 0; page < 10; page++) {
    const qs = new URLSearchParams({ limit: '1000' });
    if (after) qs.set('after_id', after);
    const res = await upstreamFetch(`${anthropicBaseUrl({ baseUrl })}/models?${qs}`, {
      headers: anthropicHeaders(token),
      signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) throw await httpError(res);
    const json = await res.json().catch(() => ({}));
    for (const m of json.data || []) if (m?.id) ids.push(m.id);
    if (!json.has_more || !json.last_id) break;
    after = json.last_id;
  }
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}
