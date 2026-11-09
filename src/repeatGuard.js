// Cross-turn loop protection. Some models (seen with Kimi Web & DeepSeek) re-issue the exact same tool call every
// turn, typically `cat bigfile` whose output Codex truncates, or repeatedly re-read files they already inspected.
// These helpers spot that and produce the hint that breaks the cycle, dropping redundant executions.

import { isMutatingCall } from './parser.js';

const CALL_TYPES = new Set(['function_call', 'custom_tool_call']);
const OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output', 'tool_result']);
// Arguments that do not change what the command does
const VOLATILE_ARGS = new Set(['yield_time_ms', 'max_output_tokens', 'timeout_ms', 'justification', 'sandbox_permissions']);
const TRUNCATED_RE = /Warning:\s*truncated output|original token count:\s*\d+\)|\[output truncated|…\s*\d+\s+(?:lines|tokens) truncated/i;

function parseArgs(args) {
  if (args && typeof args === 'object') return args;
  if (typeof args !== 'string') return {};
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === 'object' ? parsed : { input: args };
  } catch {
    return { input: args };
  }
}

export function normalizeCommand(cmd) {
  if (typeof cmd !== 'string') return '';
  let c = cmd.trim();
  // Strip shell prompts ($ , # , > )
  c = c.replace(/^[#$>]\s+/, '');
  // Strip leading cd ... &&
  c = c.replace(/^cd\s+["']?[^;&|]+["']?\s*&&\s*/, '');
  // Strip trailing ; echo ... or && echo ...
  c = c.replace(/(?:;|&&)\s*echo\s+["'].*?["']\s*$/, '');
  // Strip 2>/dev/null or 2>&1
  c = c.replace(/\s*2>\s*(?:\/dev\/null|&1)/g, '');
  // Strip redundant quotes around words/paths
  c = c.replace(/(["'])([\w.\/-]+)\1/g, '$2');
  // Strip known workspace directory prefix patterns if absolute
  c = c.replace(/(?:\/[a-zA-Z0-9_.-]+)+?\/(apps_soundbox|include_lib|tools|src|lib|include|test|packages|app)\//g, '$1/');
  // Strip leading ./
  c = c.replace(/(?:^|\s)\.\//g, ' ');
  // Collapse whitespace
  c = c.replace(/\s+/g, ' ').trim();
  return c;
}

export function callSignature(name, args) {
  const obj = parseArgs(args);
  const stable = {};
  for (const key of Object.keys(obj).sort()) {
    if (VOLATILE_ARGS.has(key)) continue;
    const v = obj[key];
    if (typeof v === 'string') {
      const trimmed = v.replace(/\s+/g, ' ').trim();
      stable[key] = (key === 'cmd' || key === 'command' || key === 'input') ? normalizeCommand(trimmed) : trimmed;
    } else {
      stable[key] = v;
    }
  }
  return `${name || ''}::${JSON.stringify(stable)}`;
}

function outputText(item) {
  const out = item.output ?? item.content;
  if (typeof out === 'string') return out;
  if (Array.isArray(out)) return out.map(p => (typeof p === 'string' ? p : p?.text || '')).join('');
  if (out && typeof out === 'object') return out.content || out.text || JSON.stringify(out);
  return '';
}

function argsOf(item) {
  return item.type === 'custom_tool_call' ? { input: item.input } : item.arguments;
}

// Last `limit` tool calls in the history, newest first, with whether their output was truncated
// and whether any state-mutating command occurred after them
export function recentToolCalls(input, limit = 50) {
  if (!Array.isArray(input)) return [];
  const outputs = new Map();
  for (const item of input) {
    if (item && OUTPUT_TYPES.has(item.type) && item.call_id) outputs.set(item.call_id, outputText(item));
  }
  const calls = [];
  let mutatingSeen = false;
  for (let i = input.length - 1; i >= 0 && calls.length < limit; i--) {
    const item = input[i];
    if (!item || !CALL_TYPES.has(item.type)) continue;
    const out = outputs.get(item.call_id) || '';
    const rawArgs = argsOf(item);
    const parsed = parseArgs(rawArgs);
    const callObj = { name: item.name, arguments: rawArgs, kind: item.kind };
    const mutating = mayChangeState(callObj, parsed);
    calls.push({
      name: item.name,
      signature: callSignature(item.name, rawArgs),
      args: parsed,
      truncated: TRUNCATED_RE.test(out),
      isMutating: mutating,
      followedByMutation: mutatingSeen
    });
    if (mutating) mutatingSeen = true;
  }
  return calls;
}

// Commands that run a program or let time pass can change files, processes or logs that the mutation
// regex in parser.js does not know about (`python gen.py`, `./build.sh`, `sleep 5`)
const RUNS_PROGRAM_RE = /(?:^|[;&|(\n]\s*)(?:sudo\s+)?(?:python[23]?|node|deno|bun|bash|sh|zsh|ruby|perl|php|java|go\s+run|docker|podman|systemctl\s+(?:start|stop|restart|reload)|service|kill|pkill|killall|sleep|\.{0,2}\/[\w./-]+)\b/;
// Commands whose output changes over time even when nothing in the workspace was edited
const TIME_VARYING_RE = /(?:^|[;&|(\n]\s*)(?:sudo\s+)?(?:tail|journalctl|dmesg|ps|top|htop|pgrep|pidof|uptime|date|free|df|du|ss|netstat|lsof|nvidia-smi|curl|wget|ping|nc|systemctl\s+(?:status|is-active)|docker\s+(?:ps|logs|stats)|git\s+(?:status|log|diff)|watch|sleep)\b/;

function commandOf(args) {
  const cmd = args?.cmd ?? args?.command ?? args?.input;
  return Array.isArray(cmd) ? cmd.join(' ') : typeof cmd === 'string' ? cmd : '';
}

// write_stdin with no characters only waits for more output of a running command (Codex polling)
function isPoll(name, args) {
  return /^writes?_stdin$/.test(name || '') && !(args?.chars ?? '');
}

// Calls that may legitimately be repeated with an identical signature: polls and time-varying checks
export function isObservationCall(name, args) {
  const parsed = parseArgs(args);
  return isPoll(name, parsed) || TIME_VARYING_RE.test(commandOf(parsed));
}

function mayChangeState(callObj, parsed) {
  return isMutatingCall(callObj) || RUNS_PROGRAM_RE.test(commandOf(parsed));
}

const READ_CMD_RE = /^(?:cat|head|tail|sed(?:\s+-[a-zA-Z0-9]+)*)\s+(?:['"]?)([a-zA-Z0-9_./-]+\.[a-zA-Z0-9_]+)(?:['"]?)/;

export function extractReadFiles(input) {
  const recent = recentToolCalls(input, 50);
  const files = new Set();
  for (const call of recent) {
    if (call.followedByMutation) continue;
    const cmd = call.args?.cmd ?? call.args?.command ?? call.args?.input;
    if (typeof cmd !== 'string') continue;
    const norm = normalizeCommand(cmd);
    const m = READ_CMD_RE.exec(norm);
    if (m && m[1] && !m[1].startsWith('-')) {
      files.add(m[1]);
    }
  }
  return Array.from(files);
}

// New calls that repeat one of the calls already executed in recent history
export function findRepeatedCalls(newCalls, input, lookback = 50) {
  if (!Array.isArray(newCalls) || newCalls.length === 0) return [];
  const recent = recentToolCalls(input, lookback);
  if (recent.length === 0) return [];
  const repeats = [];
  for (const call of newCalls) {
    const sig = callSignature(call.name, call.arguments);
    const prev = recent.find(r => r.signature === sig);
    if (!prev) continue;
    // Polling a running command or re-checking a log/process/status is expected to repeat
    if (isObservationCall(call.name, call.arguments)) continue;

    // If the previous output was truncated, repeating the same call will just truncate again
    if (prev.truncated) {
      repeats.push({ call, previous: prev, reason: 'truncated' });
      continue;
    }

    // If no mutation occurred since the previous call:
    // Any identical read-only call or build call produces zero new information and wastes tokens
    if (!prev.followedByMutation) {
      repeats.push({ call, previous: prev, reason: 'unmodified' });
      continue;
    }

    // Even if mutations occurred elsewhere, if the call was run in the immediate 2 calls without modification, flag it
    const veryRecent = recent.slice(0, 2).find(r => r.signature === sig);
    if (veryRecent && !veryRecent.followedByMutation) {
      repeats.push({ call, previous: veryRecent, reason: 'consecutive' });
    }
  }
  return repeats;
}

export function describeCall(entry) {
  const call = entry?.call || entry;
  const rawArgs = call?.arguments ?? call?.args;
  const parsed = typeof rawArgs === 'string' ? parseArgs(rawArgs) : (rawArgs || {});
  const cmd = parsed.cmd ?? parsed.command ?? parsed.input ?? parsed.patch;
  const text = Array.isArray(cmd) ? cmd.join(' ') : String(cmd ?? call?.name ?? '');
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

const READ_IN_RANGES = 'read it in smaller pieces instead, for example `sed -n \'1,800p\' FILE`, then `sed -n \'801,1600p\' FILE`, or use `grep -n PATTERN FILE` to find the relevant lines first and print only those ranges';

// Note appended to the prompt when the latest tool output was truncated or the model is repeating itself
export function loopAvoidanceNote(input) {
  const recent = recentToolCalls(input, 50);
  if (recent.length === 0) return '';
  const notes = [];
  const latest = recent[0];
  if (latest.truncated) {
    notes.push(`The output of your last command (\`${describeCall(latest)}\`) was TRUNCATED by the tool because it was too long; running the same command again will be truncated the same way. Do NOT repeat it: ${READ_IN_RANGES}.`);
  }
  const repeatCount = isObservationCall(latest.name, latest.args)
    ? 0
    : recent.slice(0, 4).filter(r => r.signature === latest.signature).length;
  if (repeatCount >= 2) {
    notes.push(`You have already run \`${describeCall(latest)}\` ${repeatCount} times in a row with the same result shown above. Do NOT run it again: use the output you already have and move on to the next step of the task (edit the code, build, or test).`);
  }
  const readFiles = extractReadFiles(input);
  if (readFiles.length > 0 && !latest.truncated && repeatCount < 2) {
    const list = readFiles.slice(0, 8).map(f => `\`${f}\``).join(', ');
    notes.push(`Context awareness: The contents of ${list} are already visible in your conversation history above. Do NOT run cat, head, or sed on them again unless you modified them. Proceed directly to editing code (apply_patch), building, or concluding.`);
  }
  return notes.length ? `\n\n[LOOP GUARD]: ${notes.join(' ')}` : '';
}

export function repeatedCallFollowUp(repeats) {
  const first = repeats[0];
  const truncated = repeats.some(r => r.previous.truncated);
  const why = truncated
    ? `Its output was truncated because it is too long, so repeating it cannot show you more. ${READ_IN_RANGES[0].toUpperCase()}${READ_IN_RANGES.slice(1)}.`
    : 'Its output is already visible in the conversation history above; running it again returns identical output and burns tokens.';
  return `[SUPERVISOR INTERVENTION]: You just issued the exact same tool call you already ran (\`${describeCall(first.previous)}\`). ${why} Do not repeat it. Emit a DIFFERENT next tool call that makes progress on the task now (edit code using apply_patch, compile/build, or inspect a new unread file). If the task is finished, write the final summary in the user's language without calling any tools.`;
}
