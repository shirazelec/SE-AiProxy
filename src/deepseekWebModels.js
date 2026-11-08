// DeepSeek Web models chosen per account in the dashboard. The web app has no model names: each
// request carries model_type ('default' / 'expert') and thinking_enabled (the DeepThink button).
// chat = DeepThink off, reasoner = DeepThink on. Older names stay mapped for existing accounts.
export const DEEPSEEK_WEB_MODELS = {
  'deepseek-chat': { modelType: 'default', thinkingEnabled: false },
  'deepseek-instant': { modelType: 'default', thinkingEnabled: false },
  'deepseek-reasoner': { modelType: 'default', thinkingEnabled: true },
  'deepseek-expert': { modelType: 'expert', thinkingEnabled: true }
};

export function deepSeekWebModelOptions(accountModel, fallback) {
  return DEEPSEEK_WEB_MODELS[accountModel] || fallback;
}
