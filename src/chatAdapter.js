import { generateId, parseToolCalls, buildPromptFromChatMessages, getVisibleStreamingText } from './parser.js';
import { streamDeepSeekChat, createSession, isRateLimitedOrBusy } from './deepseek.js';
import { BoundedCache } from './sessionCache.js';
import tokenPool, { sessionKeyMatches } from './tokenPool.js';
import providerManager from './providers.js';
import { forwardChatCompletions } from './providerRunner.js';
import { streamKimiChatAsResponsesChunks } from './kimiWeb.js';
import { penalizeAccount } from './accountHealth.js';

async function forwardKimiChatCompletions({ provider, prompt, body, res, isStream, signal }) {
  const model = provider.model || 'k1.5-thinking';
  const id = 'chatcmpl-' + generateId();
  const created = Math.floor(Date.now() / 1000);

  if (isStream) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    await streamKimiChatAsResponsesChunks({
      provider,
      prompt,
      conversationKey: 'chat-' + generateId(),
      signal,
      onChunk: (chunk) => {
        const text = chunk.content || chunk.text;
        if (text) {
          const chunkData = {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{
              index: 0,
              delta: { content: text },
              finish_reason: null
            }]
          };
          res.write(`data: ${JSON.stringify(chunkData)}\n\n`);
        }
      }
    });

    res.write(`data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } else {
    let fullText = '';
    const resStream = await streamKimiChatAsResponsesChunks({
      provider,
      prompt,
      conversationKey: 'chat-' + generateId(),
      signal,
      onChunk: (chunk) => {
        const text = chunk.content || chunk.text;
        if (text) fullText += text;
      }
    });
    const content = fullText || resStream?.content || '';

    res.json({
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop'
      }]
    });
  }
}

// Client session id -> { sessionId, tokenId }. The upstream session belongs to one account, so the
// binding is dropped whenever the pool routes the conversation to a different token.
const chatSessionMap = new BoundedCache({ maxEntries: 1000, ttlMs: 12 * 60 * 60 * 1000 });

const penalizeToken = penalizeAccount;

export async function handleChatCompletionRequest(req, res) {
  const body = req.body || {};
  const modelId = body.model || 'deepseek-chat';
  const isReasoner = modelId === 'deepseek-reasoner' || /reasoner|r1/i.test(modelId);
  const modelType = isReasoner ? 'expert' : 'default';
  const thinkingEnabled = isReasoner || Boolean(body.thinking_enabled || (body.reasoning_effort && body.reasoning_effort !== 'none'));

  const prompt = buildPromptFromChatMessages({
    messages: body.messages,
    tools: body.tools
  });

  if (!prompt.trim()) {
    return res.status(400).json({
      error: {
        message: 'No messages provided in request',
        type: 'invalid_request_error',
        code: 'missing_messages'
      }
    });
  }

  const abortController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abortController.abort();
  });

  const requestedSessionId = req.params?.sessionId || body.session_id || 'default';
  const excludeIds = new Set();
  const maxAttempts = Math.min(10, Math.max(2, tokenPool.countKeys()));

  let preferId = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let selectedTurn;
    try {
      selectedTurn = tokenPool.selectAccountForTurn({ conversationKey: requestedSessionId, excludeIds, preferId });
      preferId = null;
    } catch {
      break;
    }

    const account = selectedTurn?.account;
    if (!account) break;

    if (account.type && account.type !== 'deepseek_web') {
      try {
        console.log(`[Chat] Routing completion to ${account.label} (${account.model})...`);
        if (account.type === 'kimi_web') {
          await forwardKimiChatCompletions({
            provider: account,
            prompt,
            body,
            res,
            isStream: Boolean(body.stream),
            signal: abortController.signal
          });
        } else {
          await forwardChatCompletions({
            provider: account,
            body,
            res,
            isStream: Boolean(body.stream),
            signal: abortController.signal
          });
        }
        tokenPool.recordUsage(account.id);
        return;
      } catch (err) {
        console.warn(`[Chat] Account ${account.label} failed: ${err.message}. Failing over...`);
        if (penalizeAccount(account.id, err)) preferId = account.id;
        else excludeIds.add(account.id);
        continue;
      }
    } else {
      break; // DeepSeek Web is handled below
    }
  }

  const { tokenObj } = tokenPool.selectTokenForConversation(requestedSessionId, excludeIds);

  if (tokenObj.type && tokenObj.type !== 'deepseek_web') {
    console.log(`[Chat] Routing completion to ${tokenObj.label} (${tokenObj.model})...`);
    if (tokenObj.type === 'kimi_web') {
      await forwardKimiChatCompletions({
        provider: tokenObj,
        prompt,
        body,
        res,
        isStream: Boolean(body.stream),
        signal: abortController.signal
      });
    } else {
      await forwardChatCompletions({
        provider: tokenObj,
        body,
        res,
        isStream: Boolean(body.stream),
        signal: abortController.signal
      });
    }
    tokenPool.recordUsage(tokenObj.id);
    return;
  }

  let binding = chatSessionMap.get(requestedSessionId);
  if (!binding || binding.tokenId !== tokenObj.id || !sessionKeyMatches(binding, tokenObj)) {
    try {
      binding = { sessionId: await createSession(tokenObj.token), tokenId: tokenObj.id, keyId: tokenObj.activeKeyId };
    } catch (err) {
      penalizeToken(tokenObj.id, err);
      throw err;
    }
    chatSessionMap.set(requestedSessionId, binding);
  }
  const { sessionId } = binding;

  const isStream = Boolean(body.stream);
  const completionId = generateId('chatcmpl-');

  if (!isStream) {
    let result;
    try {
      result = await streamDeepSeekChat({
        token: tokenObj.token,
        sessionId,
        prompt,
        modelType,
        thinkingEnabled,
        // Full history is resent every request, so a full upstream session just needs a new one
        rebuildPrompt: () => prompt
      });
    } catch (err) {
      penalizeToken(tokenObj.id, err);
      throw err;
    }
    if (result.sessionReset) binding.sessionId = result.sessionId;

    tokenPool.recordUsage(tokenObj.id);

    const { cleanContent, calls } = parseToolCalls(result.content);
    const message = {
      role: 'assistant',
      content: cleanContent || ''
    };

    if (result.thinkingContent) {
      message.reasoning_content = result.thinkingContent;
    }

    if (calls.length > 0) {
      message.tool_calls = calls.map(c => ({
        id: c.id,
        type: 'function',
        function: {
          name: c.name,
          arguments: c.arguments
        }
      }));
    }

    res.setHeader('X-RP-Session-Id', sessionId);
    return res.json({
      id: completionId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [
        {
          index: 0,
          message,
          finish_reason: calls.length > 0 ? 'tool_calls' : 'stop'
        }
      ],
      usage: {
        prompt_tokens: result.tokenUsage?.prompt_tokens || 10,
        completion_tokens: result.tokenUsage?.completion_tokens || 20,
        total_tokens: result.tokenUsage?.total_tokens || 30
      }
    });
  }

  // Stream SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-RP-Session-Id': sessionId
  });

  const writeChunk = (chunkObj) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(chunkObj)}\n\n`);
  };

  res.on('error', (err) => console.warn('[Chat] Client socket error:', err.message));

  try {
    let accumulatedContent = '';
    let emittedText = '';

    const result = await streamDeepSeekChat({
      token: tokenObj.token,
      sessionId,
      prompt,
      modelType,
      thinkingEnabled,
      signal: abortController.signal,
      rebuildPrompt: () => prompt,
      onChunk: (chunk) => {
        if (chunk.type === 'thinking') {
          writeChunk({
            id: completionId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [
              {
                index: 0,
                delta: { reasoning_content: chunk.content },
                finish_reason: null
              }
            ]
          });
        } else if (chunk.type === 'response') {
          accumulatedContent += chunk.content;
          // Hold back tool-call markup; it is sent as structured tool_calls at the end
          const visible = getVisibleStreamingText(accumulatedContent);
          if (visible.length <= emittedText.length || !visible.startsWith(emittedText)) return;
          const delta = visible.slice(emittedText.length);
          emittedText = visible;
          writeChunk({
            id: completionId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: modelId,
            choices: [
              {
                index: 0,
                delta: { content: delta },
                finish_reason: null
              }
            ]
          });
        }
      }
    });

    tokenPool.recordUsage(tokenObj.id);
    if (result.sessionReset) binding.sessionId = result.sessionId;

    const { calls, cleanContent } = parseToolCalls(accumulatedContent);
    // Flush visible text that was held back while it looked like the start of a tag
    if (cleanContent.length > emittedText.length && cleanContent.startsWith(emittedText)) {
      writeChunk({
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [{ index: 0, delta: { content: cleanContent.slice(emittedText.length) }, finish_reason: null }]
      });
    }
    if (calls.length > 0) {
      writeChunk({
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: calls.map((c, i) => ({
                index: i,
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: c.arguments }
              }))
            },
            finish_reason: 'tool_calls'
          }
        ]
      });
    } else {
      writeChunk({
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop'
          }
        ]
      });
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    if (abortController.signal.aborted) {
      return res.end();
    }
    console.error('[Chat Stream Error]', err);
    penalizeToken(tokenObj.id, err);
    writeChunk({
      error: {
        message: err.message || 'Stream error',
        type: 'api_error',
        code: isRateLimitedOrBusy(err) ? 'rate_limit_exceeded' : (err.code || 'internal_error')
      }
    });
    if (!res.writableEnded) res.write('data: [DONE]\n\n');
    res.end();
  }
}
