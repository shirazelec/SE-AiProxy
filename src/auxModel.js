import tokenPool, { accountRole, isAccountOff } from './tokenPool.js';
import { streamDeepSeekChat, createSession } from './deepseek.js';
import { PROVIDER_PRESETS } from './providerPresets.js';
import { penalizeAccount, isAbortLike } from './accountHealth.js';
import { hasHeadroom } from './webAccountPolicy.js';
import { upstreamFetch } from './directFetch.js';
import { deepSeekWebModelOptions } from './deepseekWebModels.js';

// Helper ("auxiliary") model shared by the prompt optimizer and the turn supervisor.
// It prefers stateless OpenAI-compatible accounts (no PoW, no per-account pacing) and avoids the
// account that runs the main turn: DeepSeek Web serializes every request per account with a 4.5s
// gap, so a helper call on the same account used to delay the main turn and often time out.

// DeepSeek Web helper sessions are rotated so they never hit the per-session length cap
const WEB_SESSION_MAX_USES = 12;
const webSessions = new Map();

function isUsable(t, now = Date.now()) {
  return Boolean(t?.token) && !isAccountOff(t) && now >= (t.rateLimitedUntil || 0);
}

// True when at least one usable account is dedicated to this helper role
export function hasRoleAccount(role, tokens = tokenPool.tokens) {
  const now = Date.now();
  return Boolean(role) && tokens.some(t => accountRole(t) === role && isUsable(t, now));
}

// Accounts dedicated to the role come first, then shared ('all') ones, then the rest; within a group
// the least busy / least recently used account wins, so several keys of one role split the work.
export function orderAuxCandidates(tokens, avoidTokenId, role = null) {
  const now = Date.now();
  const roleRank = t => {
    if (!role) return 0;
    const r = accountRole(t);
    if (r === role) return 0;
    if (r === 'all') return 1;
    if (r === 'work') return 2;
    return 3;
  };
  const rank = t => {
    const isWeb = !t.type || t.type === 'deepseek_web';
    return roleRank(t) * 10 + (isWeb ? 2 : 0) + (t.id === avoidTokenId ? 1 : 0);
  };
  // With a dedicated account for this role, work accounts keep their request budget for the task
  const dedicated = role && tokens.some(t => accountRole(t) === role && isUsable(t, now));
  return tokens
    .filter(t => isUsable(t, now) && t.type !== 'kimi_web' && !(dedicated && accountRole(t) === 'work') &&
      // A DeepSeek Web work account's per-minute budget belongs to Codex's own requests: a judge /
      // optimizer / debugger call there pushed the main turn over budget and set off failover chains
      // Helper calls are requests no person typed: on a DeepSeek Web account they add to the
      // automated-looking traffic that sets off its human checks, so only an account the user
      // dedicated to this exact role may take them
      !((!t.type || t.type === 'deepseek_web') && !(role && accountRole(t) === role)))
    .sort((a, b) => rank(a) - rank(b) ||
      (a.activeRequests || 0) - (b.activeRequests || 0) ||
      (a.lastUsed || 0) - (b.lastUsed || 0) ||
      (a.priority ?? 4) - (b.priority ?? 4));
}

async function runOnOpenAICompatible(acc, { prompt, signal, maxTokens }) {
  const baseUrl = (acc.baseUrl || PROVIDER_PRESETS[acc.type]?.baseUrl || '').replace(/\/+$/, '');
  const res = await upstreamFetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${acc.token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    },
    body: JSON.stringify({
      model: acc.model || PROVIDER_PRESETS[acc.type]?.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: maxTokens,
      stream: false
    }),
    signal
  });
  if (!res.ok) {
    const err = new Error(`${acc.label || acc.type} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  tokenPool.recordUsage(acc.id);
  return String(json.choices?.[0]?.message?.content || '').trim();
}

async function runOnDeepSeekWeb(acc, { prompt, signal }) {
  let session = webSessions.get(acc.id);
  // A chat belongs to the key that opened it: after a key switch the helper opens a new one
  if (!session || session.uses >= WEB_SESSION_MAX_USES || session.token !== acc.token) {
    session = { sessionId: await createSession(acc.token), parentMessageId: null, uses: 0, token: acc.token };
    webSessions.set(acc.id, session);
  }
  try {
    const result = await streamDeepSeekChat({
      token: acc.token,
      sessionId: session.sessionId,
      parentMessageId: session.parentMessageId,
      prompt,
      // Helper accounts follow their dashboard model too (reasoner = thinks before answering)
      ...deepSeekWebModelOptions(acc.model, { modelType: 'default', thinkingEnabled: false }),
      signal,
      retryOnRateLimit: false
    });
    session.uses++;
    if (result.messageId) session.parentMessageId = result.messageId;
    if (result.sessionReset) {
      session.sessionId = result.sessionId;
      session.parentMessageId = result.messageId || null;
    }
    return String(result.content || '').trim();
  } catch (err) {
    webSessions.delete(acc.id);
    throw err;
  }
}

/**
 * Runs one short, stateless helper prompt. Returns { text, accountId } or null when no helper
 * account answered within the time budget (callers then fall back to heuristics / no-op).
 */
export async function runAuxPrompt({ prompt, signal = null, timeoutMs = 9000, avoidTokenId = null, maxTokens = 1200, accept = null, label = 'Aux', role = null }) {
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;

  for (const acc of orderAuxCandidates(tokenPool.tokens, avoidTokenId, role)) {
    if (combined.aborted) break;
    acc.lastUsed = Date.now();
    const isWeb = !acc.type || acc.type === 'deepseek_web';
    // Helper calls are optional: never spend the last part of a web account's hourly budget on them
    if (isWeb && !hasHeadroom(acc.token)) continue;
    try {
      const text = isWeb
        ? await runOnDeepSeekWeb(acc, { prompt, signal: combined })
        : await runOnOpenAICompatible(acc, { prompt, signal: combined, maxTokens });
      if (text && (!accept || accept(text))) return { text, accountId: acc.id };
      console.warn(`[${label}] ${acc.label || acc.id} returned an unusable answer; trying next helper account.`);
    } catch (err) {
      if (combined.aborted || isAbortLike(err)) break;
      penalizeAccount(acc.id, err);
      console.warn(`[${label}] Helper call failed on ${acc.label || acc.id}: ${err.message}`);
    }
  }
  return null;
}
