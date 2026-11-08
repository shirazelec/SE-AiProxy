import { detectRepetitionLoop, findFabricatedResult } from './parser.js';
import { beforeRequest, recordSuccess } from './webAccountPolicy.js';
import { resetKimiOverload } from './accountHealth.js';

// Cache for access tokens: refreshToken -> { accessToken, expiresAt, userId }
const tokenCache = new Map();

// Standard browser headers matching Chrome desktop
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export async function getKimiAccessToken(refreshToken, baseUrl = 'https://www.kimi.ai') {
  const cached = tokenCache.get(refreshToken);
  if (cached && Date.now() < cached.expiresAt - 60000) {
    return cached;
  }

  const cleanBase = (baseUrl || 'https://www.kimi.ai').replace(/\/+$/, '');
  const url = `${cleanBase}/api/auth/token/refresh`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${refreshToken}`,
      'User-Agent': DEFAULT_USER_AGENT,
      'Accept': 'application/json'
    }
  });

  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`Kimi Auth HTTP ${res.status}: ${errText.slice(0, 150)}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Kimi Auth failed: missing access_token in response');
  }

  let expiresAt = Date.now() + 3600 * 1000;
  let userId = '';
  try {
    const payload = JSON.parse(Buffer.from(data.access_token.split('.')[1], 'base64').toString());
    if (payload.exp) expiresAt = payload.exp * 1000;
    if (payload.sub) userId = payload.sub;
  } catch {}

  const entry = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresAt,
    userId
  };
  tokenCache.set(refreshToken, entry);
  return entry;
}

export async function createKimiChat({ accessToken, baseUrl = 'https://www.kimi.ai', name = 'Codex Session' }) {
  const cleanBase = (baseUrl || 'https://www.kimi.ai').replace(/\/+$/, '');
  const res = await fetch(`${cleanBase}/api/chat`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': DEFAULT_USER_AGENT
    },
    body: JSON.stringify({ name, is_example: false })
  });

  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`Kimi CreateChat HTTP ${res.status}: ${errText.slice(0, 150)}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  return data.id;
}

export async function deleteKimiChat({ accessToken, chatId, baseUrl = 'https://www.kimi.ai' }) {
  if (!chatId) return;
  const cleanBase = (baseUrl || 'https://www.kimi.ai').replace(/\/+$/, '');
  try {
    await fetch(`${cleanBase}/api/chat/${chatId}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'User-Agent': DEFAULT_USER_AGENT
      }
    });
  } catch {}
}

// Models offered by kimi.ai's web app (ConfigService/GetAvailableModels). Free accounts reliably get
// "Instant" (k2d6-chat, with thinking); K3 / K2.8 run in the "OK Computer" agent scenario and are often
// refused for free users with REASON_SERVER_OVERLOADED_FOR_FREE_USER.
export const KIMI_MODELS = {
  instant: { id: 'k2d6-chat', scenario: 'SCENARIO_CHAT', kimiplusId: '', effort: 'REASONING_EFFORT_LOW', label: 'Instant (thinking)' },
  k3: { id: 'k3-agent', scenario: 'SCENARIO_OK_COMPUTER', kimiplusId: 'ok-computer', effort: 'REASONING_EFFORT_HIGH', label: 'K3' },
  k28: { id: 'k28-agent-preview', scenario: 'SCENARIO_OK_COMPUTER', kimiplusId: 'ok-computer', effort: 'REASONING_EFFORT_HIGH', label: 'K2.8 Preview' }
};
export const VALID_KIMI_MODELS = ['instant', 'k2d6-chat', 'k3', 'k3-agent', 'k28', 'k28-agent-preview'];

// Maps whatever the account's model field says to a real kimi.ai model; unknown names use Instant
export function resolveKimiModel(model) {
  const m = String(model || '').toLowerCase().trim();
  if (/^(?:kimi-)?k3(?:[.\-\s]?1)?(?:[\s\-]?(?:pro|agent))?$|^(?:3\.1[\s\-]?)?pro$/.test(m)) return KIMI_MODELS.k3;
  if (/^(?:kimi-)?k2[.\-]?8(?:-agent)?(?:-preview)?$|^k28/.test(m)) return KIMI_MODELS.k28;
  return KIMI_MODELS.instant;
}

export function buildKimiChatRequest(prompt, target) {
  return {
    chatId: '',
    kimiplusId: target.kimiplusId,
    scenario: target.scenario,
    tools: [],
    message: { role: 'user', blocks: [{ messageId: '', text: { content: prompt } }], scenario: target.scenario },
    options: { thinking: true, model: target.id, reasoningEffort: target.effort }
  };
}

export async function testKimiToken(token, baseUrl = 'https://www.kimi.ai', model) {
  const t0 = Date.now();
  await getKimiAccessToken(token, baseUrl);
  const target = resolveKimiModel(model);
  return { ok: true, latencyMs: Date.now() - t0, reply: `Kimi Web Verified (OK - ${target.label})`, model: target.id };
}

// Connect-RPC envelope: 1 flag byte (2 = end-of-stream) + 4-byte big-endian length + JSON
function encodeEnvelope(obj) {
  const json = Buffer.from(JSON.stringify(obj));
  const out = Buffer.alloc(5 + json.length);
  out[0] = 0;
  out.writeUInt32BE(json.length, 1);
  json.copy(out, 5);
  return out;
}

function kimiError(errObj) {
  const debug = errObj?.details?.[0]?.debug || {};
  const reason = debug.reason || '';
  const text = debug.localizedMessage?.message || errObj?.message || errObj?.code || 'unknown error';
  const err = new Error(`Kimi ${errObj?.code || 'error'}${reason ? ` (${reason})` : ''}: ${text}`);
  err.status = { resource_exhausted: 429, unauthenticated: 401, permission_denied: 403, invalid_argument: 400, not_found: 404 }[errObj?.code] || 502;
  err.kimiReason = reason;
  return err;
}

const GATEWAY = 'apiv2/kimi.gateway.chat.v1.ChatService';

// kimi.ai gives the model its own server-side tools (an `ipython` sandbox, a shell). They run on Kimi's
// machines, not the user's, so the model "checks" the project, finds nothing and concludes it has no
// access. Such a call is intercepted and turned into an exec_command that Codex runs on the real machine.
export function kimiToolToCommand(name, rawArgs) {
  let args = {};
  try { args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : (rawArgs || {}); } catch { return null; }
  const tool = String(name || '').toLowerCase();
  if (tool === 'ipython' || tool === 'python' || tool === 'code_interpreter') {
    const code = typeof args.code === 'string' ? args.code : (typeof args.input === 'string' ? args.input : '');
    if (!code.trim()) return null;
    return `python3 - <<'KIMI_PY'\n${code.replace(/\s+$/, '')}\nKIMI_PY`;
  }
  if (tool === 'shell' || tool === 'bash' || tool === 'terminal' || tool === 'exec' || tool === 'run_command') {
    const cmd = args.command ?? args.cmd ?? args.script ?? args.input;
    const text = Array.isArray(cmd) ? cmd.join(' ') : cmd;
    return typeof text === 'string' && text.trim() ? text : null;
  }
  return null;
}

export const KIMI_ENVIRONMENT_NOTE = "[ENVIRONMENT]: You are connected to the user's real computer through Codex. Every exec_command you emit — and any code you run with your python or shell tool — is executed on the user's machine inside their project folder, so you DO have access to their files and can edit, build and run the program. Never claim that you cannot access the user's system; run the command and use its real output.";

export function execCallMarkup(cmd) {
  const value = cmd.includes(']]>') ? cmd : `<![CDATA[${cmd}]]>`;
  return `\n<tool_calls>\n<invoke name="exec_command">\n<parameter name="cmd">${value}</parameter>\n</invoke>\n</tool_calls>`;
}

export async function deleteKimiGatewayChat({ accessToken, chatId, baseUrl = 'https://www.kimi.ai' }) {
  if (!chatId) return;
  try {
    await fetch(`${baseUrl}/${GATEWAY}/DeleteChat`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'User-Agent': DEFAULT_USER_AGENT },
      body: JSON.stringify({ chatId }),
      signal: AbortSignal.timeout(15000)
    });
  } catch {}
}

// Accounts whose K3 request was refused as overloaded: skip K3 on them for a while
const premiumBlockedUntil = new Map();
const PREMIUM_RETRY_MS = 10 * 60 * 1000;

async function runKimiChat({ baseUrl, accessToken, prompt, target, signal, onChunk }) {
  const res = await fetch(`${baseUrl}/${GATEWAY}/Chat`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/connect+json',
      'Connect-Protocol-Version': '1',
      'Origin': baseUrl,
      'Referer': `${baseUrl}/`,
      'User-Agent': DEFAULT_USER_AGENT
    },
    body: encodeEnvelope(buildKimiChatRequest(prompt, target)),
    signal
  });
  if (!res.ok) {
    const text = await res.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    if (parsed?.code) throw kimiError(parsed);
    const err = new Error(`Kimi Stream HTTP ${res.status}: ${text.slice(0, 150)}`);
    err.status = res.status;
    throw err;
  }

  const reader = res.body.getReader();
  let buf = Buffer.alloc(0);
  let content = '';
  let thinkingContent = '';
  let chatId = null;
  let streamError = null;
  let stopReason = null;
  let lastRepetitionCheckLen = 0;
  let loopDetected = false;
  const toolNames = new Map(); // Kimi block id -> server-side tool name
  const startTime = Date.now();
  const MAX_STREAM_MS = 300000; // thinking can take a while before the first text arrives

  try {
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf = Buffer.concat([buf, Buffer.from(value)]);
      while (buf.length >= 5) {
        const flag = buf[0];
        const len = buf.readUInt32BE(1);
        if (buf.length < 5 + len) break;
        const frame = buf.subarray(5, 5 + len).toString('utf8');
        buf = buf.subarray(5 + len);
        let ev;
        try { ev = JSON.parse(frame); } catch { continue; }
        if (flag & 2) {
          if (ev.error) streamError = kimiError(ev.error);
          break outer;
        }
        if (ev.chat?.id && !chatId) chatId = ev.chat.id;
        // A refusal arrives as `done` followed by an end-of-stream error frame, so keep reading until flag 2
        if (ev.done) continue;
        const block = ev.block;
        if (!block) continue;
        if (block.tool) {
          if (block.tool.name) toolNames.set(block.id, block.tool.name);
          // STATUS_RUNNING carries the complete arguments: hand the call to Codex instead of Kimi's sandbox
          if (block.tool.status === 'STATUS_RUNNING' && block.tool.args) {
            const name = toolNames.get(block.id) || block.tool.name;
            const cmd = kimiToolToCommand(name, block.tool.args);
            if (cmd) {
              const markup = execCallMarkup(cmd);
              content += markup;
              onChunk?.({ type: 'response', content: markup });
              stopReason = `intercepted Kimi server-side "${name}" call; running it on the user's machine via Codex`;
              break outer;
            }
          }
          continue;
        }
        if (ev.mask === 'block.text' || ev.mask === 'block.text.content') {
          const t = block.text?.content || '';
          if (t) { content += t; onChunk?.({ type: 'response', content: t }); }
        } else if (ev.mask === 'block.think' || ev.mask === 'block.think.content') {
          const t = block.think?.content || '';
          if (t) { thinkingContent += t; onChunk?.({ type: 'thinking', content: t }); }
        }
      }

      if (Date.now() - startTime > MAX_STREAM_MS) { stopReason = 'duration limit (300s)'; break; }
      // The model started inventing the tool's output after its call: the call is complete, stop here
      if (findFabricatedResult(content) !== -1) { stopReason = 'model began writing a fake tool result'; break; }
      if (content.length > 35000) { stopReason = 'length limit (35k chars)'; break; }
      if (content.length - lastRepetitionCheckLen >= 80) {
        lastRepetitionCheckLen = content.length;
        if (detectRepetitionLoop(content)) { loopDetected = true; stopReason = 'runaway repetition loop'; break; }
      }
    }
  } finally {
    try { await reader.cancel(); } catch {}
  }
  if (stopReason) console.warn(`[Kimi Web] Halting stream: ${stopReason}.`);
  // Each turn carries the full history, so the chat is single-use; keep the user's Kimi history clean
  if (chatId) deleteKimiGatewayChat({ accessToken, chatId, baseUrl }).catch(() => {});
  if (streamError && !content) throw streamError;
  if (!content && !thinkingContent && !stopReason) {
    const err = new Error('Kimi returned an empty reply');
    err.status = 502;
    throw err;
  }
  return { ok: true, content, thinkingContent, finished: true, loopDetected };
}

export async function streamKimiChatAsResponsesChunks({ provider, prompt, signal, onChunk }) {
  const baseUrl = (provider.baseUrl || 'https://www.kimi.ai').replace(/\/+$/, '');
  const refreshToken = provider.token || provider.apiKey;
  let auth = await getKimiAccessToken(refreshToken, baseUrl);

  const wanted = resolveKimiModel(provider.model);
  const accountKey = provider.id || refreshToken;
  const targets = wanted === KIMI_MODELS.instant || Date.now() < (premiumBlockedUntil.get(accountKey) || 0)
    ? [KIMI_MODELS.instant]
    : [wanted, KIMI_MODELS.instant];

  prompt = `${KIMI_ENVIRONMENT_NOTE}\n\n${prompt}`;

  // Same anti-suspension usage policy as DeepSeek Web (pacing + per-minute/hour/day budgets)
  await beforeRequest(refreshToken, 'completion', { signal });

  let lastErr = null;
  for (const target of targets) {
    for (let authTry = 0; authTry < 2; authTry++) {
      try {
        const result = await runKimiChat({ baseUrl, accessToken: auth.accessToken, prompt, target, signal, onChunk });
        recordSuccess(refreshToken);
        resetKimiOverload();
        return result;
      } catch (err) {
        if (signal?.aborted) throw err;
        if ((err.status === 401 || err.status === 403) && authTry === 0) {
          tokenCache.delete(refreshToken);
          auth = await getKimiAccessToken(refreshToken, baseUrl);
          continue;
        }
        lastErr = err;
        // Premium model refused for this (free) account: fall back to Instant for this turn and a while after
        if (target !== KIMI_MODELS.instant && (err.status === 429 || err.status === 403 || err.status === 400)) {
          premiumBlockedUntil.set(accountKey, Date.now() + PREMIUM_RETRY_MS);
          console.warn(`[Kimi Web] ${target.label} unavailable on ${provider.label || provider.id} (${err.message}); using ${KIMI_MODELS.instant.label}.`);
          break;
        }
        throw err;
      }
    }
  }
  throw lastErr || new Error('Kimi request failed');
}
