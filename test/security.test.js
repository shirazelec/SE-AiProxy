import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// tokenPool persists to DATA_DIR on import; keep tests away from the real data/config.json
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-proxy-security-'));

const { sanitizeHost, sanitizePort, isAllowedHostHeader, createAdminGuard, safeEqual } = await import('../src/security.js');
const { tokenPool } = await import('../src/tokenPool.js');
const { generateCodexToml } = await import('../src/codexInstaller.js');
const { isSafeImageFile } = await import('../src/vision.js');

function mockReq({ method = 'GET', path: p = '/tokens', headers = {}, remote = '127.0.0.1', body = {} } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { method, path: p, body, socket: { remoteAddress: remote }, header: name => lower[name.toLowerCase()] };
}

function mockRes() {
  const res = { statusCode: 200, headers: {}, body: null };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.sendStatus = code => { res.statusCode = code; return res; };
  return res;
}

function runGuard(guard, req) {
  const res = mockRes();
  let passed = false;
  guard(req, res, () => { passed = true; });
  return { passed, res };
}

describe('host and port sanitizing', () => {
  test('accepts hostnames and IPs', () => {
    assert.equal(sanitizeHost('192.168.1.10'), '192.168.1.10');
    assert.equal(sanitizeHost('proxy.example.com'), 'proxy.example.com');
    assert.equal(sanitizeHost('::1'), '[::1]');
  });

  test('rejects TOML / shell injection payloads', () => {
    for (const bad of ['x"\n[mcp_servers.evil]\ncommand="sh"', '$(touch /tmp/pwn)', 'a b', 'host;rm -rf ~', '`id`']) {
      assert.throws(() => sanitizeHost(bad), /Invalid host/);
    }
    assert.throws(() => generateCodexToml({ host: 'x"\nevil = 1' }), /Invalid host/);
  });

  test('ports must be integers in range', () => {
    assert.equal(sanitizePort('8080'), 8080);
    assert.equal(sanitizePort('abc', 18789), 18789);
    assert.throws(() => sanitizePort('70000'), /Invalid port/);
    assert.throws(() => sanitizePort('1;id'), /Invalid port/);
  });
});

describe('proxy key validation', () => {
  test('requires a real proxy key', () => {
    const key = tokenPool.getProxyKeys()[0].key;
    assert.equal(tokenPool.validateProxyKey(key), true);
    for (const bad of [null, '', 'test', 'not-needed', 'sk-ant-anything', key + 'x']) {
      assert.equal(tokenPool.validateProxyKey(bad), false, `accepted ${bad}`);
    }
  });

  test('ships no hardcoded upstream accounts', () => {
    assert.deepEqual(tokenPool.tokens.filter(t => t.type !== 'deepseek_web'), []);
  });

  test('config.json is owner-only', { skip: process.platform === 'win32' }, () => {
    const mode = fs.statSync(path.join(process.env.DATA_DIR, 'config.json')).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  test('safeEqual', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', undefined), false);
  });
});

describe('admin guard', () => {
  const guard = createAdminGuard({ getAdminKey: () => 'sk-admin-secret', allowedHosts: ['proxy.example.com'] });

  test('allows same-origin loopback requests', () => {
    assert.equal(runGuard(guard, mockReq({ headers: { host: '127.0.0.1:18789' } })).passed, true);
    assert.equal(runGuard(guard, mockReq({ headers: { host: 'localhost:18789', origin: 'http://localhost:18789' } })).passed, true);
  });

  test('blocks cross-origin browser requests (CSRF)', () => {
    const { passed, res } = runGuard(guard, mockReq({ headers: { host: '127.0.0.1:18789', origin: 'https://evil.example' } }));
    assert.equal(passed, false);
    assert.equal(res.statusCode, 403);
  });

  test('blocks unknown Host headers (DNS rebinding)', () => {
    const { passed, res } = runGuard(guard, mockReq({ headers: { host: 'evil.example:18789', origin: 'http://evil.example:18789' } }));
    assert.equal(passed, false);
    assert.equal(res.body.error.code, 'host_not_allowed');
    assert.equal(runGuard(guard, mockReq({ headers: { host: 'proxy.example.com' } })).passed, true);
  });

  test('remote clients need the admin key', () => {
    const remote = { remote: '10.0.0.5', headers: { host: '10.0.0.2:18789' } };
    assert.equal(runGuard(guard, mockReq(remote)).res.statusCode, 401);
    assert.equal(runGuard(guard, mockReq({ ...remote, headers: { ...remote.headers, 'x-admin-key': 'wrong' } })).passed, false);
    assert.equal(runGuard(guard, mockReq({ ...remote, headers: { ...remote.headers, 'x-admin-key': 'sk-admin-secret' } })).passed, true);
  });

  test('bookmarklet may only add a DeepSeek Web token', () => {
    const req = mockReq({
      method: 'POST',
      headers: { host: '127.0.0.1:18789', origin: 'https://chat.deepseek.com' },
      body: { token: 't', label: 'l', type: 'tokenharbor', baseUrl: 'https://evil.example' }
    });
    assert.equal(runGuard(guard, req).passed, true);
    assert.deepEqual(req.body, { token: 't', label: 'l', type: 'deepseek_web' });

    const other = mockReq({ method: 'DELETE', path: '/tokens/x', headers: { host: '127.0.0.1:18789', origin: 'https://chat.deepseek.com' } });
    assert.equal(runGuard(guard, other).passed, false);
  });
});

describe('vision file reads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-safe-'));

  test('only real image files are readable', () => {
    const png = path.join(dir, 'ok.png');
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));
    assert.equal(isSafeImageFile(png), true);

    const fakePng = path.join(dir, 'secret.png');
    fs.writeFileSync(fakePng, 'API_KEY=hunter2');
    assert.equal(isSafeImageFile(fakePng), false);

    const text = path.join(dir, 'config.json');
    fs.writeFileSync(text, '{}');
    assert.equal(isSafeImageFile(text), false);
  });
});
