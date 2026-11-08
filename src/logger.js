import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { fileURLToPath } from 'node:url';

// Mirrors everything written to the console into logs/proxy.log (next to the project) so a failing
// session can be sent for diagnosis. Secrets are redacted before anything reaches the file.
// The file rotates at MAX_BYTES: proxy.log -> proxy.1.log -> ... -> proxy.<KEEP>.log.

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LOG_DIR = process.env.LOG_DIR ? path.resolve(process.env.LOG_DIR) : path.join(PROJECT_ROOT, 'logs');
export const LOG_FILE = path.join(LOG_DIR, 'proxy.log');
const MAX_BYTES = (Number(process.env.LOG_MAX_MB) || 10) * 1024 * 1024;
const KEEP = Number(process.env.LOG_KEEP) || 5;

// Exact secrets (account tokens, proxy/admin keys) supplied by tokenPool, plus generic key shapes
let secretProvider = () => [];
let secretCache = { at: 0, list: [] };
export function setSecretProvider(fn) {
  secretProvider = fn;
  secretCache = { at: 0, list: [] };
}

const KEY_PATTERNS = [
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]'],
  [/\b(?:sk|thk)[-_][A-Za-z0-9_-]{8,}/g, '[REDACTED]'],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]'],
  [/\bAQ\.[0-9A-Za-z_-]{20,}/g, '[REDACTED]'],
  [/("(?:token|apiKey|api_key|authorization|x-api-key|x-admin-key|adminKey|key|userToken)"\s*:\s*")[^"]{6,}(")/gi, '$1[REDACTED]$2']
];

function knownSecrets() {
  if (Date.now() - secretCache.at > 30000) {
    try {
      secretCache = { at: Date.now(), list: secretProvider().filter(s => typeof s === 'string' && s.length >= 8) };
    } catch {
      secretCache = { at: Date.now(), list: [] };
    }
  }
  return secretCache.list;
}

export function redact(text) {
  let out = String(text);
  for (const secret of knownSecrets()) {
    if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
  }
  for (const [re, replacement] of KEY_PATTERNS) out = out.replace(re, replacement);
  return out;
}

let stream = null;
let bytes = 0;

function openStream() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  try { bytes = fs.statSync(LOG_FILE).size; } catch { bytes = 0; }
  stream = fs.createWriteStream(LOG_FILE, { flags: 'a', mode: 0o600 });
  stream.on('error', () => { stream = null; });
}

function rotate() {
  try {
    stream?.end();
    stream = null;
    for (let i = KEEP - 1; i >= 1; i--) {
      const from = path.join(LOG_DIR, `proxy.${i}.log`);
      if (fs.existsSync(from)) fs.renameSync(from, path.join(LOG_DIR, `proxy.${i + 1}.log`));
    }
    if (fs.existsSync(LOG_FILE)) fs.renameSync(LOG_FILE, path.join(LOG_DIR, 'proxy.1.log'));
  } catch {}
  openStream();
}

function writeLine(level, args) {
  try {
    if (!stream) openStream();
    const line = `${new Date().toISOString()} ${level.padEnd(5)} ${redact(util.format(...args))}\n`;
    bytes += Buffer.byteLength(line);
    stream?.write(line);
    if (bytes >= MAX_BYTES) rotate();
  } catch {}
}

let installed = false;
export function installFileLogger() {
  if (installed) return;
  installed = true;
  for (const [method, level] of [['log', 'INFO'], ['info', 'INFO'], ['warn', 'WARN'], ['error', 'ERROR']]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      writeLine(level, args);
    };
  }
  process.on('uncaughtException', (err) => {
    writeLine('FATAL', [err]);
    stream?.end();
    process.stderr.write(`${err?.stack || err}\n`);
    process.exit(1);
  });
}

// Newest log content (rotated file first, then current), capped for download
export function readRecentLogs(maxBytes = 8 * 1024 * 1024) {
  const parts = [];
  let remaining = maxBytes;
  for (const file of [LOG_FILE, path.join(LOG_DIR, 'proxy.1.log')]) {
    if (remaining <= 0 || !fs.existsSync(file)) continue;
    const size = fs.statSync(file).size;
    const take = Math.min(size, remaining);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(take);
      fs.readSync(fd, buf, 0, take, size - take);
      parts.unshift(buf.toString('utf8'));
    } finally {
      fs.closeSync(fd);
    }
    remaining -= take;
  }
  return parts.join('');
}
