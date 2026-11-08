import tokenPool from './tokenPool.js';
import { isRateLimitedOrBusy, isThrottleError } from './deepseek.js';
import { recordThrottle } from './webAccountPolicy.js';

export function isNetworkError(err) {
  if (!err) return false;
  const msg = (err.message || '').toLowerCase();
  const code = (err.code || '').toLowerCase();
  return (
    code === 'econnreset' ||
    code === 'etimedout' ||
    code === 'enotfound' ||
    code === 'eai_again' ||
    code === 'econnrefused' ||
    msg.includes('fetch failed') ||
    msg.includes('network socket disconnected') ||
    msg.includes('client network socket') ||
    msg.includes('timeout') ||
    msg === 'terminated'
  );
}

export function isAbortLike(err) {
  return Boolean(err) && (err.name === 'AbortError' || err.status === 499 || err.code === 'client_aborted');
}

// Daily/free quotas ("You've used today's Free usage. It resets in 6h 33m" or
// "Your free allowance for ':free' models is used up. It comes back on 10 Nov 2026 at 20:26 UTC")
// must park the account until the reset; otherwise rapid failover churns through the account pool.
// A depleted prepaid wallet comes back the moment it is topped up
const TOP_UP_COOLDOWN_MS = 3 * 60000;

export function quotaCooldownMs(message = '') {
  // Only the upstream's own text counts: "Chabokan-2 HTTP 402: ..." must not read as "2 h"
  const msg = String(message).replace(/^[\s\S]*?HTTP\s+\d{3}:\s*/, '');
  if (/credit\s+exhausted|top\s*up|insufficient[_\s]credit|insufficient[_\s](?:balance|funds)/i.test(msg)) return TOP_UP_COOLDOWN_MS;
  if (!/(?:quota|free usage|usage pack|credit|billing|insufficient|exceeded your|resets? in|allowance|used up|free_tier|period starts)/i.test(msg)) return 0;

  // Pattern 1: TokenHarbor "comes back on 5 Nov 2026 at 05:28 UTC" /
  // "Your next rolling 7-day period starts on 10 Nov 2026 at 20:20 UTC"
  const utcMatch = /(?:comes back|starts|resets?)\s+on\s+([0-9]+\s+[A-Za-z]+\s+[0-9]{4})\s+at\s+([0-9]{1,2}:[0-9]{2})\s*UTC/i.exec(msg);
  if (utcMatch) {
    const resetMs = Date.parse(`${utcMatch[1]} ${utcMatch[2]} UTC`);
    const diff = resetMs - Date.now();
    if (diff > 0) return diff;
  }

  // Pattern 2: "resets in 6h 33m" / "comes back in 2h"
  const h = /(\d+)\s*h/i.exec(msg);
  const m = /(\d+)\s*m(?:in)?\b/i.exec(msg);
  const parsed = ((h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0)) * 60000;
  return parsed > 0 ? parsed : 15 * 60000; // Unknown reset time: check again in 15 min
}

// Single place that turns an upstream failure into account state (invalid / cooldown).
// Returns true when the account switched to another of its keys and can be retried right away.
export const CHALLENGE_MIN_COOLDOWN_MS = 30000;
export const CHALLENGE_MAX_COOLDOWN_MS = 60000;
export const UPSTREAM_TIMEOUT_COOLDOWN_MS = 60000;
export const MODEL_GONE_COOLDOWN_MS = 60 * 60000;
// A connection that drops twice in one request is treated as an account failure, not a blip
export const NETWORK_FAIL_COOLDOWN_MS = 30000;

// Kimi refuses every free account at once when its servers are full; resting just the one that
// failed makes the next request try (and wait on) its siblings, which fail the same way.
export const KIMI_OVERLOAD_BASE_MS = 20000;
export const KIMI_OVERLOAD_MAX_MS = 2 * 60000;
const KIMI_OVERLOAD_RESET_MS = 15 * 60000;
let kimiOverload = { strikes: 0, lastAt: 0 };

export function isProviderWideOverload(err) {
  return Boolean(err) && /SERVER_OVERLOADED/i.test(err.kimiReason || err.message || '');
}

// 20 s, 40 s, 80 s, then 2 min while the overload keeps going; back to 20 s after 15 quiet minutes
export function kimiOverloadCooldownMs(now = Date.now()) {
  if (now - kimiOverload.lastAt > KIMI_OVERLOAD_RESET_MS) kimiOverload.strikes = 0;
  kimiOverload = { strikes: kimiOverload.strikes + 1, lastAt: now };
  return Math.min(KIMI_OVERLOAD_MAX_MS, KIMI_OVERLOAD_BASE_MS * 2 ** (kimiOverload.strikes - 1));
}

export function resetKimiOverload() {
  kimiOverload = { strikes: 0, lastAt: 0 };
}

function restAllKimiAccounts(tokenId, msg) {
  const ms = kimiOverloadCooldownMs();
  const until = Date.now() + ms;
  let switched = false;
  for (const t of tokenPool.tokens) {
    if (t.type !== 'kimi_web' || t.status === 'disabled' || t.status === 'invalid') continue;
    // Never shorten a longer rest the account already has
    if (t.id !== tokenId && (t.rateLimitedUntil || 0) >= until) continue;
    const r = tokenPool.markTokenRateLimited(t.id, ms, `${msg} (Kimi-wide overload)`);
    if (t.id === tokenId) switched = r;
  }
  console.warn(`[AccountHealth] Kimi servers are overloaded for free users; resting every Kimi account for ${ms / 1000}s.`);
  return switched;
}

export function penalizeAccount(tokenId, err) {
  if (!tokenId || !err || isAbortLike(err) || isNetworkError(err)) return false;
  const msg = err.message || '';
  const lower = msg.toLowerCase();
  const token = tokenPool.tokens.find(t => t.id === tokenId);
  const isWeb = !token || !token.type || token.type === 'deepseek_web';

  if (token?.type === 'kimi_web' && isProviderWideOverload(err)) return restAllKimiAccounts(tokenId, msg);

  // The DeepSeek client / usage policy already computed how long this account must rest
  if (err.retryAfterMs > 0) {
    return tokenPool.markTokenRateLimited(tokenId, err.retryAfterMs, msg);
  }
  // The endpoint accepted the request but went silent (see upstreamGuard.js): rest it briefly so the
  // next request goes elsewhere instead of waiting on the same silent endpoint again
  if (err.code === 'upstream_timeout') {
    return tokenPool.markTokenRateLimited(tokenId, UPSTREAM_TIMEOUT_COOLDOWN_MS, msg);
  }
  // The configured model was removed or renamed upstream; retrying soon will not bring it back
  if (!isWeb && (err.status === 404 || err.status === 410)) {
    return tokenPool.markTokenRateLimited(tokenId, MODEL_GONE_COOLDOWN_MS, `${msg} (check the model name)`);
  }
  const quotaMs = (err.status === 402 || err.status === 429 || isWeb) ? quotaCooldownMs(msg) : 0;

  // HTML response (<!DOCTYPE, <html>) indicates a Cloudflare challenge, Vercel Security Checkpoint,
  // or transient edge WAF challenge. This is an IP/edge-level challenge, NOT an account failure or permanent ban.
  const isHtml = /<html|<!doctype|checkpoint|turnstile/i.test(msg);
  if (isHtml) {
    // For Web accounts: 60s cooldown. For API accounts: 5s cooldown (prevents entire pool lockdown).
    return tokenPool.markTokenRateLimited(tokenId, isWeb ? 60000 : 5000, msg);
  }

  if (isWeb) {
    // DeepSeek asks for a human check: park the account briefly (30–60 s) instead of half an hour.
    if (/CHALLENGE_REQUIRED/i.test(msg)) {
      const strikeMs = token?.token ? recordThrottle(token.token) : 0;
      return tokenPool.markTokenRateLimited(tokenId, Math.min(CHALLENGE_MAX_COOLDOWN_MS, Math.max(CHALLENGE_MIN_COOLDOWN_MS, strikeMs * 2)), msg);
    }
    const isInvalid = err.status === 401 ||
      (err.status === 400 && lower.includes('authorization')) ||
      /invalid.?token/i.test(msg) ||
      lower.includes('invalid_token') ||
      err.code === 'invalid_token';
    if (isInvalid) {
      return tokenPool.markTokenInvalid(tokenId, msg);
    } else if (isRateLimitedOrBusy(err) || err.status === 429 || err.status === 402 || quotaMs) {
      // Throttle warnings escalate per account (webAccountPolicy); server-busy only needs a short pause
      const cooldown = quotaMs || (isThrottleError(err) && token?.token ? recordThrottle(token.token) : 20000);
      return tokenPool.markTokenRateLimited(tokenId, cooldown, msg);
    } else {
      return tokenPool.markTokenRateLimited(tokenId, 20000, msg);
    }
  }

  // Non-web (API) accounts: fast recovery without heavy anti-bot penalties
  if (quotaMs) {
    return tokenPool.markTokenRateLimited(tokenId, quotaMs, msg);
  } else if (err.status === 429 || /(?:frequent|rate.?limit|too many requests)/i.test(msg)) {
    // API rate limits: short 15s cooldown instead of 60s
    return tokenPool.markTokenRateLimited(tokenId, 15000, msg);
  } else if (err.status === 401) {
    // Only real API authentication rejection (401 Unauthorized) marks an API key invalid
    return tokenPool.markTokenInvalid(tokenId, msg);
  } else if (err.status === 403) {
    return tokenPool.markTokenRateLimited(tokenId, 20000, msg);
  } else {
    return tokenPool.markTokenRateLimited(tokenId, 10000, msg);
  }
}
