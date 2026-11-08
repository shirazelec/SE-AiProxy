import { runAuxPrompt } from './auxModel.js';

export function buildJudgePrompt({ text, goal, isFollowingTool, recentError, toolOutputTail }) {
  return `You supervise an autonomous coding agent. Decide whether its turn is complete or it stopped prematurely.

User's goal for this task:
"""
${(goal || '(not available)').slice(0, 1200)}
"""

Turn context:
- The agent just received tool/command output: ${isFollowingTool ? 'YES' : 'NO'}
- Unresolved command/compiler error: ${recentError ? `YES\n"""\n${recentError.slice(0, 600)}\n"""` : 'NO'}
${toolOutputTail ? `- Latest tool output (tail):\n"""\n${toolOutputTail.slice(-800)}\n"""\n` : ''}
The agent's reply (it contains NO tool call):
"""
${text.slice(-1800)}
"""

Answer CONTINUE when any of these hold:
1. It announced a next action, plan or fix (in any language) but did not perform it.
2. Work toward the goal is clearly unfinished (steps remain, errors unresolved, nothing verified) and it simply stopped.
3. It asks the user for permission or preferences about something the goal already asked it to do.

Answer STOP when any of these hold:
1. The goal is achieved and the reply reports the result (a final summary or report).
2. It needs input only a human can give (credentials, passwords, missing API keys, a decision the goal leaves open).
3. The goal was a question and the reply answers it.

Reply with ONE word: CONTINUE or STOP.`;
}

/**
 * Supervisor verdict on a turn that ended without a tool call.
 * Runs on a helper account (never the busy main account) and returns 'CONTINUE', 'STOP' or null
 * when no helper answered in time (callers then fall back to heuristics).
 */
export async function judgeTurnCompletion({
  text,
  goal = null,
  isFollowingTool = false,
  recentError = null,
  toolOutputTail = null,
  avoidTokenId = null,
  signal = null,
  timeoutMs = 9000
}) {
  if (!text || typeof text !== 'string' || !text.trim()) return null;

  const answer = await runAuxPrompt({
    prompt: buildJudgePrompt({ text: text.trim(), goal, isFollowingTool, recentError, toolOutputTail }),
    signal,
    timeoutMs,
    avoidTokenId,
    maxTokens: 400,
    label: 'TurnJudge',
    role: 'debug',
    accept: reply => /\b(?:CONTINUE|STOP)\b/i.test(reply)
  });
  if (!answer) {
    if (!signal?.aborted) console.warn('[TurnJudge] No helper verdict in time; falling back to heuristic regexes.');
    return null;
  }
  // Reasoning-style helpers may think out loud first; the verdict is the last keyword they wrote
  const verdicts = answer.text.toUpperCase().match(/\b(?:CONTINUE|STOP)\b/g);
  return verdicts[verdicts.length - 1];
}
