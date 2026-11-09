import tokenPool from './tokenPool.js';
import { detectRepetitionLoop, findFabricatedResult } from './parser.js';
import { upstreamFetch } from './directFetch.js';
import { PROVIDER_PRESETS } from './providerPresets.js';
import { guardedFetch, guardedRead, upstreamHttpError, STREAM_STALL_TIMEOUT_MS, stallReason } from './upstreamGuard.js';
import {
  isAnthropicProvider, anthropicBaseUrl, anthropicHeaders, chatToAnthropic, anthropicToChat,
  readAnthropicStream, pipeAnthropicStreamAsChat, ANTHROPIC_DEFAULT_MAX_TOKENS
} from './anthropicUpstream.js';

export const STANDARD_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
export const STANDARD_API_USER_AGENT = 'SE-AiProxy/1.0.0 (OpenAI-Compatible/1.0; +https://shirazelectronic.ir)';

// Long answers (a whole file in one apply_patch) need room; Codex keeps waiting while chunks arrive
const MAX_STREAM_MS = 300000;
const MAX_STREAM_CHARS = 150000;

// OpenAI's reasoning models (o-series, gpt-5 family) reject max_tokens and non-default sampling
const isOpenAIReasoningModel = model => /^(o\d|gpt-5)/i.test(String(model || '').replace(/^openai\//, ''));

export function adaptOpenAIPayload(provider, payload) {
  if (provider?.type !== 'openai') return payload;
  if (payload.max_tokens != null) {
    if (payload.max_completion_tokens == null) payload.max_completion_tokens = payload.max_tokens;
    delete payload.max_tokens;
  }
  if (isOpenAIReasoningModel(payload.model)) {
    for (const k of ['temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'logit_bias', 'stop']) delete payload[k];
  }
  return payload;
}

/**
 * Builds the per-delta bookkeeping shared by the OpenAI and Anthropic prompt streams:
 * collects content, forwards chunks, and says when to stop (time / size / repetition limits).
 */
function createDeltaSink(name, onChunk) {
  const state = { content: '', thinkingContent: '', lastCheck: 0 };
  const startTime = Date.now();
  state.push = (type, text) => {
    if (!text) return false;
    if (type === 'thinking') {
      state.thinkingContent += text;
      onChunk?.({ type: 'thinking', content: text });
      return false;
    }
    state.content += text;
    onChunk?.({ type: 'response', content: text });
    if (Date.now() - startTime > MAX_STREAM_MS) {
      console.warn(`[${name}] Stream duration limit exceeded (300s). Halting stream to avoid Codex timeout.`);
      return true;
    }
    if (state.content.length > MAX_STREAM_CHARS) {
      console.warn(`[${name}] Stream length limit exceeded (${MAX_STREAM_CHARS} chars). Halting stream.`);
      return true;
    }
    if (findFabricatedResult(state.content) !== -1) {
      console.warn(`[${name}] Fake tool result detected in stream. Halting stream immediately to preserve response.`);
      return true;
    }
    if (state.content.length - state.lastCheck >= 80) {
      state.lastCheck = state.content.length;
      if (detectRepetitionLoop(state.content)) {
        console.warn(`[${name}] Runaway repetition loop detected in stream! Halting stream to preserve response.`);
        return true;
      }
    }
    return false;
  };
  return state;
}

/** Prompt path for the official Anthropic API: one user turn, streamed back as text deltas. */
async function streamAnthropicPromptChunks({ provider, prompt, signal, onChunk, name }) {
  const payload = {
    model: provider.model,
    max_tokens: provider.max_tokens || ANTHROPIC_DEFAULT_MAX_TOKENS,
    messages: [{ role: 'user', content: prompt }],
    stream: true
  };
  tokenPool.noteApiRequest(provider.id);
  const { res: upstreamRes, guard } = await guardedFetch(upstreamFetch, `${anthropicBaseUrl(provider)}/messages`, {
    method: 'POST',
    headers: { ...anthropicHeaders(provider.token || provider.apiKey), Accept: 'text/event-stream' },
    body: JSON.stringify(payload)
  }, { name, provider, signal });
  if (!upstreamRes.ok) {
    guard.dispose();
    throw await upstreamHttpError(name, upstreamRes);
  }
  const sink = createDeltaSink(name, onChunk);
  const reader = upstreamRes.body.getReader();
  try {
    await readAnthropicStream(reader, guard, { name, signal, onDelta: sink.push });
  } finally {
    guard.dispose();
    reader.cancel?.().catch(() => {});
  }
  tokenPool.recordUsage(provider.id);
  return { ok: true, content: sink.content, thinkingContent: sink.thinkingContent, finished: true };
}

/**
 * Executes a streaming or non-streaming responses request against Moonmath (Zro)
 * which natively supports the OpenAI Responses API.
 */
export async function forwardMoonmathResponses({ provider, body, req, res, signal }) {
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/responses`;
  const isStream = body.stream !== false;
  const apiKey = provider.token || provider.apiKey;
  const name = provider.label || provider.name || provider.type;

  const payload = {
    ...body,
    model: provider.model || 'deepseek-v4.1-flash'
  };

  tokenPool.noteApiRequest(provider.id);
  const { res: upstreamRes, guard } = await guardedFetch(upstreamFetch, url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': STANDARD_API_USER_AGENT,
      'HTTP-Referer': 'https://shirazelectronic.ir',
      'X-Title': 'SE-AiProxy'
    },
    body: JSON.stringify(payload)
  }, { name, provider, signal });

  if (!upstreamRes.ok) {
    guard.dispose();
    throw await upstreamHttpError(name, upstreamRes);
  }

  tokenPool.recordUsage(provider.id);

  if (!isStream) {
    guard.arm(0);
    try {
      return res.json(await upstreamRes.json());
    } finally {
      guard.dispose();
    }
  }

  res.writeHead(upstreamRes.status, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  const reader = upstreamRes.body.getReader();
  try {
    while (true) {
      const { done, value } = await guardedRead(reader, guard, { name, signal });
      if (done) break;
      guard.arm(STREAM_STALL_TIMEOUT_MS, stallReason());
      if (res.writableEnded || res.destroyed) break;
      res.write(value);
    }
  } catch (err) {
    // Headers already went to the client, so a stall can only end the stream
    if (err.code !== 'upstream_timeout') throw err;
    console.warn(`[${name}] ${err.message}; closing the stream.`);
  } finally {
    guard.dispose();
    reader.releaseLock?.();
  }
  if (!res.writableEnded) {
    res.end();
  }
}

/**
 * Executes an OpenAI-compatible Chat Completions stream (for TokenHarbor, Google Gemini, etc.)
 * and adapters chunks into DeepSeek-like chunks for `responsesAdapter.js` to process.
 */
export async function streamOpenAIChatAsResponsesChunks({ provider, prompt, signal, onChunk }) {
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const apiKey = provider.token || provider.apiKey;
  const name = provider.label || provider.name || provider.type;

  let effectivePrompt = prompt;
  const presetMaxChars = PROVIDER_PRESETS[provider.type]?.maxPromptChars;
  if (presetMaxChars || provider.type === 'tokenharbor' || provider.type === 'openrouter' || provider.type === 'openai_custom' || provider.type === 'chabokan') {
    // Vercel Edge / Cloudflare WAF / API queues drop requests with large payloads (>60KB-80KB)
    // Compact history keeping the initial instruction goal (head) and recent tool interactions (tail).
    // Chabokan takes 600k+ chars without trouble; the history budget in responsesAdapter already keeps it smaller
    const MAX_CHARS = presetMaxChars || (provider.type === 'tokenharbor' ? 42000 : provider.type === 'chabokan' ? 360000 : 70000);
    if (effectivePrompt.length > MAX_CHARS) {
      const head = effectivePrompt.slice(0, Math.floor(MAX_CHARS * 0.15));
      const tail = effectivePrompt.slice(-Math.floor(MAX_CHARS * 0.8));
      const marker = `\n\n[HISTORY COMPACTED FOR API PROVIDER: middle steps omitted to fit upstream payload limit]\n\n`;
      effectivePrompt = head + marker + tail;
    }
    // Sanitize bash heredoc signatures (e.g. <<'PYEOF') which trip Cloudflare WAF shell injection rules
    effectivePrompt = effectivePrompt.replace(/<<\s*['"]?([A-Za-z0-9_-]+)['"]?/g, '<< $1');
  }

  if (isAnthropicProvider(provider)) {
    return streamAnthropicPromptChunks({ provider, prompt: effectivePrompt, signal, onChunk, name });
  }

  const payload = adaptOpenAIPayload(provider, {
    model: provider.model,
    messages: [{ role: 'user', content: effectivePrompt }],
    stream: true,
    max_tokens: provider.max_tokens || 16384,
    // OpenAI and Groq accept at most 4 stop sequences; the newline variants are covered by these
    stop: ['[TOOL RESULT', '[COMMAND OUTPUT', '[POLL RESULT']
  });

  tokenPool.noteApiRequest(provider.id);
  const { res: upstreamRes, guard } = await guardedFetch(upstreamFetch, url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': STANDARD_API_USER_AGENT,
      'HTTP-Referer': 'https://shirazelectronic.ir',
      'X-Title': 'SE-AiProxy'
    },
    body: JSON.stringify(payload)
  }, { name, provider, signal });

  if (!upstreamRes.ok) {
    guard.dispose();
    throw await upstreamHttpError(name, upstreamRes);
  }

  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  const sink = createDeltaSink(name, onChunk);
  let buffer = '';
  let stop = false;

  try {
    while (!stop) {
      const { done, value } = await guardedRead(reader, guard, { name, signal });
      if (done) break;
      guard.arm(STREAM_STALL_TIMEOUT_MS, stallReason());
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (stop) break;
        if (!line.startsWith('data:')) continue;
        const jsonStr = line.slice(5).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;

        let parsed;
        try {
          parsed = JSON.parse(jsonStr);
        } catch {
          continue;
        }
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;

        // Reasoning / thinking content (TokenHarbor, DeepSeek, Google, etc.)
        const reasoning = delta.reasoning_content || delta.reasoning || delta.thought;
        if (typeof reasoning === 'string') sink.push('thinking', reasoning);

        // Visible text content
        if (delta.content) stop = sink.push('response', delta.content) || stop;

        // OpenAI structured tool calls
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const fn = tc.function;
            if (fn?.name) stop = sink.push('response', `\n<tool_call>\n{"name": "${fn.name}", "arguments": `) || stop;
            if (fn?.arguments) stop = sink.push('response', fn.arguments) || stop;
          }
        }
      }
    }
  } finally {
    guard.dispose();
    reader.releaseLock?.();
  }

  tokenPool.recordUsage(provider.id);

  return {
    ok: true,
    content: sink.content,
    thinkingContent: sink.thinkingContent,
    finished: true
  };
}

/**
 * Forwards OpenAI Chat Completion request directly to an upstream provider.
 */
export async function forwardChatCompletions({ provider, body, res, isStream, signal }) {
  if (isAnthropicProvider(provider)) return forwardChatCompletionsToAnthropic({ provider, body, res, isStream, signal });
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const apiKey = provider.token || provider.apiKey;
  const name = provider.label || provider.name || provider.type;

  const payload = adaptOpenAIPayload(provider, {
    ...body,
    model: provider.model || body.model
  });

  tokenPool.noteApiRequest(provider.id);
  const { res: upstreamRes, guard } = await guardedFetch(upstreamFetch, url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'User-Agent': STANDARD_API_USER_AGENT,
      'HTTP-Referer': 'https://shirazelectronic.ir',
      'X-Title': 'SE-AiProxy'
    },
    body: JSON.stringify(payload)
  }, { name, provider, signal });

  if (!upstreamRes.ok) {
    guard.dispose();
    throw await upstreamHttpError(name, upstreamRes);
  }

  tokenPool.recordUsage(provider.id);

  if (!isStream) {
    guard.arm(0);
    try {
      return res.json(await upstreamRes.json());
    } finally {
      guard.dispose();
    }
  }

  res.writeHead(upstreamRes.status, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.flushHeaders?.();

  const reader = upstreamRes.body.getReader();
  try {
    while (true) {
      const { done, value } = await guardedRead(reader, guard, { name, signal });
      if (done) break;
      guard.arm(STREAM_STALL_TIMEOUT_MS, stallReason());
      if (res.writableEnded || res.destroyed) break;
      res.write(value);
    }
  } catch (err) {
    // Headers already went to the client, so a stall can only end the stream
    if (err.code !== 'upstream_timeout') throw err;
    console.warn(`[${name}] ${err.message}; closing the stream.`);
  } finally {
    guard.dispose();
    reader.releaseLock?.();
  }
  if (!res.writableEnded) {
    res.end();
  }
}

/**
 * OpenAI Chat Completions request answered by the official Anthropic API: the request is translated
 * to Messages, and the reply (JSON or SSE) back to chat.completion / chat.completion.chunk.
 */
export async function forwardChatCompletionsToAnthropic({ provider, body, res, isStream, signal }) {
  const name = provider.label || provider.name || provider.type;
  const model = provider.model || body.model;
  const payload = chatToAnthropic({ ...body, stream: Boolean(isStream) }, { model, maxTokens: provider.max_tokens });

  tokenPool.noteApiRequest(provider.id);
  const { res: upstreamRes, guard } = await guardedFetch(upstreamFetch, `${anthropicBaseUrl(provider)}/messages`, {
    method: 'POST',
    headers: { ...anthropicHeaders(provider.token || provider.apiKey), ...(isStream ? { Accept: 'text/event-stream' } : {}) },
    body: JSON.stringify(payload)
  }, { name, provider, signal });

  if (!upstreamRes.ok) {
    guard.dispose();
    throw await upstreamHttpError(name, upstreamRes);
  }
  tokenPool.recordUsage(provider.id);

  if (!isStream) {
    guard.arm(0);
    try {
      return res.json(anthropicToChat(await upstreamRes.json(), model));
    } finally {
      guard.dispose();
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  const reader = upstreamRes.body.getReader();
  try {
    await pipeAnthropicStreamAsChat(reader, guard, res, {
      name, signal, model, includeUsage: Boolean(body.stream_options?.include_usage)
    });
  } finally {
    guard.dispose();
    reader.cancel?.().catch(() => {});
  }
  if (!res.writableEnded) res.end();
}
