import crypto from 'node:crypto';
import net from 'node:net';

// Constant-time string comparison (avoids leaking key prefixes through response timing)
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb) && a.length === b.length;
}

export function isLoopbackAddress(addr = '') {
  const a = String(addr).replace(/^::ffff:/, '');
  return a === '::1' || a.startsWith('127.');
}

// Hostnames/IPs that may be written into config.toml or setup scripts. Anything else
// (quotes, newlines, $, spaces...) could inject TOML sections or shell commands.
const HOSTNAME_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

export function sanitizeHost(host) {
  const raw = String(host ?? '').trim();
  const unbracketed = raw.replace(/^\[(.*)\]$/, '$1');
  if (net.isIP(unbracketed) === 6) return `[${unbracketed}]`;
  if (net.isIP(unbracketed) === 4 || HOSTNAME_RE.test(raw)) return raw;
  const err = new Error(`Invalid host: ${JSON.stringify(raw.slice(0, 80))}`);
  err.status = 400;
  throw err;
}

export function sanitizePort(port, fallback) {
  const n = Number(port);
  if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  if (fallback !== undefined) return fallback;
  const err = new Error(`Invalid port: ${port}`);
  err.status = 400;
  throw err;
}

// Host header names the dashboard may be served under. Blocks DNS-rebinding, where an
// attacker domain resolves to 127.0.0.1 and the browser treats it as same-origin.
export function isAllowedHostHeader(hostHeader, extraHosts = []) {
  if (!hostHeader) return false;
  let name = String(hostHeader).trim().toLowerCase();
  if (name.startsWith('[')) name = name.slice(1, name.indexOf(']'));
  else name = name.replace(/:\d+$/, '');
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (net.isIP(name)) return true;
  return extraHosts.map(h => h.toLowerCase()).includes(name);
}

export function parseAllowedHosts(value = process.env.ALLOWED_HOSTS) {
  return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
}

export function extractClientKey(req) {
  const direct = req.header('x-api-key');
  if (direct) return direct.trim();
  const match = /^Bearer\s+(\S+)/i.exec(req.header('authorization') || '');
  return match ? match[1] : null;
}

// Requests from a browser page on another origin. Missing Origin = CLI tool (curl, Codex).
export function isCrossOrigin(req) {
  const origin = req.header('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host.toLowerCase() !== String(req.header('host') || '').toLowerCase();
  } catch {
    return true;
  }
}

// The DeepSeek bookmarklet runs on chat.deepseek.com and may only add a DeepSeek Web token
export const BOOKMARKLET_ORIGIN = 'https://chat.deepseek.com';

/**
 * Guards the management API (/api/*):
 * - Host header must be localhost, an IP literal or listed in ALLOWED_HOSTS (anti DNS-rebinding)
 * - cross-origin browser requests are refused (anti CSRF), except the bookmarklet add-token call
 * - non-loopback clients must present the admin key (x-admin-key or Bearer)
 */
export function createAdminGuard({ getAdminKey, allowedHosts = parseAllowedHosts() }) {
  return function requireAdmin(req, res, next) {
    const deny = (status, code, message) => res.status(status).json({ error: { message, type: 'authentication_error', code } });

    if (!isAllowedHostHeader(req.header('host'), allowedHosts)) {
      return deny(403, 'host_not_allowed', 'Host header not allowed. Add this hostname to ALLOWED_HOSTS in .env to use it.');
    }

    const origin = req.header('origin');
    const bookmarkletPath = req.path === '/tokens' || req.path === '/tokens/deepseek-sync';
    if (req.method === 'OPTIONS' && origin === BOOKMARKLET_ORIGIN && bookmarkletPath) {
      res.setHeader('Access-Control-Allow-Origin', BOOKMARKLET_ORIGIN);
      res.setHeader('Access-Control-Allow-Methods', 'POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.setHeader('Vary', 'Origin');
      return res.sendStatus(204);
    }
    const isBookmarklet = origin === BOOKMARKLET_ORIGIN && req.method === 'POST' && bookmarkletPath;
    if (isCrossOrigin(req) && !isBookmarklet) {
      return deny(403, 'cross_origin_forbidden', 'Cross-origin requests to the management API are not allowed.');
    }
    if (isBookmarklet) {
      // Never let a web page choose provider type or upstream URL
      req.body = req.path === '/tokens'
        ? { token: req.body?.token, label: req.body?.label, type: 'deepseek_web' }
        : { token: req.body?.token, userAgent: req.body?.userAgent };
      res.setHeader('Access-Control-Allow-Origin', BOOKMARKLET_ORIGIN);
      res.setHeader('Vary', 'Origin');
    }

    if (isLoopbackAddress(req.socket?.remoteAddress)) return next();

    const provided = req.header('x-admin-key') || extractClientKey(req);
    if (provided && safeEqual(provided, getAdminKey())) return next();
    return deny(401, 'admin_auth_required', 'Admin key required for remote access to the management API.');
  };
}
