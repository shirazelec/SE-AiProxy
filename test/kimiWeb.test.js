import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveKimiModel, buildKimiChatRequest, KIMI_MODELS } from '../src/kimiWeb.js';

describe('Kimi Web model mapping (kimi.ai GetAvailableModels ids)', () => {
  test('unknown, legacy and empty names use Instant with thinking', () => {
    for (const m of [undefined, '', 'kimi', 'k1.5-thinking', 'thinking', 'instant', 'k2d6-chat', 'whatever']) {
      assert.equal(resolveKimiModel(m).id, 'k2d6-chat', String(m));
    }
  });

  test('K3 / 3.1 Pro names map to the K3 agent model', () => {
    for (const m of ['k3', 'K3', 'k3-agent', 'k3.1', 'k3.1 pro', 'kimi-k3.1-pro', '3.1 pro', 'pro']) {
      assert.equal(resolveKimiModel(m).id, 'k3-agent', m);
    }
    assert.equal(resolveKimiModel('k2.8').id, 'k28-agent-preview');
  });

  test('chat request carries model, scenario and thinking', () => {
    const req = buildKimiChatRequest('Hello', KIMI_MODELS.instant);
    assert.equal(req.scenario, 'SCENARIO_CHAT');
    assert.equal(req.options.model, 'k2d6-chat');
    assert.equal(req.options.thinking, true);
    assert.equal(req.message.blocks[0].text.content, 'Hello');
    const k3 = buildKimiChatRequest('x', KIMI_MODELS.k3);
    assert.equal(k3.scenario, 'SCENARIO_OK_COMPUTER');
    assert.equal(k3.kimiplusId, 'ok-computer');
  });
});

describe('Kimi server-side tool interception', async () => {
  const { kimiToolToCommand, execCallMarkup } = await import('../src/kimiWeb.js');
  const { parseToolCalls } = await import('../src/parser.js');

  test('ipython code becomes a python3 heredoc command that parses back intact', () => {
    const code = "import os\nprint(os.listdir('/home/u/Desktop'))  # a < b && c\n";
    const cmd = kimiToolToCommand('ipython', JSON.stringify({ code }));
    assert.match(cmd, /^python3 - <<'KIMI_PY'\n/);
    const parsed = parseToolCalls(`I will check.${execCallMarkup(cmd)}`);
    assert.equal(parsed.calls.length, 1);
    assert.equal(JSON.parse(parsed.calls[0].arguments).cmd, cmd);
  });

  test('shell tool maps to its command; unknown tools are left alone', () => {
    assert.equal(kimiToolToCommand('shell', '{"command":"ls -la"}'), 'ls -la');
    assert.equal(kimiToolToCommand('memory', '{"q":"x"}'), null);
    assert.equal(kimiToolToCommand('ipython', 'not json'), null);
  });
});
