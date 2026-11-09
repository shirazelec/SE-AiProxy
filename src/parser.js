import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { isFinalDeliverableReport } from './intent.js';

export function generateId(prefix = 'call_') {
  return `${prefix}${crypto.randomBytes(12).toString('hex')}`;
}

function isDelimiterOnly(str) {
  return /^[\s\-_=*#\/\\|.,:;!?'"()\[\]{}<>~`+]+$/.test(str);
}

// Cycles built from very few distinct characters (e.g. "[0, 0, 0, 0],\n" or "    }\n") are
// almost always legitimate code/data padding, not a model hallucination loop.
function isLowDiversity(str) {
  const distinct = new Set(str.replace(/\s+/g, ''));
  return distinct.size < 6;
}

// True when the tail of `text` sits inside an open <parameter> body, i.e. the model is emitting code.
function isInsideOpenParameter(text) {
  const lastOpen = text.lastIndexOf('<parameter');
  if (lastOpen === -1) return false;
  return text.indexOf('</parameter>', lastOpen) === -1;
}

function countTrailingRepeats(window, cycleLen, maxReps) {
  const unit = window.slice(-cycleLen);
  let reps = 1;
  while (reps < maxReps) {
    const end = window.length - reps * cycleLen;
    const start = end - cycleLen;
    if (start < 0 || window.slice(start, end) !== unit) break;
    reps++;
  }
  return reps;
}

const REPETITION_WINDOW = 4000;
const PROSE_MIN_REPS = 5;
const CODE_MIN_REPS = 8;
const CODE_MIN_SPAN = 1200;

export function detectRepetitionLoop(text) {
  if (!text || text.length < 100) return false;
  const window = text.slice(-REPETITION_WINDOW);

  // 1. Repeating parameter tags inside the current UNCLOSED invoke (model stuck re-emitting arguments)
  const lastInvokeIdx = window.lastIndexOf('<invoke');
  if (lastInvokeIdx !== -1) {
    const invokeChunk = window.slice(lastInvokeIdx);
    if (!invokeChunk.includes('</invoke>')) {
      const nameCounts = {};
      // Only count parameter tags that start a line or follow a tag, so tags quoted inside code are ignored
      const nameRegex = /(?:^|>|\n)\s*<parameter\b[^>]*name="([^"]+)"/gi;
      let nm;
      while ((nm = nameRegex.exec(invokeChunk)) !== null) {
        nameCounts[nm[1]] = (nameCounts[nm[1]] || 0) + 1;
        if (nameCounts[nm[1]] >= 4) {
          return true;
        }
      }
    }
  }

  // 2. Runaway phrase loops. Prose needs 5 identical consecutive cycles; inside a tool parameter
  //    (source code) legitimately repeated blocks are common, so demand far more evidence there.
  const inCode = isInsideOpenParameter(window);
  const minReps = inCode ? CODE_MIN_REPS : PROSE_MIN_REPS;
  const minSpan = inCode ? CODE_MIN_SPAN : 0;

  for (let cycleLen = 20; cycleLen <= 300; cycleLen++) {
    const requiredReps = Math.max(minReps, Math.ceil(minSpan / cycleLen));
    if (window.length < cycleLen * requiredReps) {
      if (window.length < cycleLen * minReps) break;
      continue;
    }
    const unit = window.slice(-cycleLen);
    if (isDelimiterOnly(unit) || isLowDiversity(unit)) continue;
    if (countTrailingRepeats(window, cycleLen, requiredReps) >= requiredReps) {
      return true;
    }
  }

  return false;
}

export function normalizeToolCallMarkup(content) {
  if (!content) return '';
  let s = content
    .replace(/＜/g, '<')
    .replace(/＞/g, '>')
    .replace(/<([/]?)[\s|｜_]*DSML[\s|｜_:.]*(calls?|calles|call_calls?|call_tools?|tool_calls?|tools?|toolcalls?|tool_call|tool|invoke|parameter|exec_commands?|writes?_stdin|apply_patch(?:es)?|view_images?)\b/gi, (_m, slash, tag) => {
      const lower = tag.toLowerCase();
      const normalizedTag = ['calls', 'call', 'calles', 'call_calls', 'call_tool', 'call_tools', 'tools', 'tool', 'toolcalls', 'tool_call', 'tools_call', 'calltools', 'use_tool'].includes(lower) ? 'tool_calls' : lower;
      return `<${slash}${normalizedTag}`;
    })
    .replace(/<\/?\s*[^>]*?DSML[^>]*?>/gi, '')
    .replace(/\|{1,2}_*DSML_*\|{1,2}/gi, '')
    .replace(/<\/?[\s|｜_]*DSML\b[^>]*>/gi, '')
    .replace(/<\/?[\s|｜_]*DSML[\s|｜_]*(?:>|\n|$)/gi, '')
    // Direct invocation with assignment or DSML remnants: <invoke="name">, <function="name">, <call="name">, <tool="name">
    .replace(/<(?:invoke|function|call|tool)=\s*["']?([\w.\-]+)["']?\s*>/gi, '<invoke name="$1">')
    .replace(/<parameter=\s*["']?([\w.\-]+)["']?\s*>/gi, '<parameter name="$1">');

  // A named <tool_call name="x"> / <function name="x"> / <call name="x"> is an invocation, not a wrapper.
  // Must run before wrapper normalization, which would otherwise drop the name and lose the call.
  for (const tag of ['tool_call', 'function', 'call', 'tool', 'call_tool', 'call_function', 'use_tool', 'tool_invoke', 'inv', 'invocation']) {
    const openRe = new RegExp(`<${tag}\\s+name=`, 'gi');
    if (openRe.test(s)) {
      s = s.replace(openRe, '<invoke name=').replace(new RegExp(`</${tag}>`, 'gi'), '</invoke>');
    }
  }
  for (const tag of ['コール', 'ツール', '调用', '工具']) {
    const openRe = new RegExp(`<${tag}\\s+name=`, 'gi');
    if (openRe.test(s)) {
      s = s.replace(openRe, '<invoke name=').replace(new RegExp(`</${tag}>`, 'gi'), '</invoke>');
    }
  }
  if (/<invoke\b/i.test(s)) s = s.replace(/<\/(?:function|call|tool)>/gi, '</invoke>');

  // Tool name with a "tool" prefix: <tool_exec_command>, <tool:exec_command>, <tools.apply_patch>
  s = s.replace(/<(\/?)tools?[_:.\-]+(exec_commands?|writes?_stdin|apply_patch(?:es)?|view_images?|bash|shell|sh|terminal|run_commands?|execute_commands?)\b/gi, '<$1$2');

  // <exec_command> without <parameter> children: the command sits in a <cmd>/<command> child,
  // a cmd="..." attribute, or is the bare body. Otherwise the call is dropped as "no cmd" and the
  // raw tag leaks into the reply Codex shows.
  s = s.replace(/<(?:exec_commands?|bash|shell|sh|terminal|run_commands?|execute_commands?)\b([^>]*)>([\s\S]*?)<\/(?:exec_commands?|bash|shell|sh|terminal|run_commands?|execute_commands?)>/gi, (m, attrs, body) => {
    if (/<parameter\b/i.test(body)) return `<invoke name="exec_command">${body}</invoke>`;
    const attr = attrs.match(/\b(?:cmd|command|input)\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    const child = body.match(/<(cmd|command|input)\b[^>]*>([\s\S]*?)<\/\1>/i);
    // Inside an attribute quotes have to be escaped, so decode them even next to a bare `&&`
    const decodeAttr = v => v.replace(/&quot;/g, '"').replace(/&(?:apos|#39);/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const cmd = (attr ? decodeAttr(attr[1] ?? attr[2]) : child ? child[2] : body).trim();
    if (!cmd || /<[a-z_]+\b[^>]*>/i.test(cmd)) return m;
    return `<invoke name="exec_command"><parameter name="cmd" string="true">${cmd}</parameter></invoke>`;
  });

  // Handle <invoke name="exec_command" cmd="..."> or command="..."
  s = s.replace(/<invoke\s+name=["']?exec_commands?["']?\s+(?:cmd|command|input)=["']([^"']+)["'][^>]*>/gi, '<invoke name="exec_command"><parameter name="cmd">$1</parameter>');

  // Direct tool name invocations: <write_stdin> / <writes_stdin> / <exec_command> / <apply_patch> / <view_image> / <bash> / <shell>
  s = s
    .replace(/<writes?_stdin\b[^>]*>/gi, '<invoke name="write_stdin">')
    .replace(/<\/writes?_stdin>/gi, '</invoke>')
    .replace(/<(?:exec_commands?|bash|shell|sh|terminal|run_commands?|execute_commands?)\b[^>]*>/gi, '<invoke name="exec_command">')
    .replace(/<\/(?:exec_commands?|bash|shell|sh|terminal|run_commands?|execute_commands?)>/gi, '</invoke>')
    .replace(/<(?:apply_patch(?:es)?|patch|diff|apply_diff)\b[^>]*>/gi, '<invoke name="apply_patch">')
    .replace(/<\/(?:apply_patch(?:es)?|patch|diff|apply_diff)>/gi, '</invoke>')
    .replace(/<view_images?\b[^>]*>/gi, '<invoke name="view_image">')
    .replace(/<\/view_images?>/gi, '</invoke>');

  s = s
    .replace(/<\/?(?:tool_calls?|tools?_calls?|call_tools?|calls?_tools?|toolcalls?|calltools?|calls?|calles|call_calls?|use_tools?|tool_invokes?|tools?|inv[\s_-]*calls?|invoke[\s_-]*calls?|invocation[\s_-]*calls?|invocations?)\b[^>]*>/gi, (m) => m.startsWith('</') ? '</tool_calls>' : '<tool_calls>')
    .replace(/<\/?(?:コール|ツール|调用|工具)[^>]*>/gi, (m) => m.startsWith('</') ? '</tool_calls>' : '<tool_calls>')
    .replace(/<tool_calls>\s*<\/tool_calls>/gi, '')
    // Fix merged closing/opening tag like </parameter name="..." -> </parameter><parameter name="..."
    .replace(/<\/parameter\s+name=/gi, '</parameter><parameter name=');

  // Fix second unslashed <tool_calls> tag if the first one was never closed
  const firstWrapper = s.indexOf('<tool_calls>');
  if (firstWrapper !== -1) {
    const firstClose = s.indexOf('</tool_calls>', firstWrapper);
    const secondWrapper = s.indexOf('<tool_calls>', firstWrapper + 12);
    if (secondWrapper !== -1 && (firstClose === -1 || firstClose > secondWrapper)) {
      s = s.slice(0, secondWrapper) + '</tool_calls>' + s.slice(secondWrapper + 12);
    }
  }

  // If there are parameter tags or closing </invoke> without an opening <invoke, synthesize invoke
  if (!/<invoke\b/i.test(s)) {
    if (/<parameter\s+name=["']?(?:session_id|chars)\b/i.test(s)) {
      s = (/<tool_calls>/i.test(s) ? s.replace(/<tool_calls>\s*/i, '<tool_calls><invoke name="write_stdin">') : '<tool_calls><invoke name="write_stdin">' + s);
    } else if (/<parameter\s+name=["']?path\b/i.test(s)) {
      s = (/<tool_calls>/i.test(s) ? s.replace(/<tool_calls>\s*/i, '<tool_calls><invoke name="view_image">') : '<tool_calls><invoke name="view_image">' + s);
    } else if (/<parameter\s+name=["']?patch\b/i.test(s)) {
      s = (/<tool_calls>/i.test(s) ? s.replace(/<tool_calls>\s*/i, '<tool_calls><invoke name="apply_patch">') : '<tool_calls><invoke name="apply_patch">' + s);
    } else if (/<parameter\s+name=["']?cmd\b/i.test(s) || /<\/invoke>/i.test(s)) {
      s = (/<tool_calls>/i.test(s) ? s.replace(/<tool_calls>\s*/i, '<tool_calls><invoke name="exec_command">') : '<tool_calls><invoke name="exec_command">' + s);
    }
  }

  // Auto-close unclosed <invoke> if it reaches end of text
  const lastInvokeOpen = s.lastIndexOf('<invoke');
  if (lastInvokeOpen !== -1) {
    const lastInvokeClose = s.lastIndexOf('</invoke>');
    if (lastInvokeClose < lastInvokeOpen) {
      s += '</invoke></tool_calls>';
    }
  }

  s = s
    .replace(/<\/?\s*[^>]*?DSML[^>]*?>/gi, '')
    .replace(/\|{1,2}_*DSML_*\|{1,2}/gi, '');

  return s;
}

const XML_ENTITY_RE = /&(?:lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi;
const NAMED_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

// Some models (Gemini in particular) XML-escape parameter bodies: `cat &lt;&lt;EOF &gt; f`,
// `make &amp;&amp; ctest`. Bash then fails with "syntax error near unexpected token `;&'".
// Decode only when the value is consistently escaped (every '&' starts an entity), so a command
// that genuinely contains a literal "&amp;" next to raw '&&' is left as written.
export function decodeXmlEntities(val) {
  if (typeof val !== 'string') return val;
  const cdata = /^<!\[CDATA\[([\s\S]*)\]\]>$/.exec(val);
  if (cdata) return cdata[1];
  if (!val.includes('&')) return val;
  const entities = (val.match(XML_ENTITY_RE) || []).length;
  if (entities === 0 || entities !== (val.match(/&/g) || []).length) return val;
  return val.replace(XML_ENTITY_RE, (entity) => {
    const body = entity.slice(1, -1).toLowerCase();
    if (body.startsWith('#x')) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return NAMED_ENTITIES[body];
  });
}

// Attribute values a well-formed <parameter> tag uses for its type hints
const PARAM_TYPE_WORDS = /^(?:true|false|string|number|integer|int|float|boolean|bool|object|array|json|text)$/i;

// Lenient <parameter> parsing. Besides the clean form it accepts what weaker models (seen with Kimi) emit:
//   <parameter name="cmd" type="string"wc -l f</parameter>        (missing `>`)
//   <parameter name="cmd" type="string"<|sep|>ls</parameter>       (junk token instead of `>`)
//   <parameter name="cmd" string="awk '...' f</parameter>          (value stuffed into the attribute)
//   <parameter name="cmd">ls                                        (no closing tag at the end of the reply)
function parseParams(body) {
  const args = {};
  const starts = [];
  const startRe = /<parameter\b/g;
  let m;
  while ((m = startRe.exec(body)) !== null) starts.push(m.index);

  for (let k = 0; k < starts.length; k++) {
    const from = starts[k] + '<parameter'.length;
    const nextStart = k + 1 < starts.length ? starts[k + 1] : body.length;
    const closeIdx = body.indexOf('</parameter>', from);
    const invokeEnd = body.indexOf('</invoke>', from);
    let end = nextStart;
    if (closeIdx !== -1 && closeIdx < end) end = closeIdx;
    if (invokeEnd !== -1 && invokeEnd < end) end = invokeEnd;
    const seg = body.slice(from, end);

    const attrs = {};
    let pos = 0;
    let value = null;
    const attrRe = /^\s*([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/;
    while (pos < seg.length) {
      const am = attrRe.exec(seg.slice(pos));
      if (!am) break;
      const key = am[1].toLowerCase();
      const val = am[2] ?? am[3] ?? am[4] ?? '';
      if ((key === 'string' || key === 'type' || key === 'value') && !PARAM_TYPE_WORDS.test(val) && key !== 'name') {
        // The "attribute" is really the value whose quote was never closed (or contains quotes itself)
        const q = seg.indexOf('"', pos);
        value = seg.slice(q + 1).replace(/"\s*>?\s*$/, '');
        break;
      }
      attrs[key] = val;
      pos += am[0].length;
    }
    if (value === null) {
      const rest = seg.slice(pos);
      const unterminated = /^\s*(?:string|type|value)\s*=\s*"/.exec(rest);
      value = unterminated
        ? rest.slice(unterminated[0].length)
        : rest.replace(/^\s*(?:"|'|<\|[^|>]*\|>|\|)*\s*>?/, '');
    }

    let pName = attrs.name || attrs.parameter || null;
    if (!pName) {
      if (starts.length === 1 && !args.cmd && value) {
        value = value.replace(/<\|(?:close|end|im_end|eot_id|tool_call_end|tool_calls_end)\|>[\s\S]*$/, '');
        const val = decodeXmlEntities(value.trim());
        if (val) args.cmd = val;
      }
      continue;
    }
    // Kimi's native special tokens sometimes leak after the value: `ls<|close|>argument<|sep|><|close|>call`
    value = value.replace(/<\|(?:close|end|im_end|eot_id|tool_call_end|tool_calls_end)\|>[\s\S]*$/, '');
    let val = decodeXmlEntities(value.trim());
    // Normalize common command parameter names to cmd
    if (['command', 'cmd', 'input', 'code', 'script'].includes(pName.toLowerCase())) {
      if (!args.cmd && val) args.cmd = val;
    }
    // Keep first non-empty value; ignore subsequent repetitive loop hallucinations
    if (args[pName] !== undefined && args[pName] !== '') continue;
    if (attrs.string === 'false') {
      try { val = JSON.parse(val); } catch {}
    }
    args[pName] = val;
  }
  return args;
}

let lastReferencedImagePath = '';
let lastSeenSessionId = null;

export function getLastReferencedImagePath() {
  return lastReferencedImagePath;
}

export function getLastSeenSessionId() {
  return lastSeenSessionId;
}

export function formatToolOutput(output) {
  if (output == null) return '';
  if (typeof output === 'string') {
    const sessMatch = /Process running with session ID (\d+)/i.exec(output);
    if (sessMatch) {
      lastSeenSessionId = parseInt(sessMatch[1]);
    }
    if (output.includes('data:image/') && output.length > 300) {
      return output.replace(/data:image\/[a-zA-Z0-9.+_-]+;base64,[A-Za-z0-9+/=\s]+/g, '[IMAGE_RAW_BINARY_OMITTED]');
    }
    return output;
  }
  if (Array.isArray(output)) {
    const cleaned = output.map(item => {
      if (item && (item.type === 'input_image' || item.image_url)) {
        return {
          type: 'input_image',
          status: 'image_captured',
          note: 'Raw base64 data omitted for efficiency. You are a text-only model; inspect the local image file via python scripts or ask the user for schematic specifics.'
        };
      }
      return item;
    });
    return JSON.stringify(cleaned, null, 2);
  }
  if (typeof output === 'object') {
    const jsonStr = JSON.stringify(output);
    const sessMatch = /Process running with session ID (\d+)/i.exec(jsonStr);
    if (sessMatch) {
      lastSeenSessionId = parseInt(sessMatch[1]);
    }
    if (jsonStr.includes('data:image/') && jsonStr.length > 300) {
      return jsonStr.replace(/data:image\/[a-zA-Z0-9.+_-]+;base64,[A-Za-z0-9+/=\s]+/g, '[IMAGE_RAW_BINARY_OMITTED]');
    }
    return jsonStr;
  }
  return String(output);
}

const INTEGER_ARGS = new Set(['session_id', 'yield_time_ms', 'max_output_tokens', 'timeout_ms', 'timeout']);
const BOOLEAN_ARGS = new Set(['tty', 'login']);
const SANDBOX_VALUES = new Set(['use_default', 'require_escalated']);

// DeepSeek emits every parameter as text; Codex deserializes strictly, so restore numbers/booleans
function coerceArgTypes(args) {
  for (const key of Object.keys(args)) {
    const val = args[key];
    if (typeof val !== 'string') continue;
    const trimmed = val.trim();
    if (INTEGER_ARGS.has(key) && /^-?\d+$/.test(trimmed)) {
      args[key] = parseInt(trimmed, 10);
    } else if (BOOLEAN_ARGS.has(key) && /^(?:true|false)$/i.test(trimmed)) {
      args[key] = trimmed.toLowerCase() === 'true';
    }
  }
  return args;
}

function sanitizeSandboxPermissions(args) {
  if (args.sandbox_permissions === undefined) return;
  const raw = String(args.sandbox_permissions).trim().toLowerCase().replace(/[\s-]+/g, '_');
  const normalized = raw === 'escalated' || raw === 'require_escalation' ? 'require_escalated' : raw;
  if (!SANDBOX_VALUES.has(normalized)) {
    console.warn(`[Parser] Dropping unknown sandbox_permissions value: '${args.sandbox_permissions}'`);
    delete args.sandbox_permissions;
    return;
  }
  // Preserve an explicit escalation request (network/build tasks); Codex asks the user to approve it
  args.sandbox_permissions = normalized;
  if (normalized === 'require_escalated' && (typeof args.justification !== 'string' || !args.justification.trim())) {
    args.justification = 'This command needs access outside the default sandbox (e.g. network or system paths) to complete the task.';
  }
}

function isValidImagePath(p) {
  if (!p || typeof p !== 'string') return false;
  const clean = p.trim();
  if (/^(?:\/absolute\/path|\/path\/to|example|sample|test)\./i.test(clean)) return false;
  if (clean.includes('<') || clean.includes('>')) return false;
  try {
    return fs.existsSync(clean);
  } catch {
    return false;
  }
}

// A parameter whose closing tag the model forgot runs on into the markup after it
const LEAKED_CLOSING_TAGS_RE = /(?:\s*<\/(?:tool_calls?|invoke|parameter|function_calls?|calls?)>)+\s*$/i;

function sanitizeToolArgs(args, fnName = '') {
  if (!args || typeof args !== 'object') return args;
  for (const key of Object.keys(args)) {
    if (typeof args[key] === 'string' && LEAKED_CLOSING_TAGS_RE.test(args[key])) {
      args[key] = args[key].replace(LEAKED_CLOSING_TAGS_RE, '');
      if (key !== 'cmd' && key !== 'patch' && key !== 'input') args[key] = args[key].trim();
    }
  }
  const isShell = fnName === 'exec_command' || /^(?:bash|shell|sh|terminal|run_command|execute_command|cmd)$/i.test(fnName);
  if (isShell && !args.cmd) {
    args.cmd = args.command || args.input || args.code || args.script || args.action || args.value || '';
  }
  if (isShell && typeof args.cmd === 'string') {
    const trimmedCmd = args.cmd.trim();
    if (/^<\/?(?:parameter|invoke|tool_calls?|action|tool|inv)\b/i.test(trimmedCmd) || /^<[a-zA-Z_][\w-]*(?:\s+[^>]*)?$/.test(trimmedCmd)) {
      console.warn(`[Parser] Intercepted broken XML tag in cmd argument: '${trimmedCmd}'. Stripping.`);
      delete args.cmd;
    }
  }
  const isPatch = fnName === 'apply_patch' || /^(?:patch|diff|apply_diff)$/i.test(fnName);
  if (isPatch && !args.patch) {
    args.patch = args.content || args.input || args.diff || '';
  }
  coerceArgTypes(args);
  sanitizeSandboxPermissions(args);
  if (typeof args.workdir === 'string') {
    const wd = args.workdir.trim().toLowerCase();
    if (wd === '/tmp' || wd === '/temp' || wd.startsWith('/tmp/') || wd.startsWith('/temp/')) {
      console.warn(`[Parser] Intercepted invalid workdir: '${args.workdir}'. Stripping to keep execution within project workspace root.`);
      delete args.workdir;
    }
  }

  // Auto-fill path for view_image if model emitted empty arguments with an actual valid image on disk
  if (fnName === 'view_image') {
    if (!args.path && lastReferencedImagePath && isValidImagePath(lastReferencedImagePath)) {
      console.log(`[Parser] Auto-filling missing 'path' for view_image with last seen image: ${lastReferencedImagePath}`);
      args.path = lastReferencedImagePath;
    }
  }

  // Auto-fill session_id for write_stdin if model called it without session_id
  if (fnName === 'write_stdin') {
    if (!args.session_id && lastSeenSessionId) {
      console.log(`[Parser] Auto-filling missing 'session_id' (${lastSeenSessionId}) for write_stdin`);
      args.session_id = lastSeenSessionId;
    }
    if (typeof args.chars !== 'string') {
      args.chars = '';
    }
  }

  // Auto-inject wheel find-links for offline pip install (if local wheels cache exists)
  if (fnName === 'exec_command' && args.cmd && /\bpip\s+install\b/i.test(args.cmd)) {
    if (!args.cmd.includes('--find-links')) {
      const wheelsDir = path.join(os.homedir(), '.cache', 'pip', 'wheels');
      if (fs.existsSync(wheelsDir)) {
        args.cmd = args.cmd.replace(/\bpip\s+install\b/gi, `pip install --find-links "${wheelsDir}"`);
        console.log(`[Parser] Auto-injected local wheel find-links for offline pip install.`);
      }
    }
  }

  // Extend yield_time_ms for long build or download commands so they don't prematurely background
  if (fnName === 'exec_command' && args.cmd) {
    if (/(?:pio|platformio|npm|cargo|pip|cmake|make|gradle|git clone)\b/i.test(args.cmd)) {
      if (!args.yield_time_ms || args.yield_time_ms < 60000) {
        console.log(`[Parser] Extending yield_time_ms to 60s for build/download command: ${args.cmd.slice(0, 35)}...`);
        args.yield_time_ms = 60000;
      }
    }
  }

  // Remove empty justification to avoid Codex sandbox_permissions validation error
  if (args.justification === '' || !args.justification) {
    delete args.justification;
  }

  return args;
}

// Matches both the real Codex format ("*** Begin Patch") and the legacy "*** Begin Patch ***"
const PATCH_BLOCK_RE = /\*\*\* Begin Patch(?: \*\*\*)?[\s\S]*?(?:\*\*\* End Patch(?: \*\*\*)?|$)/;
const PATCH_BEGIN_RE = /\*\*\* Begin Patch(?: \*\*\*)?/;

function extractPatch(text) {
  const m = PATCH_BLOCK_RE.exec(text || '');
  if (!m) return null;
  let patch = m[0].replace(/^\*\*\* Begin Patch \*\*\*/, '*** Begin Patch');
  patch = patch.replace(/\*\*\* End Patch \*\*\*$/, '*** End Patch');
  if (!/\*\*\* End Patch$/.test(patch)) patch = patch.replace(/\s*$/, '\n*** End Patch');
  return patch;
}

// Pulls every top-level {...} object out of text, respecting strings and escapes
function extractJsonObjects(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < (text || '').length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0) {
        try { out.push(JSON.parse(text.slice(start, i + 1))); } catch {}
      }
    }
  }
  return out;
}

export function parseRelaxedObject(str) {
  let s = (str || '').trim();
  if (s.startsWith('{') && s.endsWith('}')) s = s.slice(1, -1).trim();
  const result = {};
  const re = /(?:^|,)\s*"?([a-zA-Z0-9_]+)"?\s*:\s*(?:"((?:[^"\\]|\\.)*)"|([0-9]+)|true|false)/g;
  let match;
  while ((match = re.exec(s)) !== null) {
    const key = match[1];
    if (match[2] !== undefined) {
      result[key] = match[2];
    } else if (match[3] !== undefined) {
      result[key] = Number(match[3]);
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

// Recovers {"cmd": "..."} even if inner unescaped quotes or trailing truncation break standard JSON.parse
export function tryParseOrRecoverCmd(str) {
  if (!str) return null;
  const trimmed = str.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const relaxed = parseRelaxedObject(trimmed);
    if (relaxed) {
      if (relaxed.exec_command && !relaxed.cmd) relaxed.cmd = relaxed.exec_command;
      return relaxed;
    }
    const cmdMatch = /^\{"?cmd"?\s*:\s*"([\s\S]*)"\s*\}?$/.exec(trimmed);
    if (cmdMatch) return { cmd: cmdMatch[1] };
    const prefixMatch = /^\{"?cmd"?\s*:\s*"?([\s\S]*?)"?\s*\}?$/.exec(trimmed);
    if (prefixMatch) return { cmd: prefixMatch[1] };
  }
  return null;
}

export const KNOWN_TOOL_NAMES = new Set([
  'exec_command',
  'execute_command',
  'run_command',
  'apply_patch',
  'apply_patches',
  'patch',
  'write_stdin',
  'stdin',
  'view_image',
  'view_images',
  'read_file',
  'edit_file',
  'write_file'
]);

export function normalizeToolName(name) {
  const lower = (name || '').trim().toLowerCase();
  if (['exec_command', 'exec', 'execute_command', 'run_command', 'bash', 'sh'].includes(lower)) return 'exec_command';
  if (['apply_patch', 'apply_patches', 'patch', 'patch_file'].includes(lower)) return 'apply_patch';
  if (['write_stdin', 'stdin'].includes(lower)) return 'write_stdin';
  if (['view_image', 'view_images', 'image_view'].includes(lower)) return 'view_image';
  return (name || '').trim();
}

function tryParsePartialJson(str) {
  let s = (str || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/^\[\s*/, '');
  for (const suffix of ['', '"', '"}', '"}}', '"}]', '"]}', '}', '}]', '}}', '"}}}', '}}}']) {
    try {
      const candidate = s + suffix;
      try {
        const obj = JSON.parse(candidate);
        if (obj && typeof obj === 'object') return obj;
      } catch {
        const sanitized = candidate.replace(/\\([^"\\\/bfnrtu])/g, '\\\\$1');
        const obj = JSON.parse(sanitized);
        if (obj && typeof obj === 'object') return obj;
      }
    } catch {}
  }
  return null;
}

function extractRawJsonToolCalls(text) {
  const calls = [];
  const rawRanges = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < (text || '').length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        const rawJson = text.slice(start, i + 1);
        try {
          let parsed;
          try {
            parsed = JSON.parse(rawJson);
          } catch {
            try {
              const sanitized = rawJson.replace(/\\([^"\\\/bfnrtu])/g, '\\\\$1');
              parsed = JSON.parse(sanitized);
            } catch {
              parsed = parseRelaxedObject(rawJson);
            }
          }
          if (!parsed || typeof parsed !== 'object') continue;
          if (parsed.exec_command && !parsed.cmd) parsed.cmd = parsed.exec_command;
          const fn = parsed.function && typeof parsed.function === 'object' ? parsed.function : parsed;
          let rawName = fn.name || parsed.tool || parsed.tool_name;
          if (!rawName) {
            if (typeof parsed.cmd === 'string' || typeof parsed.command === 'string' || typeof parsed.exec_command === 'string') rawName = 'exec_command';
            else if (typeof parsed.patch === 'string' || typeof parsed.diff === 'string') rawName = 'apply_patch';
          }
          if (typeof rawName === 'string' && rawName.trim()) {
            const name = normalizeToolName(rawName);
            if (KNOWN_TOOL_NAMES.has(name) || KNOWN_TOOL_NAMES.has(rawName.trim().toLowerCase())) {
              const call = jsonToolCall(parsed);
              if (call) {
                // Range expansion backwards to include optional [ or markdown fences
                let rangeStart = start;
                while (rangeStart > 0 && /[\s\n\r]/.test(text[rangeStart - 1])) rangeStart--;
                if (rangeStart > 0 && text[rangeStart - 1] === '[') {
                  rangeStart--;
                  while (rangeStart > 0 && /[\s\n\r]/.test(text[rangeStart - 1])) rangeStart--;
                }
                const beforeFence = text.slice(Math.max(0, rangeStart - 10), rangeStart);
                const fenceMatch = /```(?:json)?\s*$/i.exec(beforeFence);
                if (fenceMatch) {
                  rangeStart -= fenceMatch[0].length;
                }

                // Range expansion forwards to include optional ] or markdown fences
                let rangeEnd = i + 1;
                while (rangeEnd < text.length && /[\s\n\r]/.test(text[rangeEnd])) rangeEnd++;
                if (rangeEnd < text.length && text[rangeEnd] === ']') {
                  rangeEnd++;
                  while (rangeEnd < text.length && /[\s\n\r]/.test(text[rangeEnd])) rangeEnd++;
                }
                if (text.slice(rangeEnd, rangeEnd + 3) === '```') {
                  rangeEnd += 3;
                }

                rawRanges.push({ start: rangeStart, end: rangeEnd });
                calls.push(call);
              }
            }
          }
        } catch {}
      }
    }
  }

  // Merge overlapping or adjacent ranges
  const mergedRanges = [];
  for (const r of rawRanges.sort((a, b) => a.start - b.start)) {
    if (mergedRanges.length === 0) {
      mergedRanges.push({ start: r.start, end: r.end });
    } else {
      const prev = mergedRanges[mergedRanges.length - 1];
      if (r.start <= prev.end) {
        prev.end = Math.max(prev.end, r.end);
      } else {
        mergedRanges.push({ start: r.start, end: r.end });
      }
    }
  }

  // Strip matched ranges from back to front
  let clean = text;
  for (let i = mergedRanges.length - 1; i >= 0; i--) {
    clean = clean.slice(0, mergedRanges[i].start) + clean.slice(mergedRanges[i].end);
  }

  // Check for trailing dangling partial tool call at the end of clean (e.g. truncated {"cmd": "..."})
  const trailingPrefixRe = /(?:```(?:json)?\s*)?(?:\[\s*)?\{\s*"?\b(?:name|function|tool|tool_name|cmd|command|exec_command)\b"?\s*:[\s\S]*$/i;
  const trailingMatch = trailingPrefixRe.exec(clean);
  if (trailingMatch) {
    if (calls.length === 0) {
      const partialObj = tryParsePartialJson(trailingMatch[0]);
      if (partialObj) {
        const call = jsonToolCall(partialObj);
        if (call) calls.push(call);
      }
    }
    clean = clean.slice(0, trailingMatch.index);
  }

  return { calls, clean: clean.trim() };
}

function jsonToolCall(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const fn = obj.function && typeof obj.function === 'object' ? obj.function : obj;
  let rawName = fn.name || obj.tool || obj.tool_name;
  if (!rawName) {
    if (typeof obj.cmd === 'string' || typeof obj.command === 'string' || typeof obj.exec_command === 'string') rawName = 'exec_command';
    else if (typeof obj.patch === 'string' || typeof obj.diff === 'string') rawName = 'apply_patch';
  }
  if (typeof rawName !== 'string' || !rawName.trim()) return null;
  const name = normalizeToolName(rawName);
  let args = fn.arguments ?? fn.parameters ?? fn.input ?? fn.args ?? null;
  if (args == null || (typeof args === 'object' && Object.keys(args).length === 0)) {
    if (name === 'exec_command' && (typeof obj.cmd === 'string' || typeof obj.command === 'string' || typeof obj.exec_command === 'string')) {
      args = { ...obj };
      delete args.name; delete args.tool; delete args.tool_name;
      if (!args.cmd && args.exec_command) args.cmd = args.exec_command;
    } else if (name === 'apply_patch' && (typeof obj.patch === 'string' || typeof obj.diff === 'string')) {
      args = { ...obj };
      delete args.name; delete args.tool; delete args.tool_name;
    } else {
      args = {};
    }
  }
  if (typeof args === 'string') {
    try { args = JSON.parse(args); } catch { args = name === 'apply_patch' ? { patch: args } : { input: args }; }
  }
  if (!args || typeof args !== 'object') args = {};
  if (name === 'exec_command' && !args.cmd && typeof args.command === 'string') {
    args.cmd = args.command;
  }
  if (name === 'exec_command' && !args.cmd && typeof args.exec_command === 'string') {
    args.cmd = args.exec_command;
  }
  args = sanitizeToolArgs(args, name);
  if (name === 'apply_patch') {
    const raw = args.patch ?? args.input ?? args.content ?? '';
    args = { patch: extractPatch(raw) || raw };
  }
  return { id: generateId('call_'), name, arguments: JSON.stringify(args) };
}

// Commands with placeholders or annotations are examples from documentation, never something to run
const EXAMPLE_COMMAND_RE = /<[\w.\-\/ ]+>|\/path\/to\/|…|→|\.\.\.\/|#\s*\S*[^\x00-\x7F]/;

// A structured markdown answer (headings, several fences or a long body) shows commands to the user;
// treating its code blocks as tool calls makes the agent run its own report line by line.
export function looksLikeDocumentation(text) {
  if (!text) return false;
  const fences = (text.match(/```/g) || []).length;
  if (fences >= 4) return true;
  if (/(?:^|\n)\s*#{1,4}\s+\S/.test(text)) return true;
  const prose = text.replace(/```[\s\S]*?```/g, '').trim();
  return prose.length > 600;
}

function isRunnableCommand(cmd) {
  return !!cmd && !EXAMPLE_COMMAND_RE.test(cmd);
}

export function extractRawShellCommand(text) {
  if (!text || typeof text !== 'string') return { clean: text || '', calls: [] };
  const trimmed = text.trim();
  if (!trimmed) return { clean: text, calls: [] };
  if (looksLikeDocumentation(trimmed)) return { clean: text, calls: [] };

  const BARE_CMD_RE = /^[ \t]*(?:[$>#]\s*)?`?(?:cd\s+(?:"[^"]+"|\'[^\']+\'|[^\s;&|]+)(?:\s*&&|\s*;)?|git\s+|make\b|cmake\b|gcc\b|g\+\+\b|clang\b|python[23]?\s+|pytest\b|npm\s+|npx\s+|node\s+|grep\s+|rg\s+|find\s+|cat\s+|head\s+|tail\s+|sed\s+|awk\s+|ls\s+|rm\s+|mkdir\s+|cp\s+|mv\s+|curl\s+|wget\s+|\.\/)\s*([\s\S]*?)`?$/;
  const cleanCmdStr = s => s.replace(/^[ \t]*[$>#]\s*/, '').replace(/^`|`$/g, '').trim();

  // 1. Fenced bash/sh code block
  const fencedMatch = trimmed.match(/^([\s\S]*?)```(?:bash|sh|shell|zsh)?\s*\n+([\s\S]+?)\n+```([\s\S]*)$/i);
  if (fencedMatch) {
    const before = fencedMatch[1].trim();
    const cmd = cleanCmdStr(fencedMatch[2]);
    const after = fencedMatch[3].trim();
    if (isRunnableCommand(cmd) && !/^(?:def |class |function |import |#include|<|var |const |let )/m.test(cmd)) {
      const isShellLike = /(?:&&|\||;|\b(?:cd|git|pytest|python[23]?|make|cmake|gcc|g\+\+|clang|npm|npx|node|grep|rg|find|cat|head|tail|sed|awk|ls|rm|mkdir|cp|mv|curl|wget)\b)/.test(cmd);
      if (isShellLike) {
        return {
          clean: [before, after].filter(Boolean).join('\n\n').trim(),
          calls: [{
            id: generateId('call_'),
            name: 'exec_command',
            arguments: JSON.stringify({ cmd })
          }]
        };
      }
    }
  }

  // 2. Entire text is a bare shell command
  if (BARE_CMD_RE.test(trimmed)) {
    const hasProseIndicators = /(?:please|because|should|would|could|however|therefore|لطفاً|چون|باید|می‌توان|است\b|شد\b)/i.test(trimmed);
    const hasShellPunctuation = /(?:&&|\||;|\s-[a-zA-Z]|\/|\\|\*)/.test(trimmed);
    const cmd = cleanCmdStr(trimmed);
    if (!hasProseIndicators && hasShellPunctuation && isRunnableCommand(cmd)) {
      return {
        clean: '',
        calls: [{
          id: generateId('call_'),
          name: 'exec_command',
          arguments: JSON.stringify({ cmd })
        }]
      };
    }
  }

  // 3. Short explanation followed by shell command on subsequent lines
  const lines = trimmed.split('\n');
  if (lines.length >= 2) {
    for (let i = 1; i < lines.length; i++) {
      const lineTrimmed = lines[i].trim();
      if (BARE_CMD_RE.test(lineTrimmed)) {
        const hasProseIndicators = /(?:please|because|should|would|could|however|therefore|لطفاً|چون|باید|می‌توان|است\b|شد\b)/i.test(lineTrimmed);
        const hasShellPunctuation = /(?:&&|\||;|\s-[a-zA-Z]|\/|\\|\*)/.test(lineTrimmed);
        const cmd = cleanCmdStr(lineTrimmed);
        if (!hasProseIndicators && hasShellPunctuation && isRunnableCommand(cmd)) {
          const cleanIntro = lines.slice(0, i).filter(Boolean).join('\n').trim();
          return {
            clean: cleanIntro,
            calls: [{
              id: generateId('call_'),
              name: 'exec_command',
              arguments: JSON.stringify({ cmd })
            }]
          };
        }
      }
    }

    const lastLines = lines.slice(1).join('\n').trim();
    if (BARE_CMD_RE.test(lastLines)) {
      const hasProseIndicators = /(?:please|because|should|would|could|however|therefore|لطفاً|چون|باید|می‌توان|است\b|شد\b)/i.test(lastLines);
      const hasShellPunctuation = /(?:&&|\||;|\s-[a-zA-Z]|\/|\\|\*)/.test(lastLines);
      const cmd = cleanCmdStr(lastLines);
      if (!hasProseIndicators && hasShellPunctuation && isRunnableCommand(cmd)) {
        return {
          clean: lines[0].trim(),
          calls: [{
            id: generateId('call_'),
            name: 'exec_command',
            arguments: JSON.stringify({ cmd })
          }]
        };
      }
    }
  }

  return { clean: text, calls: [] };
}

// A tool result header the model wrote itself ("[TOOL RESULT …]", "[POLL RESULT]", "[COMMAND OUTPUT]"…),
// optionally after a "---" separator. Only the proxy writes these; in a model reply they mean it is
// inventing what a command printed, so everything from there on is fabricated.
const FAKE_RESULT_HEADER = /(?:^|\n)(?:[ \t]*[-*_]{3,}[ \t]*\n)?[ \t\n]*\[(?:TOOL|POLL|COMMAND|CMD|EXEC|EXECUTION|SHELL|TERMINAL|FUNCTION|RUN|BASH|PROCESS)[ _](?:RESULTS?|OUTPUTS?|ERRORS?|RESPONSES?)\b[^\]\n]*\]/gi;

const countOf = (text, re) => (text.match(re) || []).length;

// Index where a fabricated tool result starts, or -1. A header inside an open tool call or code fence
// (e.g. a patch that edits code containing such a string) is real content and is skipped.
export function findFabricatedResult(text) {
  if (!text || typeof text !== 'string') return -1;
  FAKE_RESULT_HEADER.lastIndex = 0;
  let m;
  while ((m = FAKE_RESULT_HEADER.exec(text)) !== null) {
    const before = text.slice(0, m.index);
    const insideCall =
      countOf(before, /<invoke\b/gi) > countOf(before, /<\/invoke\s*>/gi) ||
      countOf(before, /<parameter\b/gi) > countOf(before, /<\/parameter\s*>/gi) ||
      countOf(before, /```/g) % 2 === 1 ||
      /\*\*\* Begin Patch(?![\s\S]*\*\*\* End Patch)/.test(before);
    if (!insideCall) return m.index;
  }
  return -1;
}

export function parseToolCalls(rawContent) {
  const calls = [];
  if (!rawContent) return { cleanContent: '', calls };

  // Drop an invented tool result and everything after it: calls made before it are real, but any
  // conclusion or follow-up call written after it rests on output that never existed.
  let fabricatedResult = false;
  const fakeIdx = findFabricatedResult(rawContent);
  if (fakeIdx !== -1) {
    rawContent = rawContent.slice(0, fakeIdx);
    fabricatedResult = true;
    if (!rawContent.trim()) return { cleanContent: '', calls, fabricatedResult };
  }

  const content = normalizeToolCallMarkup(rawContent);

  // 1. Direct or wrapped <invoke name="..."> / <invoke="name"> ... </invoke> (also handling unclosed tag)
  const invokePattern = /<invoke(?:\s+name=|=)\s*["']?([^"'>\s]+)["']?[^>]*>\s*([\s\S]*?)(?:<\/invoke>|$)/gi;
  let invokeMatch;
  while ((invokeMatch = invokePattern.exec(content)) !== null) {
    let fnName = invokeMatch[1].trim();
    const invokeBody = invokeMatch[2];
    const SHELL_ALIASES = new Set(['exec_command', 'exec_commands', 'bash', 'shell', 'sh', 'terminal', 'cmd', 'command', 'run_command', 'execute_command']);
    const PATCH_ALIASES = new Set(['apply_patch', 'apply_patches', 'patch', 'diff', 'apply_diff']);
    if (SHELL_ALIASES.has(fnName.toLowerCase())) fnName = 'exec_command';
    else if (PATCH_ALIASES.has(fnName.toLowerCase())) fnName = 'apply_patch';
    const args = sanitizeToolArgs(parseParams(invokeBody), fnName);

    // If exec_command contains bare body without parameter tags
    if (fnName === 'exec_command' && !args.cmd) {
      const cleanBody = invokeBody.replace(/<[^>]+>/g, '').trim();
      if (cleanBody && !cleanBody.startsWith('{')) args.cmd = cleanBody;
    }

    // If exec_command contains an embedded apply_patch, convert directly to apply_patch tool
    if (fnName === 'exec_command' && typeof args.cmd === 'string' && PATCH_BEGIN_RE.test(args.cmd)) {
      console.log('[Parser] Intercepted embedded patch in exec_command. Converting to apply_patch tool.');
      calls.push({
        id: generateId('call_'),
        name: 'apply_patch',
        arguments: JSON.stringify({ patch: extractPatch(args.cmd) })
      });
    } else if (fnName === 'apply_patch') {
      // Accept whichever key the model used (patch / input / content) and normalize the envelope
      const rawPatch = args.patch ?? args.input ?? args.content ?? Object.values(args).find(v => typeof v === 'string') ?? '';
      calls.push({
        id: generateId('call_'),
        name: 'apply_patch',
        arguments: JSON.stringify({ patch: extractPatch(rawPatch) || rawPatch })
      });
    } else {
      calls.push({
        id: generateId('call_'),
        name: fnName,
        arguments: JSON.stringify(args)
      });
    }
  }

  // 2. Fallback check for <function_call name="..."> ... <argument name="..."> ... </argument> </function_call>
  const xmlPattern = /<function_call\s+name="([^"]+)">\s*([\s\S]*?)(?:<\/function_call>|$)/gi;
  let match;
  while ((match = xmlPattern.exec(content)) !== null) {
    const name = match[1];
    const rawArgs = match[2];
    const args = {};
    const argPattern = /<argument\s+name="([^"]+)">([\s\S]*?)<\/argument>/gi;
    let argMatch;
    while ((argMatch = argPattern.exec(rawArgs)) !== null) {
      if (args[argMatch[1]] === undefined) {
        args[argMatch[1]] = argMatch[2].trim();
      }
    }
    const sanitizedArgs = sanitizeToolArgs(args, name);
    calls.push({
      id: generateId('call_'),
      name,
      arguments: JSON.stringify(sanitizedArgs)
    });
  }

  // 3. JSON-style calls inside a wrapper: <tool_call>{"name": "...", "arguments": {...}}</tool_call>
  const jsonWrapperPattern = /<tool_calls>\s*(\{[\s\S]*?)(?:<\/tool_calls>|$)/gi;
  let jsonMatch;
  while ((jsonMatch = jsonWrapperPattern.exec(content)) !== null) {
    for (const obj of extractJsonObjects(jsonMatch[1])) {
      const call = jsonToolCall(obj);
      if (call) calls.push(call);
    }
  }

  // 4. DeepSeek native tool tokens: <｜tool▁call▁begin｜>function<｜tool▁sep｜>name ```json {...} ```<｜tool▁call▁end｜>
  const nativePattern = /<[|｜]tool[▁_]call[▁_]begin[|｜]>\s*(?:function)?\s*<[|｜]tool[▁_]sep[|｜]>\s*([\w.\-]+)\s*([\s\S]*?)(?:<[|｜]tool[▁_]call[▁_]end[|｜]>|$)/g;
  let nativeMatch;
  while ((nativeMatch = nativePattern.exec(content)) !== null) {
    const body = nativeMatch[2].replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const [obj] = extractJsonObjects(body);
    const call = jsonToolCall({ name: nativeMatch[1], arguments: obj || {} });
    if (call) calls.push(call);
  }

  // 5. Fallback check for a raw patch block written as plain text (only when outside any tool call)
  const textOutsideCalls = content
    .replace(/<invoke\b[\s\S]*?(?:<\/invoke>|$)/gi, '')
    .replace(/<function_call\b[\s\S]*?(?:<\/function_call>|$)/gi, '');
  const patchText = extractPatch(textOutsideCalls);
  if (patchText) {
    const alreadyAdded = calls.some(c => c.name === 'apply_patch');
    if (!alreadyAdded) {
      calls.push({
        id: generateId('call_'),
        name: 'apply_patch',
        arguments: JSON.stringify({ patch: patchText })
      });
    }
  }

  // 5b. Check for [ACTION <name> <call_id>]: <json> or {ACTION <name> <call_id>} <json>
  // Models that imitate the transcript format (seen with Kimi) keep writing after the call: a `---`
  // separator and an invented [TOOL RESULT ...]. The call body ends where that hallucination starts.
  const actionPattern = /[\[\{]ACTION\s+([\w.\-]+)(?:\s+([\w.\-]+))?[\]\}]:?\s*([\s\S]*?)(?=\n[\[\{]ACTION|\n<|\n\s*-{3,}\s*(?:\n|$)|\n\s*\[(?:TOOL RESULT|USER|ASSISTANT|SYSTEM)\b|$)/gi;
  let actionMatch;
  while ((actionMatch = actionPattern.exec(content)) !== null) {
    const fnName = actionMatch[1].trim();
    const explicitCallId = actionMatch[2]?.trim();
    const bodyStr = actionMatch[3].trim();
    let argsObj = null;
    try {
      argsObj = JSON.parse(bodyStr);
    } catch {
      // Prefer a real JSON object (keeps \" escapes decoded) over raw cmd recovery
      const [obj] = bodyStr.startsWith('{') ? extractJsonObjects(bodyStr) : [];
      argsObj = obj || tryParseOrRecoverCmd(bodyStr);
      if (!argsObj) {
        const [anyObj] = extractJsonObjects(bodyStr);
        if (anyObj) argsObj = anyObj;
      }
    }
    if (argsObj && typeof argsObj === 'object') {
      if (fnName === 'exec_command' && !argsObj.cmd) {
        argsObj.cmd = argsObj.exec_command || argsObj.command || '';
      } else if (fnName === 'apply_patch' && !argsObj.patch) {
        argsObj.patch = argsObj.apply_patch || argsObj.diff || '';
      }
      const sanitized = sanitizeToolArgs(argsObj, fnName);
      calls.push({
        id: explicitCallId || generateId('call_'),
        name: fnName,
        arguments: JSON.stringify(sanitized)
      });
    }
  }

  // 5c. XML-shaped copy of the transcript format (seen with Kimi): <ACTION exec_command call_x>{json}</ACTION>.
  // Usually empty — a label the model writes before using its own tool — so it only yields a call with arguments.
  const xmlActionPattern = /<ACTION\s+([\w.\-]+)(?:\s+([\w.\-]+))?\s*\/?>([\s\S]*?)(?:<\/ACTION>|(?=\n<ACTION\b)|$)/gi;
  let xmlActionMatch;
  while ((xmlActionMatch = xmlActionPattern.exec(content)) !== null) {
    const bodyStr = xmlActionMatch[3].trim();
    if (!bodyStr.startsWith('{')) continue;
    let argsObj = null;
    try { argsObj = JSON.parse(bodyStr); } catch { [argsObj] = extractJsonObjects(bodyStr); }
    if (!argsObj || typeof argsObj !== 'object') continue;
    const fnName = xmlActionMatch[1].trim();
    if (fnName === 'exec_command' && !argsObj.cmd) argsObj.cmd = argsObj.command || '';
    calls.push({
      id: xmlActionMatch[2]?.trim() || generateId('call_'),
      name: fnName,
      arguments: JSON.stringify(sanitizeToolArgs(argsObj, fnName))
    });
  }

  // Clean all tool tags completely out of cleanContent, even if unclosed or lone closing tags
  let cleanContent = content
    .replace(/<ACTION\s+[\w.\-]+(?:\s+[\w.\-]+)?\s*\/?>[\s\S]*?(?:<\/ACTION>|(?=\n<ACTION\b)|$)/gi, '')
    .replace(/<\/ACTION>/gi, '')
    .replace(/[\[\{]ACTION\s+[\w.\-]+(?:\s+[\w.\-]+)?[\]\}]:?[\s\S]*?(?=\n[\[\{]ACTION|\n<|\n\s*-{3,}\s*(?:\n|$)|\n\s*\[(?:TOOL RESULT|USER|ASSISTANT|SYSTEM)\b|$)/gi, '')
    .replace(/<tool_calls>\s*\{[\s\S]*?\}\s*(?:<\/tool_calls>|$)/gi, '')
    .replace(/<[|｜]tool[▁_]calls?[▁_]begin[|｜]>[\s\S]*?(?:<[|｜]tool[▁_]calls?[▁_]end[|｜]>|$)/g, '')
    .replace(/<invoke\b[\s\S]*?(?:<\/invoke>|$)/gi, '')
    .replace(/<\/?invoke\b[^>]*>/gi, '')
    .replace(/<function_call\b[\s\S]*?(?:<\/function_call>|$)/gi, '')
    .replace(/<\/?function_call\b[^>]*>/gi, '')
    .replace(/<function\b[\s\S]*?(?:<\/function>|$)/gi, '')
    .replace(/<\/?function\b[^>]*>/gi, '')
    .replace(/<parameter\b[\s\S]*?(?:<\/parameter>|$)/gi, '')
    .replace(/<\/?parameter\b[^>]*>/gi, '')
    .replace(/[<＜]\/?(?:tool_calls?|tools?_calls?|call_tools?|calls?_tools?|toolcalls?|calltools?|calls?|calles|call_calls?|function_calls?|call_functions?|functioncalls?|use_tools?|tool_invokes?|tools?|inv[\s_-]*calls?|invoke[\s_-]*calls?|invocation[\s_-]*calls?|invocations?|invokes?|inv|writes?_stdin|exec_commands?|apply_patch(?:es)?|view_images?)\b[^>＞]*[>＞]?/gi, '')
    .replace(/(?:\[\s*(?:exec_commands?|apply_patch(?:es)?|write_stdin|read_file|view_images?|execute_commands?|run_commands?|tools?_calls?|calls?)\s*\])+/gi, '')
    .replace(/\{bmatrix\b/gi, '{')
    .replace(/[<＜]\/?(?:コール|ツール|调用|工具)[^>＞]*[>＞]?/gi, '')
    .replace(/<\/?div\b[^>]*>/gi, '')
    .replace(/<\/?argument\b[^>]*>/gi, '')
    .replace(/[<＜][|｜]?\/?\s*ds[_\w-]*[^>＞]*[>＞]?/gi, '')
    .replace(/<\/?\s*[^>]*?DSML[^>]*?>/gi, '')
    .replace(/\|{1,2}_*DSML_*\|{1,2}/gi, '')
    .replace(/<\/?[\s|｜_]*DSML\b[^>]*>/gi, '')
    .replace(/<\/?[\s|｜_]*DSML[\s|｜_]*(?:>|\n|$)/gi, '')
    .replace(/<\/?(?:[|｜]{1,2})[\s\S]*?(?:[|｜]{1,2})(?:>|\n|$)/g, '')
    .replace(/<[|｜][\s\S]*?[|｜](?:>|\n|$)/g, '')
    .replace(/<\/?(?:[|｜]{1,2})\b[^>]*>?/gi, '')
    .replace(/\*\*\* Begin Patch(?: \*\*\*)?[\s\S]*?(?:\*\*\* End Patch(?: \*\*\*)?|$)/g, '')
    .replace(/apply_patch\s*<<\s*['"]?([A-Z_]+)['"]?[\s\S]*?(?:^\1$|(?![\s\S]))/gm, '')
    .replace(/(?:^|\n)\s*FUNCTION\s+CALL:?\s*/gi, '\n')
    .replace(/(?:\x1b\[[0-9;]*[a-zA-Z]|(?:^|\n)\s*\[[A-Za-z]\s*(?:\n|$))/g, '\n')
    .replace(/(?:^|\n)\s*[|｜]+\s*(?:\n|$)/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // Clean dangling, trailing, or repeated markdown horizontal rules (---) left behind by tool tags or dividers
  cleanContent = cleanContent
    .replace(/(?:\s*[-*_]{3,}\s*){2,}/g, '\n\n---\n\n')
    .replace(/(?:\s*[-*_]{3,}\s*)+$/g, '')
    .replace(/^(?:\s*[-*_]{3,}\s*)+/g, '');

  // Strip hallucinated tool results, simulated environment outputs, and synthetic dialogue
  cleanContent = cleanContent
    .replace(/(?:^|\n)(?:[-*_]{3,}\s*)?\[(?:PROGRESS STATUS|SESSION RESUMED|SUPERVISOR|STRICT CONTINUATION|TOOL RESULT)[\s\S]*?(?=\n\[(?!PROGRESS STATUS|SESSION RESUMED|SUPERVISOR|STRICT CONTINUATION|TOOL RESULT)|\n<|$)/gi, '')
    .replace(/(?:^|\n)\[(?:USER|ASSISTANT|SYSTEM|PROGRESS STATUS|SESSION RESUMED|SUPERVISOR|STRICT CONTINUATION)[^\]]*\]:?[\s\S]*?(?=\n\[|\n<|$)/gi, '')
    .replace(/\[(?:PROGRESS STATUS|SESSION RESUMED|SUPERVISOR|STRICT CONTINUATION)[^\]]*\]:?[^\n]*(?:\n|$)/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // If a tool was emitted, any trailing text roleplaying tool output or next turns is dropped
  if (calls.length > 0) {
    const toolResultIdx = cleanContent.search(/(?:^|\n)(?:[-*_]{3,}\s*)?\[TOOL RESULT/i);
    if (toolResultIdx !== -1) {
      cleanContent = cleanContent.slice(0, toolResultIdx).trim();
    }
  }

  // 6. Fallback and cleanup for raw JSON tool calls (e.g. [{"name": "exec_command", ...}] or {"name": ...})
  const rawJsonResult = extractRawJsonToolCalls(cleanContent);
  if (calls.length === 0 && rawJsonResult.calls.length > 0) {
    calls.push(...rawJsonResult.calls);
  }
  cleanContent = rawJsonResult.clean;

  // 7. Fallback and cleanup for raw shell commands emitted without XML tags
  // Skip if text is already a completed deliverable report (fenced bash blocks there are user documentation, not tool invocations)
  if (calls.length === 0 && !isFinalDeliverableReport(cleanContent)) {
    const rawShellResult = extractRawShellCommand(cleanContent);
    if (rawShellResult.calls.length > 0) {
      calls.push(...rawShellResult.calls);
      cleanContent = rawShellResult.clean;
    }
  }

  // Deduplicate identical calls in the same turn (common symptom of LLM repetition loops)
  const seenSigs = new Set();
  const dedupedCalls = [];
  for (const c of calls) {
    if (c.name === 'exec_command' || /^(?:bash|shell|sh|terminal|run_command|execute_command|cmd)$/i.test(c.name)) {
      c.name = 'exec_command';
      let parsedArgs = {};
      try { parsedArgs = JSON.parse(c.arguments || '{}'); } catch {
        if (typeof c.arguments === 'string' && c.arguments.trim()) {
          parsedArgs = { cmd: c.arguments.trim() };
        }
      }
      let cmd = parsedArgs.cmd || parsedArgs.command || parsedArgs.input || parsedArgs.code || parsedArgs.script || '';
      if (typeof cmd === 'string' ? cmd.trim() : Array.isArray(cmd) && cmd.length) {
        if (!parsedArgs.cmd) parsedArgs.cmd = typeof cmd === 'string' ? cmd.trim() : cmd;
        c.arguments = JSON.stringify(parsedArgs);
      } else {
        console.warn('[Parser] Dropping exec_command call with no cmd (malformed tool call).');
        continue;
      }
    } else if (c.name === 'apply_patch' || /^(?:patch|diff|apply_diff)$/i.test(c.name)) {
      c.name = 'apply_patch';
      let parsedArgs = {};
      try { parsedArgs = JSON.parse(c.arguments || '{}'); } catch {
        if (typeof c.arguments === 'string' && c.arguments.trim()) {
          parsedArgs = { patch: c.arguments.trim() };
        }
      }
      let patch = parsedArgs.patch || parsedArgs.input || parsedArgs.content || parsedArgs.diff || '';
      if (typeof patch === 'string' && patch.trim()) {
        if (!parsedArgs.patch) parsedArgs.patch = patch.trim();
        c.arguments = JSON.stringify(parsedArgs);
      }
    }
    const sig = `${c.name}::${c.arguments}`;
    if (!seenSigs.has(sig)) {
      seenSigs.add(sig);
      dedupedCalls.push(c);
    }
  }

  // If there are tool calls and cleanContent consists solely of stray delimiters, punctuation,
  // or leftover tag remnants (like '| calls>', 'calls>', '| invoke>'), drop it completely.
  if (dedupedCalls.length > 0) {
    cleanContent = cleanContent
      .replace(/(?:^|\n)\s*(?:[|｜]\s*)?(?:tool_calls?|calls?|tools?|invokes?)\s*>\s*(?:\n|$)/gi, '\n')
      .trim();

    // If cleanContent is an endlessly repeated investigation preamble announcing future edits while running tools,
    // suppress it so intermediate tool-execution turns don't spam identical filler sentences to the user.
    const isPreambleFiller = /^(?:من مشکلات رو بررسی کردم|حالا شروع به اصلاحات می‌کنم|اول باید کد رو دقیق‌تر ببینم|بسیار خب، من مشکلات رو|اول بذار کد رو|مشکلات رو بررسی کردم)/.test(cleanContent.trim());
    if (isPreambleFiller || /^[\s|｜_—\-:;.,`'"\/\\~*#]*$/.test(cleanContent)) {
      cleanContent = '';
    }
  }

  return { cleanContent, calls: dedupedCalls, fabricatedResult };
}

export function getVisibleStreamingText(accumulatedContent) {
  if (!accumulatedContent) return '';

  const markers = [
    '<tool',
    '</tool',
    '<call',
    '</call',
    '<invoke',
    '</invoke',
    '<inv',
    '</inv',
    '<parameter',
    '</parameter',
    '<function',
    '</function',
    '<argument',
    '</argument',
    '<write',
    '</write',
    '<exec',
    '</exec',
    '<apply',
    '</apply',
    '<view',
    '</view',
    '<コール',
    '</コール',
    '＜コール',
    '＜/コール',
    '<ツール',
    '</ツール',
    '＜ツール',
    '＜/ツール',
    '<调用',
    '</调用',
    '＜调用',
    '＜/调用',
    '<工具',
    '</工具',
    '＜工具',
    '＜/工具',
    '＜tool',
    '＜call',
    '＜invoke',
    '＜/invoke',
    '＜inv',
    '＜/inv',
    '＜parameter',
    '<｜',
    '<|',
    '</｜',
    '</|',
    '<__',
    '</__',
    '<_',
    '</_',
    '|__',
    '｜｜',
    '<ds',
    '</ds',
    '＜ds',
    '＜/ds',
    'ds_small_trigger',
    'ds_trigger',
    '<dsml',
    '</dsml',
    '| calls',
    '|calls',
    '| tool',
    '|tool',
    'calls>',
    'tool_calls>',
    '| invoke',
    '|invoke',
    '*** begin patch',
    'apply_patch <<',
    '[action',
    '[action ',
    '<action',
    '{action',
    '{action ',
    'action:',
    '[tool_call',
    '{tool_call',
    'function call:',
    'tool call:',
    'tool_call:',
    'function:',
    '[invoke',
    '{invoke',
    '[available tools]',
    '[tool result'
  ];

  const fakeAt = findFabricatedResult(accumulatedContent);
  if (fakeAt !== -1) accumulatedContent = accumulatedContent.slice(0, fakeAt);
  // A bracketed header still being written ("\n[POLL RES") may become a fake result: hold it back
  accumulatedContent = accumulatedContent.replace(/\n[ \t]*\[[A-Za-z _]{0,40}$/, '');

  const lower = accumulatedContent.toLowerCase();
  let minIndex = -1;
  for (const marker of markers) {
    const idx = lower.indexOf(marker);
    if (idx !== -1) {
      if (minIndex === -1 || idx < minIndex) {
        minIndex = idx;
      }
    }
  }

  // Also check for JSON tool call beginnings: quoted or unquoted keys
  // e.g. [{"name": ..., {"cmd": ..., {"exec_command": ..., {exec_command: ..., ```json [{"name": ...
  const jsonToolCallRe = /(?:```(?:json)?\s*)?(?:\[\s*)?\{\s*"?\b(?:name|function|tool|tool_name|cmd|command|exec_command|target|session_id)\b"?\s*:/i;
  const jsonMatch = jsonToolCallRe.exec(accumulatedContent);
  if (jsonMatch) {
    if (minIndex === -1 || jsonMatch.index < minIndex) {
      minIndex = jsonMatch.index;
    }
  }

  // Also check for [ACTION ... or {ACTION ...
  const actionRe = /(?:\[|\{)\s*ACTION\b/i;
  const actionMatch = actionRe.exec(accumulatedContent);
  if (actionMatch) {
    if (minIndex === -1 || actionMatch.index < minIndex) {
      minIndex = actionMatch.index;
    }
  }

  // Also check for FUNCTION CALL:
  const funcCallRe = /\bFUNCTION\s+CALL\s*:/i;
  const funcMatch = funcCallRe.exec(accumulatedContent);
  if (funcMatch) {
    if (minIndex === -1 || funcMatch.index < minIndex) {
      minIndex = funcMatch.index;
    }
  }

  // Also check for raw fenced bash/sh blocks: ```bash or ```sh
  const bashFenceRe = /```(?:bash|sh|shell|zsh)\b/i;
  const bashMatch = bashFenceRe.exec(accumulatedContent);
  if (bashMatch) {
    if (minIndex === -1 || bashMatch.index < minIndex) {
      minIndex = bashMatch.index;
    }
  }

  // Also check for bare shell command (e.g. starts with cd /... or cd ~/)
  if (/^\s*cd\s+[~.\/\w\-]+/i.test(accumulatedContent)) {
    return '';
  }

  let s = minIndex !== -1 ? accumulatedContent.slice(0, minIndex) : accumulatedContent;

  // Guard against any unclosed '<' or '＜' tag at the end of the streaming string
  const lastLt = Math.max(s.lastIndexOf('<'), s.lastIndexOf('＜'));
  const lastGt = Math.max(s.indexOf('>', lastLt), s.indexOf('＞', lastLt));
  if (lastLt !== -1 && lastGt === -1) {
    s = s.slice(0, lastLt);
  }

  // Guard against unclosed pipe at end
  const lastPipe = Math.max(s.lastIndexOf('|'), s.lastIndexOf('｜'));
  if (lastPipe !== -1 && lastPipe >= s.length - 10) {
    s = s.slice(0, lastPipe);
  }

  // Guard against trailing partial JSON tool call prefix
  const partialPrefixRe = /(?:```(?:json)?\s*)?(?:\[\s*)?\{\s*(?:"?\b(?:name|function|tool|tool_name|cmd|command|exec_command|target|session_id)\b"?)?$/i;
  const partialMatch = partialPrefixRe.exec(s);
  if (partialMatch && partialMatch.index < s.length) {
    s = s.slice(0, partialMatch.index);
  }

  // Strip ANSI cursor escapes, [A remnants, and terminal control codes
  s = s.replace(/(?:\x1b\[[0-9;]*[a-zA-Z]|(?:^|\n)\s*\[[A-Za-z]\s*(?:\n|$))/g, '\n');

  s = s
    .replace(/[<＜]\/?(?:tool_calls?|tools?_calls?|call_tools?|calls?_tools?|toolcalls?|calltools?|calls?|calles|call_calls?|function_calls?|call_functions?|functioncalls?|use_tools?|tool_invokes?|tools?|inv[\s_-]*calls?|invoke[\s_-]*calls?|invocation[\s_-]*calls?|invocations?|invokes?|inv|writes?_stdin|exec_commands?|apply_patch(?:es)?|view_images?)\b[^>＞]*[>＞]?/gi, '')
    .replace(/(?:\[\s*(?:exec_commands?|apply_patch(?:es)?|write_stdin|read_file|view_images?|execute_commands?|run_commands?|tools?_calls?|calls?)\s*\])+/gi, '')
    .replace(/\{bmatrix\b/gi, '{')
    .replace(/[<＜]\/?(?:コール|ツール|调用|工具)[^>＞]*[>＞]?/gi, '')
    .replace(/<\/?\s*[^>]*?DSML[^>]*?>/gi, '')
    .replace(/[|｜]{1,2}[\s_]*DSML[\s_]*[|｜]{1,2}/gi, '')
    .replace(/<[|｜][^>]*?[|｜]>/g, '')
    .replace(/<\/?div\b[^>]*>/gi, '')
    .replace(/(?:\s*[-*_]{3,}\s*)+$/g, '');

  if (!s.trim()) return '';

  return s;
}

export function simplifyToolsForPrompt(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.filter(tool => (tool?.function || tool)?.name).map(tool => {
    const fn = tool.function || tool;
    const name = fn.name;
    const desc = fn.description || '';
    const params = fn.parameters || {};
    const props = params.properties || {};

    let simplifiedProps = {};
    let simplifiedRequired = [];

    if (name === 'exec_command') {
      simplifiedProps = {
        cmd: {
          type: 'string',
          description: 'The shell command to execute'
        },
        workdir: {
          type: 'string',
          description: 'Working directory for the command (optional)'
        }
      };
      // Keep the escalation knobs when Codex offers them, so network/build commands can request approval
      if (props.sandbox_permissions) {
        simplifiedProps.sandbox_permissions = {
          type: 'string',
          enum: ['use_default', 'require_escalated'],
          description: 'Optional. Use "require_escalated" ONLY when the command needs network access or writes outside the workspace; otherwise omit.'
        };
        simplifiedProps.justification = {
          type: 'string',
          description: 'Required only with require_escalated: one sentence explaining why escalation is needed.'
        };
      }
      simplifiedRequired = ['cmd'];
    } else if (name === 'write_stdin') {
      simplifiedProps = {
        session_id: {
          type: 'integer',
          description: 'Session ID of the running process'
        },
        chars: {
          type: 'string',
          description: 'Characters/input to send to stdin'
        }
      };
      simplifiedRequired = ['session_id', 'chars'];
    } else if (name === 'view_image') {
      simplifiedProps = {
        path: {
          type: 'string',
          description: 'Local filesystem path to the image file'
        }
      };
      simplifiedRequired = ['path'];
    } else if (name === 'apply_patch') {
      simplifiedProps = {
        patch: {
          type: 'string',
          description: 'Patch content to apply'
        }
      };
      simplifiedRequired = ['patch'];
    } else {
      const ignoredKeys = new Set([
        'sandbox_permissions',
        'prefix_rule',
        'justification',
        'login',
        'tty',
        'max_output_tokens',
        'yield_time_ms'
      ]);
      for (const [key, val] of Object.entries(props)) {
        if (!ignoredKeys.has(key)) {
          simplifiedProps[key] = val;
        }
      }
      simplifiedRequired = Array.isArray(params.required)
        ? params.required.filter(k => !ignoredKeys.has(k))
        : [];
    }

    return {
      type: 'function',
      name,
      description: desc,
      parameters: {
        type: 'object',
        properties: simplifiedProps,
        required: simplifiedRequired
      }
    };
  });
}

export function formatToolsInstruction(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  const cleanTools = simplifyToolsForPrompt(tools);

  return `
[AVAILABLE TOOLS]
You have access to the following tools:
${JSON.stringify(cleanTools, null, 2)}

[TOOL CALL FORMAT RULES - STRICT]
To execute a tool call, output a block in XML format:
<tool_calls>
<invoke name="tool_name">
<parameter name="parameter_name" string="true">parameter_value</parameter>
</invoke>
</tool_calls>

CRITICAL RULES:
1. Provide required parameters; include optional ones only when actually needed. Do NOT provide redundant parameters.
2. NEVER repeat a parameter tag. Each parameter must appear AT MOST ONCE.
3. Close the invocation immediately with </invoke></tool_calls> and STOP GENERATING immediately after.
4. NEVER simulate, hallucinate or write [TOOL RESULT...], [COMMAND OUTPUT...], or pretend to output terminal results. The execution environment runs your tool on the real operating system and provides the actual result in the next turn. Writing [TOOL RESULT] or inventing command outputs is strictly forbidden.
5. NEVER output empty <tools></tools> tags or lone </tools> tags. Use strictly <tool_calls><invoke name="...">...</invoke></tool_calls>.
6. NEVER output DSML markup or tokens such as </__DSML__|>, <__DSML__|>, or <|...|>. Output strictly pure XML tags.
7. Keep commands concise and verify outputs inside the project workspace.
8. Output ONLY standard English XML tags (<tool_calls>, <invoke>, <parameter>). NEVER output pseudo or abbreviated tags like <inv calls>, <inv_calls>, <inv>, <call_tool>, or multilingual tags like <コール>, <ツール>, or <调用>.
9. NEVER output raw JSON tool calls (e.g. [{"name": "exec_command", ...}] or {"name": ...}). You MUST format every tool call strictly using XML: <tool_calls><invoke name="...">...</invoke></tool_calls>.
10. Write parameter values as raw text: never XML-escape them (write <, >, & and quotes literally, e.g. cat <<'EOF' > file && make), and never wrap them in CDATA.
11. All tool calls of one reply run AT THE SAME TIME. Batch only independent read-only commands. A state-changing step (writing files, patches, builds, tests, git changes) must be the LAST call of its reply; run the steps that depend on it in the next reply, after you have seen its result.
`;
}

function recordCandidateImagePath(candidate) {
  if (candidate && isValidImagePath(candidate)) {
    lastReferencedImagePath = candidate;
  }
}

export function extractTextFromContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') {
    const match = /(?:path=["']([^"']+\.(?:png|jpg|jpeg|webp|gif))["']|(?:\/[^\s'"]+\.(?:png|jpg|jpeg|webp|gif)))/i.exec(content);
    if (match) recordCandidateImagePath(match[1] || match[0]);
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part?.text) {
          const match = /(?:path=["']([^"']+\.(?:png|jpg|jpeg|webp|gif))["']|(?:\/[^\s'"]+\.(?:png|jpg|jpeg|webp|gif)))/i.exec(part.text);
          if (match) recordCandidateImagePath(match[1] || match[0]);
          return part.text;
        }
        if (part?.input_text) {
          const match = /(?:path=["']([^"']+\.(?:png|jpg|jpeg|webp|gif))["']|(?:\/[^\s'"]+\.(?:png|jpg|jpeg|webp|gif)))/i.exec(part.input_text);
          if (match) recordCandidateImagePath(match[1] || match[0]);
          return part.input_text;
        }
        if (part?.output_text) return part.output_text;
        if (part?.type === 'input_image' || part?.image_url) {
          return '[User Attached Image File]';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content);
}

const WORKSPACE_DIRECTIVE = `[WORKSPACE & EXECUTION RULES - STRICT ENFORCEMENT]
CRITICAL RULES:
1. Workspace: You MUST create, edit, compile, and execute all files strictly inside the active project workspace root directory. DO NOT use /tmp, /temp, /var/tmp, or temporary directories outside the workspace.
2. Build & Task Persistence vs. Collaboration:
   - When a concrete technical task is underway and unobstructed, proceed systematically without dangling promises (if you state an immediate intent like "بررسی می‌کنم", execute the tool in the same turn).
   - After receiving a tool execution result, proceed with the immediate next step or report findings.
   - Once all tests or builds pass successfully, conclude your response with a clear final summary of the completed work.
3. Architectural Rules (Architecture Preservation & Minimal Surgical Scope):
   - Scope Guardrails: Focus strictly on implementing the requested feature or fixing proven defects. Modify only the minimal necessary files.
   - Non-Destructive Invariants: Never delete working components or rewrite unrelated modules. Preserve existing public API contracts and backwards compatibility unless explicitly instructed by the user's specification.
4. Collaboration & Consultative Decision Making (Executive Autonomy & Proactive Implementation):
   - Proactive Decision Making: When faced with implementation trade-offs or design choices within the task scope, do NOT halt execution to ask conversational or consultative questions. Make the soundest, most robust senior engineering decision yourself and PROCEED with the implementation.
   - End-to-End Delivery: Carry out the work from inspection to code modification, compilation, and automated test execution. Do not leave the job halfway.
   - Only TWO conditions justify stopping your autonomous loop:
     a) The task is 100% complete, code is written, builds succeed, and all relevant tests pass.
     b) A hard, impassable external barrier occurs (such as missing external system packages requiring root/sudo privileges).
5. System Packages, Sudo & Permissions (STRICT):
   - When a missing dependency or task requires system-level packages (e.g. apt, dpkg, pacman, dnf, brew, or modifying /etc or /usr/lib) or root privileges (sudo):
     DO NOT claim "sudo is locked in this environment" and NEVER invent convoluted hacky detours (such as downloading raw deb packages into workspace, cloning foreign repositories, or arbitrarily hacking project build scripts).
     INSTEAD: PAUSE AND ASK THE USER!
     Clearly explain which package is missing, specify the exact command (e.g. \`sudo apt install -y libsdl2-dev\`), and ask the user to execute it or confirm so you can continue.
6. Code Editing & Tool Usage:
   - When the 'apply_patch' tool is listed in [AVAILABLE TOOLS], you can use it to apply code patches:
     <tool_calls>
     <invoke name="apply_patch">
     <parameter name="patch" string="true">*** Begin Patch ***
     ...
     *** End Patch ***</parameter>
     </invoke>
     </tool_calls>
   - Otherwise, write, edit, or patch files directly via shell commands (e.g. cat <<'EOF' > file, python3, sed, or git apply).
   - NEVER run 'apply_patch' as a shell command; apply_patch is a tool name.
   - Do NOT simulate or hallucinate [TOOL RESULT ...] blocks; stop generation immediately after closing your tool call.
7. Multimodal Vision & Image Inspection:
   - DeepSeek Multimodal Vision is FULLY ENABLED and ACTIVE in this environment.
   - You CAN directly see and understand images, screenshots, schematics, photos, waveforms, diagrams, and UI elements.
   - When the user attaches an image or asks about an image, the image is automatically processed by DeepSeek's native vision model and provided to you.
   - To inspect any local image file (e.g. .png, .jpg, .svg), invoke the 'view_image' tool with {"path": "<image_path>"}. You will receive the visual analysis directly.
8. Audio & Sound Environment:
   - Full audio subsystem (PipeWire / PulseAudio compatibility) is FULLY RUNNING and OPERATIONAL.
   - PulseAudio server socket is available at unix:/run/user/1000/pulse/native (PULSE_SERVER).
   - Audio playback and testing tools are installed and ready: 'paplay', 'pactl', 'pw-play', 'pw-cat', 'aplay'.
   - Audio output and playback CAN and MUST be tested directly using pulse/alsa/pipewire without assuming audio is unavailable.
9. Local Environment & Packages:
   - For Python: Use python3 or python and existing packages directly, or create venvs with 'python3 -m venv --system-site-packages .venv' (or 'python -m venv ...').
   - Avoid unnecessary network downloads if local packages exist.
10. Framework Testing Best Practices:
   - For FastAPI testing: In sandboxed environments, DO NOT use 'fastapi.testclient.TestClient' (it creates threading portals that can block under sandbox filters). ALWAYS test FastAPI endpoints using 'httpx.AsyncClient(transport=httpx.ASGITransport(app=app))' or call the endpoint handler functions directly!
   - For Express: Use in-process requests or standard Jest/Node test runners without opening network ports.
11. Cognitive Interpretation & Language Mirroring:
   - In your internal thinking / reasoning phase, translate the user's human, informal, or colloquial prompt into precise technical specifications, identifying exact files, system APIs, and concrete execution steps.
   - Language Mirroring (STRICT): Detect the language used by the user in their prompt (e.g., Persian/فارسی, English, etc.). Even though you reason internally using technical terms, your FINAL visible response, explanations, and summaries to the user MUST be delivered in that EXACT SAME language!
12. Workspace Hygiene, Temporary Files Cleanup & Targeted Testing (STRICT & MANDATORY):
   - You MUST keep the user's workspace clean, organized, and uncluttered at all times.
   - Immediate Cleanup of Scratch Files: Any temporary test script, throwaway benchmark, probe script (e.g. \`test_probe.py\`, \`check_*.c\`, \`probe_*.sh\`), debug print log, or temporary artifact/dump file (e.g. \`tmp_*.png\`, \`out_test.raw\`) created during your investigation MUST be deleted (using \`rm\`) immediately after verification or before concluding your turn.
   - Do NOT litter the project root with temporary files or test clutter. If scratch files are temporarily required, place them inside a single temporary directory (e.g. \`.tmp_scratch/\`) and delete the entire directory when finished.
   - Targeted Testing Discipline: Run only focused, strictly necessary tests. Do NOT run endless redundant test variations or repeatedly re-execute the same test suite without an intervening code fix. Once a test confirms the behavior or defect, stop test churning and proceed directly with the fix.`;

const TOOL_OUTPUT_TYPES = new Set([
  'function_call_output',
  'custom_tool_call_output',
  'tool_result',
  'apply_patch_call_output',
  'local_shell_call_output',
  'commandExecution'
]);
const TOOL_CALL_TYPES = new Set(['function_call', 'call', 'custom_tool_call', 'local_shell_call']);

function isToolOutputItem(item) {
  return Boolean(item) && TOOL_OUTPUT_TYPES.has(item.type);
}

// Items produced by the model itself (they mark the boundary of "what is new since the last turn")
function isModelItem(item) {
  if (!item) return false;
  if (TOOL_CALL_TYPES.has(item.type) || item.type === 'reasoning') return true;
  return item.role === 'assistant';
}

// Context blocks Codex (CLI and desktop app) injects as user/developer messages; never a human request
const CODEX_CONTEXT_TAGS = [
  'environment_context', 'user_instructions', 'permissions instructions', 'turn_aborted', 'user_shell_command',
  'app-context', 'skills_instructions', 'collaboration_mode', 'codex_apps_client_time_context',
  'image_resize_notice', 'personality', 'personality_spec', 'model_switch', 'apps_instructions',
  'plugins_instructions', 'subagent_notification', 'realtime_conversation'
];
const CODEX_CONTEXT_RE = new RegExp(`^<(?:${CODEX_CONTEXT_TAGS.map(t => t.replace(/[-]/g, '\\-')).join('|')})\\b`, 'i');
// Unknown future blocks in the same style: the whole message is one <snake_case|kebab-case> element
const CONTEXT_BLOCK_RE = /^<([a-z][a-z0-9]*(?:[_-][a-z0-9]+)+)>[\s\S]*<\/\1>\s*$/i;

export function isSyntheticUserText(text) {
  const t = (text || '').trim();
  return CODEX_CONTEXT_RE.test(t) || CONTEXT_BLOCK_RE.test(t) || /^# AGENTS\.md instructions/i.test(t) ||
    /Another\s+language\s+model\s+started\s+to\s+solve/i.test(t) ||
    /CONTEXT\s+CHECKPOINT\s+COMPACTION/i.test(t);
}

// developer/system messages carry instructions for the model, never the human's request
export function isInstructionRole(item) {
  return item?.role === 'developer' || item?.role === 'system';
}

// Keeps the head and tail of an oversized text (errors usually sit at the end of command output)
export function truncateMiddle(text, maxChars) {
  if (typeof text !== 'string' || text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n[... ${text.length - maxChars} characters truncated by proxy ...]\n${text.slice(-tail)}`;
}

// Latest outputs stay large enough for a ~1000-line file read; older ones shrink but still keep their gist,
// so the model does not have to re-read files it saw a few turns ago
const TOOL_OUTPUT_MAX_CHARS = 48000;
const OLD_TOOL_OUTPUT_MAX_CHARS = 6000;
const OLD_ARGS_MAX_CHARS = 4000;
const RECENT_ITEMS_KEPT_VERBATIM = 8;
const TRIM_BLOCK_ITEMS = 40;

function formatToolResultItem(item, callNames, { latest = false, maxChars = TOOL_OUTPUT_MAX_CHARS } = {}) {
  const callId = item.call_id || item.id || '';
  const name = callNames.get(callId);
  const rawOutput = item.output != null ? item.output : (item.aggregatedOutput != null ? item.aggregatedOutput : item.content);
  const output = truncateMiddle(formatToolOutput(rawOutput), maxChars);
  const label = name ? `[TOOL RESULT ${name} ${callId}]` : `[TOOL RESULT ${callId}]`;
  if (latest && typeof output === 'string' && output.includes('Command declined by auto-review')) {
    return `${label}:\n${output}\nNotice: The command was declined because it requested escalated network permissions. Remember that all packages (fastapi, uvicorn, pytest, httpx, express) are ALREADY available locally offline on the machine. Proceed using local packages without network access.`;
  }
  return `${label}:\n${output}`;
}

function collectCallNames(input) {
  const names = new Map();
  for (const item of input) {
    if (item && TOOL_CALL_TYPES.has(item.type) && item.call_id) names.set(item.call_id, item.name || item.type);
  }
  return names;
}

// Returns the items appended after the model's last output (tool results, new user messages)
export function getIncrementalItems(input) {
  if (!Array.isArray(input) || input.length === 0) return [];
  let i = input.length;
  while (i > 0 && !isModelItem(input[i - 1])) i--;
  // No model item at all: the whole input is new (should not happen on a continuation)
  return i === 0 ? input.slice(-1) : input.slice(i);
}

export function hasPriorModelActivity(input) {
  return Array.isArray(input) && input.some(isModelItem);
}

const FAILOVER_NOTICE = `[SESSION RESUMED - CRITICAL MODEL HANDOFF - CONTINUE PREVIOUS WORK]:
This active task was seamlessly migrated to your session due to an account switch/network failover.
The full conversation history, previous model reasoning, executed commands, created files, and tool results are recorded in detail above.

STRICT CONTINUATION DIRECTIVE:
1. Everything above was ALREADY EXECUTED live in the workspace by the previous model.
2. DO NOT restart the task from scratch, do NOT delete, recreate, or re-scaffold existing files, do NOT ask the user to repeat the request, and do NOT re-explore or re-run existing setup steps.
3. Review the last [TOOL RESULT] or action above. If the immediate next technical step is clear and unobstructed, proceed with it.
4. If a missing dependency requires sudo/system package installation, or if user approval/input is needed for a key decision, STOP and ask the user clearly.
5. Deliver all user-facing explanations and final conclusions in the user's language (Persian/فارسی if the prompt was in Persian).`;

const PROGRESS_NOTICE = `[PROGRESS STATUS]: The previous steps above have already been carried out in the active workspace. Do NOT restart the task from scratch, do NOT delete workspace files again, and do NOT repeat prior exploratory or investigation commands. Proceed with the next step, or if root/sudo or user confirmation is required, ask the user clearly.`;

const USER_QUESTION_FAILOVER_NOTICE = `[SESSION RESUMED - CRITICAL MODEL HANDOFF]: This conversation was migrated to your session. The workspace state and complete conversation history above are preserved. Respond directly and specifically to the user's latest message above without re-executing or repeating prior completed tasks. Deliver your response in the user's language (Persian/فارسی if the user spoke Persian).`;

const USER_QUESTION_PROGRESS_NOTICE = `[PROGRESS STATUS]: The previous steps above have already been carried out in the workspace. Respond directly to the user's latest message above without repeating prior completed tasks.`;

function formatIncremental(items, callNames) {
  const parts = [];
  const outputs = items.filter(isToolOutputItem);
  items.forEach((item, idx) => {
    if (isToolOutputItem(item)) {
      parts.push(formatToolResultItem(item, callNames, { latest: idx === items.length - 1 }));
    } else if (item.role || item.type === 'message') {
      const text = extractTextFromContent(item.content);
      if (!text) return;
      // Label context so the model never mistakes injected app/developer blocks for the user's request
      if (isInstructionRole(item)) {
        parts.push(`[DEVELOPER INSTRUCTIONS]:\n${text.trim()}`);
      } else if (isSyntheticUserText(text)) {
        if (items.length === 1) parts.push(`[CONTEXT]:\n${text.trim()}`);
      } else {
        parts.push(outputs.length ? `[USER]:\n${text.trim()}` : text.trim());
      }
    }
  });
  if (outputs.length) {
    parts.push('Continue your task using these tool results. Remember to stay within the active workspace.');
  }
  return parts.join('\n\n');
}

// Formats one history item for a full-history prompt; `old` items get compacted harder
function formatHistoryItem(item, callNames, old) {
  if (!item) return '';
  if (isToolOutputItem(item)) {
    return formatToolResultItem(item, callNames, { maxChars: old ? OLD_TOOL_OUTPUT_MAX_CHARS : TOOL_OUTPUT_MAX_CHARS });
  }
  if (TOOL_CALL_TYPES.has(item.type)) {
    const name = item.name || item.call_id || 'tool_call';
    const rawArgs = item.arguments ?? item.input ?? item.action ?? {};
    const argsStr = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
    return `[ACTION ${name}${item.call_id ? ' ' + item.call_id : ''}]:\n${old ? truncateMiddle(argsStr, OLD_ARGS_MAX_CHARS) : argsStr}`;
  }
  if (item.role || item.type === 'message') {
    let text = extractTextFromContent(item.content);
    if (!text) return '';
    if (item.role === 'assistant') {
      text = text
        .replace(/سلام!?[^\n]*\n+/gi, '')
        .replace(/با توجه به لیست مشکلاتی که دادی[\s\S]*?(?:اول بذار کد رو دقیق‌تر بررسی کنم:?|اول باید کد رو دقیق‌تر ببینم:?|\n\n)/gi, '')
        .replace(/(?:\s*[-*_]{3,}\s*){2,}/g, '\n\n---\n\n')
        .replace(/(?:\s*[-*_]{3,}\s*)+$/g, '')
        .replace(/^(?:\s*[-*_]{3,}\s*)+/g, '')
        .trim();
    }
    if (text) return `[${(item.role || 'user').toUpperCase()}]:\n${old ? truncateMiddle(text, OLD_ARGS_MAX_CHARS * 2) : text}`;
  }
  return '';
}

// Fits the conversation into `budget` characters: the first real user request and the most recent
// items are always kept; the oldest middle steps are dropped with an explicit marker.
function formatHistoryWithinBudget(input, callNames, budget) {
  const recentFrom = Math.max(0, input.length - RECENT_ITEMS_KEPT_VERBATIM);
  const entries = input.map((item, idx) => formatHistoryItem(item, callNames, idx < recentFrom));
  const total = entries.reduce((n, e) => n + (e ? e.length + 7 : 0), 0);
  if (!Number.isFinite(budget) || total <= budget) return entries.filter(Boolean);

  // Anchor: leading user/system messages up to and including the first real user request
  let anchorEnd = 0;
  for (let i = 0; i < input.length; i++) {
    const it = input[i];
    if (isModelItem(it) || isToolOutputItem(it)) break;
    anchorEnd = i + 1;
    if (it?.role === 'user' && !isSyntheticUserText(extractTextFromContent(it.content))) break;
  }
  const anchor = entries.slice(0, anchorEnd).filter(Boolean);
  const anchorSize = anchor.reduce((n, e) => n + e.length + 7, 0);

  // Oldest steps are dropped in fixed blocks of TRIM_BLOCK_ITEMS, so the cut point (and with it the
  // whole prompt prefix) stays the same for many turns. Providers bill cached prefix tokens at a
  // fraction of the price; trimming one item per turn would change the prefix every time.
  const size = i => (entries[i] ? entries[i].length + 7 : 0);
  const suffix = new Array(entries.length + 1).fill(0);
  for (let i = entries.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + size(i);
  let cut = anchorEnd;
  while (cut < entries.length - 1 && anchorSize + suffix[cut] > budget) {
    cut = Math.min(entries.length - 1, cut + TRIM_BLOCK_ITEMS);
  }
  // A single huge recent item can still exceed the budget: keep at least the newest one
  const tail = entries.slice(cut).filter(Boolean);
  const omitted = entries.slice(anchorEnd, cut).filter(Boolean).length;
  if (omitted === 0) return [...anchor, ...tail];
  const marker = `[HISTORY TRIMMED]: ${omitted} earlier steps of this task were omitted here to fit the context window. They were ALREADY EXECUTED in the workspace; their effects (created/edited files, installed packages) are real. Do NOT redo them; inspect files if you need details.`;
  return [...anchor, marker, ...tail];
}

export const DEFAULT_HISTORY_BUDGET = Number(process.env.FULL_PROMPT_MAX_CHARS) || 120000;

export function buildPromptFromResponsesInput({
  instructions,
  input,
  tools,
  isContinuation = false,
  isFailover = false,
  interruptedContext = null,
  maxChars = DEFAULT_HISTORY_BUDGET
}) {
  if (typeof input === 'string') {
    if (isContinuation) return input.trim();
    const parts = [WORKSPACE_DIRECTIVE];
    if (instructions) parts.push(`[System Instructions]\n${instructions.trim()}`);
    if (tools?.length) parts.push(formatToolsInstruction(tools));
    parts.push(input.trim());
    return parts.filter(Boolean).join('\n\n---\n\n');
  }

  if (!Array.isArray(input) || input.length === 0) {
    const parts = [WORKSPACE_DIRECTIVE];
    if (instructions) parts.push(`[System Instructions]\n${instructions.trim()}`);
    return parts.join('\n\n---\n\n');
  }

  const callNames = collectCallNames(input);

  // Same account + same upstream session: DeepSeek already holds the history, send only what is new
  if (isContinuation) {
    const incremental = formatIncremental(getIncrementalItems(input), callNames);
    if (incremental.trim()) return incremental;
  }

  // For a new session or failover migration to another account, inject full history
  const parts = [WORKSPACE_DIRECTIVE];

  if (instructions && typeof instructions === 'string') {
    parts.push(`[System Instructions]\n${instructions.trim()}`);
  }

  if (Array.isArray(tools) && tools.length > 0) {
    parts.push(formatToolsInstruction(tools));
  }

  const fixedChars = parts.reduce((n, p) => n + p.length + 7, 0) + FAILOVER_NOTICE.length;
  // Never let the fixed preamble starve the history completely
  const historyBudget = Math.max(maxChars - fixedChars, Math.floor(maxChars * 0.4));
  parts.push(...formatHistoryWithinBudget(input, callNames, historyBudget));

  if (interruptedContext?.content && typeof interruptedContext.content === 'string' && interruptedContext.content.trim()) {
    parts.push(`[PREVIOUS MODEL IMMEDIATE STATE RIGHT BEFORE HANDOFF]:
Right before the account switch occurred, the previous model had initiated this step:
"""
${interruptedContext.content.trim()}
"""
You MUST pick up directly from this exact step, execute the required tool call, and complete the action.`);
  }

  if (hasPriorModelActivity(input)) {
    const lastItem = input[input.length - 1];
    const isLatestToolOutput = isToolOutputItem(lastItem);
    const isLatestUserMessage = !isLatestToolOutput && (lastItem?.role === 'user' || (lastItem?.type === 'message' && lastItem?.role !== 'assistant'));

    if (isLatestUserMessage) {
      parts.push(isFailover ? USER_QUESTION_FAILOVER_NOTICE : USER_QUESTION_PROGRESS_NOTICE);
    } else {
      parts.push(isFailover ? FAILOVER_NOTICE : PROGRESS_NOTICE);
    }
  }

  return parts.filter(Boolean).join('\n\n---\n\n');
}

// Codex declares apply_patch either as a freeform "custom" tool or as a function with an `input`
// (newer) or `patch` (older) parameter. Shape each parsed call to match the declared tool.
export function adaptCallsForTools(calls, tools) {
  if (!Array.isArray(calls) || calls.length === 0) return calls || [];
  const declared = new Map();
  for (const tool of Array.isArray(tools) ? tools : []) {
    const name = tool?.function?.name || tool?.custom?.name || tool?.name;
    const isCustom = tool?.type === 'custom' || Boolean(tool?.custom) || (!tool?.function && tool?.type !== 'function');
    const props = tool?.parameters?.properties || tool?.function?.parameters?.properties || tool?.custom?.parameters?.properties || {};
    if (name) {
      declared.set(name, { kind: isCustom ? 'custom' : 'function', props });
    }
  }
  return calls.map(call => {
    if (call.name !== 'apply_patch') return { ...call, kind: 'function' };
    const decl = declared.get('apply_patch');
    let args = {};
    try { args = JSON.parse(call.arguments || '{}'); } catch {}
    const patch = args.patch ?? args.input ?? '';
    if (decl?.kind === 'custom') {
      return { ...call, kind: 'custom', input: patch };
    }
    if (decl && decl.props.input && !decl.props.patch) {
      return { ...call, kind: 'function', arguments: JSON.stringify({ input: patch }) };
    }
    return { ...call, kind: 'function', arguments: JSON.stringify({ patch }) };
  });
}

export function buildPromptFromChatMessages({ messages, tools }) {
  const parts = [WORKSPACE_DIRECTIVE];

  if (Array.isArray(tools) && tools.length > 0) {
    parts.push(formatToolsInstruction(tools));
  }

  if (Array.isArray(messages)) {
    for (const msg of messages) {
      const text = extractTextFromContent(msg.content);
      if (!text && !msg.tool_calls) continue;

      if (msg.role === 'system') {
        parts.push(`[SYSTEM]:\n${text}`);
      } else if (msg.role === 'user') {
        parts.push(`[USER]:\n${text}`);
      } else if (msg.role === 'assistant') {
        parts.push(`[ASSISTANT]:\n${text}`);
      } else if (msg.role === 'tool') {
        const callId = msg.tool_call_id ? ` (call_id: ${msg.tool_call_id})` : '';
        parts.push(`[TOOL RESULT${callId}]:\n${text}\nContinue your response using this result.`);
      }
    }
  }

  return parts.filter(Boolean).join('\n\n---\n\n');
}

// Codex runs every call of one turn at the same time. Models (Gemini especially) often emit a
// whole script as one batch — write files, then build, then run — and those race: the build
// starts before the files exist and every step fails. A batch is therefore cut right after its
// first state-changing call; read-only batches stay parallel up to MAX_PARALLEL_CALLS. The model
// sees the results and issues the remaining steps in the next turn.
export const MAX_PARALLEL_CALLS = 8;
const MUTATING_TOOLS = new Set(['apply_patch', 'write_stdin']);
const MUTATING_CMD_RE = /(?:^|[;&|(\n]\s*)(?:sudo\s+)?(?:rm|mv|cp|mkdir|rmdir|touch|tee|ln|chmod|chown|truncate|dd|install|patch|make|cmake|ninja|ctest|meson|cargo|go\s+(?:build|test|run|mod)|npm|npx|yarn|pnpm|pip3?|python3?\s+-m\s+pip|apt(?:-get)?|git\s+(?:commit|checkout|switch|reset|apply|add|rm|mv|stash|merge|rebase|restore|clean|push|pull|clone|init)|sed\s+-i|perl\s+-[a-z]*i)\b|[^0-9&>]>{1,2}\s*(?!&|\/dev\/null)\S|^>{1,2}\s*\S/m;

function callCommand(call) {
  if (call.kind === 'custom') return '';
  try {
    const args = typeof call.arguments === 'string' ? JSON.parse(call.arguments || '{}') : (call.arguments || {});
    return typeof args.cmd === 'string' ? args.cmd : (Array.isArray(args.command) ? args.command.join(' ') : String(args.command || ''));
  } catch {
    return '';
  }
}

export function isMutatingCall(call) {
  if (!call) return false;
  if (MUTATING_TOOLS.has(call.name) || call.kind === 'custom') return true;
  return MUTATING_CMD_RE.test(callCommand(call));
}

export function limitCallBatch(calls, { parallel = true } = {}) {
  if (!Array.isArray(calls) || calls.length <= 1) return calls || [];
  if (parallel === false) return calls.slice(0, 1);
  const firstMutating = calls.findIndex(isMutatingCall);
  const cut = firstMutating === -1 ? MAX_PARALLEL_CALLS : Math.min(firstMutating + 1, MAX_PARALLEL_CALLS);
  return calls.slice(0, cut);
}
