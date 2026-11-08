import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isUnfulfilledIntent, isCompactionRequest, extractRecentErrorFromInput, isFinalDeliverableReport } from '../src/intent.js';
import { parseToolCalls } from '../src/parser.js';

const args = (call) => JSON.parse(call.arguments);

describe('isUnfulfilledIntent', () => {
  const stops = [
    // Real turns from a Codex log that ended the task without a tool call
    '`pw-cat` نصب است و libadwaita هم موجود. دو ایراد واقعی پیدا کردم: AudioPlayer اصلاً رویداد پایان ندارد؛ ضمناً دستور pw-cat باید ورودی stdin را صریح بگیرد. حالا کد فولدر و پخش را می‌بینم و بعد یک‌جا اصلاح می‌کنم....',
    'کد فعلی از قبل DropTarget و کنترلر کلید را دارد؛ حالا مسیر پخش صدا، پایان آهنگ و فول‌اسکرین را دقیق بررسی می‌کنم....',
    'محل کار: /home/x. اول وضعیت واقعی اجرا را چک می‌کنم تا علت‌ها را دقیق ببندم.',
    'Found the bug. Now I will patch the decoder.',
    'I will run the tests and inspect the logs now.',
    'Let me check the database configuration...',
    'پیدا شد: فایل‌های MP3 کاور آلبوم جاسازی‌شده دارند و به‌عنوان «ویدیو» تشخیص داده می‌شدند. کد probe را دقیق می‌بینم.',
    'بگذار ببینم...',
    '让我检查一下代码中的错误...',
    '现在开始检查音频解码器的逻辑。',
    "Now checking NanoSVG redirect coverage and whether QR's intermediate buffers bypass its static mode.",
    "Verifying pool alignment satisfies rlottie's SIMD requirements.",
    "Found the JPEG clamp rule: `setCropArea` drops a whole MCU when the window reaches the right edge, so my pre-check must use the MCU-rounded width. Fixing that, and instrumenting the SVG tile failure.",
    "Both remaining failures need real diagnosis. Adding a temporary result-code print in the tile decode path.",
    "Updating CMakeLists.txt to link the library.",
    "The checker or the dump has a systematic offset. Printing raw pixels from one pair to see the actual difference.",
    "حالا سهم دقیق هر بخش و Fragmentation را اندازه می‌گیرم.",
    "Dumping the memory buffer to analyze the offset.",
    "I need to confirm whether `lwmem_alloc` can relocate existing blocks — that decides the Object allocation design.",
    "Checking the compiler options before compiling.",
    'پیش از پاسخ نهایی، فایل‌های سورس را بررسی می‌کنم تا اگر کامنت فارسی اضافه شده باشد، آن را پاک کنم.',
    "باگ پیدا شد: رویداد PARENT روی والد جدید منتشر میشود، ولی هندلر روی Widget منتقلشده است. حالت را با API عمومی set_parent هماهنگ میکنم."
  ];
  for (const text of stops) {
    test(`flags: ${text.slice(-40)}`, () => assert.equal(isUnfulfilledIntent(text), true));
  }

  const finals = [
    'هر پنج مورد اصلاح شد و برنامه بدون خطا اجرا می‌شود.',
    'اگر بخواهید می‌توانم تم تیره هم اضافه کنم.',
    'در صورت تمایل می‌توانم تست‌های بیشتری هم اضافه کنم.',
    'کدام گزینه را ترجیح می‌دهید؟',
    'تغییرات اعمال شد. برای اجرا: python3 -m nava',
    'All five fixes are done and tests passed.',
    'I executed all commands and verified that the player runs.',
    'همچنین دستورهایی که من در ابزار اجرا کردم در history ترمینال تو ثبت نمی‌شوند، چون در یک shell جداگانه اجرا شده‌اند.',
    'برنامه را با دستور زیر اجرا کنید و نتیجه را به من بگویید',
    'برای ادامه نیاز به پکیج libsdl2-dev است. لطفاً دستور sudo apt install libsdl2-dev را اجرا کرده و تأیید کنید.',
    'آیا مایلید از کتابخانه SDL استفاده کنیم یا روش دیگر؟',
    'لطفاً پسورد را وارد کرده و اجرای دستور را تایید نمایید.',
    'Please run sudo apt install libsdl2-dev and confirm once done.',
    'Which option do you prefer to proceed with?',
    'دو راهکار وجود دارد: گزینه ۱ استفاده از بافر استاتیک و گزینه ۲ استفاده از هیپ. کدام گزینه را ترجیح می‌دهید؟',
    'Before modifying files, here are two options with pros and cons. Which approach do you prefer?',
    'x'.repeat(2000) + ' حالا بررسی می‌کنم...',
    'You can view previous commands with:\n```bash\nhistory 50\n```\nHope this helps!',
    '| File | Status |\n|---|---|\n| app.py | fixed |\nReady to use.',
    '- First step completed\n- Second step fixed\n- Audio working properly',
    'I printed the raw pixels and found no mismatch.',
    'All output logs were printed and dumped to disk.',
    'We validated and confirmed all 10 tests.',
    'اندازه بافر را گرفتم و مشکلی نبود.',
    '所有测试已通过，程序已修复完成。',
    '我已执行测试，音频播放正常。'
  ];
  for (const text of finals) {
    test(`does not flag: ${text.slice(-40)}`, () => assert.equal(isUnfulfilledIntent(text), false));
  }
});

describe('isCompactionRequest', () => {
  test('recognizes the Codex compaction prompt', () => {
    const input = [{ role: 'user', content: [{ type: 'input_text', text: 'You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary...' }] }];
    assert.equal(isCompactionRequest(input), true);
    assert.equal(isCompactionRequest([{ role: 'user', content: 'fix the bug' }]), false);
  });

  test('does not mistake normal handoff summary in history for a compaction request', () => {
    const input = [
      { role: 'user', content: 'Here is what was done: # Handoff Summary — Nava Studio' },
      { role: 'assistant', content: 'Working on it' },
      { type: 'function_call_output', output: 'error' }
    ];
    assert.equal(isCompactionRequest(input), false);
  });
});

describe('extractRecentErrorFromInput', () => {
  test('extracts compilation error lines from tool outputs', () => {
    const sampleOutput = `cc -Isrc -c src/app.c -o build/app.o
src/app.c:1248:22: error: implicit declaration of function 'gtk_toggle_button_new_from_icon_name'
make: *** [Makefile:35: build/app.o] Error 1`;
    const input = [{ type: 'function_call_output', output: sampleOutput }];
    const extracted = extractRecentErrorFromInput(input);
    assert.ok(extracted);
    assert.ok(extracted.includes('error: implicit declaration of function'));
    assert.ok(extracted.includes('make: ***'));
  });

  test('returns null when tool output is clean or successful', () => {
    const input = [{ type: 'function_call_output', output: 'All 15 tests passed.' }];
    assert.equal(extractRecentErrorFromInput(input), null);
  });
});

describe('extra tool-call formats', () => {
  const cases = {
    'named <tool_call name=...> (previously lost entirely)': '<tool_call name="exec_command"><parameter name="cmd">ls</parameter></tool_call>',
    'named <function name=...>': '<function name="exec_command"><parameter name="cmd">ls</parameter></function>',
    '<function=...> with <parameter=...>': '<function=exec_command><parameter=cmd>ls</parameter></function>',
    'JSON inside <tool_call>': '<tool_call>{"name":"exec_command","arguments":{"cmd":"ls"}}</tool_call>',
    'JSON with string arguments': '<tool_call>{"name":"exec_command","arguments":"{\\"cmd\\":\\"ls\\"}"}</tool_call>',
    'missing invoke synthesized from parameter': '<tool_calls>\n<parameter name="cmd" string="true">ls</parameter>\n</invoke>\n</tool_calls>',
    'DeepSeek native tokens': '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>exec_command\n```json\n{"cmd":"ls"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>'
  };
  for (const [name, raw] of Object.entries(cases)) {
    test(name, () => {
      const { calls, cleanContent } = parseToolCalls('Running it.\n' + raw);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].name, 'exec_command');
      assert.equal(args(calls[0]).cmd, 'ls');
      assert.equal(cleanContent, 'Running it.');
    });
  }

  test('unnamed <tool_call> wrapper around an invoke still works', () => {
    const { calls } = parseToolCalls('<tool_call><invoke name="exec_command"><parameter name="cmd">pwd</parameter></invoke></tool_call>');
    assert.equal(args(calls[0]).cmd, 'pwd');
  });
});

describe('isFinalDeliverableReport', () => {
  test('recognizes comprehensive Persian final reports from Codex/DeepSeek', () => {
    const persianReport = `## G.11.1 — گزارش نهایی
### وضعیت: کار مجاز تکمیل، ساخته و تست شد؛ بستن فاز نیازمند تصمیم شماست
آخرین اجرا: هر شش پیکربندی PASS · HEAD=d6a5235 · ۱۵۴ ورودی Working Tree.
### ۱. Scratch منتقل‌شده به lwmem
| فایل | تغییر |
|---|---|
| draw/lw_gui_shapes.c | رئوس چندضلعی → lwmem هر فراخوانی |
| draw/lw_gui_text.c | شش بافر per-line → lwmem هر فراخوانی |
تصمیم‌گیری نهایی درباره موارد استثنا با شماست.`;

    assert.equal(isFinalDeliverableReport(persianReport), true);
  });

  test('recognizes comprehensive English handoff summaries', () => {
    const englishReport = `# G.11.1 Handoff Summary — Runtime Scratch, Mutable State, and Lifetime Compliance
## 1. Current Progress
**Phase status:** G.0–G.11 closed. G.11.1 in progress — the authorized work is implemented, built, and tested; all 6 tests pass.
- Task 1: verified and passing
- Task 2: dynamic allocation converted
- Task 3: documentation updated`;

    assert.equal(isFinalDeliverableReport(englishReport), true);
  });

  test('does not flag short intermediate text as final deliverable report', () => {
    assert.equal(isFinalDeliverableReport('حالا تست‌ها را اجرا می‌کنم.'), false);
    assert.equal(isFinalDeliverableReport('I will check the files now.'), false);
    assert.equal(isFinalDeliverableReport('All done!'), false);
    assert.equal(isFinalDeliverableReport(null), false);
  });
});

describe('commands written as text instead of tool calls', () => {
  test('bare shell command lines mean the work was not done', async () => {
    const { isUnfulfilledIntent, hasBareShellCommand } = await import('../src/intent.js');
    const text = 'باگ را ردیابی می‌کنم: مسیر کامل را می‌خوانم.\n\ncd "/home/me/app" && sed -n \'/^static void switch_track/,/^}/p\' src/app.c\n\ncd "/home/me/app" && ...';
    assert.ok(hasBareShellCommand(text));
    assert.ok(isUnfulfilledIntent(text));
    assert.ok(hasBareShellCommand('grep -n "eof" src/engine.c'));
  });

  test('commands quoted in a fence or inline, and ordinary prose, are not flagged', async () => {
    const { hasBareShellCommand } = await import('../src/intent.js');
    assert.ok(!hasBareShellCommand('کار تمام شد. برای نصب:\n```bash\nsudo dpkg -i dist/app.deb\n```'));
    assert.ok(!hasBareShellCommand('Build passed and `make test` is green.'));
    assert.ok(!hasBareShellCommand('find the bug was hard\nmake sure tests pass'));
  });
});
