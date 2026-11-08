import crypto from 'node:crypto';
import { runAuxPrompt, hasRoleAccount } from './auxModel.js';
import { BoundedCache } from './sessionCache.js';
import { recentToolCalls } from './repeatGuard.js';

// Role C ("debug"): when the latest command failed, a dedicated debugger account reads the error and
// writes a short root-cause diagnosis that is handed to the worker with its next prompt. Runs only
// when an account has the debug role, so pools without one keep their previous behaviour.

const diagnosisCache = new BoundedCache({ maxEntries: 200 });

export function buildDiagnosisPrompt({ goal, command, errorText, outputTail }) {
  return `You are the debugger of an autonomous coding agent. Its last command failed. Find the root cause and the concrete fix.

Task goal:
"""
${(goal || '(not available)').slice(0, 1200)}
"""

Failed command:
"""
${(command || '(unknown)').slice(0, 600)}
"""

Error lines:
"""
${errorText.slice(0, 1500)}
"""
${outputTail ? `\nOutput tail:\n"""\n${outputTail.slice(-1500)}\n"""\n` : ''}
Reply in at most 8 short lines, in English:
1. Root cause (file:line when the error shows it).
2. The exact fix (what to change, or the corrected command).
3. How to verify it.
Do not repeat the error text and do not add anything else.`;
}

function describeLastCommand(input) {
  const last = recentToolCalls(input, 1)[0];
  if (!last) return null;
  const cmd = last.args?.cmd ?? last.args?.command ?? last.args?.input ?? last.args?.patch;
  return Array.isArray(cmd) ? cmd.join(' ') : (cmd ? String(cmd) : last.name);
}

export async function diagnoseToolError({ input, goal, errorText, outputTail = null, avoidTokenId = null, signal = null, timeoutMs = 60000 }) {
  if (!errorText || !hasRoleAccount('debug')) return null;
  const command = describeLastCommand(input);
  const key = crypto.createHash('sha256').update(`${command}\n${errorText}`).digest('hex');
  const cached = diagnosisCache.get(key);
  if (cached !== undefined) return cached;

  const answer = await runAuxPrompt({
    prompt: buildDiagnosisPrompt({ goal, command, errorText, outputTail }),
    signal,
    timeoutMs,
    avoidTokenId,
    maxTokens: 1500,
    label: 'Debugger',
    role: 'debug',
    accept: text => text.trim().length >= 20
  });
  if (!answer) return null;
  const text = answer.text.trim().slice(0, 1500);
  console.log(`[Debugger] Diagnosis ready via ${answer.accountId} (${text.length} chars).`);
  diagnosisCache.set(key, text);
  return text;
}

export function formatDiagnosisNote(diagnosis) {
  return diagnosis
    ? `\n\n[DEBUGGER NOTE]: A debugging assistant analysed the failed command above. Its diagnosis (verify it against the code before acting on it):\n${diagnosis}`
    : '';
}
