import crypto from 'node:crypto';
import { extractTextFromContent, isSyntheticUserText } from './parser.js';
import { BoundedCache } from './sessionCache.js';
import { runAuxPrompt } from './auxModel.js';

// Trivial or short confirmations do not need LLM optimization
const MAX_OPTIMIZE_CHARS = 3000;
const TRIVIAL_INPUT_RE = /^(?:yes|no|ok|okay|continue|proceed|y|n|بله|خیر|ادامه|باشه|خب|موافقم|درسته|تایید|تمام|خوبه|[0-9]+)\.?$/i;

export function findLatestRealUserMessage(input) {
  if (!Array.isArray(input) || input.length === 0) return null;
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (!item) continue;
    // If the latest item is a tool output or assistant message, the turn is not a fresh user prompt
    if (item.type === 'function_call_output' || item.type === 'tool_result' || item.type === 'commandExecution' || item.role === 'assistant') {
      return null;
    }
    // developer/system messages (<app-context>, <collaboration_mode>, time context...) and Codex's
    // injected user-role context blocks sit next to the human's message; look past them
    if (item.role === 'user' || item.type === 'userMessage') {
      const text = extractTextFromContent(item.content);
      if (text && !isSyntheticUserText(text)) {
        return { index: i, item, text: text.trim() };
      }
    }
  }
  return null;
}

// Literal details a restatement must carry over: paths, file names, `code`, URLs, numbers, flags
const LITERAL_RE = /`[^`\n]+`|https?:\/\/\S+|(?:[\w.-]+\/)+[\w.-]+|\b[\w-]+\.[a-z]{1,5}\b|(?:^|\s)--?[a-z][\w-]*|\b\d+(?:\.\d+)?\b/gi;

export function extractLiterals(text) {
  return [...new Set((String(text).match(LITERAL_RE) || []).map(s => s.trim()).filter(s => s.length > 1))];
}

// The brief is only used when it kept (nearly) every literal detail of the request
export function isLosslessBrief(original, brief) {
  if (!brief || !/\[Goal\]/.test(brief) || !/\[Requirements\]/.test(brief)) return false;
  const literals = extractLiterals(original);
  if (literals.length === 0) return true;
  const kept = literals.filter(l => brief.includes(l)).length;
  return kept / literals.length >= 0.9;
}

// Retries of the same turn (Codex re-sends on failure) must not pay for the helper call again
const briefCache = new BoundedCache({ maxEntries: 300, ttlMs: 6 * 60 * 60 * 1000 });

export function buildOptimizerPrompt(userText) {
  return `You restructure a user's request for an autonomous coding agent into a precise execution brief.

USER REQUEST (verbatim):
"""
${userText}
"""

Hard rules:
- Keep EVERY requirement, constraint, preference, question, file name, path, command, number, code snippet and error message from the request. Copy literal details exactly (do not translate or reformat them).
- Do not drop, weaken, merge away or reinterpret anything. Do not add requirements, policies, approval steps or opinions the user did not state.
- If something is ambiguous, list it under [Open Points] instead of guessing.
- Write the brief in English, except copied literals.

Output EXACTLY this format and nothing else:
[Detected Language]: <language of the user request>
[Goal]: <one or two sentences>
[Requirements]:
- <every distinct instruction or constraint from the request, one per line>
[Key Areas]: <files, modules, commands or systems mentioned or clearly implied>
[Open Points]: <ambiguities, or "none">
[Language Directive]: Reply to the user in <language of the user request>.`;
}

export async function optimizePromptWithSupervisor({ userText, signal, avoidTokenId = null, timeoutMs = 8000 }) {
  if (!userText || typeof userText !== 'string') return null;
  const trimmed = userText.trim();
  if (trimmed.length < 5 || TRIVIAL_INPUT_RE.test(trimmed)) {
    return null;
  }
  // Long texts are already detailed (often Codex's own handoff summary after compaction); rewriting
  // them only loses details and spends a helper request
  if (trimmed.length > MAX_OPTIMIZE_CHARS || /CONTEXT\s+CHECKPOINT\s+COMPACTION|handoff\s+summary|checkpoint|compaction|خلاصه|وضعیت|گزارش|دستور/i.test(trimmed)) {
    return null;
  }

  const cacheKey = crypto.createHash('sha256').update(trimmed).digest('hex');
  const cached = briefCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const answer = await runAuxPrompt({
    prompt: buildOptimizerPrompt(trimmed),
    signal,
    timeoutMs,
    avoidTokenId,
    maxTokens: 2000,
    label: 'Optimizer',
    role: 'prompt',
    accept: brief => isLosslessBrief(trimmed, brief)
  });

  if (!answer) {
    if (!signal?.aborted) console.warn('[Optimizer] No lossless brief within budget; using the original prompt unchanged.');
    return null;
  }
  console.log(`[Optimizer] Built lossless execution brief (${answer.text.length} chars) via ${answer.accountId}.`);
  briefCache.set(cacheKey, answer.text);
  return answer.text;
}

export function formatOptimizedUserPrompt(originalText, supervisorContent) {
  if (!supervisorContent) return originalText;
  return `[USER ORIGINAL REQUEST]:
${originalText}

[SUPERVISOR COGNITIVE INTERPRETATION & SPECIFICATION]:
${supervisorContent}

(The original request above is authoritative. The specification only restructures it; if they ever differ, follow the original request.)`;
}
