import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './tokenPool.js';

const DEBUG_DIR = path.join(DATA_DIR, 'debug');
const MAX_DUMPS = 30;

// Saves the raw model output of a turn the parser could not turn into text or tool calls,
// so new DeepSeek output formats can be diagnosed from data/debug/.
export function dumpUnparsedOutput(reason, { conversationKey, raw, thinking }) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const file = path.join(DEBUG_DIR, `unparsed-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
    const body = [
      `reason: ${reason}`,
      `conversation: ${conversationKey}`,
      '===== RAW CONTENT =====',
      raw || '(empty)',
      '===== THINKING =====',
      thinking || '(empty)'
    ].join('\n');
    fs.writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 });
    const dumps = fs.readdirSync(DEBUG_DIR).filter(f => f.startsWith('unparsed-')).sort();
    for (const old of dumps.slice(0, Math.max(0, dumps.length - MAX_DUMPS))) {
      fs.unlinkSync(path.join(DEBUG_DIR, old));
    }
    console.warn(`[Responses] Saved raw model output to ${file}`);
  } catch (err) {
    console.warn('[Responses] Could not save debug dump:', err.message);
  }
}
