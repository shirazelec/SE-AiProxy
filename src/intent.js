// Detects "announce-and-stop" turns: the model says what it is about to do but emits no tool call.
// Codex ends the task on any turn without a tool call, so these must be nudged to continue.

// Action verbs and phrases signaling work about to be performed (present/future intent only, never past tense)
const PERSIAN_ACTION_VERBS = /(?:\b|[\s‌])(?:می|نمی|ب)[\s‌]?(?:بین|خوان|نویس|سنج|زن|ساز|گیر|آور|بر)[یم](?![؀-ۿ])|[\s‌](?:[؀-ۿ]+)\s*(?:می\s*‌?\s*)?(?:کنم|کنیم|خواهم\s*کرد)(?![؀-ۿ])|[\s‌](?:[؀-ۿ]+)\s*(?:می\s*‌?\s*)?(?:دهم|دهیم|خواهم\s*داد)(?![؀-ۿ])|[\s‌](?:[؀-ۿ]+)\s*(?:می\s*‌?\s*)?(?:گیرم|گیریم|خواهم\s*گرفت)(?![؀-ۿ])|نگاه.*?(?:بیندازم|بندازم|می\s*‌?\s*اندازم|کنم|کنیم)(?![؀-ۿ])|(?:بریم|برویم|میرم|می‌روم|می‌ریم)\s*سراغ/i;
const ENGLISH_ACTION_VERBS = /(?:(?:let\s*me|let\s*us|let's|i\s*will|i'll|i\s*am|we\s*will|we'll|we\s*are|i\s*need\s*to|we\s*need\s*to|i\s*must|we\s*must|time\s*to)\s+(?:check|see|inspect|investigate|verify|confirm|validate|determine|ensure|audit|trace|test|examine|run|look|find|read|patch|edit|modify|apply|create|build|write|fix|add|update|implement|compile|print|dump|show|display|list|compare|diff|echo|measure|probe|profile|log|analyze|benchmark|extract)|\b(?:(?:now|next|first|then|temporarily|directly|quickly),?\s+)?(?:fixing|patching|instrumenting|adding|updating|modifying|implementing|writing|applying|creating|building|compiling|running|testing|checking|verifying|confirming|validating|inspecting|investigating|auditing|tracing|examining|reading|searching|locating|looking\s+into|printing|dumping|showing|displaying|listing|comparing|diffing|echoing|measuring|probing|profiling|logging|analyzing|benchmarking|extracting)\b|(?:now|next,?)\s+(?:i\s*will|i'll|let's|let\s*me|i\s*am|we\s*will|we'll)\s+(?:check|see|inspect|investigate|verify|confirm|validate|audit|trace|test|examine|run|look|find|read|patch|edit|modify|apply|create|build|write|fix|add|update|implement|compile|print|dump|show|display|list|compare|diff|echo|measure|probe|profile|log|analyze|benchmark|extract)|(?:next\s*step:?\s*|next:?\s*)(?:check|verify|confirm|validate|inspect|investigate|test|examine|run|read|patch|edit|fix|add|update|implement|print|dump|show|display|list|compare|diff))/i;
const CHINESE_ACTION_VERBS = /(?:让我(?:查看|检查|看一下|运行|测试|分析|修改|修复|打印|对比|确认)|我(?:将|会|准备)(?:查看|检查|看一下|运行|测试|分析|修改|修复|打印|对比|确认)|现在(?:开始|检查|查看))/;

// Past-tense references to previously executed work (should NOT be flagged as unfulfilled intent)
const PAST_TENSE_CUE = /(?:^|[\s‌])(?:بررسی|چک|تست|امتحان|اجرا|اصلاح|رفع|ویرایش|پچ|اعمال|تغییر|باز|حذف|پاک|چاپ|دامپ|مقایسه|اندازه‌گیری|اندازه|لاگ)?\s*(?:کردم|کردیم|دادم|دادیم|زدم|زدیم|دیدم|دیدیم|خواندم|خواندیم|نوشتم|نوشتیم|ساختم|ساختیم|گرفتم|گرفتیم)(?![؀-ۿ])/;
const ENGLISH_PAST_TENSE = /\b(?:i|we)\s+(?:have\s+|already\s+)?(?:ran|executed|tested|checked|inspected|verified|confirmed|validated|fixed|patched|modified|created|built|wrote|found|updated|added|did|printed|dumped|showed|displayed|listed|compared|diffed|echoed|measured|logged|analyzed)\b|\b(?:was|were|has\s+been|have\s+been)\s+(?:executed|tested|checked|verified|confirmed|validated|fixed|applied|printed|dumped|compared|displayed|built|compiled|updated|added)\b/i;
const CHINESE_DONE_CUE = /(?:已(?:完成|执行|测试|修复|检查|运行)|全部完成|修复完成|测试通过)/;

// First-person present/future verbs (e.g. I see, I do, I will write)
const PERSIAN_FIRST_PERSON = /(?:^|[\s‌])(?:می|نمی)[\s‌]?[؀-ۿ]+(?:م|یم)(?![؀-ۿ])|خواهی?م\s+[؀-ۿ]+/;
const ENGLISH_FIRST_PERSON = /\b(?:i'll|i\s+will|let\s+me|let's|i'm\s+going\s+to|i\s+am\s+going\s+to|i'm\s+now|now\s+i|next,?\s+i)\b/i;

// Words signalling that an action is about to start
const NEXT_STEP_CUE = /(?:حالا|الان|اکنون|اول|ابتدا|سپس|بعد|در\s*ادامه|یک‌جا|یکجا|\bnow\b|\bnext\b|\bfirst\b|\bthen\b|let\s+me|let's|i'll|going\s+to)/i;

// Completion reports and offers to the user are legitimate turn endings
export const DONE_CUE = /(?:انجام\s*شد|تمام\s*شد|کامل\s*شد|تکمیل\s*شد|اعمال\s*شد|رفع\s*شد|درست\s*شد|اصلاح\s*شد|پاس\s*شد|موفق|خلاصه|نتیجه|\bdone\b|\bcompleted?\b|\bfinished\b|\ball\s+set\b|\bsummary\b|\bpassed\b)/i;
// A bare «اگر» ("if") is not an offer: "…بررسی می‌کنم تا اگر کامنتی بود پاکش کنم" is still an announced
// action. Only a conditional addressed to the user ("اگر بخواهید", "در صورت تمایل") offers something.
const OFFER_CUE = /(?:اگر\s*(?:بخواهید|بخواین|بخوای|خواستید|مایل|تمایل|لازم\s*(?:بود|باشد|دانستید|می‌?\s*دانید)|صلاح|موافق|اجازه)|در\s*صورت\s*(?:تمایل|نیاز\s*شما|موافقت|صلاحدید)|بخواهید|خواستید|می‌?\s*توانم|میتونم|می‌تونم|بفرمایید|\bif\s+you\b|\bwould\s+you\b|\blet\s+me\s+know\b|\bi\s+can\b|\bshall\s+i\b)/i;
export const ASK_USER_CUE = /(?:لطفاً|لطفا|فرمایید|بفرمایید|تأیید\s*(?:کنید|فرمایید|نمایید)|تایید\s*(?:کنید|فرمایید|نمایید)|نظرتان|نظرتون|اطلاع\s*(?:دهید|بدید)|به\s*من\s*بگویید|بگید|انتخاب\s*کنید|پاسخ\s*دهید|کدام\s*(?:گزینه|روش|راهکار|راه|رو|یک)|ترجیح\s*می‌?دهید|ترجیح\s*می‌?دین|رمز\s*عبور\s*(?:را|خود)?\s*(?:وارد|بزنید)|پسورد\s*(?:را|خود)?\s*(?:وارد|بزنید)|\bplease\b|\bkindly\b|\blet\s*me\s*know\b|\btell\s*me\b|\bwhich\s*(?:option|one|approach|method|path)\b|\bdo\s*you\s*(?:want|prefer|wish)\b|\bwould\s*you\s*(?:like|prefer)\b|\bconfirm\s*once\s*(?:done|ready|finished)\b|\b(?:can|could)\s*you\s*confirm\b|\bwaiting\s+for\s+(?:your\s+)?confirm|\b(?:enter|provide|input|type|share|give|send)\s+(?:the\s+|your\s+)?(?:password|token|credential|credentials|sudo\s+password|api\s*key)\b|\bneed\s+your\s+(?:password|token|credential|credentials|sudo\s+password|api\s*key)\b|\bsudo\s+password\b)/i;

/**
 * Detects whether the text is a comprehensive final deliverable report or handoff summary.
 * Used to immediately recognize completed turns and prevent supervisor intervention loops.
 */
export function isFinalDeliverableReport(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length < 250) return false;

  const hasReportHeader = /(?:##?\s*.*(?:گزارش\s*(?:نهایی|وضعیت)|handoff\s+summary|final\s+report|status\s+report|task\s+summary)|###\s*وضعیت:\s*کار\s*مجاز\s*تکمیل)/i.test(trimmed);
  const hasStructuredBody = /\|[^\n]+\|[^\n]+\|\n\|[-:\s|]+\|/.test(trimmed) || (trimmed.match(/(?:^|\n)\s*[-*•\d+.]\s+/g) || []).length >= 3;
  const hasCompletionVerification = /(?:هر\s*شش\s*پیکربندی\s*PASS|تست‌ها\s*سبزند|ساخته\s*و\s*تست\s*شد|all\s+\d+\s+tests\s+pass|builds?\s+pass|tests?\s+pass)/i.test(trimmed);

  return hasReportHeader && (hasStructuredBody || hasCompletionVerification);
}

const MAX_INTENT_TEXT = 450;

function lastSentence(text) {
  const parts = text.split(/(?:[.!?؟]+(?=\s|$)|[…\n]+)/).map(p => p.trim()).filter(p => p.length > 2);
  return parts.length ? parts[parts.length - 1] : '';
}

// A shell command written as a plain line of text (outside a ``` fence), e.g.
//   cd "/home/me/project" && sed -n '1,40p' src/app.c
// Models that slip out of the tool-call format print the commands they meant to run; the turn then
// ends with nothing executed. A final report quotes commands inline (`make`) or in a fence instead.
const BARE_COMMAND_LINE = /^[ \t]*(?:\$[ \t]*)?(?:cd|sed|grep|rg|cat|ls|find|make|cmake|meson|ninja|npm|npx|node|python3?|pip3?|git|bash|sh|gcc|g\+\+|cc|head|tail|awk|rm|cp|mv|mkdir|chmod|dpkg|dpkg-deb|apt|apt-get|cargo|go|pkg-config|ldd|file|stat|wc|diff|xxd|strings|timeout)[ \t]+\S[^\n]*$/m;

export function hasBareShellCommand(text) {
  if (!text) return false;
  const outsideFences = String(text).replace(/```[\s\S]*?(?:```|$)/g, '');
  // Prose can start with "find" / "file" / "make": also require something only a command line has
  // (a flag, path, quote, pipe, && or redirect)
  return outsideFences.split('\n').some(line =>
    BARE_COMMAND_LINE.test(line) && /(?:\s-{1,2}[A-Za-z]|&&|\||[\/"'`]|>|<)/.test(line));
}

export function isUnfulfilledIntent(text) {
  if (!text) return false;
  if (hasBareShellCommand(text)) return true;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > MAX_INTENT_TEXT) return false;

  // Structural cue 1: Fenced code blocks indicate an informational answer or code deliverable, never a mere intent announcement
  if (/```[\s\S]+?```/.test(trimmed)) return false;

  // Structural cue 2: Markdown tables indicate structured output or comparison data
  if (/\|[^\n]+\|[^\n]+\|\n\|[-:\s|]+\|/.test(trimmed)) return false;

  // Structural cue 3: Multiple bullet points (3+) indicate an explanatory list or summary
  const bullets = trimmed.match(/(?:^|\n)\s*[-*•\d+.]\s+/g);
  if (bullets && bullets.length >= 3) return false;

  // Asking the user a question: the turn is legitimately waiting for an answer
  if (/[؟?]\s*$/.test(trimmed) || /[؟?]/.test(trimmed)) return false;

  const last = lastSentence(trimmed);
  if (!last) return false;
  if (OFFER_CUE.test(last) || DONE_CUE.test(last) || CHINESE_DONE_CUE.test(last) || ASK_USER_CUE.test(last)) return false;

  // Do not flag statements describing past actions (e.g. past executed commands, "I verified the tests")
  const isPast = PAST_TENSE_CUE.test(last) || ENGLISH_PAST_TENSE.test(last);
  if (isPast && !NEXT_STEP_CUE.test(last)) return false;

  const hasEllipsis = /(?:\.{2,}|…|:)\s*$/.test(trimmed);
  const firstPerson = PERSIAN_FIRST_PERSON.test(last) || ENGLISH_FIRST_PERSON.test(last);
  if (firstPerson && (NEXT_STEP_CUE.test(last) || hasEllipsis)) return true;

  // Direct action intent in the final sentence across supported languages
  if (PERSIAN_ACTION_VERBS.test(last) || ENGLISH_ACTION_VERBS.test(last) || CHINESE_ACTION_VERBS.test(last)) return true;

  return false;
}

const IGNORED_ERRORS = /(?:Failed to create stream fd|could not read Username|Username for|Password for|Permission denied \(publickey\)|terminal is required to read the password)/i;

// Extracts recent compilation, build, or runtime errors from the latest tool outputs
export function extractRecentErrorFromInput(input) {
  if (!Array.isArray(input) || input.length === 0) return null;
  const errorRegex = /(?:error:|fatal\s+error:|make:\s+\*\*\*|Traceback\s+\(most\s+recent\s+call\s+last\):|undefined\s+reference|cannot\s+find\s+-l|syntax\s*error|npm\s+ERR!|command\s+not\s+found|FAILED\b)/i;
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (!item) continue;
    if (item.type === 'function_call_output' || item.type === 'tool_result' || item.type === 'commandExecution') {
      const out = typeof item.output === 'string' ? item.output : (typeof item.content === 'string' ? item.content : JSON.stringify(item.output || ''));
      if (!out || out.length < 5) continue;
      if (errorRegex.test(out)) {
        const lines = out.split('\n');
        const errLines = lines.filter(l => (errorRegex.test(l) || /:\s+warning:|\^~+/i.test(l)) && !IGNORED_ERRORS.test(l));
        if (errLines.length > 0) {
          return errLines.slice(-12).join('\n').slice(0, 800);
        }
      }
    }
    // Only inspect the latest contiguous block of tool outputs
    if (item.role === 'assistant' || item.role === 'user') break;
  }
  return null;
}

// Codex's own history-compaction request expects a plain summary, never a tool call
export function isCompactionRequest(input) {
  if (!Array.isArray(input) || input.length === 0) return false;
  // If the last item is a tool result, this is continuing a tool turn, never compaction
  const last = input[input.length - 1];
  if (last?.type === 'function_call_output' || last?.type === 'tool_result' || last?.type === 'commandExecution') {
    return false;
  }
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (!item) continue;
    // If an assistant message or tool call is found first, this turn is not a fresh user compaction request
    if (item.role === 'assistant' || item.type === 'function_call') return false;
    if (item.role === 'user') {
      const parts = Array.isArray(item.content) ? item.content : [item.content];
      const text = parts.map(p => (typeof p === 'string' ? p : p?.text || p?.input_text || '')).join('\n');
      return /CONTEXT\s+CHECKPOINT\s+COMPACTION/i.test(text);
    }
  }
  return false;
}
