import crypto from 'node:crypto';
import {
  generateId,
  parseToolCalls,
  extractTextFromContent,
  adaptCallsForTools,
  getVisibleStreamingText
} from './parser.js';
import { streamDeepSeekChat, createSession } from './deepseek.js';
import { BoundedCache } from './sessionCache.js';
import tokenPool, { sessionKeyMatches } from './tokenPool.js';
import { judgeTurnCompletion } from './turnJudge.js';
import { isUnfulfilledIntent, extractRecentErrorFromInput, isFinalDeliverableReport, DONE_CUE, ASK_USER_CUE } from './intent.js';
import { dumpUnparsedOutput } from './debugLog.js';
import { streamOpenAIChatAsResponsesChunks } from './providerRunner.js';
import { streamKimiChatAsResponsesChunks } from './kimiWeb.js';
import { penalizeAccount } from './accountHealth.js';
import { optimizePromptWithSupervisor, formatOptimizedUserPrompt } from './promptOptimizer.js';

const MAX_FOLLOW_UPS = 3;

// Claude Code conversation -> DeepSeek Web session { sessionId, parentMessageId, tokenId, upstreamChars }
const anthropicSessions = new BoundedCache({ maxEntries: 1000, ttlMs: 6 * 60 * 60 * 1000 });

function hashKey(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 24);
}

/**
 * Derives a stable conversation key from Anthropic messages array.
 */
export function resolveAnthropicConversationKey(body) {
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return 'anthropic_conv_' + Date.now();
  }

  // Find the first user message text
  for (const m of body.messages) {
    if (m.role === 'user') {
      const text = extractTextFromContent(m.content);
      if (text && text.trim().length > 3) {
        return 'anthropic_' + hashKey(text.trim());
      }
    }
  }

  // Fallback to hashing the system prompt or first message
  const firstContent = JSON.stringify(body.messages[0]);
  return 'anthropic_' + hashKey(firstContent);
}

/**
 * Converts Anthropic tools array into a clear XML tool prompt description
 * optimized for DeepSeek's instruction-following.
 */
export function formatAnthropicToolsForPrompt(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return '';

  const toolDefs = tools.map(t => {
    const props = t.input_schema?.properties || {};
    const required = new Set(t.input_schema?.required || []);
    const paramsList = Object.entries(props).map(([pName, pSpec]) => {
      const req = required.has(pName) ? ' required="true"' : '';
      const type = pSpec.type ? ` type="${pSpec.type}"` : '';
      const desc = pSpec.description ? ` description="${pSpec.description.replace(/"/g, '&quot;')}"` : '';
      return `    <parameter name="${pName}"${type}${req}${desc}/>`;
    }).join('\n');

    return `  <tool>
    <name>${t.name}</name>
    <description>${(t.description || '').replace(/&/g, '&amp;')}</description>
    <parameters>
${paramsList}
    </parameters>
  </tool>`;
  }).join('\n\n');

  return `[AVAILABLE TOOLS]
<tools>
${toolDefs}
</tools>

TOOL CALL FORMAT RULES:
1. To invoke a tool, format your call using strict XML:
<tool_calls>
<invoke name="<tool_name>">
<parameter name="<parameter_name>"><value></parameter>
</invoke>
</tool_calls>
2. You may emit multiple parallel <invoke> blocks inside one <tool_calls> block.
3. NEVER emit raw JSON tool calls or markdown blocks like [{"name": "..."}]. Use strictly <tool_calls><invoke name="...">...</invoke></tool_calls>.
4. Do not output anything after </tool_calls> until you receive tool results.`;
}

/**
 * Builds the complete prompt for DeepSeek from an Anthropic /v1/messages request.
 */
export function buildPromptFromAnthropicMessages(body) {
  const parts = [];

  // 1. System prompt
  let systemText = '';
  if (typeof body.system === 'string') {
    systemText = body.system.trim();
  } else if (Array.isArray(body.system)) {
    systemText = body.system
      .map(s => (typeof s === 'string' ? s : s?.text || ''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  if (systemText) {
    parts.push(`[SYSTEM DIRECTIVE]\n${systemText}`);
  }

  // Workspace Hygiene, Executive Autonomy & Cleanup Directive
  const hygieneDirective = `[WORKSPACE HYGIENE, EXECUTIVE AUTONOMY & DISCIPLINE RULES]
1. Mandatory Cleanup of Temporary Files: Any temporary test script, one-off probe (e.g. test_probe.py, check_*.c, probe_*.sh), benchmark file, or diagnostic artifact/dump created during your work MUST be deleted (using \`rm\`) immediately after inspection or before concluding your turn. NEVER clutter the user's workspace with scratch files.
2. Targeted Testing Discipline: Run only strictly necessary, focused tests. Do NOT run repetitive or redundant permutations of tests without an intervening code change. Once a test confirms the behavior, stop churning tests and proceed directly.
3. Executive Autonomy & End-to-End Implementation: When faced with implementation trade-offs or design choices within the task scope, do NOT halt execution to ask conversational or consultative questions. Make the soundest, most robust senior engineering decision yourself, implement the changes, and verify with builds and tests before concluding.`;
  parts.push(hygieneDirective);

  // 2. Tools
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    parts.push(formatAnthropicToolsForPrompt(body.tools));
  }

  // 3. Messages conversation history
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const role = msg.role === 'assistant' ? 'ASSISTANT' : 'USER';

    if (typeof msg.content === 'string') {
      parts.push(`[${role}]:\n${msg.content}`);
      continue;
    }

    if (Array.isArray(msg.content)) {
      const msgSubparts = [];
      for (const block of msg.content) {
        if (!block) continue;
        if (block.type === 'text' && block.text) {
          msgSubparts.push(block.text);
        } else if (block.type === 'tool_use') {
          // Format past assistant tool uses as XML
          const paramXml = Object.entries(block.input || {}).map(([k, v]) => {
            const valStr = typeof v === 'string' ? v : JSON.stringify(v);
            return `<parameter name="${k}">${valStr}</parameter>`;
          }).join('\n');
          msgSubparts.push(`<tool_calls>\n<invoke name="${block.name}">\n${paramXml}\n</invoke>\n</tool_calls>`);
        } else if (block.type === 'tool_result') {
          // Format tool results
          const resContent = typeof block.content === 'string'
            ? block.content
            : (Array.isArray(block.content) ? block.content.map(c => c?.text || '').join('\n') : JSON.stringify(block.content || ''));
          const errPrefix = block.is_error ? '[TOOL ERROR]: ' : '[TOOL OUTPUT]: ';
          msgSubparts.push(`${errPrefix}\n${resContent}`);
        }
      }
      if (msgSubparts.length > 0) {
        parts.push(`[${role}]:\n${msgSubparts.join('\n\n')}`);
      }
    }
  }

  return parts.join('\n\n---\n\n');
}

/**
 * Handles incoming POST /v1/messages and POST /messages from Claude Code.
 */
const penalizeToken = penalizeAccount;

// Latest message when it is a fresh human request (not a tool_result round-trip)
function latestHumanText(body) {
  const last = Array.isArray(body.messages) ? body.messages[body.messages.length - 1] : null;
  if (!last || last.role !== 'user') return null;
  if (Array.isArray(last.content) && last.content.some(c => c?.type === 'tool_result')) return null;
  const text = extractTextFromContent(last.content).trim();
  return text || null;
}

// Most recent human request in the thread (goal for the supervisor)
function latestGoalText(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user' || (Array.isArray(m.content) && m.content.some(c => c?.type === 'tool_result'))) continue;
    const text = extractTextFromContent(m.content).trim();
    if (text) return text;
  }
  return null;
}

// Optimizer stage: append the lossless execution brief to the latest human message
async function withOptimizedLatestMessage(body, signal) {
  const text = latestHumanText(body);
  if (!text) return body;
  const brief = await optimizePromptWithSupervisor({ userText: text, signal });
  if (!brief) return body;
  const messages = body.messages.slice();
  messages[messages.length - 1] = { ...messages[messages.length - 1], content: formatOptimizedUserPrompt(text, brief) };
  return { ...body, messages };
}

export async function handleAnthropicMessagesRequest(req, res) {
  const body = req.body || {};
  const isStream = Boolean(body.stream);
  const requestedModel = body.model || 'claude-3-7-sonnet-20250219';
  const messageId = generateId('msg_');

  // Quick connection test ping detection (single message <= 50 chars, e.g. "Hi", "test")
  const isShortPing = Array.isArray(body.messages) &&
    body.messages.length === 1 &&
    extractTextFromContent(body.messages[0]?.content).trim().length <= 50;

  const conversationKey = isShortPing
    ? 'anthropic_ping_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
    : resolveAnthropicConversationKey(body);
  let promptText = buildPromptFromAnthropicMessages(body);

  const abortController = new AbortController();
  let pingInterval = null;

  const cleanup = () => {
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
  };

  res.on('close', () => {
    cleanup();
    if (!res.writableEnded) {
      abortController.abort();
    }
  });
  res.on('finish', cleanup);

  if (isStream) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    // Anthropic Gateway requires keep-alive pings (: ping\n\n) to satisfy the stream idle timeout
    pingInterval = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) {
        res.write(': ping\n\n');
      }
    }, 2500);
  }

  const sendSse = (event, data) => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };

  if (isStream) {
    // 1. Send initial message_start
    sendSse('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: requestedModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: Math.max(10, Math.round(promptText.length / 4)),
          output_tokens: 1
        }
      }
    });
  }

  if (!isShortPing) {
    try {
      promptText = buildPromptFromAnthropicMessages(await withOptimizedLatestMessage(body, abortController.signal));
    } catch (err) {
      console.warn('[Anthropic Adapter] Prompt optimization skipped:', err.message);
    }
  }

  // Determine model selection:
  // - body.thinking = { type: 'enabled', budget_tokens: ... } -> official extended thinking
  // - explicit reasoner requested in model name: deepseek-reasoner, r1, thinking
  const isReasoningRequested = Boolean(
    (body.thinking && body.thinking.type === 'enabled') ||
    /reasoner|r1/i.test(requestedModel)
  );

  // Use reasoning model only when explicitly requested AND not a quick connection test
  const useReasoner = isReasoningRequested && !isShortPing;
  const modelType = useReasoner ? 'expert' : 'default';
  const thinkingEnabled = useReasoner;
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;

  let accumulatedRawContent = '';
  let accumulatedThinking = '';
  let currentBlockIndex = 0;
  let thinkingBlockOpened = false;
  let textBlockOpened = false;
  let textBlockIndex = -1;
  let emittedText = '';

  const excludeIds = new Set();
  const maxAttempts = Math.min(6, Math.max(1, tokenPool.countKeys()));
  let tokenObj;
  let sessionInfo;
  let result;
  let lastError;

  let preferId = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const selected = tokenPool.selectAccountForTurn({ conversationKey, excludeIds, preferId });
      preferId = null;
      tokenObj = selected.account || selected.tokenObj;
      tokenPool.incrementActiveRequests(tokenObj.id);

      const handleChunk = (chunk) => {
        if (chunk.type === 'thinking') {
          accumulatedThinking += chunk.content;
          if (isStream) {
            if (!thinkingBlockOpened) {
              thinkingBlockOpened = true;
              sendSse('content_block_start', {
                type: 'content_block_start',
                index: currentBlockIndex,
                content_block: { type: 'thinking', thinking: '' }
              });
            }
            sendSse('content_block_delta', {
              type: 'content_block_delta',
              index: currentBlockIndex,
              delta: { type: 'thinking_delta', thinking: chunk.content }
            });
          }
        } else if (chunk.type === 'response') {
          accumulatedRawContent += chunk.content;
          if (isStream) {
            if (thinkingBlockOpened) {
              thinkingBlockOpened = false;
              sendSse('content_block_stop', {
                type: 'content_block_stop',
                index: currentBlockIndex
              });
              currentBlockIndex++;
            }

            if (!hasTools) {
              if (!textBlockOpened) {
                textBlockOpened = true;
                textBlockIndex = currentBlockIndex++;
                sendSse('content_block_start', {
                  type: 'content_block_start',
                  index: textBlockIndex,
                  content_block: { type: 'text', text: '' }
                });
              }
              sendSse('content_block_delta', {
                type: 'content_block_delta',
                index: textBlockIndex,
                delta: { type: 'text_delta', text: chunk.content }
              });
              emittedText += chunk.content;
            } else {
              const visible = getVisibleStreamingText(accumulatedRawContent);
              if (visible.length > emittedText.length && visible.startsWith(emittedText)) {
                const delta = visible.slice(emittedText.length);
                emittedText = visible;
                if (!textBlockOpened) {
                  textBlockOpened = true;
                  textBlockIndex = currentBlockIndex++;
                  sendSse('content_block_start', {
                    type: 'content_block_start',
                    index: textBlockIndex,
                    content_block: { type: 'text', text: '' }
                  });
                }
                sendSse('content_block_delta', {
                  type: 'content_block_delta',
                  index: textBlockIndex,
                  delta: { type: 'text_delta', text: delta }
                });
              }
            }
          }
        }
      };

      if (tokenObj.type === 'kimi_web') {
        result = await streamKimiChatAsResponsesChunks({
          provider: tokenObj,
          prompt: promptText,
          conversationKey,
          signal: abortController.signal,
          onChunk: handleChunk
        });
        tokenPool.recordUsage(tokenObj.id);
      } else if (tokenObj.type && tokenObj.type !== 'deepseek_web') {
        result = await streamOpenAIChatAsResponsesChunks({
          provider: tokenObj,
          prompt: promptText,
          signal: abortController.signal,
          onChunk: handleChunk
        });
        tokenPool.recordUsage(tokenObj.id);
      } else {
        // Claude Code re-sends the whole history every turn, so chaining a session stacks that
        // history again each turn. Reuse the conversation's session while it is small (new sessions
        // count against the account's hourly session budget) and rotate before DeepSeek's length cap.
        sessionInfo = anthropicSessions.get(conversationKey);
        const rotateAt = tokenPool.getSettings().sessionRotateChars;
        if (!sessionInfo || sessionInfo.tokenId !== tokenObj.id || !sessionKeyMatches(sessionInfo, tokenObj) || (sessionInfo.upstreamChars || 0) + promptText.length > rotateAt) {
          sessionInfo = {
            sessionId: await createSession(tokenObj.token),
            parentMessageId: null,
            tokenId: tokenObj.id,
            keyId: tokenObj.activeKeyId,
            inputCount: 0,
            upstreamChars: 0
          };
          anthropicSessions.set(conversationKey, sessionInfo);
        }

        result = await streamDeepSeekChat({
          token: tokenObj.token,
          sessionId: sessionInfo.sessionId,
          parentMessageId: sessionInfo.parentMessageId,
          prompt: promptText,
          modelType,
          thinkingEnabled,
          signal: abortController.signal,
          onChunk: handleChunk,
          // Session filled up anyway: DeepSeek client opens a new session and re-sends the history
          rebuildPrompt: () => promptText
        });
        if (result.sessionReset) {
          sessionInfo.sessionId = result.sessionId;
          sessionInfo.upstreamChars = 0;
        }
      }
      break; // Success
    } catch (err) {
      lastError = err;
      if (abortController.signal.aborted || err.name === 'AbortError') {
        throw err;
      }
      // An account that switched to its next key is retried as is; otherwise try another account
      if (tokenObj) {
        if (penalizeToken(tokenObj.id, err)) preferId = tokenObj.id;
        else excludeIds.add(tokenObj.id);
      }
      console.warn(`[Anthropic Adapter] DeepSeek attempt ${attempt} failed on ${tokenObj?.label || tokenObj?.id} (${err.message}), retrying with another account...`);
      if (attempt === maxAttempts) throw lastError;
      accumulatedRawContent = '';
      accumulatedThinking = '';
    } finally {
      if (tokenObj) {
        tokenPool.decrementActiveRequests(tokenObj.id);
      }
    }
  }

  if (thinkingBlockOpened) {
    sendSse('content_block_stop', {
      type: 'content_block_stop',
      index: currentBlockIndex
    });
    currentBlockIndex++;
  }

  if (result?.messageId && sessionInfo) sessionInfo.parentMessageId = result.messageId;
  if (sessionInfo) {
    sessionInfo.upstreamChars = (sessionInfo.upstreamChars || 0) + promptText.length + (result?.content || '').length;
  }

  let parsed = parseToolCalls(accumulatedRawContent);

  // Autonomous Supervisor Check for Claude Code (Only run if tools were provided)
  const lastMsg = Array.isArray(body.messages) && body.messages.length > 0 ? body.messages[body.messages.length - 1] : null;
  const isFollowingTool = Boolean(lastMsg && Array.isArray(lastMsg.content) && lastMsg.content.some(c => c?.type === 'tool_result'));

  if (hasTools && parsed.calls.length === 0 && !result?.loopDetected && !abortController.signal.aborted) {
    const trimmedClean = parsed.cleanContent.trim();
    const isFinalReport = isFinalDeliverableReport(trimmedClean);
    const isObviousUserQuestion = /[?؟]\s*$/.test(trimmedClean) && ASK_USER_CUE.test(trimmedClean);

    if (!isFinalReport && !isObviousUserQuestion && (isFollowingTool || isUnfulfilledIntent(parsed.cleanContent))) {
      let shouldContinue = false;
      try {
        const verdict = await judgeTurnCompletion({
          text: parsed.cleanContent,
          goal: latestGoalText(body),
          isFollowingTool,
          recentError: null,
          avoidTokenId: tokenObj.id,
          signal: abortController.signal,
          timeoutMs: 8000
        });
        if (verdict === 'CONTINUE') shouldContinue = true;
      } catch {}

      if (!shouldContinue) {
        shouldContinue = isUnfulfilledIntent(parsed.cleanContent);
      }

      if (shouldContinue) {
        console.log(`[Anthropic Adapter] Autonomous Supervisor nudging Claude Code turn...`);
        const followUpPrompt = `[SUPERVISOR INTERVENTION]: You announced an upcoming action ("${parsed.cleanContent.slice(-140)}") but emitted no tool call. Emit the tool call now using standard <tool_calls><invoke name="...">...</invoke></tool_calls>. If fully complete, provide your final response.`;
        try {
          // A DeepSeek session can only be continued by its own account; API accounts are stateless,
          // so they get the history, the reply so far and the instruction in one prompt.
          const followUpPromptText = `${promptText}\n\n[YOUR REPLY SO FAR IN THIS TURN]:\n${accumulatedRawContent.trim()}\n\n${followUpPrompt}`;
          const followUpResult = (sessionInfo && (!tokenObj.type || tokenObj.type === 'deepseek_web'))
            ? await streamDeepSeekChat({
              token: tokenObj.token,
              sessionId: sessionInfo.sessionId,
              parentMessageId: sessionInfo.parentMessageId,
              prompt: followUpPrompt,
              modelType: 'default',
              thinkingEnabled: false,
              signal: abortController.signal
            })
            : (tokenObj.type === 'kimi_web'
              ? await streamKimiChatAsResponsesChunks({
                provider: tokenObj,
                prompt: followUpPromptText,
                conversationKey,
                signal: abortController.signal
              })
              : await streamOpenAIChatAsResponsesChunks({
                provider: tokenObj,
                prompt: followUpPromptText,
                signal: abortController.signal
              }));
          if (followUpResult.content) {
            accumulatedRawContent += '\n\n' + followUpResult.content;
            parsed = parseToolCalls(accumulatedRawContent);
            if (followUpResult.messageId && sessionInfo) sessionInfo.parentMessageId = followUpResult.messageId;
          }
        } catch (e) {
          console.warn('[Anthropic Adapter] Supervisor follow-up failed:', e.message);
        }
      }
    }
  }

  // Map parsed tools to Anthropic tool_use format
  const mappedCalls = adaptCallsForTools(parsed.calls, body.tools || []);
  const cleanText = parsed.cleanContent.trim();
  const stopReason = mappedCalls.length > 0 ? 'tool_use' : 'end_turn';
  const outTokens = Math.max(10, Math.round(accumulatedRawContent.length / 4));

  if (isStream) {
    // Finalize text block
    if (textBlockOpened) {
      if (cleanText.length > emittedText.length) {
        const remaining = cleanText.slice(emittedText.length);
        sendSse('content_block_delta', {
          type: 'content_block_delta',
          index: textBlockIndex,
          delta: { type: 'text_delta', text: remaining }
        });
      }
      sendSse('content_block_stop', {
        type: 'content_block_stop',
        index: textBlockIndex
      });
    } else if (cleanText) {
      textBlockIndex = currentBlockIndex++;
      sendSse('content_block_start', {
        type: 'content_block_start',
        index: textBlockIndex,
        content_block: { type: 'text', text: '' }
      });
      sendSse('content_block_delta', {
        type: 'content_block_delta',
        index: textBlockIndex,
        delta: { type: 'text_delta', text: cleanText }
      });
      sendSse('content_block_stop', {
        type: 'content_block_stop',
        index: textBlockIndex
      });
    }

    // Stream each tool_use block
    for (const call of mappedCalls) {
      let inputArgs = {};
      try {
        inputArgs = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
      } catch {
        inputArgs = { raw: call.arguments };
      }
      const toolUseId = call.id || generateId('toolu_');
      const toolBlockIndex = currentBlockIndex++;

      sendSse('content_block_start', {
        type: 'content_block_start',
        index: toolBlockIndex,
        content_block: {
          type: 'tool_use',
          id: toolUseId,
          name: call.name,
          input: {}
        }
      });
      sendSse('content_block_delta', {
        type: 'content_block_delta',
        index: toolBlockIndex,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(inputArgs)
        }
      });
      sendSse('content_block_stop', {
        type: 'content_block_stop',
        index: toolBlockIndex
      });
    }

    // Send final message_delta and message_stop
    sendSse('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: stopReason,
        stop_sequence: null
      },
      usage: {
        output_tokens: outTokens
      }
    });

    sendSse('message_stop', {
      type: 'message_stop'
    });

    cleanup();
    res.end();
  } else {
    // Non-streaming JSON response
    const contentBlocks = [];
    if (cleanText) {
      contentBlocks.push({ type: 'text', text: cleanText });
    }

    for (const call of mappedCalls) {
      let inputArgs = {};
      try {
        inputArgs = typeof call.arguments === 'string' ? JSON.parse(call.arguments) : call.arguments;
      } catch {
        inputArgs = { raw: call.arguments };
      }
      contentBlocks.push({
        type: 'tool_use',
        id: call.id || generateId('toolu_'),
        name: call.name,
        input: inputArgs
      });
    }

    cleanup();
    res.json({
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: requestedModel,
      content: contentBlocks,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: Math.max(10, Math.round(promptText.length / 4)),
        output_tokens: outTokens
      }
    });
  }

  if (tokenObj) {
    tokenPool.recordUsage(tokenObj.id);
  }
}
