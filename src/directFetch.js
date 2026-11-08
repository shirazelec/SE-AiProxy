// Direct (VPN-bypassing) HTTP for domestic providers.
//
// When the machine's default route goes through a VPN tunnel (Xray/V2Ray/WireGuard TUN), requests to
// Iranian services such as ai.chabokan.net leave through a foreign exit and often time out: the
// tunnel path drops connections while the direct link answers in milliseconds. Node cannot bind a
// socket to a network device, so for those hosts the request goes through curl --interface <dev>
// (SO_BINDTODEVICE), and falls back to the normal route if the direct link fails to connect.

import { spawn, execFileSync } from 'node:child_process';

const DIRECT_HOST_RE = /(?:^|\.)chabokan\.net$|\.ir$/i;
const TUNNEL_DEV_RE = /tun|tap|xray|v2ray|wg|utun|ppp|sing|clash|proxy/i;
const ROUTE_CACHE_MS = 60000;

let routeCache = { at: 0, dev: null };
let curlAvailable = null;

function hasCurl() {
  if (curlAvailable === null) {
    try {
      execFileSync('curl', ['--version'], { stdio: 'ignore', timeout: 3000 });
      curlAvailable = true;
    } catch {
      curlAvailable = false;
    }
  }
  return curlAvailable;
}

// Physical interface to use when the default route is a VPN tunnel; null when no bypass is needed.
export function parseDirectInterface(routeText) {
  const routes = String(routeText || '').split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('default'))
    .map(line => ({
      dev: /\bdev\s+(\S+)/.exec(line)?.[1],
      via: /\bvia\s+(\S+)/.exec(line)?.[1],
      metric: Number(/\bmetric\s+(\d+)/.exec(line)?.[1] ?? 0)
    }))
    .filter(r => r.dev)
    .sort((a, b) => a.metric - b.metric);
  if (routes.length < 2) return null;
  const primary = routes[0];
  if (!TUNNEL_DEV_RE.test(primary.dev)) return null;
  const physical = routes.find(r => r.via && !TUNNEL_DEV_RE.test(r.dev));
  return physical ? physical.dev : null;
}

export function directInterface() {
  if (process.platform !== 'linux' || process.env.DIRECT_ROUTE === '0') return null;
  const now = Date.now();
  if (now - routeCache.at < ROUTE_CACHE_MS) return routeCache.dev;
  let dev = null;
  try {
    dev = parseDirectInterface(execFileSync('ip', ['route', 'show', 'default'], { encoding: 'utf8', timeout: 3000 }));
  } catch {}
  routeCache = { at: now, dev };
  return dev;
}

export function shouldGoDirect(url) {
  try {
    return DIRECT_HOST_RE.test(new URL(url).hostname) && !!directInterface() && hasCurl();
  } catch {
    return false;
  }
}

function networkError(message, code) {
  const err = new TypeError('fetch failed');
  err.cause = Object.assign(new Error(message), { code });
  err.code = code;
  return err;
}

// Minimal fetch over curl: resolves once response headers arrive, body streams as it comes.
export function curlFetch(url, { method = 'GET', headers = {}, body, signal } = {}, dev) {
  return new Promise((resolve, reject) => {
    const args = ['-sS', '-N', '-i', '--http1.1', '--interface', dev, '--connect-timeout', '8',
      '-X', method, '-H', 'Expect:'];
    for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
    if (body != null) args.push('--data-binary', '@-');
    args.push(url);

    const child = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let settled = false;
    let headerBuf = Buffer.alloc(0);
    let controller = null;
    let stderr = '';

    const onAbort = () => {
      child.kill('SIGKILL');
      const err = new DOMException('This operation was aborted', 'AbortError');
      if (!settled) { settled = true; reject(err); } else controller?.error(err);
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const stream = new ReadableStream({
      start(c) { controller = c; },
      cancel() { child.kill('SIGKILL'); }
    });

    child.stdout.on('data', chunk => {
      if (settled) {
        try { controller.enqueue(new Uint8Array(chunk)); } catch {}
        return;
      }
      headerBuf = Buffer.concat([headerBuf, chunk]);
      // Skip interim responses (100 Continue) and keep the final header block
      while (true) {
        const end = headerBuf.indexOf('\r\n\r\n');
        if (end === -1) return;
        const head = headerBuf.subarray(0, end).toString('latin1');
        const rest = headerBuf.subarray(end + 4);
        const status = Number(/^HTTP\/[\d.]+\s+(\d{3})/.exec(head)?.[1] || 0);
        if (status >= 100 && status < 200) { headerBuf = rest; continue; }
        const resHeaders = new Headers();
        for (const line of head.split('\r\n').slice(1)) {
          const i = line.indexOf(':');
          if (i > 0) { try { resHeaders.append(line.slice(0, i).trim(), line.slice(i + 1).trim()); } catch {} }
        }
        settled = true;
        if (rest.length) controller.enqueue(new Uint8Array(rest));
        resolve(new Response(stream, { status: status || 502, headers: resHeaders }));
        return;
      }
    });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', err => {
      if (!settled) { settled = true; reject(networkError(err.message, 'ECONNREFUSED')); }
    });
    child.on('close', code => {
      signal?.removeEventListener?.('abort', onAbort);
      if (!settled) {
        settled = true;
        const timedOut = code === 28;
        reject(networkError(stderr.trim() || `curl exited with code ${code}`, timedOut ? 'ETIMEDOUT' : 'ECONNREFUSED'));
      } else if (code !== 0 && !signal?.aborted) {
        try { controller.error(networkError(stderr.trim() || `curl exited with code ${code}`, 'ECONNRESET')); } catch {}
      } else {
        try { controller.close(); } catch {}
      }
    });

    if (body != null) child.stdin.end(typeof body === 'string' ? body : Buffer.from(body));
    else child.stdin.end();
  });
}

// fetch() that sends domestic-provider requests over the direct link when a VPN owns the default route
export async function upstreamFetch(url, options = {}) {
  const dev = shouldGoDirect(url) ? directInterface() : null;
  if (!dev) return fetch(url, options);
  try {
    return await curlFetch(url, options, dev);
  } catch (err) {
    if (options.signal?.aborted || err?.name === 'AbortError') throw err;
    console.warn(`[DirectRoute] Direct request to ${new URL(url).hostname} via ${dev} failed (${err.cause?.message || err.message}); retrying through the default route.`);
    return fetch(url, options);
  }
}
