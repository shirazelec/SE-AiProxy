import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Request budgets for API accounts (free tiers: "30 requests per minute, 1000 per day").
// Each key keeps its own count. When a key reaches its budget it is rested until the oldest request
// leaves the window, so the pool moves to another key or account before the provider answers 429.
// 0 means no budget. Counts survive restarts (keyed by a fingerprint, never the key itself).

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const usage = new Map(); // fingerprint -> number[] (request timestamps, last 24h)
let persistPath = null;
let persistTimer = null;

const fingerprint = token => crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16);

export function configureApiBudget({ dataDir } = {}) {
  if (!dataDir) return;
  persistPath = path.join(dataDir, 'api-usage.json');
  try {
    const now = Date.now();
    const saved = JSON.parse(fs.readFileSync(persistPath, 'utf8'));
    for (const [fp, list] of Object.entries(saved)) {
      if (Array.isArray(list)) usage.set(fp, list.filter(t => now - t < DAY));
    }
  } catch {}
}

function schedulePersist() {
  if (!persistPath || persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      fs.writeFileSync(persistPath, JSON.stringify(Object.fromEntries(usage)), { encoding: 'utf8', mode: 0o600 });
    } catch {}
  }, 5000);
  persistTimer.unref?.();
}

function list(token, now) {
  const fp = fingerprint(token);
  let l = usage.get(fp);
  if (!l) usage.set(fp, (l = []));
  while (l.length && now - l[0] >= DAY) l.shift();
  return l;
}

const countSince = (l, since) => {
  let n = 0;
  for (let i = l.length - 1; i >= 0 && l[i] > since; i--) n++;
  return n;
};

export function normalizeBudget(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1_000_000) : 0;
}

/** How long until this key may send another request under { rpm, rpd } (0 = now). */
export function budgetWaitMs(token, { rpm = 0, rpd = 0 } = {}, now = Date.now()) {
  if (!token || (!rpm && !rpd)) return 0;
  const l = list(token, now);
  const waits = [0];
  for (const [windowMs, max] of [[MINUTE, rpm], [DAY, rpd]]) {
    if (max > 0 && countSince(l, now - windowMs) >= max) waits.push(l[l.length - max] + windowMs - now);
  }
  return Math.max(...waits);
}

/** Count one request; returns the wait before the key may be used again (0 = still within budget). */
export function recordApiRequest(token, limits = {}, now = Date.now()) {
  if (!token) return 0;
  list(token, now).push(now);
  schedulePersist();
  return budgetWaitMs(token, limits, now);
}

export function apiUsageSnapshot(token, { rpm = 0, rpd = 0 } = {}, now = Date.now()) {
  const l = list(token, now);
  return { minute: countSince(l, now - MINUTE), day: l.length, limits: { minute: rpm, day: rpd } };
}

export function resetApiBudget() {
  usage.clear();
}
