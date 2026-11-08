import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Usage policy for DeepSeek Web accounts. DeepSeek suspends / logs out accounts that look automated:
// a non-stop stream of completions at a fixed rhythm, retries right after a "too frequent" warning,
// and many new chat sessions. The policy keeps each account inside a human-like envelope:
//   - a minimum gap between requests with random jitter (no metronome timing)
//   - per-minute / per-hour / per-day request budgets and an hourly new-session budget
//   - escalating cooldowns after throttle warnings, decaying again after clean requests
// An account outside its envelope is parked (rate-limited until the budget frees up), so the pool
// hands the conversation to another account instead of pushing this one further.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// 0 = no limit. Hourly / daily / new-chat caps are off by default: once reached they park the
// account until the oldest request leaves the window (often half an hour or more), which stalls the
// work far more than the caps help. The short gap with random jitter stays on.
export const POLICY_DEFAULTS = {
  webMinIntervalSec: 4,
  webJitterSec: 5,
  webMaxPerMinute: 0,
  webMaxPerHour: 0,
  webMaxPerDay: 0,
  webMaxSessionsPerHour: 0
};

let getSettings = () => POLICY_DEFAULTS;
let cooldownListener = () => {};
let persistPath = null;
let persistTimer = null;
let pendingRestore = {};

// token -> { requests: number[] (timestamps, last 24h), sessions: number[], strikes, cleanStreak, lastRequestAt }
const accounts = new Map();

function settings() {
  return { ...POLICY_DEFAULTS, ...getSettings() };
}

function state(token) {
  let s = accounts.get(token);
  if (!s) {
    s = { requests: [], sessions: [], strikes: 0, cleanStreak: 0, lastRequestAt: 0 };
    accounts.set(token, s);
  }
  return s;
}

function prune(list, now, windowMs) {
  while (list.length && now - list[0] > windowMs) list.shift();
}

function countSince(list, since) {
  let n = 0;
  for (let i = list.length - 1; i >= 0 && list[i] >= since; i--) n++;
  return n;
}

export function configurePolicy({ settingsProvider, onCooldown, dataDir } = {}) {
  if (settingsProvider) getSettings = settingsProvider;
  if (onCooldown) cooldownListener = onCooldown;
  if (dataDir) {
    persistPath = path.join(dataDir, 'web-usage.json');
    loadUsage();
  }
}

// Usage survives restarts, otherwise a restart would silently reset the daily budget.
// Keyed by a token fingerprint so the file holds no credentials.
function fingerprint(token) {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function loadUsage() {
  try {
    const raw = JSON.parse(fs.readFileSync(persistPath, 'utf8'));
    pendingRestore = raw;
  } catch {
    pendingRestore = {};
  }
}

function restoreFor(token, s) {
  const saved = pendingRestore[fingerprint(token)];
  if (!saved) return;
  delete pendingRestore[fingerprint(token)];
  const now = Date.now();
  s.requests = (saved.requests || []).filter(t => now - t < DAY);
  s.sessions = (saved.sessions || []).filter(t => now - t < HOUR);
  s.strikes = saved.strikes || 0;
}

function schedulePersist() {
  if (!persistPath || persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const out = { ...pendingRestore };
    for (const [token, s] of accounts) {
      out[fingerprint(token)] = { requests: s.requests, sessions: s.sessions, strikes: s.strikes };
    }
    try {
      fs.writeFileSync(persistPath, JSON.stringify(out), { encoding: 'utf8', mode: 0o600 });
    } catch {}
  }, 5000);
  persistTimer.unref?.();
}

function account(token) {
  const s = state(token);
  if (pendingRestore[fingerprint(token)]) restoreFor(token, s);
  return s;
}

/**
 * How long until this account may send another request of the given kind (0 = now).
 * kind: 'completion' | 'session'
 */
export function budgetWaitMs(token, kind = 'completion', now = Date.now()) {
  const cfg = settings();
  const s = account(token);
  prune(s.requests, now, DAY);
  prune(s.sessions, now, HOUR);

  if (kind === 'session') {
    if (cfg.webMaxSessionsPerHour > 0 && s.sessions.length >= cfg.webMaxSessionsPerHour) return s.sessions[s.sessions.length - cfg.webMaxSessionsPerHour] + HOUR - now;
    return 0;
  }
  const waits = [0];
  const limits = [[MINUTE, cfg.webMaxPerMinute], [HOUR, cfg.webMaxPerHour], [DAY, cfg.webMaxPerDay]];
  for (const [windowMs, max] of limits) {
    if (max > 0 && countSince(s.requests, now - windowMs) >= max) {
      // The window frees up when its oldest counted request ages out
      const oldestInWindow = s.requests[s.requests.length - max];
      waits.push(oldestInWindow + windowMs - now);
    }
  }
  return Math.max(...waits);
}

// Human-like gap since the account's previous request: minimum interval plus random jitter
export function pacingDelayMs(token, now = Date.now(), random = Math.random) {
  const cfg = settings();
  const s = account(token);
  if (!s.lastRequestAt || (cfg.webMinIntervalSec <= 0 && cfg.webJitterSec <= 0)) return 0;
  const gap = (cfg.webMinIntervalSec + random() * cfg.webJitterSec) * 1000;
  return Math.max(0, s.lastRequestAt + gap - now);
}

export class AccountBudgetError extends Error {
  constructor(waitMs, kind) {
    super(`Web account is resting to stay within its usage budget (${kind}); available again in ${Math.ceil(waitMs / 1000)}s`);
    this.name = 'AccountBudgetError';
    this.status = 429;
    this.code = 'account_budget';
    this.retryAfterMs = waitMs;
  }
}

/**
 * Called right before a request goes out (inside the account's serialized queue).
 * Throws AccountBudgetError when the account must rest, so the caller hands off to another account.
 */
export async function beforeRequest(token, kind = 'completion', { signal } = {}) {
  const wait = budgetWaitMs(token, kind);
  if (wait > 0) {
    cooldownListener(token, wait, `Usage budget reached (${kind}); resting to avoid suspension`);
    throw new AccountBudgetError(wait, kind);
  }
  if (kind === 'completion') {
    const delay = pacingDelayMs(token);
    if (delay > 0) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, delay);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
      });
    }
  }
  const s = account(token);
  const now = Date.now();
  if (kind === 'session') s.sessions.push(now);
  else {
    s.requests.push(now);
    s.lastRequestAt = now;
  }
  schedulePersist();
}

// Throttle warnings escalate: 15s, 30s, 1m ... capped at 2 minutes
export function recordThrottle(token) {
  const s = account(token);
  s.strikes = Math.min(s.strikes + 1, 4);
  s.cleanStreak = 0;
  const cooldown = Math.min(2 * MINUTE, 15_000 * 2 ** (s.strikes - 1));
  schedulePersist();
  return cooldown;
}

// Any clean request clears the strikes
export function recordSuccess(token) {
  const s = account(token);
  if (s.strikes > 0) {
    s.strikes = 0;
    s.cleanStreak = 0;
    schedulePersist();
  }
}

// Helper calls (optimizer / supervisor) may only use a web account with plenty of hourly budget left
export function hasHeadroom(token, fraction = 0.5, now = Date.now()) {
  const cfg = settings();
  const s = account(token);
  if (budgetWaitMs(token, 'completion', now) !== 0) return false;
  return cfg.webMaxPerHour <= 0 || countSince(s.requests, now - HOUR) < cfg.webMaxPerHour * fraction;
}

export function usageSnapshot(token, now = Date.now()) {
  const cfg = settings();
  const s = account(token);
  prune(s.requests, now, DAY);
  return {
    minute: countSince(s.requests, now - MINUTE),
    hour: countSince(s.requests, now - HOUR),
    day: s.requests.length,
    sessionsHour: countSince(s.sessions, now - HOUR),
    limits: { minute: cfg.webMaxPerMinute, hour: cfg.webMaxPerHour, day: cfg.webMaxPerDay, sessionsHour: cfg.webMaxSessionsPerHour },
    strikes: s.strikes
  };
}

export function resetPolicyState() {
  accounts.clear();
  pendingRestore = {};
}
