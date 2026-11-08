import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

/**
 * Returns a comma-separated list of SAN entries covering:
 * - localhost and hostname (DNS)
 * - 127.0.0.1 and 0.0.0.0 (IP)
 * - All detected local IPv4 addresses (IP)
 */
export function buildSanList() {
  const ips = new Set(['127.0.0.1', '0.0.0.0', '192.168.1.6']);
  const dns = new Set(['localhost']);

  const hostname = os.hostname();
  if (hostname) {
    dns.add(hostname);
    dns.add(`${hostname}.local`);
  }

  try {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && net.address) {
          ips.add(net.address);
        }
      }
    }
  } catch (_e) {
    // Ignore network interface enumeration errors
  }

  const entries = [];
  for (const d of dns) entries.push(`DNS:${d}`);
  for (const ip of ips) entries.push(`IP:${ip}`);

  return { sanString: entries.join(','), ips: Array.from(ips) };
}

/**
 * Ensures a self-signed TLS certificate exists in data/certs/ for HTTPS support.
 * Checks that all local IPs are included in the Subject Alternative Name (SAN).
 * If any IP is missing, regenerates the cert so browsers/Electron do not throw ERR_CERT_COMMON_NAME_INVALID.
 */
export function getOrCreateTlsCertificate(dataDir) {
  const certsDir = path.join(dataDir, 'certs');
  const keyPath = path.join(certsDir, 'server.key');
  const crtPath = path.join(certsDir, 'server.crt');
  const { sanString, ips } = buildSanList();

  if (fs.existsSync(keyPath) && fs.existsSync(crtPath)) {
    try {
      const key = fs.readFileSync(keyPath, 'utf8');
      const cert = fs.readFileSync(crtPath, 'utf8');
      
      // Verify whether the existing cert contains all current local IPs in its text
      let certDetails = '';
      try {
        certDetails = execFileSync('openssl', ['x509', '-in', crtPath, '-noout', '-text'], { stdio: 'pipe' }).toString();
      } catch (_e) {
        // Fall back to simple reading
      }

      const allIpsPresent = ips.every(ip => certDetails.includes(`IP Address:${ip}`));

      if (key && cert && allIpsPresent) {
        return { key, cert, keyPath, crtPath, isNew: false };
      }
      console.log('[TLS] Existing certificate missing current IP in SAN list. Regenerating...');
    } catch (e) {
      console.warn('[TLS] Failed to verify existing certs, regenerating:', e.message);
    }
  }

  // Primary CN: prefer first non-loopback IP, else 192.168.1.6 or localhost
  const primaryIp = ips.find(ip => ip !== '127.0.0.1' && ip !== '0.0.0.0') || '192.168.1.6';

  try {
    fs.mkdirSync(certsDir, { recursive: true });
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath,
      '-out', crtPath,
      '-days', '3650',
      '-subj', `/CN=${primaryIp}/O=SE-AiProxy`,
      '-addext', `subjectAltName=${sanString}`
    ], { stdio: 'pipe' });

    const key = fs.readFileSync(keyPath, 'utf8');
    const cert = fs.readFileSync(crtPath, 'utf8');
    console.log(`[TLS] Self-signed certificate successfully generated with SAN: ${sanString}`);
    return { key, cert, keyPath, crtPath, isNew: true };
  } catch (err) {
    console.warn('[TLS] OpenSSL certificate generation not available or failed:', err.message);
    return null;
  }
}
