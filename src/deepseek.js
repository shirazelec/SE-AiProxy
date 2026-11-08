import fs from 'node:fs';
import path from 'node:path';
import PowSolver from '@rezaparsian/deepseek-pow-solver';
import { detectRepetitionLoop } from './parser.js';
import { beforeRequest, recordThrottle, recordSuccess } from './webAccountPolicy.js';

let solverInstance = null;
let solverInitPromise = null;

export async function getPowSolver() {
  if (solverInstance) return solverInstance;
  if (!solverInitPromise) {
    solverInitPromise = (async () => {
      const solver = new PowSolver();
      await solver.init();
      solverInstance = solver;
      return solver;
    })();
  }
  return solverInitPromise;
}


// Tokens come from chat.deepseek.com in the user's browser. Presenting them as the (old, Chinese)
// Android app made one login appear on two very different clients at once, and DeepSeek answered by
// logging the account out everywhere. Requests now carry exactly the headers the web app sends
// (read from chat.deepseek.com's own bundle, web 2.7.1) with the browser's user agent when known.
export const DEFAULT_WEB_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const WEB_CLIENT_VERSION = '2.7.1';
const clientProfiles = new Map(); // token -> { userAgent }

export function setClientProfile(token, profile = {}) {
  if (!token) return;
  if (profile.userAgent) clientProfiles.set(token, { userAgent: String(profile.userAgent).slice(0, 400) });
}

export function clientHeaders(token) {
  return {
    'content-type': 'application/json',
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-platform': 'web',
    'x-client-version': WEB_CLIENT_VERSION,
    'x-client-locale': 'en_US',
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
    'user-agent': clientProfiles.get(token)?.userAgent || DEFAULT_WEB_USER_AGENT,
    origin: 'https://chat.deepseek.com',
    referer: 'https://chat.deepseek.com/'
  };
}

// Multipart uploads set their own content type
function withoutContentType(headers) {
  const { 'content-type': _ct, ...rest } = headers;
  return rest;
}

function isWafBlock(res) {
  return res.status === 405 || res.status === 403 || /text\/html/i.test(res.headers.get('content-type') || '');
}

// POST to chat.deepseek.com as the web client. A WAF challenge is passed back as is: switching this
// token to another client identity (the old Android fallback) looks like evasion to DeepSeek and once
// logged the account out everywhere, so the account just rests and the pool moves on.
async function dsFetch(path, { token, body, signal, extraHeaders = {} }) {
  const send = () => fetch('https://chat.deepseek.com' + path, {
    method: 'POST',
    signal,
    headers: { ...clientHeaders(token), ...extraHeaders, authorization: 'Bearer ' + token },
    body: JSON.stringify(body)
  });
  const res = await send();
  if (isWafBlock(res)) console.warn(`[DeepSeek] Web-client request to ${path} was challenged (HTTP ${res.status}); the account will rest.`);
  return res;
}

// Who a token belongs to: lets a fresh token replace the dead one of the same account
export async function getDeepSeekIdentity(token, signal = AbortSignal.timeout(10000)) {
  const res = await fetch('https://chat.deepseek.com/api/v0/users/current', {
    signal,
    headers: { ...clientHeaders(token), authorization: 'Bearer ' + token }
  });
  const json = await res.json().catch(() => ({}));
  const user = json.data?.biz_data;
  if (res.status === 401 || !user?.id) {
    throw new DeepSeekError('Invalid or expired DeepSeek token', 401, 'invalid_token');
  }
  return { id: String(user.id), email: user.email || null, mobile: user.mobile_number || null };
}

export class DeepSeekError extends Error {
  constructor(message, status = 500, code = 'deepseek_error') {
    super(message);
    this.name = 'DeepSeekError';
    this.status = status;
    this.code = code;
  }
}

// Per-account completion queues: requests on the same account are serialized, while different
// accounts in the pool run in parallel. Pacing (minimum gap + jitter) and usage budgets are applied
// per request by webAccountPolicy.beforeRequest.
const requestQueues = new Map();
export function enqueueTask(task, queueKey = 'global') {
  const prev = requestQueues.get(queueKey) || Promise.resolve();
  const next = prev.then(() => task(), () => task());
  const tail = next.then(() => undefined, () => undefined);
  requestQueues.set(queueKey, tail);
  // Drop the queue entry once it drains so the map does not grow forever
  tail.then(() => {
    if (requestQueues.get(queueKey) === tail) requestQueues.delete(queueKey);
  });
  return next;
}

// "Too frequent" style warnings are aimed at the account; "server busy" is DeepSeek-wide load
export function isThrottleError(err) {
  if (!err || err.code === 'account_budget') return false;
  if (err.status === 429 || err.code === 'rate_limit_reached' || err.bizCode === 11) return true;
  return /(?:频繁|too\s+frequent|frequently|too\s+many\s+requests|rate[\s_-]?limit|flood)/i.test(String(err.message || ''));
}

function isAbortError(err, signal) {
  return Boolean(signal?.aborted) || err?.name === 'AbortError';
}

// Turns a non-SSE DeepSeek reply (HTTP error or JSON envelope) into a typed error
async function errorFromJsonResponse(res, fallbackMessage) {
  const json = await res.json().catch(() => ({}));
  const msg = json.data?.biz_msg || json.msg || fallbackMessage;
  if (res.status === 429 || json.code === 429 || json.data?.biz_code === 429) {
    return new DeepSeekError(msg || 'Rate limit reached', 429, 'rate_limit_reached');
  }
  if (json.data?.biz_code && json.data.biz_code !== 0) {
    const err = new DeepSeekError(msg, 400, 'biz_error');
    err.bizCode = json.data.biz_code;
    return err;
  }
  if (json.code !== undefined && json.code !== 0) {
    const err = new DeepSeekError(msg, res.status >= 400 ? res.status : 400, 'deepseek_error');
    err.bizCode = json.code;
    return err;
  }
  return new DeepSeekError(fallbackMessage, res.status >= 400 ? res.status : 502, 'bad_gateway');
}

export async function createPowChallenge(token, target_path = '/api/v0/chat/completion', signal) {
  const timeoutSignal = signal || AbortSignal.timeout(10000);
  const res = await dsFetch('/api/v0/chat/create_pow_challenge', { token, signal: timeoutSignal, body: { target_path } });

  if (res.status === 401) {
    throw new DeepSeekError('Invalid or expired DeepSeek token (401 Unauthorized)', 401, 'invalid_token');
  }
  if (res.status === 429) {
    throw new DeepSeekError('Rate limit reached while creating PoW challenge', 429, 'rate_limit_reached');
  }

  const data = await res.json().catch(() => ({}));
  if (data.code !== 0 && data.code !== undefined) {
    throw new DeepSeekError(data.msg || 'Failed to create PoW challenge', 400, 'pow_challenge_failed');
  }

  const challenge = data.data?.biz_data?.challenge;
  if (!challenge) {
    throw new DeepSeekError('Malformed PoW challenge response from DeepSeek', 502, 'pow_challenge_failed');
  }
  return challenge;
}

export async function solveChallenge(challengeData) {
  const solver = await getPowSolver();
  const solved = solver.solve(challengeData);
  return Buffer.from(JSON.stringify(solved)).toString('base64');
}

export async function createSession(token) {
  await beforeRequest(token, 'session');
  const res = await dsFetch('/api/v0/chat_session/create', { token, body: { character_id: null } });

  if (res.status === 401) {
    throw new DeepSeekError('Invalid or expired DeepSeek token', 401, 'invalid_token');
  }
  if (res.status === 429) {
    throw new DeepSeekError('Rate limit reached while creating chat session', 429, 'rate_limit_reached');
  }

  const data = await res.json().catch(() => ({}));
  if (data.code !== 0 && data.code !== undefined) {
    throw new DeepSeekError(data.msg || 'Failed to create chat session', 400, 'session_create_failed');
  }

  const id = data.data?.biz_data?.chat_session?.id;
  if (!id) {
    throw new DeepSeekError('Malformed chat session response from DeepSeek', 502, 'session_create_failed');
  }
  return id;
}

export async function continueChat({ token, sessionId, messageId, signal }) {
  return dsFetch('/api/v0/chat/continue', {
    token,
    signal,
    body: { chat_session_id: sessionId, message_id: messageId, fallback_to_resume: true }
  });
}

export async function uploadFileToDeepSeekVision({ token, filePath, buffer, filename = 'image.png', signal }) {
  let fileBuffer = buffer;
  if (!fileBuffer && filePath) {
    fileBuffer = fs.readFileSync(filePath);
  }
  if (!fileBuffer || fileBuffer.length === 0) {
    throw new Error('No image buffer or file path provided for vision upload');
  }

  const target_path = '/api/v0/file/upload_file';
  const challengeData = await createPowChallenge(token, target_path);
  const challengeHeader = await solveChallenge(challengeData);

  const ext = (filePath ? path.extname(filePath) : (filename ? path.extname(filename) : '')).toLowerCase();
  let mimeType = 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
  else if (ext === '.webp') mimeType = 'image/webp';
  else if (ext === '.gif') mimeType = 'image/gif';
  else if (ext === '.bmp') mimeType = 'image/bmp';

  const blob = new Blob([fileBuffer], { type: mimeType });
  const form = new FormData();
  form.append('file', blob, filename || (filePath ? path.basename(filePath) : 'image.png'));

  const uploadRes = await fetch('https://chat.deepseek.com/api/v0/file/upload_file', {
    method: 'POST',
    signal,
    headers: {
      ...withoutContentType(clientHeaders(token)),
      'authorization': 'Bearer ' + token,
      'x-ds-pow-response': challengeHeader
    },
    body: form
  });

  const uploadData = await uploadRes.json();
  if (uploadData.code !== 0 || !uploadData.data?.biz_data?.id) {
    throw new DeepSeekError(uploadData.msg || 'Failed to upload image to DeepSeek vision', 500, 'vision_upload_failed');
  }

  const fileId = uploadData.data.biz_data.id;

  const pollHeaders = {
    ...withoutContentType(clientHeaders(token)),
    'authorization': 'Bearer ' + token
  };

  for (let i = 0; i < 20; i++) {
    if (signal?.aborted) throw new Error('Vision upload aborted');
    await new Promise(r => setTimeout(r, 800));
    const chk = await fetch(`https://chat.deepseek.com/api/v0/file/fetch_files?file_ids=${fileId}`, {
      headers: pollHeaders,
      signal
    });
    const chkData = await chk.json().catch(() => ({}));
    const status = chkData.data?.biz_data?.files?.[0]?.status;
    if (status === 'SUCCESS') {
      return fileId;
    }
    if (status === 'FAILED' || status === 'ERROR') {
      throw new DeepSeekError(`Vision processing failed with status ${status}`, 500, 'vision_processing_failed');
    }
  }

  return fileId;
}

export async function analyzeImageWithDeepSeekVision({ token, filePath, buffer, prompt = 'Describe this image in detail and extract all visible text, numbers, icons, layout, and UI elements.', signal }) {
  const fileId = await uploadFileToDeepSeekVision({ token, filePath, buffer, signal });
  const sessionId = await createSession(token);

  let resultText = '';
  await streamDeepSeekChat({
    token,
    sessionId,
    prompt,
    refFileIds: [fileId],
    modelType: 'vision',
    thinkingEnabled: false,
    signal,
    onChunk: (chunk) => {
      if (chunk.type === 'response') resultText += chunk.content;
    }
  });

  return resultText.trim();
}

// Core streaming implementation
async function executeChatStream({
  token,
  sessionId,
  parentMessageId = null,
  prompt,
  modelType = 'default',
  thinkingEnabled = false,
  searchEnabled = false,
  refFileIds = [],
  onChunk,
  signal
}) {
  await beforeRequest(token, 'completion', { signal });
  const challengeData = await createPowChallenge(token);
  const challengeHeader = await solveChallenge(challengeData);

  let currentResponse = await dsFetch('/api/v0/chat/completion', {
    token,
    signal,
    extraHeaders: { 'x-ds-pow-response': challengeHeader },
    body: {
      chat_session_id: sessionId,
      parent_message_id: parentMessageId,
      model_type: modelType,
      prompt,
      thinking_enabled: thinkingEnabled,
      search_enabled: searchEnabled,
      ref_file_ids: refFileIds || [],
      action: null,
      preempt: false
    }
  });

  if (currentResponse.status === 401) {
    throw new DeepSeekError('Invalid or expired DeepSeek token', 401, 'invalid_token');
  }

  const contentType = currentResponse.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    throw await errorFromJsonResponse(currentResponse, 'Unexpected response format from DeepSeek API');
  }

  const decoder = new TextDecoder();
  const result = {
    ok: true,
    sessionId,
    content: '',
    thinkingContent: '',
    messageId: null,
    parentId: null,
    status: null,
    tokenUsage: null,
    finished: false
  };

  const fragments = [];
  let activeFragmentIndex = null;
  let flatContent = '';
  let flatThinkingContent = '';
  let usingFragments = false;
  let activePatchPath = '';
  let continuationCount = 0;
  let loopDetected = false;
  const MAX_CONTINUATIONS = 10;

  const emitChunk = (type, text) => {
    if (!text) return;
    onChunk?.({ type, content: text, messageId: result.messageId });
  };

  const activeText = () => (usingFragments
    ? (fragments[activeFragmentIndex]?.content || '')
    : flatContent);

  while (true) {
    if (!currentResponse.body) break;
    const reader = currentResponse.body.getReader();
    let buffer = '';
    let streamErrored = false;
    let lastRepetitionCheckLen = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr) continue;

          let parsed;
          try {
            parsed = JSON.parse(jsonStr);
          } catch {
            continue;
          }

          if (typeof parsed.p === 'string') activePatchPath = parsed.p;
          let contentChanged = false;

          if (parsed.v?.response) {
            const r = parsed.v.response;
            if (r.message_id) result.messageId = r.message_id;
            if (r.parent_id) result.parentId = r.parent_id;
            if (r.status) result.status = r.status;
            if (r.accumulated_token_usage) result.tokenUsage = r.accumulated_token_usage;

            if (Array.isArray(r.fragments) && r.fragments.length) {
              usingFragments = true;
              if (fragments.length === 0) {
                for (const f of r.fragments) {
                  const type = f?.type ?? 'RESPONSE';
                  const text = f?.content ?? '';
                  fragments.push({ type, content: text });
                  emitChunk(type === 'THINK' ? 'thinking' : 'response', text);
                }
                activeFragmentIndex = fragments.length - 1;
              }
            } else {
              if (typeof r.content === 'string') {
                flatContent += r.content;
                emitChunk('response', r.content);
                contentChanged = true;
              }
              if (typeof r.thinking_content === 'string') {
                flatThinkingContent += r.thinking_content;
                emitChunk('thinking', r.thinking_content);
              }
            }
          } else if (parsed.type === 'error') {
            result.ok = false;
            result.status = parsed.finish_reason || 'ERROR';
            result.error = parsed.content || 'Error from DeepSeek';
            streamErrored = true;
            break;
          } else if (parsed.o === 'APPEND' && activePatchPath === 'response/fragments' && Array.isArray(parsed.v)) {
            usingFragments = true;
            for (const f of parsed.v) {
              const type = f?.type ?? 'RESPONSE';
              const text = f?.content ?? '';
              fragments.push({ type, content: text });
              activeFragmentIndex = fragments.length - 1;
              emitChunk(type === 'THINK' ? 'thinking' : 'response', text);
            }
            contentChanged = true;
          } else if (usingFragments && typeof parsed.v === 'string' && activePatchPath.includes('fragments')) {
            if (activeFragmentIndex !== null && fragments[activeFragmentIndex]) {
              fragments[activeFragmentIndex].content += parsed.v;
              emitChunk(fragments[activeFragmentIndex].type === 'THINK' ? 'thinking' : 'response', parsed.v);
            } else {
              flatContent += parsed.v;
              emitChunk('response', parsed.v);
            }
            contentChanged = true;
          } else if (!usingFragments && typeof parsed.v === 'string' && activePatchPath === 'response/thinking_content') {
            flatThinkingContent += parsed.v;
            emitChunk('thinking', parsed.v);
          } else if (!usingFragments && typeof parsed.v === 'string' && activePatchPath === 'response/content') {
            flatContent += parsed.v;
            emitChunk('response', parsed.v);
            contentChanged = true;
          } else if (parsed.p === 'response' && parsed.o === 'BATCH' && Array.isArray(parsed.v)) {
            for (const item of parsed.v) {
              if (item.p === 'accumulated_token_usage') result.tokenUsage = item.v;
              if (item.p === 'quasi_status') {
                result.status = item.v;
                if (item.v === 'FINISHED') result.finished = true;
              }
            }
          } else if (parsed.p === 'response/accumulated_token_usage' && parsed.o === 'SET') {
            result.tokenUsage = parsed.v;
          } else if (parsed.p === 'response/status' && typeof parsed.v === 'string') {
            result.status = parsed.v;
            if (parsed.v === 'FINISHED') result.finished = true;
          }

          // Runaway repetition check runs throttled (at most once per 80 chars) to prevent event-loop starvation on low-power CPUs
          if (contentChanged) {
            const textNow = activeText();
            if (textNow.length - lastRepetitionCheckLen >= 80) {
              lastRepetitionCheckLen = textNow.length;
              if (detectRepetitionLoop(textNow)) {
                loopDetected = true;
                console.warn('[DeepSeek] Runaway repetition loop detected in stream! Halting stream to preserve response.');
                result.finished = true;
                result.loopDetected = true;
                break;
              }
            }
          }
        }

        if (loopDetected || streamErrored) break;
      }
    } finally {
      // Release the upstream connection when we stop reading early
      reader.cancel().catch(() => {});
    }

    if (!loopDetected && !streamErrored && result.status === 'TRUNCATED' && continuationCount < MAX_CONTINUATIONS && result.messageId) {
      continuationCount++;
      console.log(`[DeepSeek] Response truncated, requesting continuation ${continuationCount}/${MAX_CONTINUATIONS}...`);
      await beforeRequest(token, 'completion', { signal });
      currentResponse = await continueChat({
        token,
        sessionId,
        messageId: result.messageId,
        signal
      });
      const contType = currentResponse.headers.get('content-type') || '';
      if (!contType.includes('text/event-stream')) {
        const err = await errorFromJsonResponse(currentResponse, 'Continuation request failed');
        console.warn(`[DeepSeek] Continuation rejected (${err.message}); returning partial response.`);
        break;
      }
      // Each continuation reports its own status; reset so a stale TRUNCATED cannot loop
      result.status = null;
      continue;
    }

    break;
  }

  result.content = usingFragments
    ? fragments.filter(f => f.type === 'RESPONSE').map(f => f.content).join('') + flatContent
    : flatContent;

  result.thinkingContent = usingFragments
    ? fragments.filter(f => f.type === 'THINK').map(f => f.content).join('')
    : flatThinkingContent;

  return result;
}

export function isRateLimitedOrBusy(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return false;
  if (err.status === 429 || err.code === 'rate_limit_reached' || err.bizCode === 11) return true;
  const msg = String(err.message || '');
  return /(?:rate[\s_-]?limit|too\s+many\s+requests|too\s+frequent|frequently|server\s+(?:is\s+)?busy|is\s+busy|flood|频繁|繁忙|请稍后重试|message\s+still\s+wip|still\s+wip)/i.test(msg);
}

// DeepSeek web caps the length of one chat session ("达到对话长度上限，请开启新对话" = conversation
// length limit reached, start a new conversation). This is about the upstream session, not Codex's context.
const SESSION_FULL_RE = /context[_\s-]?length|length[_\s-]?(?:limit|exceeded)|对话长度上限|开启新对话|上下文.*(?:上限|过长)|too\s+long|maximum\s+context/i;

export function isSessionFullError(err) {
  if (!err) return false;
  if (err.sessionFull || err.code === 'session_length_exceeded') return true;
  return SESSION_FULL_RE.test(String(err.message || '')) || SESSION_FULL_RE.test(String(err.code || ''));
}

function isSessionOutOfSync(err) {
  if (!err) return false;
  if (err.bizCode === 40001 || err.bizCode === 40002) return true;
  return /(?:message|session).*(?:not\s+(?:found|exist)|invalid)|invalid.*(?:message|session)/i.test(err.message || '');
}

// Resilient wrapper with per-account queue, fallback on expert_busy, and retry on rate limit.
// options.rebuildPrompt(level) (optional) returns a full-history prompt when the upstream session had to be
// recreated; higher levels ask for a smaller history budget after the session length limit was hit.
export async function streamDeepSeekChat(options) {
  return enqueueTask(async () => {
    const maxRetries = 2;
    let attempt = 0;
    let sessionResets = 0;
    let sessionFullResets = 0;
    let currentModelType = options.modelType || 'default';
    let currentThinkingEnabled = options.thinkingEnabled ?? false;
    let sessionId = options.sessionId;
    let parentMessageId = options.parentMessageId ?? null;
    let prompt = options.prompt;
    let sessionReset = false;

    while (true) {
      attempt++;
      try {
        if (options.signal?.aborted) {
          const abortErr = new DeepSeekError('Request aborted by client', 499, 'client_aborted');
          abortErr.name = 'AbortError';
          throw abortErr;
        }

        const result = await executeChatStream({
          ...options,
          sessionId,
          parentMessageId,
          prompt,
          modelType: currentModelType,
          thinkingEnabled: currentThinkingEnabled,
          refFileIds: options.refFileIds || []
        });

        if (!result.ok) {
          if (result.status === 'expert_busy_use_default' && currentModelType !== 'default') {
            console.warn('[DeepSeek] Expert model is busy. Falling back automatically to default (DeepSeek-V3)...');
            currentModelType = 'default';
            currentThinkingEnabled = false;
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }
          const err = new DeepSeekError(result.error || `Stream failed with status ${result.status}`, 500, result.status || 'stream_error');
          if (isSessionFullError(err)) {
            err.code = 'session_length_exceeded';
            err.sessionFull = true;
            err.status = 413;
          } else if (/rate|limit|frequent|busy/i.test(String(result.status))) {
            err.status = 429;
          }
          throw err;
        }

        result.sessionId = sessionId;
        result.sessionReset = sessionReset;
        recordSuccess(options.token);
        return result;
      } catch (err) {
        if (isAbortError(err, options.signal)) throw err;
        console.error(`[DeepSeek Attempt ${attempt}] Error:`, err.message);

        // Upstream chat session is full: continue in a brand-new session with a trimmed history
        if (sessionFullResets < 3 && isSessionFullError(err) && typeof options.rebuildPrompt === 'function') {
          // If the failing request was already a fresh session, the prompt itself is too big: shrink harder
          sessionFullResets += parentMessageId ? 1 : 2;
          console.warn(`[DeepSeek] Session length limit reached; opening a new session with history level ${sessionFullResets}...`);
          sessionId = await createSession(options.token);
          parentMessageId = null;
          sessionReset = true;
          prompt = options.rebuildPrompt(sessionFullResets);
          continue;
        }

        // Parent message / session no longer valid upstream: recreate the session once
        if (sessionResets < 1 && isSessionOutOfSync(err)) {
          sessionResets++;
          console.warn('[DeepSeek] Session out of sync, creating fresh session...');
          sessionId = await createSession(options.token);
          parentMessageId = null;
          sessionReset = true;
          if (typeof options.rebuildPrompt === 'function') prompt = options.rebuildPrompt();
          continue;
        }

        // The account is resting (usage budget): hand off to another account, never retry here
        if (err.code === 'account_budget') throw err;

        // A throttle warning is a strike against this account: back off with an escalating cooldown.
        // Only a short first cooldown is waited out in place; longer ones park the account so the
        // conversation moves on (retrying right after a warning is what gets accounts suspended).
        if (isThrottleError(err)) {
          const cooldown = recordThrottle(options.token);
          if (options.retryOnRateLimit !== false && attempt === 1 && cooldown <= 30000) {
            console.warn(`[DeepSeek] Throttle warning ("${err.message}"). Cooling down ${Math.round(cooldown / 1000)}s before one retry...`);
            await new Promise(r => setTimeout(r, cooldown));
            continue;
          }
          err.retryAfterMs = cooldown;
          console.warn(`[DeepSeek] Throttle warning ("${err.message}"). Parking account for ${Math.round(cooldown / 1000)}s.`);
          throw err;
        }

        // Server-wide busy / message still generating: short waits, no strike
        if (options.retryOnRateLimit !== false && attempt <= maxRetries && isRateLimitedOrBusy(err)) {
          const waitTime = attempt * 4000;
          console.warn(`[DeepSeek] DeepSeek busy ("${err.message}"). Waiting ${waitTime}ms before retry (attempt ${attempt}/${maxRetries})...`);
          await new Promise(r => setTimeout(r, waitTime));
          continue;
        }

        throw err;
      }
    }
  }, options.token);
}
