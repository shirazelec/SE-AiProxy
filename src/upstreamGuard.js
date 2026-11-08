// Time limits and error details for API provider requests.
//
// Without a deadline, an upstream that accepts the connection but never answers holds the request
// until undici gives up after 5 minutes, and every retry waits again. Two limits close that gap:
//   - first byte: headers plus the first body chunk must arrive within this budget
//   - stall: once streaming, the gap between two chunks may not exceed this budget
// Hitting either throws an error with code 'upstream_timeout', so the account is rested briefly and the
// request moves to the next account instead of retrying the same silent endpoint.

const envMs = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 && process.env[name]?.trim() !== '' ? n : fallback;
};

export const FIRST_BYTE_TIMEOUT_MS = envMs('PROVIDER_FIRST_BYTE_TIMEOUT_MS', 90_000);
export const STREAM_STALL_TIMEOUT_MS = envMs('PROVIDER_STREAM_STALL_TIMEOUT_MS', 90_000);

// NVIDIA's free NIM endpoints queue requests and prefill long prompts before the first token
const SLOW_FIRST_BYTE = { nvidia: 180_000 };

export function firstByteBudgetMs(provider = {}) {
  const typed = SLOW_FIRST_BYTE[provider.type];
  return typed && FIRST_BYTE_TIMEOUT_MS > 0 ? Math.max(FIRST_BYTE_TIMEOUT_MS, typed) : FIRST_BYTE_TIMEOUT_MS;
}

export function upstreamTimeoutError(name, message) {
  const err = new Error(`${name}: ${message}`);
  err.code = 'upstream_timeout';
  err.status = 504;
  return err;
}

/**
 * An AbortSignal that follows the caller's signal and can also be fired by a resettable timer.
 * arm(ms, why) (re)starts the timer; 0 disables it. After an abort, `firedReason` tells whether the
 * timer fired (a string) or the caller aborted (null).
 */
export function createWatchdog(parentSignal) {
  const controller = new AbortController();
  let timer = null;
  let firedReason = null;
  const onParentAbort = () => controller.abort(parentSignal.reason);
  if (parentSignal?.aborted) controller.abort(parentSignal.reason);
  else parentSignal?.addEventListener('abort', onParentAbort, { once: true });

  return {
    signal: controller.signal,
    arm(ms, why) {
      clearTimeout(timer);
      if (ms > 0 && !controller.signal.aborted) {
        timer = setTimeout(() => { firedReason = why; controller.abort(); }, ms);
        timer.unref?.();
      }
    },
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    },
    get firedReason() { return firedReason; }
  };
}

// Durations like "2m59.56s", "1h2m", "750ms", "12s" (Groq / OpenAI x-ratelimit-reset-* headers)
function parseGoDuration(text) {
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let matched = false;
  let m;
  while ((m = re.exec(text))) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === 'h' ? n * 3600_000 : m[2] === 'm' ? n * 60_000 : m[2] === 's' ? n * 1000 : n;
  }
  return matched ? total : NaN;
}

const MAX_RETRY_AFTER_MS = 24 * 3600_000;

/** Back-off the upstream asked for, in ms, or 0 when it stated none. */
export function retryAfterMsFromHeaders(headers, now = Date.now()) {
  if (!headers?.get) return 0;
  const candidates = [];
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) candidates.push(secs * 1000);
    else {
      const at = Date.parse(retryAfter);
      if (Number.isFinite(at)) candidates.push(at - now);
    }
  }
  const retryAfterMs = Number(headers.get('retry-after-ms'));
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) candidates.push(retryAfterMs);
  for (const name of ['x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens']) {
    const v = headers.get(name);
    if (v) {
      const ms = /^\d+(?:\.\d+)?$/.test(v.trim()) ? Number(v) * 1000 : parseGoDuration(v);
      if (Number.isFinite(ms)) candidates.push(ms);
    }
  }
  const reset = headers.get('x-ratelimit-reset');
  if (reset && /^\d+(?:\.\d+)?$/.test(reset.trim())) {
    const n = Number(reset);
    // Epoch seconds / ms, or seconds from now
    if (n > 1e12) candidates.push(n - now);
    else if (n > 1e9) candidates.push(n * 1000 - now);
    else candidates.push(n * 1000);
  }
  const valid = candidates.filter(ms => Number.isFinite(ms) && ms > 0);
  return valid.length ? Math.min(MAX_RETRY_AFTER_MS, Math.ceil(Math.max(...valid))) : 0;
}

/** Error for a non-2xx upstream reply, carrying status, HTML flag and any stated back-off. */
export async function upstreamHttpError(name, res) {
  const errText = await res.text().catch(() => '');
  let errDesc = errText.slice(0, 200);
  const titleMatch = /<title>(.*?)<\/title>/i.exec(errText);
  if (titleMatch) errDesc = `HTML [${titleMatch[1]}]: ${errText.slice(0, 100).replace(/\s+/g, ' ')}`;
  const err = new Error(`${name} HTTP ${res.status}: ${errDesc}`);
  err.status = res.status;
  err.isHtml = /<html|<!doctype/i.test(errText);
  if (res.status === 429 || res.status === 503 || res.status === 529) {
    const ms = retryAfterMsFromHeaders(res.headers);
    if (ms > 0) err.retryAfterMs = ms;
  }
  return err;
}

/**
 * fetch with the first-byte budget. Resolves with the response and the watchdog; the caller arms the
 * stall timer per chunk and must call guard.dispose() when done.
 */
export async function guardedFetch(fetchImpl, url, options, { name, provider, signal }) {
  const guard = createWatchdog(signal);
  const firstByteMs = firstByteBudgetMs(provider);
  guard.arm(firstByteMs, `no response within ${Math.round(firstByteMs / 1000)}s`);
  try {
    const res = await fetchImpl(url, { ...options, signal: guard.signal });
    return { res, guard };
  } catch (err) {
    guard.dispose();
    if (guard.firedReason && !signal?.aborted) throw upstreamTimeoutError(name, guard.firedReason);
    throw err;
  }
}

/** Read one chunk; converts a watchdog abort into an upstream_timeout error. */
export async function guardedRead(reader, guard, { name, signal }) {
  try {
    return await reader.read();
  } catch (err) {
    if (guard.firedReason && !signal?.aborted) throw upstreamTimeoutError(name, guard.firedReason);
    throw err;
  }
}

export function stallReason() {
  return `stream stalled for ${Math.round(STREAM_STALL_TIMEOUT_MS / 1000)}s`;
}
