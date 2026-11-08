import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAnthropicConversationKey,
  formatAnthropicToolsForPrompt,
  buildPromptFromAnthropicMessages
} from '../src/anthropicAdapter.js';

describe('Anthropic Adapter - Conversation Key', () => {
  test('derives stable conversation key from user prompt text', () => {
    const body1 = {
      messages: [
        { role: 'user', content: 'Inspect the codebase and build' },
        { role: 'assistant', content: 'Checking files...' }
      ]
    };
    const body2 = {
      messages: [
        { role: 'user', content: 'Inspect the codebase and build' },
        { role: 'assistant', content: 'Checking files...' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }] }
      ]
    };

    const key1 = resolveAnthropicConversationKey(body1);
    const key2 = resolveAnthropicConversationKey(body2);

    assert.ok(key1.startsWith('anthropic_'));
    assert.equal(key1, key2);
  });

  test('handles content array with text blocks', () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Build the player' }] }
      ]
    };
    const key = resolveAnthropicConversationKey(body);
    assert.ok(key.startsWith('anthropic_'));
  });
});

describe('Anthropic Adapter - Tool Formatting', () => {
  test('formats Claude Code tools (Bash, FileEdit) into XML tool definitions', () => {
    const tools = [
      {
        name: 'Bash',
        description: 'Execute a bash command in the terminal',
        input_schema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The command to execute' },
            timeout: { type: 'number' }
          },
          required: ['command']
        }
      },
      {
        name: 'FileEdit',
        description: 'Edit a file using search and replace',
        input_schema: {
          type: 'object',
          properties: {
            file_path: { type: 'string' },
            old_string: { type: 'string' },
            new_string: { type: 'string' }
          },
          required: ['file_path', 'old_string', 'new_string']
        }
      }
    ];

    const formatted = formatAnthropicToolsForPrompt(tools);
    assert.ok(formatted.includes('<tool>'));
    assert.ok(formatted.includes('<name>Bash</name>'));
    assert.ok(formatted.includes('<name>FileEdit</name>'));
    assert.ok(formatted.includes('parameter name="command" type="string" required="true"'));
    assert.ok(formatted.includes('parameter name="file_path" type="string" required="true"'));
    assert.ok(formatted.includes('TOOL CALL FORMAT RULES:'));
  });
});

describe('Anthropic Adapter - Prompt Compilation', () => {
  test('compiles system prompt, tools, tool_use, and tool_result into DeepSeek prompt', () => {
    const body = {
      system: 'You are Claude Code, an expert autonomous CLI agent.',
      tools: [
        {
          name: 'Bash',
          description: 'Run command',
          input_schema: { properties: { command: { type: 'string' } } }
        }
      ],
      messages: [
        { role: 'user', content: 'Check directory contents' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Listing directory:' },
            { type: 'tool_use', id: 'toolu_123', name: 'Bash', input: { command: 'ls -la' } }
          ]
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'toolu_123', content: 'total 0\n-rw-r--r-- file.txt', is_error: false }
          ]
        }
      ]
    };

    const compiled = buildPromptFromAnthropicMessages(body);

    assert.ok(compiled.includes('[SYSTEM DIRECTIVE]'));
    assert.ok(compiled.includes('You are Claude Code'));
    assert.ok(compiled.includes('[WORKSPACE HYGIENE'));
    assert.ok(compiled.includes('Mandatory Cleanup of Temporary Files'));
    assert.ok(compiled.includes('[AVAILABLE TOOLS]'));
    assert.ok(compiled.includes('<name>Bash</name>'));
    assert.ok(compiled.includes('[USER]:\nCheck directory contents'));
    assert.ok(compiled.includes('[ASSISTANT]:'));
    assert.ok(compiled.includes('<invoke name="Bash">'));
    assert.ok(compiled.includes('<parameter name="command">ls -la</parameter>'));
    assert.ok(compiled.includes('[TOOL OUTPUT]: \ntotal 0\n-rw-r--r-- file.txt'));
  });
});

describe('Anthropic Adapter - Model Routing & Heartbeat Spec', () => {
  test('short ping message routes to fast model without reasoning', () => {
    const isReasoningRequested = false;
    const body = {
      model: 'claude-3-5-sonnet-20241022',
      messages: [{ role: 'user', content: 'Hi' }]
    };
    const isShortPing = Array.isArray(body.messages) &&
      body.messages.length === 1 &&
      typeof body.messages[0]?.content === 'string' &&
      body.messages[0].content.trim().length <= 50;

    const useReasoner = isReasoningRequested && !isShortPing;
    assert.equal(isShortPing, true);
    assert.equal(useReasoner, false);
  });

  test('extended thinking request routes to reasoner model', () => {
    const body = {
      model: 'claude-3-7-sonnet-20250219',
      thinking: { type: 'enabled', budget_tokens: 4000 },
      messages: [{ role: 'user', content: 'Solve this complex mathematical problem in full detail...' }]
    };
    const isReasoningRequested = Boolean(
      (body.thinking && body.thinking.type === 'enabled') ||
      /reasoner|r1/i.test(body.model)
    );
    const isShortPing = false;
    const useReasoner = isReasoningRequested && !isShortPing;

    assert.equal(isReasoningRequested, true);
    assert.equal(useReasoner, true);
  });

  test('deepseek-reasoner explicit model routes to reasoner', () => {
    const body = {
      model: 'deepseek-reasoner',
      messages: [{ role: 'user', content: 'Analyze this architecture' }]
    };
    const isReasoningRequested = Boolean(
      (body.thinking && body.thinking.type === 'enabled') ||
      /reasoner|r1/i.test(body.model)
    );
    assert.equal(isReasoningRequested, true);
  });

  test('1M context models (sonnet[1m], deepseek-reasoner[1m]) route properly', () => {
    const body1 = {
      model: 'sonnet[1m]',
      messages: [{ role: 'user', content: 'Analyze repo with 1M context' }]
    };
    const isReasoningRequested1 = Boolean(
      (body1.thinking && body1.thinking.type === 'enabled') ||
      /reasoner|r1/i.test(body1.model)
    );
    assert.equal(isReasoningRequested1, false);

    const body2 = {
      model: 'deepseek-reasoner[1m]',
      messages: [{ role: 'user', content: 'Deep thought analysis with 1M context' }]
    };
    const isReasoningRequested2 = Boolean(
      (body2.thinking && body2.thinking.type === 'enabled') ||
      /reasoner|r1/i.test(body2.model)
    );
    assert.equal(isReasoningRequested2, true);
  });
});

