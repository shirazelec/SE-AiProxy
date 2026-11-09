import crypto from 'node:crypto';
import {
  generateId,
  parseToolCalls,
  findFabricatedResult,
  getVisibleStreamingText,
  buildPromptFromResponsesInput,
  extractTextFromContent,
  adaptCallsForTools,
  hasPriorModelActivity,
  isSyntheticUserText,
  limitCallBatch
} from './parser.js';
import { streamDeepSeekChat, createSession, isRateLimitedOrBusy, isSessionFullError } from './deepseek.js';
import { BoundedCache } from './sessionCache.js';
import tokenPool, { sessionKeyMatches } from './tokenPool.js';
import { isUnfulfilledIntent, isCompactionRequest, extractRecentErrorFromInput, isFinalDeliverableReport, DONE_CUE, ASK_USER_CUE } from './intent.js';
import { dumpUnparsedOutput } from './debugLog.js';
import { findLatestRealUserMessage, optimizePromptWithSupervisor, formatOptimizedUserPrompt } from './promptOptimizer.js';
import { enrichInputWithVision } from './vision.js';
import { judgeTurnCompletion } from './turnJudge.js';
import { hasRoleAccount } from './auxModel.js';
import { diagnoseToolError, formatDiagnosisNote } from './debugger.js';
import { DEEPSEEK_WEB_MODELS, deepSeekWebModelOptions } from './deepseekWebModels.js';
import { streamOpenAIChatAsResponsesChunks } from './providerRunner.js';
import { streamKimiChatAsResponsesChunks } from './kimiWeb.js';
import { findRepeatedCalls, loopAvoidanceNote, repeatedCallFollowUp, recentToolCalls, callSignature, describeCall } from './repeatGuard.js';
import { penalizeAccount, isNetworkError, isProviderWideOverload, NETWORK_FAIL_COOLDOWN_MS } from './accountHealth.js';

// Cache sessions: conversation key / response id -> { sessionId, parentMessageId, tokenId, inputCount }
// Response-id aliases point at the same object, so updates are shared across keys.
export const sessionCache = new BoundedCache({ maxEntries: 2000, ttlMs: 12 * 60 * 60 * 1000 });

const MAX_FAILOVER_ATTEMPTS = 3;
const MAX_FOLLOW_UPS = 3;

function hashKey(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 24);
}

function headerValue(req, name) {
  const v = req?.headers?.[name];
  if (Array.isArray(v)) return v[0];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export function resolveConversationKey(req, body) {
  // 1. Direct from previous response ID if already cached
  if (body.previous_response_id && sessionCache.has(body.previous_response_id)) {
    return body.previous_response_id;
  }

  // 2. Explicit conversation identifiers. Codex sets prompt_cache_key to its conversation id.
  const conv = body.conversation_id || (typeof body.conversation === 'object' ? body.conversation?.id : body.conversation);
  if (conv) return `conv_${conv}`;
  if (body.prompt_cache_key) return `conv_${body.prompt_cache_key}`;
  const metaConv = body.metadata?.conversation_id || body.metadata?.thread_id || body.metadata?.session_id;
  if (metaConv) return `conv_${metaConv}`;

  // 3. HTTP headers from Codex or custom clients
  for (const h of ['x-conversation-id', 'x-codex-thread-id', 'x-thread-id', 'conversation_id', 'session_id', 'x-session-id']) {
    const v = headerValue(req, h);
    if (v) return `conv_${v}`;
  }

  // 4. Decode x-codex-turn-metadata if present (JSON or base64 JSON)
  const metaHeader = headerValue(req, 'x-codex-turn-metadata');
  if (metaHeader) {
    try {
      let str = metaHeader;
      if (!str.startsWith('{')) str = Buffer.from(str, 'base64').toString('utf8');
      const parsed = JSON.parse(str);
      const tid = parsed.thread_id || parsed.threadId || parsed.conversation_id || parsed.conversationId || parsed.session_id;
      if (tid) return `thread_${tid}`;
    } catch {}
  }

  // 5. Stable thread fingerprint from body.input: the first REAL user message (Codex prepends
  //    environment/AGENTS.md blocks as user messages; those are identical across chats in a repo).
  if (Array.isArray(body.input) && body.input.length > 0) {
    const synthetic = [];
    for (const item of body.input) {
      if (!item || !(item.role === 'user' || item.type === 'userMessage')) continue;
      const text = extractTextFromContent(item.content);
      if (isSyntheticUserText(text)) {
        synthetic.push(text);
        continue;
      }
      const id = item.id || item.clientId;
      if (id) return `user_msg_${id}`;
      if (text) return `prompt_${hashKey(synthetic.join('\n') + '\n' + text)}`;
    }
    if (synthetic.length) return `prompt_${hashKey(synthetic.join('\n'))}`;
  }

  // 6. Unknown previous_response_id (e.g. after a proxy restart)
  if (body.previous_response_id) return body.previous_response_id;

  // 7. Fallback to active main conversation
  return 'default_active_conversation';
}

function isTokenUsable(tokenObj) {
  return Boolean(tokenObj) && tokenObj.status !== 'invalid' && tokenObj.status !== 'disabled' && Date.now() >= (tokenObj.rateLimitedUntil || 0);
}

const penalizeToken = penalizeAccount;

// A web account that only has to pause briefly (per-minute pacing, a first throttle warning, a busy
// server) is waited for instead of failed over: every failover opens a new chat on another account
// and re-sends the whole history, so the hourly new-chat budget of every account runs out long before
// the request budget does, and then the whole pool rests for half an hour.
export const SHORT_REST_MAX_MS = 45_000;
const MAX_SAME_ACCOUNT_WAITS = 2;

export function shortRestWaitMs(tokenObj, now = Date.now()) {
  if (!tokenObj || tokenObj.status === 'invalid' || tokenObj.status === 'disabled') return 0;
  if (tokenObj.type && tokenObj.type !== 'deepseek_web' && tokenObj.type !== 'kimi_web') return 0;
  const wait = (tokenObj.rateLimitedUntil || 0) - now;
  return wait > 0 && wait <= SHORT_REST_MAX_MS ? wait : 0;
}

// Last error of an account parked by the usage budget, a throttle warning or a busy server
export function isPauseReason(message) {
  const msg = String(message || '');
  return /usage budget/i.test(msg) || isRateLimitedOrBusy({ message: msg });
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }, { once: true });
  });
}

// kimi.ai rejects a chat once it passes 200,000 characters ("对话超过 20 万字"), whatever the dashboard
// history budget says; leave room for instructions and tool definitions on top of the history.
const KIMI_HISTORY_MAX_CHARS = 140000;
const DEEPSEEK_WEB_HISTORY_MAX_CHARS = 300000;
// Chabokan bills per token and the history is re-sent every turn (the API is stateless). Codex
// compacts its own history at ~64k tokens (~225k chars), so this budget never has to trim: the
// history only grows at the end, the provider serves the unchanged prefix from its cache (billed at
// a fraction of the price), and the model keeps everything it read since the last compaction.
const CHABOKAN_HISTORY_MAX_CHARS = 240000;
function promptBudgetFor(tokenObj) {
  const budget = tokenPool.getSettings().fullPromptMaxChars;
  if (tokenObj?.type === 'kimi_web') return Math.min(budget, KIMI_HISTORY_MAX_CHARS);
  if (tokenObj?.type === 'chabokan') return Math.min(budget, CHABOKAN_HISTORY_MAX_CHARS);
  // A real person never pastes a million characters into chat.deepseek.com; keep web sessions
  // looking ordinary (Codex compacts at ~225k chars anyway, so normal turns are unaffected)
  if (isWebAccount(tokenObj)) return Math.min(budget, DEEPSEEK_WEB_HISTORY_MAX_CHARS);
  return budget;
}

function isWebAccount(tokenObj) {
  return !tokenObj?.type || tokenObj.type === 'deepseek_web';
}

// Tail of the newest tool output, given to the supervisor so it can judge progress
function latestToolOutputText(input) {
  if (!Array.isArray(input)) return null;
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (item?.type === 'function_call_output' || item?.type === 'tool_result' || item?.type === 'custom_tool_call_output') {
      const out = typeof item.output === 'string' ? item.output : extractTextFromContent(item.output ?? item.content);
      return out ? String(out).slice(-800) : null;
    }
    if (item?.role === 'user') return null;
  }
  return null;
}

// Most recent real user request in the thread: the goal the supervisor judges progress against
function latestUserGoal(input) {
  if (!Array.isArray(input)) return null;
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (item?.role !== 'user' && item?.type !== 'userMessage') continue;
    const text = extractTextFromContent(item.content);
    if (text && !isSyntheticUserText(text)) return text.trim();
  }
  return null;
}

// Returns { tokenObj, sessionInfo, isNewBinding, migrated }. Reuses the bound account and DeepSeek
// session when healthy; otherwise picks another account and opens a fresh upstream session.
// preferId: an account that just switched to its next key. The retry goes straight to it: going
// through selection would count this very request as "busy" and hand it to an idle peer instead.
async function acquireSession(conversationKey, previous, excludeIds, { signal, preferId = null } = {}) {
  let preferred = null;
  // Rotate to a fresh upstream session before DeepSeek's per-session length cap is reached
  const needsRotation = Boolean(previous) && (previous.upstreamChars || 0) > tokenPool.getSettings().sessionRotateChars;
  if (needsRotation) {
    console.log(`[Responses] Upstream session for ${conversationKey} is ~${previous.upstreamChars} chars; rotating to a fresh session.`);
  }
  // API accounts are stateless (full prompt each turn), so they are re-balanced every turn instead of pinned
  if (previous && !previous.isCustomProvider && !needsRotation && !excludeIds.has(previous.tokenId)) {
    const bound = tokenPool.getFullToken(previous.tokenId);
    // The chat belongs to the key that opened it; after a key switch the account opens a new chat
    const sameKey = sessionKeyMatches(previous, bound);
    if (isTokenUsable(bound) && previous.sessionId && sameKey) {
      return { tokenObj: bound, sessionInfo: previous, isNewBinding: false, migrated: false };
    }
    // Bound account is only pausing for a few seconds: keep the conversation (and its chat) on it
    const restMs = previous.sessionId && sameKey && isPauseReason(bound?.lastError) ? shortRestWaitMs(bound) : 0;
    if (restMs) {
      console.log(`[Responses] ${bound.label || bound.id} rests ${Math.ceil(restMs / 1000)}s; waiting instead of migrating ${conversationKey}.`);
      await sleep(restMs + 250, signal);
      return { tokenObj: bound, sessionInfo: previous, isNewBinding: false, migrated: false };
    }
    if (!sameKey && isTokenUsable(bound)) {
      console.log(`[Responses] ${bound.label || bound.id} switched keys; opening a new chat for ${conversationKey} on its next key.`);
      preferred = bound;
    } else console.warn(`[Responses] Token ${previous.tokenId} unavailable, migrating conversation to another account.`);
  }

  let lastErr = null;
  // One try per key: an account that switches keys is retried on its next key
  const poolSize = Math.max(1, tokenPool.countKeys());
  if (!preferred && preferId && !excludeIds.has(preferId)) {
    const acc = tokenPool.getFullToken(preferId);
    if (isTokenUsable(acc)) preferred = acc;
  }
  for (let i = 0; i < poolSize; i++) {
    let tokenObj;
    if (preferred && isTokenUsable(preferred) && !excludeIds.has(preferred.id)) {
      tokenObj = preferred;
      tokenPool.bindConversationTo(conversationKey, tokenObj.id);
    } else {
      ({ tokenObj } = tokenPool.selectTokenForConversation(conversationKey, excludeIds));
    }

    // Non-web accounts (TokenHarbor, Google Gemini, Custom OpenAI) do not require DeepSeek Web PoW/session
    if (tokenObj.type && tokenObj.type !== 'deepseek_web') {
      const sessionInfo = {
        sessionId: 'session_' + tokenObj.id,
        parentMessageId: null,
        tokenId: tokenObj.id,
        inputCount: 0,
        upstreamChars: 0,
        isCustomProvider: true,
        provider: tokenObj,
        // Per-conversation state that must survive rotating to another API account
        tools: previous?.tools,
        deferredCalls: previous?.deferredCalls || null
      };
      if (previous) sessionCache.deleteValue(previous);
      sessionCache.set(conversationKey, sessionInfo);
      return {
        tokenObj,
        sessionInfo,
        isNewBinding: true,
        // Rotating between stateless API accounts is normal load balancing, not a failover
        migrated: Boolean(previous && !previous.isCustomProvider && previous.tokenId !== tokenObj.id)
      };
    }

    try {
      const sessionId = await createSession(tokenObj.token);
      const sessionInfo = { sessionId, parentMessageId: null, tokenId: tokenObj.id, keyId: tokenObj.activeKeyId, inputCount: 0, upstreamChars: 0 };
      if (previous) sessionCache.deleteValue(previous);
      sessionCache.set(conversationKey, sessionInfo);
      return {
        tokenObj,
        sessionInfo,
        isNewBinding: true,
        migrated: Boolean(previous && (previous.tokenId !== tokenObj.id || !sessionKeyMatches(previous, tokenObj)))
      };
    } catch (err) {
      console.error(`[Responses] Session init failed on ${tokenObj.label || tokenObj.id}:`, err.message);
      lastErr = err;
      // Switched to another key of the same account: try it before moving on
      if (penalizeToken(tokenObj.id, err)) continue;
      excludeIds.add(tokenObj.id);
      // Continue trying any other available token in the pool; never give up early!
      if (excludeIds.size >= tokenPool.tokens.length) break;
    }
  }
  throw lastErr || new Error('No DeepSeek account available');
}

// The upstream session only mirrors Codex's history if the input kept growing; a shorter input means
// Codex compacted or rewound the thread, so the incremental diff would be wrong.
function canContinue(sessionInfo, body, isNewBinding) {
  if (isNewBinding || !sessionInfo?.parentMessageId) return false;
  if (body.previous_response_id) return true;
  if (Array.isArray(body.input) && sessionInfo.inputCount && body.input.length <= sessionInfo.inputCount) {
    return false;
  }
  return true;
}

// Usage must describe the size of *Codex's* conversation, which drives its auto-compaction.
// Estimating from the actual prompt characters prevents bloated JSON schemas and metadata
// from triggering premature/infinite auto-compaction loops in Codex.
const CHARS_PER_TOKEN = 3.5;
// The prompt sent upstream may be a trimmed or incremental view of the conversation; Codex must
// still see the real conversation size, otherwise it never compacts and the model silently loses
// older steps (it then re-reads the same files over and over).
export function estimateUsage(body, outputText, effectivePrompt) {
  const promptChars = typeof effectivePrompt === 'string' ? effectivePrompt.length
    : (typeof effectivePrompt === 'number' && effectivePrompt > 0 ? effectivePrompt : 0);
  let inputChars = 0;
  {
    try {
      inputChars += typeof body?.instructions === 'string' ? body.instructions.length : 0;
      if (Array.isArray(body?.input)) {
        for (const item of body.input) {
          if (typeof item === 'string') {
            inputChars += item.length;
          } else if (item && typeof item === 'object') {
            if (typeof item.content === 'string') inputChars += item.content.length;
            else if (Array.isArray(item.content)) {
              for (const c of item.content) {
                if (typeof c === 'string') inputChars += c.length;
                else if (c?.text) inputChars += c.text.length;
                else if (c?.input_text) inputChars += c.input_text.length;
              }
            }
            if (typeof item.output === 'string') inputChars += item.output.length;
            else if (Array.isArray(item.output)) for (const c of item.output) inputChars += (c?.text || '').length;
            if (typeof item.arguments === 'string') inputChars += item.arguments.length;
            if (typeof item.input === 'string') inputChars += item.input.length;
          }
        }
      } else if (typeof body?.input === 'string') {
        inputChars = body.input.length;
      }
    } catch {}
  }
  inputChars = Math.max(inputChars, promptChars);
  const input = Math.max(1, Math.ceil(inputChars / CHARS_PER_TOKEN));
  const output = Math.max(1, Math.ceil((outputText || '').length / CHARS_PER_TOKEN));
  return { input_tokens: input, output_tokens: output, total_tokens: input + output };
}

function errorCodeFor(err) {
  if (isRateLimitedOrBusy(err)) return 'rate_limit_exceeded';
  // Only reached when even a trimmed history in a fresh session did not fit
  if (isSessionFullError(err)) return 'context_length_exceeded';
  if (err?.status === 401) return 'invalid_api_key';
  return typeof err?.code === 'string' ? err.code : 'server_error';
}

// Codex executes one turn's calls concurrently; see limitCallBatch for why batches are cut
function batchCallsForCodex(calls, body, sessionInfo) {
  const limited = limitCallBatch(calls, { parallel: body.parallel_tool_calls !== false });
  // The model's own upstream session still holds the full batch; tell it next turn what really ran
  if (sessionInfo) sessionInfo.deferredCalls = limited.length < calls.length ? { ran: limited.length, total: calls.length } : null;
  if (limited.length < calls.length) {
    console.log(`[Responses] Deferred ${calls.length - limited.length} of ${calls.length} tool calls: they depend on the state-changing call before them and would race (parallel_tool_calls=${body.parallel_tool_calls}).`);
  }
  return limited;
}

function buildOutputItemsForCalls(calls) {
  return calls.map(call => (call.kind === 'custom'
    ? { id: generateId('ctc_'), type: 'custom_tool_call', status: 'completed', call_id: call.id, name: call.name, input: call.input }
    : { id: generateId('fc_'), type: 'function_call', status: 'completed', call_id: call.id, name: call.name, arguments: call.arguments }));
}

export { DEEPSEEK_WEB_MODELS, deepSeekWebModelOptions };

export async function handleResponsesRequest(req, res) {
  const body = req.body || {};
  const modelId = body.model || 'deepseek-chat';
  const isReasoner = modelId === 'deepseek-reasoner' || /reasoner|r1/i.test(modelId);
  const modelType = isReasoner ? 'expert' : 'default';
  const thinkingEnabled = isReasoner || Boolean(body.reasoning?.effort && body.reasoning.effort !== 'none');

  let clientDisconnected = false;
  const abortController = new AbortController();

  // Resolve conversation key and the DeepSeek session already bound to it (if any)
  const conversationKey = resolveConversationKey(req, body);
  const previous = sessionCache.get(conversationKey) ||
    (body.previous_response_id ? sessionCache.get(body.previous_response_id) : undefined);
  const excludeIds = new Set();

  // acquireSession walks the whole pool (priority order, DeepSeek Web and API accounts alike)
  let binding;
  try {
    binding = await acquireSession(conversationKey, previous, excludeIds, { signal: abortController.signal });
  } catch (err) {
    console.error('[Responses Session Error]', err.message);
    const status = isRateLimitedOrBusy(err) ? 429 : (err.status >= 400 && err.status < 600 ? err.status : 503);
    return res.status(status).json({
      error: {
        message: err.message || 'Failed to initialize session with DeepSeek',
        type: 'api_error',
        code: status === 429 ? 'rate_limit_exceeded' : 'session_init_failed'
      }
    });
  }

  let { tokenObj, sessionInfo } = binding;
  let isFailover = binding.migrated;
  if (tokenObj?.id) tokenPool.incrementActiveRequests(tokenObj.id);

  // 'finish' and 'close' both fire on a normal response; release the slot only once
  let activeTokenReleased = false;
  const releaseActiveToken = () => {
    if (activeTokenReleased) return;
    activeTokenReleased = true;
    if (tokenObj?.id) {
      tokenPool.decrementActiveRequests(tokenObj.id);
    }
  };
  res.on('finish', releaseActiveToken);
  res.on('close', releaseActiveToken);
  const inputCount = Array.isArray(body.input) ? body.input.length : 0;
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    sessionInfo.tools = body.tools;
  }
  const tools = body.tools || sessionInfo.tools || [];

  // Multimodal Vision: Automatically inspect images, schematics, and view_image calls via DeepSeek Vision
  // (DeepSeek Web only: API accounts' keys cannot be used for DeepSeek's vision upload)
  const visionToken = isWebAccount(tokenObj)
    ? tokenObj.token
    : tokenPool.tokens.find(t => isWebAccount(t) && isTokenUsable(t))?.token;
  if (visionToken && Array.isArray(body.input)) {
    try {
      await enrichInputWithVision({
        input: body.input,
        token: visionToken,
        signal: abortController.signal
      });
    } catch (err) {
      console.warn('[Responses] Vision enrichment skipped:', err.message);
    }
  }

  // Dual-Model Cognitive Supervisor: Professionalize human user requests into AI-optimized specifications
  // ONLY for DeepSeek Web accounts (where DeepSeek-R1 needs guidance from V3).
  // For API providers (TokenHarbor, Moonmath, Gemini), DeepSeek V4.1 is already direct, fast, and does NOT
  // need this extra LLM round-trip which adds 3-5 seconds of latency before every turn.
  // With an account dedicated to the 'prompt' role (A) the brief is built for every provider.
  const promptRole = hasRoleAccount('prompt');
  const latestUser = (isWebAccount(tokenObj) || promptRole) && !isCompactionRequest(body.input) ? findLatestRealUserMessage(body.input) : null;
  if (latestUser) {
    try {
      const supervisorSpec = await optimizePromptWithSupervisor({
        userText: latestUser.text,
        avoidTokenId: tokenObj.id,
        signal: abortController.signal,
        timeoutMs: promptRole ? 60000 : 8000
      });
      if (supervisorSpec) {
        const enrichedText = formatOptimizedUserPrompt(latestUser.text, supervisorSpec);
        body.input = body.input.map((item, idx) => {
          if (idx === latestUser.index) {
            if (typeof item.content === 'string') return { ...item, content: enrichedText };
            if (Array.isArray(item.content)) {
              return {
                ...item,
                content: item.content.map(part => {
                  if (part?.text) return { ...part, text: enrichedText };
                  if (part?.input_text) return { ...part, input_text: enrichedText };
                  return part;
                })
              };
            }
          }
          return item;
        });
      }
    } catch (err) {
      console.warn('[Responses] Supervisor prompt optimization error:', err.message);
    }
  }

  // Role C ('debug'): the latest command failed, so the debugger account diagnoses it for the worker
  let debuggerNote = '';
  const lastItem = Array.isArray(body.input) ? body.input[body.input.length - 1] : null;
  if (hasRoleAccount('debug') && ['function_call_output', 'tool_result', 'commandExecution', 'custom_tool_call_output'].includes(lastItem?.type)) {
    const failure = extractRecentErrorFromInput(body.input);
    if (failure) {
      try {
        debuggerNote = formatDiagnosisNote(await diagnoseToolError({
          input: body.input,
          goal: latestUserGoal(body.input),
          errorText: failure,
          outputTail: latestToolOutputText(body.input),
          avoidTokenId: tokenObj.id,
          signal: abortController.signal
        }));
      } catch (err) {
        console.warn('[Responses] Debugger diagnosis skipped:', err.message);
      }
    }
  }

  let interruptedContext = null;
  // level > 0: rebuilding after the upstream session filled up; each level halves the history budget
  const buildPrompt = (isContinuation, level = 0) => buildPromptFromResponsesInput({
    instructions: body.instructions,
    input: body.input,
    tools,
    isContinuation,
    isFailover,
    interruptedContext,
    maxChars: Math.floor(promptBudgetFor(tokenObj) / 2 ** Math.max(0, level - 1))
  }) + loopAvoidanceNote(body.input) + debuggerNote;
  const rebuildPrompt = (level = 0) => {
    isFailover = true;
    prompt = buildPrompt(false, level);
    return prompt;
  };

  const isContinuation = canContinue(sessionInfo, body, binding.isNewBinding);
  let prompt = buildPrompt(isContinuation);
  if (sessionInfo.deferredCalls) {
    const { ran, total } = sessionInfo.deferredCalls;
    prompt += `\n\n[EXECUTION NOTE]: Only the first ${ran} of the ${total} tool calls in your previous reply were executed (calls run in parallel, so steps that depend on an earlier state-changing call are held back). Their results are above. Re-issue any remaining steps that are still needed, at most one state-changing call per reply.`;
    sessionInfo.deferredCalls = null;
  }
  if (binding.isNewBinding && hasPriorModelActivity(body.input)) {
    console.log(`[Responses] ${isFailover ? 'Failover' : 'New session'} for ${conversationKey}: re-injecting full history (${inputCount} items).`);
  }

  if (!prompt.trim()) {
    return res.status(400).json({
      error: {
        message: 'No input text or instructions provided',
        type: 'invalid_request_error',
        code: 'empty_input'
      }
    });
  }

  let accumulatedRawContent = '';
  let accumulatedThinking = '';

  // One DeepSeek completion with in-request failover: on 429/401 the conversation moves to another
  // account (fresh session + full history) as long as nothing has been streamed to the client yet.
  const runCompletion = async ({ onChunk, signal, canFailover, onFailover }) => {
    const maxFailoverAttempts = Math.max(10, (tokenPool.countKeys() || 1) * 2);
    let sameAccountWaits = 0;
    // Network drops per account in this request: one is a blip, two means the route is bad
    const networkFails = new Map();
    for (let attempt = 1; ; attempt++) {
      try {
        if (tokenObj.type === 'kimi_web') {
          const result = await streamKimiChatAsResponsesChunks({
            provider: tokenObj,
            prompt,
            conversationKey,
            signal,
            onChunk
          });
          tokenPool.recordUsage(tokenObj.id);
          return result;
        }

        if (tokenObj.type && tokenObj.type !== 'deepseek_web') {
          const result = await streamOpenAIChatAsResponsesChunks({
            provider: tokenObj,
            prompt,
            signal,
            onChunk
          });
          tokenPool.recordUsage(tokenObj.id);
          return result;
        }

        const webModel = deepSeekWebModelOptions(tokenObj.model, { modelType, thinkingEnabled });
        const result = await streamDeepSeekChat({
          token: tokenObj.token,
          sessionId: sessionInfo.sessionId,
          parentMessageId: sessionInfo.parentMessageId,
          prompt,
          modelType: webModel.modelType,
          thinkingEnabled: webModel.thinkingEnabled,
          signal,
          onChunk,
          rebuildPrompt,
          // Retry temporary frequency throttles smoothly before failing over
          retryOnRateLimit: true
        });
        if (result.sessionReset) {
          sessionInfo.sessionId = result.sessionId;
          sessionInfo.parentMessageId = null;
          sessionInfo.upstreamChars = 0;
        }
        if (result.messageId) sessionInfo.parentMessageId = result.messageId;
        sessionInfo.upstreamChars = (sessionInfo.upstreamChars || 0) + prompt.length +
          (result.content || '').length + (result.thinkingContent || '').length;
        tokenPool.recordUsage(tokenObj.id);
        return result;
      } catch (err) {
        if (signal?.aborted) throw err;
        // true: the account moved on to its next key, so the retry stays on this account
        let switchedKey = penalizeToken(tokenObj.id, err);
        const networkErr = isNetworkError(err);
        let networkGiveUp = false;
        if (networkErr) {
          const fails = (networkFails.get(tokenObj.id) || 0) + 1;
          networkFails.set(tokenObj.id, fails);
          if (fails >= 2 && tokenPool.tokens.length > 1) {
            networkGiveUp = true;
            networkFails.delete(tokenObj.id);
            switchedKey = tokenPool.markTokenRateLimited(tokenObj.id, NETWORK_FAIL_COOLDOWN_MS, `Connection keeps failing: ${err.message}`) || false;
          }
        }
        if (attempt >= maxFailoverAttempts || !canFailover()) throw err;

        if (accumulatedRawContent || accumulatedThinking) {
          interruptedContext = {
            content: accumulatedRawContent.trim(),
            thinking: accumulatedThinking.trim()
          };
        }

        const isWafOrHtml = err.status === 403 || err.isHtml || /<html|<!doctype|checkpoint|turnstile/i.test(err.message);

        // Short pause and nothing streamed yet: retry on the same account and chat instead of opening
        // a new chat elsewhere (the request never reached the model, so the prompt stays valid)
        // Only budget / throttle / busy pauses qualify; a CHALLENGE_REQUIRED or other error still fails over
        const nothingStreamed = !accumulatedRawContent && !accumulatedThinking;
        // A provider-wide overload (Kimi full for free users) will not clear by waiting on this account
        const isPause = (err.code === 'account_budget' || isRateLimitedOrBusy(err)) && !isProviderWideOverload(err);
        const restMs = isPause && !networkErr && !isWafOrHtml && !isSessionFullError(err) && nothingStreamed &&
          sameAccountWaits < MAX_SAME_ACCOUNT_WAITS
          ? shortRestWaitMs(tokenPool.getFullToken(tokenObj.id))
          : 0;
        if (restMs) {
          sameAccountWaits++;
          console.log(`[Responses] ${tokenObj.label || tokenObj.id} rests ${Math.ceil(restMs / 1000)}s (${err.message}); waiting on the same account instead of failing over (${sameAccountWaits}/${MAX_SAME_ACCOUNT_WAITS}).`);
          await sleep(restMs + 250, signal);
          continue;
        }

        if (networkErr && !networkGiveUp) {
          const waitMs = isWebAccount(tokenObj) ? 2000 : 300;
          console.warn(`[Responses] Network drop detected (${err.message}). Retrying in ${waitMs}ms (attempt ${attempt}/${maxFailoverAttempts})...`);
          await new Promise(r => setTimeout(r, waitMs));
        } else if (isWafOrHtml) {
          // Upstream security challenge / WAF block (Vercel / Cloudflare 403 HTML):
          // Cooling down for 1500ms prevents Layer 7 flood detection from cascading across all accounts.
          const waitMs = 1500;
          console.warn(`[Responses] Upstream security checkpoint / WAF challenge (${err.message}). Cooling down for ${waitMs}ms before failover...`);
          await new Promise(r => setTimeout(r, waitMs));
        } else {
          // Pacing: only web accounts need pacing to avoid bot detection; API providers fail over with 0ms delay!
          if (isWebAccount(tokenObj)) {
            await new Promise(r => setTimeout(r, 600));
          }
        }

        if (tokenPool.tokens.length > 1 && (!networkErr || networkGiveUp) && !switchedKey) {
          excludeIds.add(tokenObj.id);
        }
        let next;
        const preferId = switchedKey ? tokenObj.id : null;
        try {
          next = await acquireSession(conversationKey, sessionInfo, excludeIds, { preferId });
        } catch (selectErr) {
          if (excludeIds.size >= tokenPool.tokens.length && tokenPool.tokens.length > 1) {
            excludeIds.clear();
            excludeIds.add(tokenObj.id);
            try {
              next = await acquireSession(conversationKey, sessionInfo, excludeIds);
            } catch (retryErr) {
              throw retryErr?.allExhausted ? retryErr : err;
            }
          } else {
            throw selectErr?.allExhausted ? selectErr : err;
          }
        }
        if (next.tokenObj.id === tokenObj.id) console.warn(`[Responses] Retrying ${conversationKey} on ${tokenObj.label || tokenObj.id} with its next key (${err.message}).`);
        else console.warn(`[Responses] Failing over ${conversationKey} from ${tokenObj.label || tokenObj.id} to ${next.tokenObj.label || next.tokenObj.id} (${err.message}).`);
        if (tokenObj?.id) tokenPool.decrementActiveRequests(tokenObj.id);
        ({ tokenObj, sessionInfo } = next);
        if (tokenObj?.id) tokenPool.incrementActiveRequests(tokenObj.id);
        isFailover = true;
        if (typeof onFailover === 'function') onFailover();
        // Progressively compact history on repeated failovers so oversized payloads fit upstream WAF limits.
        // On WAF/HTML blocks, immediately apply aggressive compaction (level >= 2) so the next account isn't blocked!
        // A network drop says nothing about payload size: keep the full history then
        const level = isWafOrHtml
          ? Math.max(2, attempt)
          : (networkErr ? 0 : (attempt > 1 ? Math.min(3, attempt) : 0));
        prompt = buildPrompt(false, level);
      }
    }
  };

  // Supervisor follow-up inside the same turn. It stays on the turn's account and session (a DeepSeek
  // session belongs to one account, so it can never be continued with another account's token); on
  // failure the conversation is handed off to the next account with the full history, the reply
  // produced so far and the supervisor instruction, so the new model resumes instead of restarting.
  let lastContinuationError = null;
  const runFollowUp = async (followUpPrompt, onFollowUpChunk) => {
    if (accumulatedRawContent.trim()) accumulatedRawContent += '\n\n';
    const replySoFar = accumulatedRawContent;
    const withReplySoFar = (historyPrompt) => `${historyPrompt}\n\n[YOUR REPLY SO FAR IN THIS TURN]:\n${replySoFar.trim() || '(empty)'}\n\n${followUpPrompt}`;

    for (let attempt = 1; attempt <= 3 && !clientDisconnected; attempt++) {
      accumulatedRawContent = replySoFar;
      try {
        if (tokenObj.type === 'kimi_web') {
          const result = await streamKimiChatAsResponsesChunks({
            provider: tokenObj,
            prompt: withReplySoFar(buildPrompt(false)),
            conversationKey,
            signal: abortController.signal,
            onChunk: onFollowUpChunk
          });
          return result;
        }
        if (!isWebAccount(tokenObj)) {
          const result = await streamOpenAIChatAsResponsesChunks({
            provider: tokenObj,
            prompt: withReplySoFar(buildPrompt(false)),
            signal: abortController.signal,
            onChunk: onFollowUpChunk
          });
          return result;
        }
        const freshSession = !sessionInfo.parentMessageId;
        const followPrompt = freshSession ? withReplySoFar(buildPrompt(false)) : followUpPrompt;
        const result = await streamDeepSeekChat({
          token: tokenObj.token,
          sessionId: sessionInfo.sessionId,
          parentMessageId: sessionInfo.parentMessageId,
          prompt: followPrompt,
          modelType: 'default',
          thinkingEnabled: false,
          signal: abortController.signal,
          rebuildPrompt: (level) => withReplySoFar(rebuildPrompt(level)),
          onChunk: onFollowUpChunk,
          retryOnRateLimit: true
        });
        if (result.sessionReset) sessionInfo.sessionId = result.sessionId;
        if (result.messageId) sessionInfo.parentMessageId = result.messageId;
        sessionInfo.upstreamChars = (sessionInfo.upstreamChars || 0) + followPrompt.length + (result.content || '').length;
        tokenPool.recordUsage(tokenObj.id);
        return result;
      } catch (err) {
        if (abortController.signal.aborted) throw err;
        lastContinuationError = err;
        const followUpSwitchedKey = penalizeToken(tokenObj.id, err);
        console.warn(`[Responses] Supervisor follow-up failed on ${tokenObj.label || tokenObj.id}: ${err.message}`);
        if (!isNetworkError(err) && !followUpSwitchedKey) {
          excludeIds.add(tokenObj.id);
          if (err.status === 403 || /<html|<!doctype|403/i.test(err.message)) {
            for (const tok of tokenPool.tokens) {
              if (tok.type === tokenObj.type || (tok.baseUrl && tok.baseUrl === tokenObj.baseUrl)) {
                excludeIds.add(tok.id);
              }
            }
          }
        }
        let next;
        try {
          next = await acquireSession(conversationKey, sessionInfo, excludeIds, { preferId: followUpSwitchedKey ? tokenObj.id : null });
        } catch {
          return null;
        }
        console.warn(`[Responses] Handing off ${conversationKey} follow-up from ${tokenObj.label || tokenObj.id} to ${next.tokenObj.label || next.tokenObj.id}.`);
        if (tokenObj?.id) tokenPool.decrementActiveRequests(tokenObj.id);
        ({ tokenObj, sessionInfo } = next);
        if (tokenObj?.id) tokenPool.incrementActiveRequests(tokenObj.id);
        isFailover = true;
      }
    }
    return null;
  };

  const remember = (responseId) => {
    sessionInfo.inputCount = inputCount;
    sessionCache.set(conversationKey, sessionInfo);
    sessionCache.set(responseId, sessionInfo);
  };

  const isStream = body.stream !== false; // Default is stream: true

  if (!isStream) {
    // Non-streaming response; errors propagate to the route handler, which replies with JSON
    const result = await runCompletion({ canFailover: () => true });

    let parsed = parseToolCalls(result.content || '');
    if (parsed.calls.length === 0 && result.thinkingContent) {
      const thinkingCalls = parseToolCalls(result.thinkingContent);
      if (thinkingCalls.calls.length > 0) parsed = { cleanContent: parsed.cleanContent, calls: thinkingCalls.calls };
    }
    const calls = batchCallsForCodex(adaptCallsForTools(parsed.calls, tools), body, sessionInfo);
    const outputItems = [];

    if (result.thinkingContent) {
      outputItems.push({
        id: generateId('rs_'),
        type: 'reasoning',
        status: 'completed',
        summary: [{ type: 'summary_text', text: result.thinkingContent }]
      });
    }

    if (parsed.cleanContent || calls.length === 0) {
      outputItems.push({
        id: generateId('msg_'),
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: parsed.cleanContent || 'Done.',
            annotations: []
          }
        ]
      });
    }

    outputItems.push(...buildOutputItemsForCalls(calls));

    const newResponseId = generateId('resp_');
    remember(newResponseId);

    return res.json({
      id: newResponseId,
      object: 'response',
      created_at: Math.floor(Date.now() / 1000),
      status: 'completed',
      model: modelId,
      output: outputItems,
      usage: estimateUsage(body, result.content, prompt)
    });
  }

  // Streaming SSE response
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();

  const canWrite = () => !clientDisconnected && !res.writableEnded && !res.destroyed;

  const writeEvent = (eventType, data) => {
    if (!canWrite()) return;
    res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const responseId = generateId('resp_');
  const messageItemId = generateId('msg_');
  const reasoningItemId = generateId('rs_');
  const createdAt = Math.floor(Date.now() / 1000);

  // Keep-alive heartbeat ping
  const pingInterval = setInterval(() => {
    if (canWrite()) res.write(': ping\n\n');
  }, 5000);

  res.on('close', () => {
    clearInterval(pingInterval);
    if (!res.writableEnded) {
      // Client went away before we finished: stop generating upstream
      clientDisconnected = true;
      abortController.abort();
    }
  });
  res.on('error', (err) => {
    console.warn('[Responses] Client socket error:', err.message);
  });

  const baseResponse = (status, extra = {}) => ({
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status,
    model: modelId,
    output: [],
    ...extra
  });

  writeEvent('response.created', { type: 'response.created', response: baseResponse('in_progress') });
  writeEvent('response.in_progress', { type: 'response.in_progress', response: baseResponse('in_progress') });

  let outputIndex = 0;
  let reasoningStarted = false;
  let reasoningFinished = false;
  let currentSummaryIndex = 0;
  let currentPartStarted = false;
  let currentPartText = '';
  const summaryList = [];
  let messageStarted = false;
  let messageOutputIndex = -1;
  accumulatedRawContent = '';
  let emittedText = '';
  accumulatedThinking = '';
  const finalOutputs = [];

  const startMessage = () => {
    if (messageStarted) return;
    messageStarted = true;
    messageOutputIndex = outputIndex;
    writeEvent('response.output_item.added', {
      type: 'response.output_item.added',
      output_index: messageOutputIndex,
      item: { id: messageItemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] }
    });
    writeEvent('response.content_part.added', {
      type: 'response.content_part.added',
      item_id: messageItemId,
      output_index: messageOutputIndex,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] }
    });
  };

  const writeTextDelta = (delta) => {
    if (!delta) return;
    startMessage();
    emittedText += delta;
    writeEvent('response.output_text.delta', {
      type: 'response.output_text.delta',
      item_id: messageItemId,
      output_index: messageOutputIndex,
      content_index: 0,
      delta
    });
  };

  // Stream newly accumulated visible text in real-time (tool markup is held back)
  let lastEmitTime = 0;
  let emitTimer = null;
  const emitVisibleDelta = (raw, force = false) => {
    const now = Date.now();
    if (force || now - lastEmitTime >= 50) {
      if (emitTimer) { clearTimeout(emitTimer); emitTimer = null; }
      lastEmitTime = now;
      const currentVisible = getVisibleStreamingText(raw);
      if (/(?:با توجه به لیست مشکلاتی که دادی|سلام! من توی پوشه‌ی)/i.test(currentVisible)) return;
      if (currentVisible.length > emittedText.length && currentVisible.startsWith(emittedText)) {
        writeTextDelta(currentVisible.slice(emittedText.length));
      }
    } else if (!emitTimer) {
      emitTimer = setTimeout(() => {
        emitTimer = null;
        lastEmitTime = Date.now();
        const currentVisible = getVisibleStreamingText(accumulatedRawContent);
        if (/(?:با توجه به لیست مشکلاتی که دادی|سلام! من توی پوشه‌ی)/i.test(currentVisible)) return;
        if (currentVisible.length > emittedText.length && currentVisible.startsWith(emittedText)) {
          writeTextDelta(currentVisible.slice(emittedText.length));
        }
      }, 50);
    }
  };

  const finishReasoning = () => {
    if (!reasoningStarted || reasoningFinished) return;
    reasoningFinished = true;
    if (currentPartStarted && currentPartText.trim()) {
      writeEvent('response.reasoning_summary_text.done', {
        type: 'response.reasoning_summary_text.done',
        item_id: reasoningItemId,
        output_index: outputIndex,
        summary_index: currentSummaryIndex,
        text: currentPartText.trim()
      });
      writeEvent('response.reasoning_summary_part.done', {
        type: 'response.reasoning_summary_part.done',
        item_id: reasoningItemId,
        output_index: outputIndex,
        summary_index: currentSummaryIndex,
        part: { type: 'summary_text', text: currentPartText.trim() }
      });
      summaryList.push({ type: 'summary_text', text: currentPartText.trim() });
      currentPartStarted = false;
      currentPartText = '';
    } else if (currentPartStarted) {
      writeEvent('response.reasoning_summary_text.done', {
        type: 'response.reasoning_summary_text.done',
        item_id: reasoningItemId,
        output_index: outputIndex,
        summary_index: currentSummaryIndex,
        text: currentPartText
      });
      writeEvent('response.reasoning_summary_part.done', {
        type: 'response.reasoning_summary_part.done',
        item_id: reasoningItemId,
        output_index: outputIndex,
        summary_index: currentSummaryIndex,
        part: { type: 'summary_text', text: currentPartText }
      });
      if (currentPartText) summaryList.push({ type: 'summary_text', text: currentPartText });
      currentPartStarted = false;
      currentPartText = '';
    }

    if (summaryList.length === 0 && accumulatedThinking.trim()) {
      summaryList.push({ type: 'summary_text', text: accumulatedThinking.trim() });
    }

    const reasoningDoneItem = {
      id: reasoningItemId,
      type: 'reasoning',
      status: 'completed',
      summary: summaryList.length ? summaryList : [{ type: 'summary_text', text: accumulatedThinking || 'Thinking...' }]
    };
    writeEvent('response.output_item.done', {
      type: 'response.output_item.done',
      output_index: outputIndex,
      item: reasoningDoneItem
    });
    finalOutputs.push(reasoningDoneItem);
    outputIndex++;
  };

  const onChunk = (chunk) => {
    if (chunk.type === 'thinking') {
      if (reasoningFinished) return; // late thinking after text started is not representable
      accumulatedThinking += chunk.content;
      if (!reasoningStarted) {
        reasoningStarted = true;
        writeEvent('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: outputIndex,
          item: { id: reasoningItemId, type: 'reasoning', status: 'in_progress', summary: [] }
        });
      }

      let remaining = chunk.content;
      while (remaining.length > 0) {
        let splitIdx = remaining.indexOf('\n');
        let isNewline = splitIdx !== -1;

        // Break on sentence end if the current line has grown long enough (>100 chars)
        if (!isNewline && currentPartText.length > 100) {
          const m = /[\.\!\?؟]\s+/.exec(remaining);
          if (m) {
            splitIdx = m.index + m[0].length;
            isNewline = false;
          }
        }

        if (splitIdx === -1) {
          const textToAppend = remaining;
          remaining = '';
          if (!currentPartStarted && textToAppend.trim()) {
            writeEvent('response.reasoning_summary_part.added', {
              type: 'response.reasoning_summary_part.added',
              item_id: reasoningItemId,
              output_index: outputIndex,
              summary_index: currentSummaryIndex,
              part: { type: 'summary_text', text: '' }
            });
            currentPartStarted = true;
          }
          if (currentPartStarted) {
            currentPartText += textToAppend;
            writeEvent('response.reasoning_summary_text.delta', {
              type: 'response.reasoning_summary_text.delta',
              item_id: reasoningItemId,
              output_index: outputIndex,
              summary_index: currentSummaryIndex,
              delta: textToAppend
            });
          }
        } else {
          const segment = remaining.slice(0, splitIdx);
          remaining = remaining.slice(splitIdx + (isNewline ? 1 : 0));

          if (!currentPartStarted && segment.trim()) {
            writeEvent('response.reasoning_summary_part.added', {
              type: 'response.reasoning_summary_part.added',
              item_id: reasoningItemId,
              output_index: outputIndex,
              summary_index: currentSummaryIndex,
              part: { type: 'summary_text', text: '' }
            });
            currentPartStarted = true;
          }

          if (currentPartStarted) {
            if (segment) {
              currentPartText += segment;
              writeEvent('response.reasoning_summary_text.delta', {
                type: 'response.reasoning_summary_text.delta',
                item_id: reasoningItemId,
                output_index: outputIndex,
                summary_index: currentSummaryIndex,
                delta: segment
              });
            }
            if (currentPartText.trim()) {
              writeEvent('response.reasoning_summary_text.done', {
                type: 'response.reasoning_summary_text.done',
                item_id: reasoningItemId,
                output_index: outputIndex,
                summary_index: currentSummaryIndex,
                text: currentPartText.trim()
              });
              writeEvent('response.reasoning_summary_part.done', {
                type: 'response.reasoning_summary_part.done',
                item_id: reasoningItemId,
                output_index: outputIndex,
                summary_index: currentSummaryIndex,
                part: { type: 'summary_text', text: currentPartText.trim() }
              });
              summaryList.push({ type: 'summary_text', text: currentPartText.trim() });
              currentSummaryIndex++;
            }
            currentPartStarted = false;
            currentPartText = '';
          }
        }
      }
    } else if (chunk.type === 'response') {
      finishReasoning();
      if (emitTimer) { clearTimeout(emitTimer); emitTimer = null; }
      emitVisibleDelta(accumulatedRawContent, true);
      accumulatedRawContent += chunk.content;
      emitVisibleDelta(accumulatedRawContent);
    }
  };

  try {
    const result = await runCompletion({
      onChunk,
      signal: abortController.signal,
      canFailover: () => !clientDisconnected && !res.writableEnded,
      onFailover: () => {
        accumulatedRawContent = '';
        accumulatedThinking = '';
      }
    });

    finishReasoning();
    if (emitTimer) { clearTimeout(emitTimer); emitTimer = null; }
    emitVisibleDelta(accumulatedRawContent, true);

    // Parse tool calls from content or thinkingContent
    let parsed = parseToolCalls(accumulatedRawContent);
    // The model invented a tool result: keep only what came before it, so follow-ups append to
    // the real part of the reply instead of to output that never existed
    const fakeResultAt = findFabricatedResult(accumulatedRawContent);
    if (fakeResultAt !== -1) {
      console.warn(`[Responses] Model wrote a fake tool result itself; dropped ${accumulatedRawContent.length - fakeResultAt} chars from it on (${parsed.calls.length} real call(s) kept).`);
      accumulatedRawContent = accumulatedRawContent.slice(0, fakeResultAt);
    }
    if (parsed.calls.length === 0 && accumulatedThinking) {
      const thinkingCalls = parseToolCalls(accumulatedThinking);
      if (thinkingCalls.calls.length > 0) {
        parsed = { cleanContent: parsed.cleanContent, calls: thinkingCalls.calls, fabricatedResult: parsed.fabricatedResult };
      }
    }

    // Auto-continuation: Codex ends the task on any turn without a tool call, so nudge the model when
    // it (1) produced nothing usable, (2) announced its next action but did not emit the tool call,
    // (3) received an error from a tool but stopped without fixing it, or (4) stopped prematurely after tool output.
    const canFollowUp = Array.isArray(tools) && tools.length > 0 && !isCompactionRequest(body.input);
    const rawBeforeFollowUp = accumulatedRawContent;
    const lastInputItem = Array.isArray(body.input) && body.input.length > 0 ? body.input[body.input.length - 1] : null;
    const isFollowingTool = Boolean(lastInputItem && (
      lastInputItem.type === 'function_call_output' ||
      lastInputItem.type === 'tool_result' ||
      lastInputItem.type === 'commandExecution'
    ));
    const recentError = isFollowingTool ? extractRecentErrorFromInput(body.input) : null;
    const userGoal = latestUserGoal(body.input);
    let effectiveMaxFollowUps = (tokenObj.type && tokenObj.type !== 'deepseek_web') ? 1 : MAX_FOLLOW_UPS;
    let repeatInterventions = 0;
    let fabricatedInterventions = 0;

    for (let round = 1; canFollowUp && round <= effectiveMaxFollowUps && !clientDisconnected; round++) {
      const trimmedClean = parsed.cleanContent.trim();
      const isEmptyTurn = parsed.calls.length === 0 && (
        trimmedClean.length === 0 ||
        /^[\s.,!?;:\-–—\(\)\[\]{}'"]*$/.test(trimmedClean) ||
        /^([<\s\/|｜_]*DSML[>\s\/|｜_]*|[<>\/|｜_\s.,!?;:\-–—\(\)\[\]{}'"])*$/i.test(trimmedClean)
      );

      const isStructuredDeliverable =
        /[?؟]/.test(trimmedClean) ||
        ASK_USER_CUE.test(trimmedClean) ||
        DONE_CUE.test(trimmedClean) ||
        /```[\s\S]+?```/.test(trimmedClean) ||
        /\|[^\n]+\|[^\n]+\|\n\|[-:\s|]+\|/.test(trimmedClean) ||
        (trimmedClean.match(/(?:^|\n)\s*[-*•\d+.]\s+/g) || []).length >= 3 ||
        /(?:^|\n)#{1,4}\s+/m.test(trimmedClean) ||
        trimmedClean.length >= 300;

      const hasUnfulfilledIntent = parsed.calls.length === 0 && !result.loopDetected && isUnfulfilledIntent(parsed.cleanContent);
      const isUnresolvedError = Boolean(recentError && parsed.calls.length === 0 && !isStructuredDeliverable);
      const isPrematureStopAfterTool = Boolean(isFollowingTool && parsed.calls.length === 0 && !isStructuredDeliverable);

      let isCrisis = false;
      let reason = 'unfulfilled action intent';

      // Fast-path: Comprehensive final deliverable report (e.g. ## G.11.1 — گزارش نهایی / Handoff Summary)
      // When the model produces a full deliverable report and no compiler errors exist, the task turn is complete.
      const isFinalReport = isFinalDeliverableReport(trimmedClean);

      // Cross-turn loop: the model re-issued a call it already ran (e.g. `cat` of a file whose output was truncated)
      let repeats = findRepeatedCalls(parsed.calls, body.input);

      // If only some calls in this batch are repeated, drop the repeated ones immediately so Codex never runs them
      if (repeats.length > 0 && repeats.length < parsed.calls.length) {
        const repeatCallSet = new Set(repeats.map(r => r.call));
        console.warn(`[Responses] Dropping ${repeats.length} redundant tool call(s) already in context: ${repeats.map(r => describeCall(r.call)).join(', ')}`);
        parsed.calls = parsed.calls.filter(c => !repeatCallSet.has(c));
        repeats = [];
      }

      if (repeats.length > 0 && repeatInterventions < 3) {
        isCrisis = true;
        reason = 'repeated identical tool call';
        repeatInterventions++;
        effectiveMaxFollowUps = Math.max(effectiveMaxFollowUps, round + 1);
      } else if (repeats.length > 0 && repeatInterventions >= 3) {
        console.warn(`[Responses] Model persistently repeated commands after ${repeatInterventions} supervisor interventions. Dropping repeated calls entirely to save tokens.`);
        parsed.calls = [];
        isCrisis = false;
      } else if (parsed.fabricatedResult && parsed.calls.length === 0 && fabricatedInterventions < 2) {
        // It wrote what a command "printed" without running anything; whatever it concluded is invented
        isCrisis = true;
        reason = 'fabricated tool result';
        fabricatedInterventions++;
        effectiveMaxFollowUps = Math.max(effectiveMaxFollowUps, round + 1);
      } else if (isFinalReport && !recentError) {
        console.log(`[Responses] Final deliverable report detected ("${trimmedClean.slice(0, 80)}..."). Marking turn as STOP.`);
        isCrisis = false;
        // If trailing tool calls or example bash commands from the documentation were attached,
        // drop them so Codex receives an empty calls array and cleanly concludes the turn.
        if (parsed.calls.length > 0) {
          console.log(`[Responses] Dropping trailing calls after final deliverable report so turn cleanly concludes.`);
          parsed.calls = [];
        }
      } else if (isEmptyTurn) {
        isCrisis = true;
        reason = 'empty response after reasoning/tool output';
      } else if (parsed.calls.length === 0 && !result.loopDetected) {
        // Fast-path: clear questions directed at the user waiting for human input
        const isObviousUserQuestion = /[?؟]\s*$/.test(trimmedClean) && ASK_USER_CUE.test(trimmedClean);

        if (!isObviousUserQuestion) {
          // Model Judge is only used for DeepSeek Web accounts (where V3 supervises R1).
          // For API accounts (TokenHarbor, Moonmath, Gemini), fast regex heuristics are instant (<1ms)
          // and avoid an extra 3-9s LLM roundtrip.
          const debugRole = hasRoleAccount('debug');
          const modelVerdict = (isWebAccount(tokenObj) || debugRole)
            ? await judgeTurnCompletion({
                text: parsed.cleanContent,
                goal: userGoal,
                isFollowingTool,
                recentError,
                toolOutputTail: isFollowingTool ? latestToolOutputText(body.input) : null,
                avoidTokenId: tokenObj.id,
                signal: abortController.signal,
                timeoutMs: debugRole ? 45000 : 9000
              })
            : null;

          if (modelVerdict === 'CONTINUE') {
            isCrisis = true;
            if (recentError) {
              reason = 'unresolved command/compiler error';
            } else if (hasUnfulfilledIntent) {
              reason = 'unfulfilled action intent';
            } else {
              reason = 'premature stop after tool execution without declaring completion';
            }
            console.log(`[Responses] Model Judge verdict: CONTINUE (${reason})`);
          } else if (modelVerdict === 'STOP') {
            isCrisis = false;
            console.log(`[Responses] Model Judge verdict: STOP (turn successfully completed)`);
          } else {
            // Priority 2 (Fallback): Heuristic regexes when Model Judge is unavailable or timed out
            console.log(`[Responses] Model Judge unavailable; falling back to heuristic regexes`);
            if (isUnresolvedError) {
              isCrisis = true;
              reason = 'unresolved command/compiler error';
            } else if (hasUnfulfilledIntent) {
              isCrisis = true;
              reason = 'unfulfilled action intent';
            } else if (isPrematureStopAfterTool) {
              isCrisis = true;
              reason = 'premature stop after tool execution without declaring completion';
            }
          }
        }
      }

      if (!isCrisis) break;

      // API accounts normally get a single nudge to save budget, but a turn that only announced its
      // next step (or produced nothing) is certain to end the Codex task, so keep nudging it.
      if (reason === 'unfulfilled action intent' || reason.startsWith('empty response')) {
        effectiveMaxFollowUps = Math.max(effectiveMaxFollowUps, MAX_FOLLOW_UPS);
      }

      if (round === 1 && isEmptyTurn && accumulatedRawContent.trim()) {
        dumpUnparsedOutput('content present but no text or tool call parsed', { conversationKey, raw: accumulatedRawContent, thinking: accumulatedThinking });
      }

      let followUpPrompt = '';
      const formatReminder = 'If you need to execute a command, use exactly this format:\n<tool_calls>\n<invoke name="exec_command">\n<parameter name="cmd" string="true">...</parameter>\n</invoke>\n</tool_calls>\nDO NOT output JSON blocks. If the task is finished and verified, do NOT invoke any tool calls; output ONLY your final summary text in the user\'s language.';

      if (reason === 'repeated identical tool call') {
        followUpPrompt = `${repeatedCallFollowUp(findRepeatedCalls(parsed.calls, body.input))} ${formatReminder}`;
        // The follow-up must replace the repeated call, not append to it
        accumulatedRawContent = accumulatedRawContent.replace(/<tool_calls?>[\s\S]*$/i, '');
      } else if (reason === 'unresolved command/compiler error') {
        followUpPrompt = `[SUPERVISOR AUTONOMOUS RECOVERY]: The previous command failed with an error:
"""
${recentError}
"""
You MUST NOT stop while there are unresolved errors! Autonomously diagnose and fix this error now using minimal surgical changes strictly to the affected lines. Preserve existing architecture and do NOT invent unnecessary abstractions or rewrite working code. Edit or patch the affected code files, then run the build or tests again. Emit your tool call immediately using this format:
${formatReminder}`;
      } else if (reason === 'empty response after reasoning/tool output') {
        followUpPrompt = `[SUPERVISOR INTERVENTION]: Your last reply contained no readable text and no valid tool call. Continue the task immediately: either emit the next tool call to make progress or, if the task is truly 100% complete and verified, write your final summary for the user in the exact language the user spoke without calling any tools. ${formatReminder}`;
      } else if (reason === 'fabricated tool result') {
        followUpPrompt = `[SUPERVISOR INTERVENTION]: You wrote a tool result block yourself, but no command was run: that output was invented and has been discarded, so do not rely on anything you concluded from it. Emit the real tool call now and STOP right after closing it; the actual output will be sent to you. Never write [TOOL RESULT], [POLL RESULT] or any other result block yourself. ${formatReminder}`;
      } else if (reason === 'unfulfilled action intent') {
        followUpPrompt = `[SUPERVISOR INTERVENTION]: You announced an action ("${parsed.cleanContent.trim().slice(-160)}") but did not emit any tool call, leaving the task paused. Do it now: emit the tool call in this reply without repeating your explanation. If the whole task is finished, write the final summary in the user's language without calling any tools. ${formatReminder}`;
      } else {
        followUpPrompt = `[SUPERVISOR INTERVENTION]: You received the tool output above but stopped without emitting the next tool call or declaring the task finished. Continue the task now: execute the next step, compile, test, or verify. Preserve the existing architecture and apply surgical fixes. If everything is completely built and tested, write your final summary in the user's language without invoking any tool calls. ${formatReminder}`;
      }

      console.log(`[Responses] Detected ${reason} ("${parsed.cleanContent.slice(-100)}"). Dual-model supervisor intervening (round ${round}/${effectiveMaxFollowUps})...`);

      const followUpResult = await runFollowUp(followUpPrompt, (chunk) => {
        if (chunk.type === 'response') {
          accumulatedRawContent += chunk.content;
          emitVisibleDelta(accumulatedRawContent);
        }
      });

      if (abortController.signal.aborted) throw new Error('Aborted');

      if (followUpResult) {
        parsed = parseToolCalls(accumulatedRawContent);
        if (reason === 'repeated identical tool call') {
          // Keep only the new calls if the repeated one survived in the accumulated text
          const repeatedNow = new Set(findRepeatedCalls(parsed.calls, body.input).map(r => r.call));
          if (repeatedNow.size > 0 && repeatedNow.size < parsed.calls.length) {
            parsed.calls = parsed.calls.filter(c => !repeatedNow.has(c));
          }
        }
      } else {
        break;
      }
    }

    // Still repeating a call that has already run or is redundant: drop it instead of feeding Codex the loop
    const redundantCalls = findRepeatedCalls(parsed.calls, body.input);
    if (redundantCalls.length > 0) {
      console.warn(`[Responses] Dropping ${redundantCalls.length} redundant tool call(s) before returning to Codex (loop guard): ${redundantCalls.map(r => describeCall(r.call)).join(', ')}`);
      const redSet = new Set(redundantCalls.map(r => r.call));
      parsed.calls = parsed.calls.filter(c => !redSet.has(c));
    }

    let sanitizedClean = (parsed.cleanContent || '')
      .replace(/[<＜][|｜]?\/?\s*ds[_\w-]*[^>＞]*[>＞]?/gi, '')
      .replace(/<\/?\s*[^>]*?DSML[^>]*?>/gi, '')
      .replace(/[|｜]{1,2}[\s_]*DSML[\s_]*[|｜]{1,2}/gi, '')
      .replace(/<[|｜][^>]*?[|｜]>/g, '')
      .replace(/(?:^|\n)(?:[-*_]{3,}\s*)?\[TOOL RESULT[\s\S]*?(?=\n\[(?!TOOL RESULT)|\n<|$)/gi, '')
      .replace(/(?:^|\n)\[(?:USER|ASSISTANT|SYSTEM)\]:[\s\S]*?(?=\n\[|\n<|$)/gi, '')
      // Broken tool-call wrappers the model sometimes leaves behind (seen in Codex chats as bare text)
      .replace(/<\/?\s*(?:inv[\s_]*calls?|inv|call_exec|call_tool|tool_cmd|tool_calls?|invoke|function_calls?)\b[^>]*>/gi, '')
      .replace(/(?:^|\n)\s*[|｜]+\s*(?:\n|$)/g, '\n')
      .replace(/(?:\s*[-*_]{3,}\s*){2,}/g, '\n\n---\n\n')
      .replace(/(?:\s*[-*_]{3,}\s*)+$/g, '')
      .replace(/^(?:\s*[-*_]{3,}\s*)+/g, '')
      .trim();

    // Fail-Safe: If no tools were parsed and no readable content exists, do not crash the connection
    if (parsed.calls.length === 0 && !sanitizedClean) {
      dumpUnparsedOutput('still nothing usable after follow-ups', { conversationKey, raw: accumulatedRawContent, thinking: accumulatedThinking });
      if (lastContinuationError) {
        console.error('[Responses] Continuation failed on all tokens:', lastContinuationError.message);
        throw lastContinuationError;
      }
      if (isFollowingTool) {
        console.warn('[Responses] Empty model turn following tool output. Providing graceful fallback instead of disconnecting stream.');
        sanitizedClean = recentError
          ? `Command output received with errors:\n${recentError}\nPlease specify next instruction.`
          : 'دستور قبلی با موفقیت اجرا شد. لطفاً مرحله بعدی را مشخص کنید.';
      }
    }

    const calls = batchCallsForCodex(adaptCallsForTools(parsed.calls, tools), body, sessionInfo);
    console.log(`[Responses] Turn completed. Clean content len: ${sanitizedClean.length}, Calls: [${calls.map(c => c.name).join(', ')}]`);
    if (sanitizedClean) {
      console.log(`[Responses Content]:\n${sanitizedClean.slice(0, 300)}...`);
    }
    const fallbackText = isFollowingTool && recentError
      ? `Command execution error detected:\n${recentError}\nPreparing automatic patch...`
      : '';

    const isOnlyPunctuationOrDelimiters = /^[\s|｜_—\-:;.,`'"\/\\~*#]*$/.test(sanitizedClean);
    const isPreambleFiller = calls.length > 0 && /(?:با توجه به لیست مشکلاتی که دادی|سلام! من توی پوشه‌ی|من مشکلات رو بررسی کردم|اول بذار کد رو|اول باید کد رو)/i.test(sanitizedClean);
    let finalContent = (calls.length > 0 && (isOnlyPunctuationOrDelimiters || isPreambleFiller))
      ? ''
      : (sanitizedClean || (calls.length === 0 ? fallbackText : ''));

    // Close text message (always close a message that was already opened)
    if (finalContent || calls.length === 0 || messageStarted) {
      if (!finalContent) finalContent = emittedText.trim();
      if (finalContent.startsWith(emittedText)) {
        writeTextDelta(finalContent.slice(emittedText.length));
      } else if (!emittedText) {
        writeTextDelta(finalContent);
      }
      // If the streamed prefix and the final text diverge (markup stripped mid-text),
      // the *.done events below carry the authoritative text.
      startMessage();

      writeEvent('response.output_text.done', {
        type: 'response.output_text.done',
        item_id: messageItemId,
        output_index: messageOutputIndex,
        content_index: 0,
        text: finalContent
      });
      writeEvent('response.content_part.done', {
        type: 'response.content_part.done',
        item_id: messageItemId,
        output_index: messageOutputIndex,
        content_index: 0,
        part: { type: 'output_text', text: finalContent, annotations: [] }
      });

      const messageItem = {
        id: messageItemId,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: finalContent, annotations: [] }]
      };
      writeEvent('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: messageOutputIndex,
        item: messageItem
      });
      finalOutputs.push(messageItem);
      outputIndex = messageOutputIndex + 1;
    }

    // Emit tool calls as Responses API function_call / custom_tool_call items
    for (const doneItem of buildOutputItemsForCalls(calls)) {
      const isCustom = doneItem.type === 'custom_tool_call';
      writeEvent('response.output_item.added', {
        type: 'response.output_item.added',
        output_index: outputIndex,
        item: isCustom ? { ...doneItem, status: 'in_progress', input: '' } : { ...doneItem, status: 'in_progress', arguments: '' }
      });

      if (isCustom) {
        writeEvent('response.custom_tool_call_input.delta', {
          type: 'response.custom_tool_call_input.delta',
          item_id: doneItem.id,
          output_index: outputIndex,
          delta: doneItem.input
        });
        writeEvent('response.custom_tool_call_input.done', {
          type: 'response.custom_tool_call_input.done',
          item_id: doneItem.id,
          output_index: outputIndex,
          input: doneItem.input
        });
      } else {
        writeEvent('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          item_id: doneItem.id,
          output_index: outputIndex,
          call_id: doneItem.call_id,
          delta: doneItem.arguments
        });
        writeEvent('response.function_call_arguments.done', {
          type: 'response.function_call_arguments.done',
          item_id: doneItem.id,
          output_index: outputIndex,
          call_id: doneItem.call_id,
          arguments: doneItem.arguments
        });
      }

      writeEvent('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: outputIndex,
        item: doneItem
      });

      finalOutputs.push(doneItem);
      outputIndex++;
    }

    remember(responseId);

    // Terminal event: response.completed
    writeEvent('response.completed', {
      type: 'response.completed',
      response: baseResponse('completed', {
        output: finalOutputs,
        usage: estimateUsage(body, accumulatedRawContent, prompt)
      })
    });
  } catch (err) {
    if (clientDisconnected || abortController.signal.aborted) {
      console.log(`[Responses] Client disconnected from ${conversationKey}; upstream generation aborted.`);
    } else {
      console.error('[Responses Stream Error]', err);
      // Never drop the stream silently: Codex needs a terminal event to fail (and retry) the turn
      writeEvent('response.failed', {
        type: 'response.failed',
        response: baseResponse('failed', {
          output: finalOutputs,
          error: {
            code: errorCodeFor(err),
            message: err.message || 'Error generating response'
          }
        })
      });
    }
  } finally {
    clearInterval(pingInterval);
    if (!res.writableEnded) res.end();
  }
}
