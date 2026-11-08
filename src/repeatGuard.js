// Cross-turn loop protection. Some models (seen with Kimi Web) re-issue the exact same tool call every
// turn, typically `cat bigfile` whose output Codex truncates: the model never sees the whole file, so it
// asks for it again forever. These helpers spot that and produce the hint that breaks the cycle.

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

export function callSignature(name, args) {
  const obj = parseArgs(args);
  const stable = {};
  for (const key of Object.keys(obj).sort()) {
    if (VOLATILE_ARGS.has(key)) continue;
    const v = obj[key];
    stable[key] = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : v;
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
export function recentToolCalls(input, limit = 6) {
  if (!Array.isArray(input)) return [];
  const outputs = new Map();
  for (const item of input) {
    if (item && OUTPUT_TYPES.has(item.type) && item.call_id) outputs.set(item.call_id, outputText(item));
  }
  const calls = [];
  for (let i = input.length - 1; i >= 0 && calls.length < limit; i--) {
    const item = input[i];
    if (!item || !CALL_TYPES.has(item.type)) continue;
    const out = outputs.get(item.call_id) || '';
    calls.push({
      name: item.name,
      signature: callSignature(item.name, argsOf(item)),
      args: parseArgs(argsOf(item)),
      truncated: TRUNCATED_RE.test(out)
    });
  }
  return calls;
}

// New calls that exactly repeat one of the last few calls already executed
export function findRepeatedCalls(newCalls, input, lookback = 4) {
  if (!Array.isArray(newCalls) || newCalls.length === 0) return [];
  const recent = recentToolCalls(input, lookback);
  if (recent.length === 0) return [];
  const repeats = [];
  for (const call of newCalls) {
    const sig = callSignature(call.name, call.arguments);
    const prev = recent.find(r => r.signature === sig);
    if (prev) repeats.push({ call, previous: prev });
  }
  return repeats;
}

function describeCall(entry) {
  const cmd = entry.args?.cmd ?? entry.args?.command ?? entry.args?.input;
  const text = Array.isArray(cmd) ? cmd.join(' ') : String(cmd ?? entry.name ?? '');
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

const READ_IN_RANGES = 'read it in smaller pieces instead, for example `sed -n \'1,800p\' FILE`, then `sed -n \'801,1600p\' FILE`, or use `grep -n PATTERN FILE` to find the relevant lines first and print only those ranges';

// Note appended to the prompt when the latest tool output was truncated or the model is repeating itself
export function loopAvoidanceNote(input) {
  const recent = recentToolCalls(input, 4);
  if (recent.length === 0) return '';
  const notes = [];
  const latest = recent[0];
  if (latest.truncated) {
    notes.push(`The output of your last command (\`${describeCall(latest)}\`) was TRUNCATED by the tool because it was too long; running the same command again will be truncated the same way. Do NOT repeat it: ${READ_IN_RANGES}.`);
  }
  const repeatCount = recent.filter(r => r.signature === latest.signature).length;
  if (repeatCount >= 2) {
    notes.push(`You have already run \`${describeCall(latest)}\` ${repeatCount} times in a row with the same result shown above. Do NOT run it again: use the output you already have and move on to the next step of the task (edit the code, build, or test).`);
  }
  return notes.length ? `\n\n[LOOP GUARD]: ${notes.join(' ')}` : '';
}

export function repeatedCallFollowUp(repeats) {
  const first = repeats[0];
  const truncated = repeats.some(r => r.previous.truncated);
  const why = truncated
    ? `Its output was truncated because it is too long, so repeating it cannot show you more. ${READ_IN_RANGES[0].toUpperCase()}${READ_IN_RANGES.slice(1)}.`
    : 'Its output is already shown above; running it again will return the same thing.';
  return `[SUPERVISOR INTERVENTION]: You just issued the exact same tool call you already ran (\`${describeCall(first.previous)}\`). ${why} Do not repeat it. Emit a DIFFERENT next tool call that makes progress on the task now (read a specific range, edit the code, build, or test). If the task is finished, write the final summary in the user's language without calling any tools.`;
}
