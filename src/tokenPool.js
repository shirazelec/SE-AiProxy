import fs from 'node:fs';
import { testAnthropicKey, listAnthropicModels } from './anthropicUpstream.js';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createPowChallenge, getDeepSeekIdentity, setClientProfile } from './deepseek.js';
import { testKimiToken } from './kimiWeb.js';
import { PROVIDER_PRESETS } from './providerPresets.js';
import { safeEqual } from './security.js';
import { quotaCooldownMs } from './accountHealth.js';
import { upstreamFetch } from './directFetch.js';

// Account roles: 'prompt' (A: turns the user's request into a clear brief), 'work' (B: runs the task),
// 'debug' (C: judges turns and diagnoses failing commands), 'all' (any of them; the default).
// 'disabled' parks an account by hand (kept in the pool, never used); 'invalid' means its key was rejected
export function isAccountOff(t) {
  return t?.status === 'invalid' || t?.status === 'disabled';
}

export const ACCOUNT_ROLES = ['all', 'prompt', 'work', 'debug'];
export function accountRole(t) {
  return ACCOUNT_ROLES.includes(t?.role) ? t.role : 'all';
}
function normalizeRole(role) {
  return ACCOUNT_ROLES.includes(role) ? role : 'all';
}
import { configurePolicy, usageSnapshot, POLICY_DEFAULTS } from './webAccountPolicy.js';
import { configureApiBudget, recordApiRequest, apiUsageSnapshot, normalizeBudget } from './apiBudget.js';

dotenv.config();

// Resolve data dir relative to the package (not cwd) so `bin/proxy.js` works from any directory
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(PROJECT_ROOT, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// Map conversation key -> token ID (Sticky Session); bounded, oldest bindings evicted first
const MAX_CONVERSATION_BINDINGS = 2000;
// When every account is cooling down, only retry one whose cooldown ends within this window
const SHORT_COOLDOWN_FALLBACK_MS = 2 * 60 * 1000;
const conversationTokenMap = new Map();

function bindConversation(conversationKey, tokenId) {
  if (!conversationKey) return;
  conversationTokenMap.delete(conversationKey);
  conversationTokenMap.set(conversationKey, tokenId);
  while (conversationTokenMap.size > MAX_CONVERSATION_BINDINGS) {
    conversationTokenMap.delete(conversationTokenMap.keys().next().value);
  }
}

// Context / session limits, editable from the dashboard. Env vars only change the initial defaults.
export const SETTINGS_SCHEMA = {
  contextWindow: { def: 1048576, min: 8000, max: 2000000 },
  autoCompactLimit: { def: 400000, min: 4000, max: 2000000 },
  sessionRotateChars: { def: Number(process.env.SESSION_ROTATE_CHARS) || 180000, min: 20000, max: 10000000 },
  fullPromptMaxChars: { def: Number(process.env.FULL_PROMPT_MAX_CHARS) || 120000, min: 10000, max: 5000000 },
  // DeepSeek Web usage policy (per account) — see webAccountPolicy.js
  webMinIntervalSec: { def: POLICY_DEFAULTS.webMinIntervalSec, min: 0, max: 120 },
  webJitterSec: { def: POLICY_DEFAULTS.webJitterSec, min: 0, max: 60 },
  webMaxPerMinute: { def: POLICY_DEFAULTS.webMaxPerMinute, min: 0, max: 1000 },
  webMaxPerHour: { def: POLICY_DEFAULTS.webMaxPerHour, min: 0, max: 2000 },
  webMaxPerDay: { def: POLICY_DEFAULTS.webMaxPerDay, min: 0, max: 20000 },
  webMaxSessionsPerHour: { def: POLICY_DEFAULTS.webMaxSessionsPerHour, min: 0, max: 500 }
};

export function normalizeSettings(input = {}, base = {}) {
  const out = {};
  const errors = [];
  for (const [key, spec] of Object.entries(SETTINGS_SCHEMA)) {
    const raw = input[key] ?? base[key] ?? spec.def;
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n < spec.min || n > spec.max) {
      errors.push(`${key} must be between ${spec.min} and ${spec.max}`);
      out[key] = base[key] ?? spec.def;
    } else {
      out[key] = n;
    }
  }
  if (out.autoCompactLimit >= out.contextWindow) {
    errors.push('autoCompactLimit must be smaller than contextWindow');
  }
  return { settings: out, errors };
}

// ── Multiple keys per account ──────────────────────────────────────────────────────────────────
// An account may hold several keys (t.keys). t.token always mirrors the active key, so every caller
// that reads acc.token keeps working; account status / cooldown describe the active key. When the
// active key fails, the account switches to its next usable key instead of being parked, and is only
// parked (or marked invalid) once every key is down.
const budgetOf = t => ({ rpm: t.rpm || 0, rpd: t.rpd || 0 });

function newKeyId() {
  return 'k_' + crypto.randomBytes(5).toString('hex');
}

function isKeyUsable(k, now = Date.now()) {
  return Boolean(k?.token) && k.status !== 'invalid' && k.status !== 'disabled' && now >= (k.rateLimitedUntil || 0);
}

export function ensureKeys(t) {
  if (!Array.isArray(t.keys)) t.keys = [];
  t.keys = t.keys.filter(k => k && typeof k.token === 'string' && k.token.trim());
  for (const k of t.keys) {
    if (!k.id) k.id = newKeyId();
    if (!k.status) k.status = 'active';
  }
  if (t.token && !t.keys.some(k => k.token === t.token)) {
    t.keys.unshift({
      id: newKeyId(),
      token: t.token,
      status: t.status === 'invalid' ? 'invalid' : (t.status === 'rate_limited' ? 'rate_limited' : 'active'),
      rateLimitedUntil: t.rateLimitedUntil || 0,
      lastError: t.lastError || null,
      dsUserId: t.dsUserId,
      dsEmail: t.dsEmail
    });
  }
  if (t.keys.length === 0) {
    t.activeKeyId = null;
    t.token = '';
    return t;
  }
  const active = t.keys.find(k => k.id === t.activeKeyId) || t.keys.find(k => k.token === t.token) || t.keys[0];
  t.activeKeyId = active.id;
  t.token = active.token;
  return t;
}

export function activeKey(t) {
  return t?.keys?.find(k => k.id === t.activeKeyId) || null;
}

function keyIndex(t, keyId = t.activeKeyId) {
  return (t.keys || []).findIndex(k => k.id === keyId);
}

function activateKey(t, k) {
  t.activeKeyId = k.id;
  t.token = k.token;
  if (k.dsUserId !== undefined) t.dsUserId = k.dsUserId;
  if (k.dsEmail !== undefined) t.dsEmail = k.dsEmail;
  if (t.status !== 'disabled') {
    const now = Date.now();
    const parked = now < (k.rateLimitedUntil || 0);
    t.status = k.status === 'invalid' ? 'invalid' : (parked ? 'rate_limited' : 'active');
    t.rateLimitedUntil = parked ? k.rateLimitedUntil : 0;
    t.lastError = k.status === 'invalid' || parked ? k.lastError : null;
  }
}

// Active key just failed: move to the next usable key (in order, wrapping). When none is usable,
// park the account on the key that recovers first so it comes back with a key that works.
// Returns true when the account switched to a usable key.
function failOverKey(t, reason) {
  if (!t.keys || t.keys.length < 2) return false;
  const now = Date.now();
  const from = keyIndex(t);
  for (let step = 1; step < t.keys.length; step++) {
    const k = t.keys[(from + step) % t.keys.length];
    if (isKeyUsable(k, now)) {
      activateKey(t, k);
      console.warn(`[TokenPool] Account ${t.label} (${t.id}): key #${from + 1} failed (${String(reason || '').slice(0, 120)}); switched to key #${keyIndex(t) + 1} of ${t.keys.length}.`);
      return true;
    }
  }
  const waiting = t.keys
    .filter(k => k.token && k.status !== 'invalid' && k.status !== 'disabled')
    .sort((a, b) => (a.rateLimitedUntil || 0) - (b.rateLimitedUntil || 0));
  if (waiting.length && waiting[0].id !== t.activeKeyId) activateKey(t, waiting[0]);
  return false;
}

// One key per line: "key1\nkey2" -> ['key1', 'key2'] (commas are left alone: they may be part of a key)
export function splitKeys(input) {
  if (Array.isArray(input)) return input.flatMap(splitKeys);
  return String(input || '').split(/[\r\n]+/).map(k => k.trim()).filter(Boolean);
}

// After a test failure on the account itself, carry its state onto the active key
function syncActiveKeyFromAccount(t) {
  const k = activeKey(t);
  if (!k || t.status === 'disabled') return;
  k.status = t.status === 'invalid' ? 'invalid' : (t.status === 'rate_limited' ? 'rate_limited' : 'active');
  k.rateLimitedUntil = t.rateLimitedUntil || 0;
  k.lastError = t.lastError || null;
}

function maskKey(token) {
  if (!token) return '';
  return token.length > 14 ? `${token.slice(0, 7)}...${token.slice(-5)}` : '••••••••';
}

// A DeepSeek session was opened with one key; after a key switch it cannot be continued with another
export function sessionKeyMatches(sessionInfo, acc) {
  return !sessionInfo?.keyId || !acc?.activeKeyId || sessionInfo.keyId === acc.activeKeyId;
}

function isTokenAvailable(t, now = Date.now()) {
  return Boolean(t) && !isAccountOff(t) && now >= (t.rateLimitedUntil || 0);
}

// A failed dashboard test: only a real 401 / explicit token rejection marks the account invalid (never
// HTML/WAF/403/network errors). Quota errors keep the account parked until the provider's reset time
// instead of a 60s pause that would let every request walk the exhausted accounts again.
function applyTestFailure(t, err) {
  const msg = err.message || '';
  const isHtml = /<html|<!doctype/i.test(msg);
  const isAuth = !isHtml && (err.status === 401 || /invalid.?token|unauthorized/i.test(msg));
  t.status = isAuth ? 'invalid' : 'rate_limited';
  t.lastError = msg;
  if (!isAuth) {
    const quotaMs = (err.status === 429 || err.status === 402) ? quotaCooldownMs(msg) : 0;
    t.rateLimitedUntil = Math.max(t.rateLimitedUntil || 0, Date.now() + (quotaMs || 60000));
  }
}

/**
 * Live test of an account (token / API key) based on its provider type.
 */
export async function testAccountLive(acc) {
  const type = acc.type || 'deepseek_web';
  if (type === 'deepseek_web') {
    await createPowChallenge(acc.token);
    return { ok: true, latencyMs: 0, reply: 'POW Verified', model: acc.model || 'deepseek-chat' };
  }
  if (type === 'kimi_web') {
    return await testKimiToken(acc.token, acc.baseUrl);
  }
  if (type === 'anthropic' || acc.protocol === 'anthropic_messages') {
    return await testAnthropicKey({ ...acc, baseUrl: acc.baseUrl || PROVIDER_PRESETS.anthropic.baseUrl });
  }

  const t0 = Date.now();
  const baseUrl = (acc.baseUrl || PROVIDER_PRESETS[type]?.baseUrl || '').replace(/\/+$/, '');
  const model = acc.model || PROVIDER_PRESETS[type]?.model || 'deepseek-v4.1-flash';
  const url = `${baseUrl}/chat/completions`;

  const res = await upstreamFetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${acc.token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'SE-AiProxy/1.0.0 (OpenAI-Compatible/1.0)',
      'HTTP-Referer': 'https://shirazelectronic.ir',
      'X-Title': 'SE-AiProxy'
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Say OK' }],
      // OpenAI's reasoning models reject max_tokens and spend tokens thinking before the reply
      ...(type === 'openai' ? { max_completion_tokens: 512 } : { max_tokens: 50 })
    }),
    // NVIDIA's free NIM endpoints queue requests, so the first reply can take a while
    signal: AbortSignal.timeout(type === 'nvidia' ? 90000 : 15000)
  });

  const latencyMs = Date.now() - t0;
  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`HTTP ${res.status}: ${errText.slice(0, 150)}`);
    err.status = res.status;
    throw err;
  }

  const json = await res.json();
  const choice = json.choices?.[0]?.message;
  const reply = (choice?.content || choice?.reasoning || 'OK').trim().replace(/\n/g, ' ').slice(0, 50) || 'OK';
  return { ok: true, latencyMs, reply, model };
}

class TokenPoolManager {
  constructor() {
    this.tokens = [];
    this.proxyKeys = [];
    this.saveTimer = null;
    this.settings = normalizeSettings().settings;
    this.init();
  }

  init() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }

    if (fs.existsSync(CONFIG_FILE)) {
      try {
        const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
        const data = JSON.parse(raw);
        this.tokens = data.tokens || [];
        this.proxyKeys = data.proxyKeys || [];
        this.adminKey = data.adminKey || null;
        this.settings = normalizeSettings(data.settings || {}).settings;
      } catch (err) {
        console.error('[TokenPool] Error reading config.json, resetting:', err);
      }
    }

    // Migration from .env if tokens array is empty
    if (this.tokens.length === 0 && process.env.DEEPSEEK_TOKEN) {
      this.tokens.push({
        id: 'tok_' + crypto.randomBytes(6).toString('hex'),
        type: 'deepseek_web',
        token: process.env.DEEPSEEK_TOKEN.trim(),
        label: 'Account 1 (Default)',
        model: 'deepseek-chat',
        baseUrl: 'https://chat.deepseek.com',
        protocol: 'deepseek_web',
        priority: 4,
        status: 'active',
        rateLimitedUntil: 0,
        activeSessions: 0,
        activeRequests: 0,
        totalRequests: 0,
        lastUsed: Date.now()
      });
    }

    // Normalize all accounts
    for (const t of this.tokens) {
      ensureKeys(t);
      if (t.userAgent) for (const k of t.keys) setClientProfile(k.token, { userAgent: t.userAgent });
    }
    for (const t of this.tokens) {
      if (!t.type) t.type = 'deepseek_web';
      const preset = PROVIDER_PRESETS[t.type] || PROVIDER_PRESETS.deepseek_web;
      if (!t.baseUrl) t.baseUrl = preset.baseUrl;
      if (!t.model) t.model = preset.model;
      if (!t.protocol) t.protocol = preset.protocol;
      if (t.priority === undefined) t.priority = preset.priority;
      // In-flight counters are runtime state; a stale persisted value would make an account look busy forever
      t.activeRequests = 0;
    }

    // Default Proxy API Key if none exists
    if (this.proxyKeys.length === 0) {
      const defaultKey = 'sk-proxy-' + crypto.randomBytes(16).toString('hex');
      this.proxyKeys.push({
        id: 'key_' + crypto.randomBytes(6).toString('hex'),
        key: defaultKey,
        label: 'Default Codex Key',
        createdAt: new Date().toISOString()
      });
    }

    // Admin key for remote access to the management API (/api/*); ADMIN_KEY in .env overrides it
    if (!this.adminKey) {
      this.adminKey = 'sk-admin-' + crypto.randomBytes(24).toString('hex');
    }

    this.save();
  }

  getAdminKey() {
    return (process.env.ADMIN_KEY || '').trim() || this.adminKey;
  }

  scheduleSave(delayMs = 2000) {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, delayMs);
    this.saveTimer.unref?.();
  }

  save() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      // Holds upstream API keys: owner read/write only
      fs.writeFileSync(CONFIG_FILE, JSON.stringify({
        tokens: this.tokens,
        proxyKeys: this.proxyKeys,
        adminKey: this.adminKey,
        settings: this.settings
      }, null, 2), { encoding: 'utf8', mode: 0o600 });
      try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {}
    } catch (err) {
      console.error('[TokenPool] Error saving config.json:', err);
    }
  }

  getTokens(mask = true) {
    const now = Date.now();
    return this.tokens.map(t => {
      const isRateLimited = now < (t.rateLimitedUntil || 0) && !isAccountOff(t);
      const status = isRateLimited ? 'rate_limited' : (isAccountOff(t) ? t.status : 'active');
      const maskedToken = mask && t.token ? maskKey(t.token) : t.token;
      const isWebType = ['deepseek_web', 'kimi_web'].includes(t.type || 'deepseek_web');
      const keys = (t.keys || []).map((k, i) => {
        const parked = now < (k.rateLimitedUntil || 0) && k.status !== 'invalid' && k.status !== 'disabled';
        return {
          id: k.id,
          index: i + 1,
          active: k.id === t.activeKeyId,
          token: mask ? maskKey(k.token) : k.token,
          status: parked ? 'rate_limited' : (k.status === 'invalid' || k.status === 'disabled' ? k.status : 'active'),
          rateLimitedUntil: k.rateLimitedUntil || 0,
          lastError: k.lastError || null,
          dsEmail: k.dsEmail || null,
          usage: isWebType ? usageSnapshot(k.token, now) : null,
          apiUsage: !isWebType && k.token ? apiUsageSnapshot(k.token, budgetOf(t), now) : null
        };
      });
      return {
        id: t.id,
        type: t.type || 'deepseek_web',
        label: t.label,
        status,
        model: t.model || 'deepseek-chat',
        baseUrl: t.baseUrl || '',
        protocol: t.protocol || 'deepseek_web',
        priority: t.priority ?? 4,
        role: accountRole(t),
        rpm: t.rpm || 0,
        rpd: t.rpd || 0,
        apiUsage: !isWebType && t.token ? apiUsageSnapshot(t.token, budgetOf(t), now) : null,
        rateLimitedUntil: t.rateLimitedUntil || 0,
        totalRequests: t.totalRequests || 0,
        lastUsed: t.lastUsed || 0,
        lastError: t.lastError || null,
        token: maskedToken,
        hasToken: Boolean(t.token),
        keys,
        keyCount: keys.length,
        activeKeyIndex: keyIndex(t) + 1,
        dsEmail: t.dsEmail || null,
        usage: ['deepseek_web', 'kimi_web'].includes(t.type || 'deepseek_web') && t.token ? usageSnapshot(t.token, now) : null
      };
    });
  }

  // Every credential the proxy holds, so the file logger can redact them
  getSecrets() {
    return [
      ...this.tokens.flatMap(t => [t.token, ...(t.keys || []).map(k => k.token)]),
      ...this.proxyKeys.map(k => k.key),
      this.getAdminKey()
    ].filter(Boolean);
  }

  getSettings() {
    return { ...this.settings };
  }

  updateSettings(partial) {
    const { settings, errors } = normalizeSettings(partial, this.settings);
    if (errors.length) {
      const err = new Error(errors.join('; '));
      err.status = 400;
      throw err;
    }
    this.settings = settings;
    this.save();
    return this.getSettings();
  }

  getFullToken(id) {
    return this.tokens.find(t => t.id === id);
  }

  async addAccount({ token, keys = [], label = '', type = 'deepseek_web', model = '', baseUrl = '', priority = null, role = 'all', rpm, rpd }) {
    // One key, or several (one per line / an array): the extra ones are fallbacks tried in order
    const allKeys = [...new Set([...splitKeys(token), ...(Array.isArray(keys) ? keys : splitKeys(keys)).flatMap(splitKeys)])];
    const trimmed = allKeys[0] || '';
    if (!trimmed) throw new Error('Token / API Key cannot be empty');

    const preset = PROVIDER_PRESETS[type] || PROVIDER_PRESETS.deepseek_web;
    const finalModel = (model || '').trim() || preset.model;
    const finalBaseUrl = (baseUrl || '').trim() || preset.baseUrl;
    const finalPriority = Number(priority) || preset.priority;
    const finalProtocol = preset.protocol;
    if (/ACCOUNT_ID/.test(finalBaseUrl)) throw new Error('Put your Cloudflare account id in the base URL in place of ACCOUNT_ID');

    const temp = {
      type,
      token: trimmed,
      model: finalModel,
      baseUrl: finalBaseUrl,
      protocol: finalProtocol
    };

    // Live test before adding (every key, so a dead fallback key is caught now, not mid-failover)
    const testResult = await testAccountLive(temp);
    for (let i = 1; i < allKeys.length; i++) {
      try {
        await testAccountLive({ ...temp, token: allKeys[i] });
      } catch (err) {
        throw new Error(`Key #${i + 1}: ${err.message}`);
      }
    }

    const id = 'tok_' + crypto.randomBytes(6).toString('hex');
    const countOfType = this.tokens.filter(t => (t.type || 'deepseek_web') === type).length + 1;
    const newToken = {
      id,
      type,
      token: trimmed,
      label: (label || '').trim() || `${preset.name} ${countOfType}`,
      model: finalModel,
      baseUrl: finalBaseUrl,
      protocol: finalProtocol,
      priority: finalPriority,
      role: normalizeRole(role),
      rpm: normalizeBudget(rpm ?? preset.rpm),
      rpd: normalizeBudget(rpd ?? preset.rpd),
      status: 'active',
      rateLimitedUntil: 0,
      activeSessions: 0,
      activeRequests: 0,
      totalRequests: 0,
      lastUsed: 0,
      lastError: null,
      keys: allKeys.map(k => ({ id: newKeyId(), token: k, status: 'active', rateLimitedUntil: 0, lastError: null }))
    };
    ensureKeys(newToken);

    this.tokens.push(newToken);
    this.save();
    this.recordIdentity(newToken);
    this.recordKeyIdentities(newToken);
    const { token: _t, keys: _k, ...publicFields } = newToken;
    return { ...publicFields, token: maskKey(trimmed), keyCount: newToken.keys.length, testResult };
  }

  // Alias for backward compatibility
  async addToken(tokenStr, label = '', type = 'deepseek_web', model = '', baseUrl = '', priority = null) {
    if (typeof tokenStr === 'object' && tokenStr !== null) {
      return this.addAccount(tokenStr);
    }
    return this.addAccount({ token: tokenStr, label, type, model, baseUrl, priority });
  }

  async updateToken(id, updates = {}) {
    const t = this.tokens.find(x => x.id === id);
    if (!t) throw new Error('Account not found');

    const { token, label, model, baseUrl, priority, status, role, rpm, rpd } = updates;

    if (role !== undefined) t.role = normalizeRole(role);
    if (rpm !== undefined) t.rpm = normalizeBudget(rpm);
    if (rpd !== undefined) t.rpd = normalizeBudget(rpd);

    if (label !== undefined && typeof label === 'string') {
      const trimmedLabel = label.trim();
      if (trimmedLabel) t.label = trimmedLabel;
    }

    if (model !== undefined && typeof model === 'string') {
      const trimmedModel = model.trim();
      if (trimmedModel) t.model = trimmedModel;
    }

    if (baseUrl !== undefined && typeof baseUrl === 'string') {
      t.baseUrl = baseUrl.trim();
    }

    if (priority !== undefined) {
      const p = Number(priority);
      if (Number.isFinite(p)) t.priority = p;
    }

    // An account slot created without a key stays disabled until a key is set (dashboard: Keys → Replace / Add)
    if (status !== undefined && !(status === 'active' && !t.token && !(typeof token === 'string' && token.trim()))) {
      t.status = status;
      if (status === 'active') {
        t.rateLimitedUntil = 0;
        t.lastError = null;
        // Switching an account back on gives every one of its keys another chance
        for (const k of t.keys || []) {
          k.status = 'active';
          k.rateLimitedUntil = 0;
          k.lastError = null;
        }
      }
    }

    if (token !== undefined && typeof token === 'string') {
      const trimmedToken = token.trim();
      if (trimmedToken && trimmedToken !== t.token && !trimmedToken.includes('...')) {
        await testAccountLive({ ...t, token: trimmedToken });
        // Replaces the active key (the other keys of the account stay as they are)
        const k = activeKey(t);
        if (k) Object.assign(k, { token: trimmedToken, status: 'active', rateLimitedUntil: 0, lastError: null, dsUserId: undefined, dsEmail: undefined });
        else ensureKeys(Object.assign(t, { token: trimmedToken }));
        t.token = trimmedToken;
        t.status = 'active';
        t.rateLimitedUntil = 0;
        t.lastError = null;
        this.recordIdentity(t);
      }
    }

    this.save();
    return {
      id: t.id,
      type: t.type,
      label: t.label,
      status: t.status,
      model: t.model,
      baseUrl: t.baseUrl,
      priority: t.priority,
      role: accountRole(t),
      rpm: t.rpm || 0,
      rpd: t.rpd || 0,
      rateLimitedUntil: t.rateLimitedUntil,
      totalRequests: t.totalRequests || 0,
      lastUsed: t.lastUsed || 0,
      token: maskKey(t.token),
      keyCount: (t.keys || []).length
    };
  }

  // ── Per-key management (dashboard: account drawer → Keys) ──
  _account(id) {
    const t = this.tokens.find(x => x.id === id);
    if (!t) {
      const err = new Error('Account not found');
      err.status = 404;
      throw err;
    }
    ensureKeys(t);
    return t;
  }

  async addKey(id, token) {
    const t = this._account(id);
    const fresh = splitKeys(token);
    if (fresh.length === 0) throw new Error('Key cannot be empty');
    const added = [];
    for (const k of fresh) {
      if (t.keys.some(x => x.token === k)) continue;
      await testAccountLive({ ...t, token: k });
      const entry = { id: newKeyId(), token: k, status: 'active', rateLimitedUntil: 0, lastError: null };
      t.keys.push(entry);
      added.push(entry);
      if (t.userAgent) setClientProfile(k, { userAgent: t.userAgent });
    }
    if (added.length === 0) throw new Error('This key is already on the account');
    // An account that was waiting for a key, or whose keys are all down, starts on the new key
    if (!t.token || !isKeyUsable(activeKey(t))) activateKey(t, added[0]);
    this.save();
    this.recordKeyIdentities(t);
    return { ok: true, added: added.length, keyCount: t.keys.length };
  }

  removeKey(id, keyId) {
    const t = this._account(id);
    const idx = keyIndex(t, keyId);
    if (idx === -1) throw new Error('Key not found');
    const wasActive = t.keys[idx].id === t.activeKeyId;
    t.keys.splice(idx, 1);
    if (t.keys.length === 0) {
      t.activeKeyId = null;
      t.token = '';
      t.status = 'disabled';
    } else if (wasActive) {
      const now = Date.now();
      activateKey(t, t.keys.find(k => isKeyUsable(k, now)) || t.keys[Math.min(idx, t.keys.length - 1)]);
      this.unbindAccount(t.id);
    }
    this.save();
    return { ok: true, keyCount: t.keys.length };
  }

  // Use this key from now on (e.g. after fixing it); a manual choice clears its cooldown
  useKey(id, keyId) {
    const t = this._account(id);
    const k = t.keys.find(x => x.id === keyId);
    if (!k) throw new Error('Key not found');
    if (k.status !== 'invalid') {
      k.status = 'active';
      k.rateLimitedUntil = 0;
      k.lastError = null;
    }
    if (k.id !== t.activeKeyId) this.unbindAccount(t.id);
    activateKey(t, k);
    this.save();
    return { ok: true, activeKeyIndex: keyIndex(t) + 1 };
  }

  // Move a key up / down in the fallback order
  moveKey(id, keyId, delta) {
    const t = this._account(id);
    const idx = keyIndex(t, keyId);
    if (idx === -1) throw new Error('Key not found');
    const to = Math.max(0, Math.min(t.keys.length - 1, idx + Math.sign(Number(delta) || 0)));
    const [k] = t.keys.splice(idx, 1);
    t.keys.splice(to, 0, k);
    this.save();
    return { ok: true };
  }

  unbindAccount(tokenId) {
    for (const [convKey, boundId] of conversationTokenMap.entries()) {
      if (boundId === tokenId) conversationTokenMap.delete(convKey);
    }
  }

  // DeepSeek identity of every key (keys of one pool account may be different DeepSeek logins)
  async recordKeyIdentities(t) {
    if ((t?.type || 'deepseek_web') !== 'deepseek_web') return;
    let changed = false;
    for (const k of t.keys || []) {
      if (k.dsUserId || k.status === 'invalid') continue;
      try {
        const who = await getDeepSeekIdentity(k.token);
        k.dsUserId = who.id;
        k.dsEmail = who.email || who.mobile || null;
        changed = true;
      } catch {}
    }
    if (changed) this.save();
  }

  // Remembers which DeepSeek account a token belongs to (so a fresh token can replace a dead one)
  async recordIdentity(t) {
    if ((t?.type || 'deepseek_web') !== 'deepseek_web' || !t.token) return null;
    try {
      const who = await getDeepSeekIdentity(t.token);
      if (t.dsUserId !== who.id || t.dsEmail !== (who.email || who.mobile)) {
        t.dsUserId = who.id;
        t.dsEmail = who.email || who.mobile || null;
        const k = activeKey(t);
        if (k && k.token === t.token) Object.assign(k, { dsUserId: t.dsUserId, dsEmail: t.dsEmail });
        this.save();
      }
      return who;
    } catch {
      return null;
    }
  }

  // Fill in identities for DeepSeek accounts added before identities were recorded
  async backfillIdentities() {
    for (const t of this.tokens) {
      if ((t.type || 'deepseek_web') === 'deepseek_web' && t.token && !t.dsUserId && t.status !== 'invalid' && t.status !== 'disabled') {
        await this.recordIdentity(t);
      }
    }
  }

  /**
   * Fresh token from the browser (bookmarklet on chat.deepseek.com). It replaces the token of the
   * same DeepSeek account when one is in the pool (keeping role, model and stats); otherwise it fills
   * an empty or dead DeepSeek slot of unknown identity; otherwise it becomes a new account.
   */
  async syncDeepSeekToken({ token, userAgent = '' } = {}) {
    let fresh = String(token || '').trim();
    // localStorage keeps it as {"value":"…","__version":"0"}
    if (fresh.startsWith('{')) { try { fresh = String(JSON.parse(fresh).value || ''); } catch {} }
    fresh = fresh.replace(/^"|"$/g, '');
    if (!fresh) throw new Error('Token is empty');
    const who = await getDeepSeekIdentity(fresh);
    const label = who.email || who.mobile || who.id;
    if (userAgent) setClientProfile(fresh, { userAgent });

    const isDeepSeek = t => (t.type || 'deepseek_web') === 'deepseek_web';
    // A key of a multi-key account that belongs to this DeepSeek login: refresh just that key
    for (const t of this.tokens) {
      if (!isDeepSeek(t)) continue;
      ensureKeys(t);
      const k = t.keys.find(x => x.dsUserId === who.id);
      if (!k || t.keys.length < 2) continue;
      Object.assign(k, { token: fresh, status: 'active', rateLimitedUntil: 0, lastError: null, dsEmail: who.email || who.mobile || null });
      if (k.id === t.activeKeyId) activateKey(t, k);
      if (userAgent) t.userAgent = String(userAgent).slice(0, 400);
      this.save();
      return { action: 'replaced', id: t.id, label: `${t.label} (key #${keyIndex(t, k.id) + 1})`, account: label };
    }
    let target = this.tokens.find(t => isDeepSeek(t) && t.dsUserId === who.id);
    let action = 'replaced';
    if (!target) {
      target = this.tokens.find(t => isDeepSeek(t) && !t.dsUserId && (!t.token || t.status === 'invalid'));
      action = 'filled';
    }
    if (!target) {
      const created = await this.addAccount({ token: fresh, type: 'deepseek_web', label: `DeepSeek Web — ${label}`, model: 'deepseek-reasoner' });
      const acc = this.tokens.find(t => t.id === created.id);
      if (acc && userAgent) acc.userAgent = String(userAgent).slice(0, 400);
      this.save();
      return { action: 'added', id: created.id, label: created.label, account: label };
    }
    const targetKey = activeKey(ensureKeys(target));
    if (targetKey) Object.assign(targetKey, { token: fresh, status: 'active', rateLimitedUntil: 0, lastError: null, dsUserId: who.id, dsEmail: who.email || who.mobile || null });
    else target.keys.push({ id: (target.activeKeyId = newKeyId()), token: fresh, status: 'active', rateLimitedUntil: 0, lastError: null, dsUserId: who.id, dsEmail: who.email || who.mobile || null });
    target.token = fresh;
    target.dsUserId = who.id;
    target.dsEmail = who.email || who.mobile || null;
    if (userAgent) target.userAgent = String(userAgent).slice(0, 400);
    target.status = 'active';
    target.rateLimitedUntil = 0;
    target.lastError = null;
    this.save();
    return { action, id: target.id, label: target.label, account: label };
  }

  // Tests every key of the account, then makes sure the active key is one that works
  async testAccountKeys(t) {
    ensureKeys(t);
    if (t.keys.length < 2) {
      const res = await testAccountLive(t);
      const k = activeKey(t);
      if (k) Object.assign(k, { status: 'active', rateLimitedUntil: 0, lastError: null });
      return { res, keys: [{ index: 1, ok: true }] };
    }
    let first = null;
    let firstErr = null;
    const keys = [];
    for (const [i, k] of t.keys.entries()) {
      try {
        const res = await testAccountLive({ ...t, token: k.token });
        Object.assign(k, { status: 'active', rateLimitedUntil: 0, lastError: null });
        if (!first) first = res;
        keys.push({ index: i + 1, ok: true });
      } catch (err) {
        applyTestFailure(k, err);
        firstErr = firstErr || err;
        keys.push({ index: i + 1, ok: false, status: k.status, error: err.message });
      }
    }
    const now = Date.now();
    const current = activeKey(t);
    if (!isKeyUsable(current, now)) {
      const usable = t.keys.find(k => isKeyUsable(k, now));
      if (usable) {
        this.unbindAccount(t.id);
        activateKey(t, usable);
      }
    }
    if (!first) {
      const err = new Error(`All ${t.keys.length} keys failed: ${firstErr?.message || 'unknown error'}`);
      err.status = firstErr?.status;
      err.keys = keys;
      throw err;
    }
    return { res: first, keys };
  }

  async testToken(id) {
    const t = this.tokens.find(x => x.id === id);
    if (!t) throw new Error('Account not found');

    try {
      const { res, keys } = await this.testAccountKeys(t);
      t.status = 'active';
      t.rateLimitedUntil = 0;
      t.lastError = null;
      this.save();
      this.recordIdentity(t);
      return { ok: true, status: 'active', latencyMs: res.latencyMs, reply: res.reply, model: res.model, keys };
    } catch (err) {
      applyTestFailure(t, err);
      if ((t.keys || []).length < 2) syncActiveKeyFromAccount(t);
      this.save();
      return { ok: false, status: t.status, error: err.message, keys: err.keys };
    }
  }

  async testAllTokens() {
    const results = [];
    for (const t of this.tokens) {
      // A disabled account stays off until it is switched back on by hand (testing it costs money)
      if (t.status === 'disabled') {
        results.push({ id: t.id, label: t.label, type: t.type || 'deepseek_web', ok: false, status: 'disabled', error: 'disabled' });
        continue;
      }
      try {
        const { res } = await this.testAccountKeys(t);
        t.status = 'active';
        t.rateLimitedUntil = 0;
        t.lastError = null;
        results.push({ id: t.id, label: t.label, type: t.type || 'deepseek_web', ok: true, status: 'active', latencyMs: res.latencyMs, reply: res.reply });
      } catch (err) {
        applyTestFailure(t, err);
        if ((t.keys || []).length < 2) syncActiveKeyFromAccount(t);
        results.push({ id: t.id, label: t.label, type: t.type || 'deepseek_web', ok: false, status: t.status, error: err.message });
      }
    }
    this.save();
    const activeCount = results.filter(r => r.ok).length;
    return {
      ok: true,
      total: results.length,
      active: activeCount,
      rateLimited: results.filter(r => r.status === 'rate_limited').length,
      invalid: results.filter(r => r.status === 'invalid').length,
      results
    };
  }

  deleteToken(id) {
    const idx = this.tokens.findIndex(t => t.id === id);
    if (idx !== -1) {
      this.tokens.splice(idx, 1);
      this.save();
      return true;
    }
    return false;
  }

  getProxyKeys() {
    return this.proxyKeys;
  }

  createProxyKey(label = 'Codex Key', keyPrefix = 'sk-proxy-') {
    const isAnthropic = String(keyPrefix).toLowerCase().includes('ant');
    const prefix = isAnthropic ? 'sk-ant-api03-' : 'sk-proxy-';
    const newKey = {
      id: 'key_' + crypto.randomBytes(6).toString('hex'),
      key: prefix + crypto.randomBytes(16).toString('hex'),
      label: label.trim() || (isAnthropic ? 'Claude Code Key' : 'Codex Key'),
      type: isAnthropic ? 'anthropic' : 'codex',
      createdAt: new Date().toISOString()
    };
    this.proxyKeys.push(newKey);
    this.save();
    return newKey;
  }

  deleteProxyKey(id) {
    const idx = this.proxyKeys.findIndex(k => k.id === id);
    if (idx !== -1) {
      this.proxyKeys.splice(idx, 1);
      this.save();
      return true;
    }
    return false;
  }

  validateProxyKey(key) {
    if (!key) return false;
    return this.proxyKeys.some(k => safeEqual(k.key, key));
  }

  /**
   * Smart Multi-Provider Routing:
   * Priority ordering + load balancing. Only DeepSeek Web accounts are sticky (their upstream chat
   * session lives on one account); API accounts get the full prompt every turn, so each turn goes to
   * the least busy / least recently used account of the best available priority.
   */
  selectAccountForTurn({ conversationKey = null, protocol = null, excludeIds = new Set(), preferId = null } = {}) {
    const now = Date.now();
    const isUsable = (acc) => Boolean(acc) && !isAccountOff(acc) && now >= (acc.rateLimitedUntil || 0) && !excludeIds.has(acc.id);
    const isWeb = (acc) => !acc.type || acc.type === 'deepseek_web';

    // 0. An account that just switched to its next key gets the retry of the request that failed
    if (preferId) {
      const preferred = this.tokens.find(t => t.id === preferId);
      if (isUsable(preferred)) {
        preferred.lastUsed = now;
        bindConversation(conversationKey, preferred.id);
        return { account: preferred, tokenObj: preferred, isNewBinding: false };
      }
    }

    // 1. Sticky Session (DeepSeek Web only): keep the bound account while it is healthy
    if (conversationKey && conversationTokenMap.has(conversationKey)) {
      const boundId = conversationTokenMap.get(conversationKey);
      const bound = this.tokens.find(t => t.id === boundId);
      if (isUsable(bound) && isWeb(bound)) {
        const isBusy = (bound.activeRequests || 0) > 0;
        const hasIdleOfSameOrBetterPrio = this.tokens.some(t => isUsable(t) && (t.activeRequests || 0) === 0 && (t.priority ?? 4) <= (bound.priority ?? 4));
        if (!isBusy || !hasIdleOfSameOrBetterPrio) {
          bindConversation(conversationKey, bound.id);
          return { account: bound, tokenObj: bound, isNewBinding: false };
        }
      }
    }

    // 2. Filter available healthy accounts. The task runs on 'work'/'all' accounts; prompt and debug
    // accounts take it only when no work account is available, so the task never stalls.
    const usable = this.tokens.filter(isUsable);
    const workers = usable.filter(t => ['work', 'all'].includes(accountRole(t)));
    // Kimi Web (free: Instant only) is the weakest worker. When every stronger worker is down, a
    // healthy DeepSeek prompt/debug account takes the task before it falls to Kimi.
    const isWeak = t => t.type === 'kimi_web';
    const strongWorkers = workers.filter(t => !isWeak(t));
    const strongHelpers = usable.filter(t => !['work', 'all'].includes(accountRole(t)) && !isWeak(t));
    let candidates;
    if (strongWorkers.length > 0) candidates = strongWorkers.length === workers.length ? workers : [...strongWorkers, ...workers.filter(isWeak)];
    else if (strongHelpers.length > 0) {
      candidates = strongHelpers;
      console.warn(`[TokenPool] No strong work account available; ${strongHelpers.map(t => t.label).join(', ')} takes the task before the Kimi backup.`);
    } else candidates = workers.length > 0 ? workers : usable;
    if (workers.length === 0 && strongHelpers.length === 0 && usable.length > 0) {
      console.warn('[TokenPool] No work account available; running the task on a prompt/debug account.');
    }

    if (candidates.length === 0) {
      // Only fall back to an account whose cooldown is about to end. Accounts parked for a quota
      // reset (hours / days) would just fail again, and retrying them burns the whole pool per request.
      const waiting = this.tokens
        .filter(t => !isAccountOff(t) && !excludeIds.has(t.id))
        .sort((a, b) => (a.rateLimitedUntil || 0) - (b.rateLimitedUntil || 0));
      const soon = waiting.find(t => (t.rateLimitedUntil || 0) - now <= SHORT_COOLDOWN_FALLBACK_MS);
      if (soon) {
        bindConversation(conversationKey, soon.id);
        return { account: soon, tokenObj: soon, isNewBinding: true };
      }
      if (waiting.length > 0) {
        const next = waiting[0];
        const err = new Error(`All AI accounts are rate-limited or out of quota. Next available: ${next.label || next.id} at ${new Date(next.rateLimitedUntil).toISOString()}. Add another account or provider in the Web UI.`);
        err.status = 429;
        err.code = 'rate_limit_exceeded';
        err.allExhausted = true;
        throw err;
      }
      throw new Error('No valid AI accounts available in the pool. Please add an account via Web UI.');
    }

    // 3. Priority + Load Balancing: lowest priority number first; within a priority the account with
    // the fewest in-flight requests, then the one used longest ago (round-robin), then fewest total.
    candidates.sort((a, b) => {
      const pDiff = (a.priority ?? 4) - (b.priority ?? 4);
      if (pDiff !== 0) return pDiff;
      const busyDiff = (a.activeRequests || 0) - (b.activeRequests || 0);
      if (busyDiff !== 0) return busyDiff;
      const usedDiff = (a.lastUsed || 0) - (b.lastUsed || 0);
      if (usedDiff !== 0) return usedDiff;
      return (a.totalRequests || 0) - (b.totalRequests || 0);
    });

    const selected = candidates[0];
    // Reserve the slot now so concurrent selections in the same tick spread across accounts
    selected.lastUsed = now;
    bindConversation(conversationKey, selected.id);
    return { account: selected, tokenObj: selected, isNewBinding: true };
  }

  // Pin a conversation to a chosen account (used when it is retried on the account's next key)
  bindConversationTo(conversationKey, tokenId) {
    const t = this.tokens.find(x => x.id === tokenId);
    if (t) t.lastUsed = Date.now();
    bindConversation(conversationKey, tokenId);
  }

  // Alias for backward compatibility
  selectTokenForConversation(conversationKey, excludeIds = new Set()) {
    return this.selectAccountForTurn({ conversationKey, excludeIds });
  }

  incrementActiveRequests(tokenId) {
    const t = this.tokens.find(tok => tok.id === tokenId);
    if (t) t.activeRequests = (t.activeRequests || 0) + 1;
  }

  decrementActiveRequests(tokenId) {
    const t = this.tokens.find(tok => tok.id === tokenId);
    if (t) t.activeRequests = Math.max(0, (t.activeRequests || 0) - 1);
  }

  /**
   * Parks the account's active key. With another usable key the account switches to it and stays
   * available (returns true); otherwise the whole account is parked (returns false).
   */
  markTokenRateLimited(tokenId, durationMs = 60000, reason = '') {
    const token = this.tokens.find(t => t.id === tokenId);
    if (token) {
      const k = activeKey(token);
      if (k) Object.assign(k, { status: 'rate_limited', rateLimitedUntil: Date.now() + durationMs, lastError: reason || 'Rate limited' });
      if (failOverKey(token, reason)) {
        this.save();
        return true;
      }
      if (k && k.id !== activeKey(token)?.id) {
        // Parked on the key that recovers first
        this.save();
        this.unbindAccount(tokenId);
        console.warn(`[TokenPool] Account ${token.label} (${token.id}): every key is resting; next one back at ${new Date(token.rateLimitedUntil).toISOString()}.`);
        return false;
      }
      console.warn(`[TokenPool] Account ${token.label} (${token.id}) marked as rate-limited for ${durationMs / 1000}s. Reason: ${reason}`);
      token.status = 'rate_limited';
      token.rateLimitedUntil = Date.now() + durationMs;
      token.lastError = reason || 'Rate limited';
      this.save();

      this.unbindAccount(tokenId);
    }
    return false;
  }

  markTokenInvalid(tokenId, reason = '') {
    const token = this.tokens.find(t => t.id === tokenId);
    if (token) {
      const k = activeKey(token);
      if (k) Object.assign(k, { status: 'invalid', lastError: reason || 'Authentication failed or invalid token' });
      if (failOverKey(token, reason)) {
        console.error(`[TokenPool] Account ${token.label}: key rejected (${reason}); continuing on key #${keyIndex(token) + 1}.`);
        this.save();
        return true;
      }
      if (k && k.id !== activeKey(token)?.id) {
        // Other keys are only resting: the account waits for them instead of being marked invalid
        this.save();
        this.unbindAccount(tokenId);
        return false;
      }
      console.error(`[TokenPool] Account ${token.label} (${token.id}) marked as invalid! Reason: ${reason}`);
      if ((token.type || 'deepseek_web') === 'deepseek_web') {
        console.error(`[TokenPool] DeepSeek rejected the token of ${token.label}: the account was logged out or suspended. Log in again and paste a fresh userToken.`);
      }
      token.status = 'invalid';
      token.lastError = reason || 'Authentication failed or invalid token';
      this.save();
      this.unbindAccount(tokenId);
    }
    return false;
  }

  // Every key in the pool (an account with no key counts once): bounds retry loops so each key gets a try
  countKeys() {
    return this.tokens.reduce((n, t) => n + Math.max(1, t.keys?.length || 0), 0);
  }

  countAvailable() {
    const now = Date.now();
    return this.tokens.filter(t => isTokenAvailable(t, now)).length;
  }

  // Models an OpenAI-compatible key can use (GET {baseUrl}/models). Pass an account id to use its
  // stored key, or type + token (+ baseUrl) for an account that is not added yet.
  async listProviderModels({ id, type, token, baseUrl } = {}) {
    let acc = id ? this.tokens.find(t => t.id === id) : null;
    if (id && !acc) throw new Error('Account not found');
    const t = acc?.type || type;
    if (['deepseek_web', 'kimi_web'].includes(t)) throw new Error('Web accounts have a fixed model list');
    const key = acc?.token || (token || '').trim();
    const base = ((acc?.baseUrl || baseUrl || PROVIDER_PRESETS[t]?.baseUrl || '')).replace(/\/+$/, '');
    if (!key) throw new Error('Enter the API key first');
    if (!base || /ACCOUNT_ID/.test(base)) throw new Error('Set the base URL first');
    if (t === 'anthropic' || acc?.protocol === 'anthropic_messages') return listAnthropicModels({ baseUrl: base, token: key });
    const res = await upstreamFetch(`${base}/models`, {
      headers: { 'Authorization': `Bearer ${key}`, 'User-Agent': 'SE-AiProxy/1.0.0 (OpenAI-Compatible/1.0)' },
      signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status}: ${text.slice(0, 150)}`);
      err.status = res.status;
      throw err;
    }
    const json = await res.json().catch(() => ({}));
    const rows = Array.isArray(json) ? json : (json.data || json.models || []);
    const ids = rows.map(m => (typeof m === 'string' ? m : m?.id || m?.name)).filter(Boolean);
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  }

  // Count one upstream request against the active key's budget (API accounts with rpm / rpd set).
  // A key that just used its last request is rested until the window frees up.
  noteApiRequest(tokenId) {
    const t = this.tokens.find(x => x.id === tokenId);
    if (!t || !t.token || (!t.rpm && !t.rpd)) return;
    const wait = recordApiRequest(t.token, budgetOf(t));
    if (wait > 0) {
      const parts = [t.rpm ? `${t.rpm}/min` : null, t.rpd ? `${t.rpd}/day` : null].filter(Boolean).join(', ');
      this.markTokenRateLimited(t.id, wait, `Request budget reached (${parts})`);
    }
  }

  recordUsage(tokenId) {
    const token = this.tokens.find(t => t.id === tokenId);
    if (token) {
      token.totalRequests = (token.totalRequests || 0) + 1;
      token.lastUsed = Date.now();
      if (token.status === 'rate_limited' && Date.now() >= (token.rateLimitedUntil || 0)) {
        token.status = 'active';
        token.lastError = null;
      }
      const k = activeKey(token);
      if (k && k.status === 'rate_limited' && Date.now() >= (k.rateLimitedUntil || 0)) {
        k.status = 'active';
        k.lastError = null;
      }
      this.scheduleSave();
    }
  }
}

export const tokenPool = new TokenPoolManager();

configureApiBudget({ dataDir: DATA_DIR });

configurePolicy({
  settingsProvider: () => tokenPool.getSettings(),
  dataDir: DATA_DIR,
  // Budget exhausted: park the account so selection hands the conversation to another one
  onCooldown: (tokenStr, ms, reason) => {
    const acc = tokenPool.tokens.find(t => t.token === tokenStr);
    if (acc && Date.now() + ms > (acc.rateLimitedUntil || 0)) tokenPool.markTokenRateLimited(acc.id, ms, reason);
  }
});
export default tokenPool;
