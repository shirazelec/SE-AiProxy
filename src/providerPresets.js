export const PROVIDER_PRESETS = {
  // Official OpenAI API (api.openai.com). Reasoning models get max_completion_tokens instead of max_tokens.
  openai: {
    type: 'openai',
    name: 'OpenAI API (official)',
    icon: '🤖',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5-mini',
    protocol: 'chat_completions',
    priority: 1,
    placeholder: 'sk-proj-...'
  },
  // Official Anthropic API (api.anthropic.com): requests are translated to the Messages API
  anthropic: {
    type: 'anthropic',
    name: 'Anthropic API (official)',
    icon: '🟠',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-opus-5-5',
    protocol: 'anthropic_messages',
    priority: 1,
    placeholder: 'sk-ant-api03-...'
  },
  openrouter: {
    type: 'openrouter',
    name: 'OpenRouter (Nemotron)',
    icon: '⚡',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'nvidia/nemotron-3.5-lightning:free',
    protocol: 'chat_completions',
    priority: 1,
    placeholder: 'sk-or-v1-...'
  },
  moonmath: {
    type: 'moonmath',
    name: 'Moonmath (Zro)',
    icon: '🌙',
    baseUrl: 'https://zro.moonmath.ai/v1',
    model: 'deepseek-v4.1-flash',
    protocol: 'responses',
    priority: 1,
    placeholder: 'sk-...'
  },
  tokenharbor: {
    type: 'tokenharbor',
    name: 'TokenHarbor',
    icon: '⚓',
    baseUrl: 'https://tokenharbor.ai/v1',
    model: 'deepseek-v4.1-flash:free',
    protocol: 'chat_completions',
    priority: 2,
    placeholder: 'thk_live_...'
  },
  chabokan: {
    type: 'chabokan',
    name: 'Chabokan AI',
    icon: '🚀',
    baseUrl: 'https://ai.chabokan.net/v1',
    model: 'deepseek/deepseek-chat',
    protocol: 'chat_completions',
    priority: 3,
    placeholder: 'sk-chbk-...'
  },
  nvidia: {
    type: 'nvidia',
    name: 'NVIDIA NIM (build.nvidia.com)',
    icon: '🟩',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    model: 'deepseek-ai/deepseek-v4.1-flash',
    protocol: 'chat_completions',
    priority: 2,
    placeholder: 'nvapi-...'
  },
  google: {
    type: 'google',
    name: 'Google Gemini',
    icon: '🔷',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-3.5-flash-lite',
    protocol: 'chat_completions',
    priority: 3,
    placeholder: 'API key'
  },
  // Official paid API: billed per token, no web-chat human checks (CHALLENGE_REQUIRED)
  deepseek_api: {
    type: 'deepseek_api',
    name: 'DeepSeek API (official)',
    icon: '🐋',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    protocol: 'chat_completions',
    priority: 1,
    placeholder: 'sk-...'
  },
  deepseek_web: {
    type: 'deepseek_web',
    name: 'DeepSeek Web',
    icon: '🌐',
    baseUrl: 'https://chat.deepseek.com',
    model: 'deepseek-chat',
    protocol: 'deepseek_web',
    priority: 4,
    placeholder: 'userToken from chat.deepseek.com'
  },
  kimi_web: {
    type: 'kimi_web',
    name: 'Kimi Web (kimi.ai)',
    icon: '🌙',
    baseUrl: 'https://www.kimi.ai',
    model: 'instant',
    protocol: 'kimi_web',
    priority: 1,
    placeholder: 'refresh_token from kimi.ai'
  },
  // Free tiers, endpoints as used by FreeLLMAPI (github.com/tashfeenahmed/freellmapi).
  // Default models are a starting point: "Load models" in the dashboard lists what the key can use.
  // maxPromptChars: history above this is compacted before sending (free tiers have small token caps).
  groq: {
    type: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'openai/gpt-oss-120b',
    protocol: 'chat_completions',
    priority: 3,
    rpm: 30,
    rpd: 1000,
    // 8K tokens per minute on the free tier
    maxPromptChars: 24000,
    placeholder: 'gsk_…'
  },
  cerebras: {
    type: 'cerebras',
    name: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    model: 'gpt-oss-120b',
    protocol: 'chat_completions',
    priority: 3,
    maxPromptChars: 200000,
    placeholder: 'csk-…'
  },
  mistral: {
    type: 'mistral',
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-large-latest',
    protocol: 'chat_completions',
    priority: 3,
    placeholder: 'API key'
  },
  zhipu: {
    type: 'zhipu',
    name: 'Zhipu GLM (bigmodel.cn)',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.7-flash',
    protocol: 'chat_completions',
    priority: 3,
    placeholder: 'API key'
  },
  zai: {
    type: 'zai',
    name: 'Z.ai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    model: 'glm-4.7-flash',
    protocol: 'chat_completions',
    priority: 3,
    placeholder: 'API key'
  },
  huggingface: {
    type: 'huggingface',
    name: 'Hugging Face',
    baseUrl: 'https://router.huggingface.co/v1',
    model: 'deepseek-ai/DeepSeek-V4-Flash',
    protocol: 'chat_completions',
    priority: 4,
    placeholder: 'hf_…'
  },
  modelscope: {
    type: 'modelscope',
    name: 'ModelScope',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    model: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
    protocol: 'chat_completions',
    priority: 3,
    placeholder: 'ms-…'
  },
  cohere: {
    type: 'cohere',
    name: 'Cohere',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    model: 'command-a-03-2025',
    protocol: 'chat_completions',
    priority: 4,
    placeholder: 'API key'
  },
  ollama: {
    type: 'ollama',
    name: 'Ollama Cloud',
    baseUrl: 'https://ollama.com/v1',
    model: 'gpt-oss:120b',
    protocol: 'chat_completions',
    priority: 4,
    placeholder: 'API key'
  },
  cloudflare: {
    type: 'cloudflare',
    name: 'Cloudflare Workers AI',
    // Replace ACCOUNT_ID with the id from the Cloudflare dashboard
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1',
    model: '@cf/openai/gpt-oss-120b',
    protocol: 'chat_completions',
    priority: 4,
    needsBaseUrl: true,
    placeholder: 'API token'
  },
  openai_custom: {
    type: 'openai_custom',
    name: 'OpenAI-compatible',
    icon: '⚙️',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    protocol: 'chat_completions',
    priority: 5,
    placeholder: 'sk-...'
  }
};
