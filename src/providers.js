import { PROVIDER_PRESETS } from './providerPresets.js';
import tokenPool from './tokenPool.js';

export { PROVIDER_PRESETS };

export class ProviderManagerShim {
  getPresets() {
    return Object.values(PROVIDER_PRESETS);
  }

  getProviders() {
    return tokenPool.getTokens();
  }

  hasActiveProviders() {
    return tokenPool.countAvailable() > 0;
  }

  testProvider(id) {
    return tokenPool.testToken(id);
  }

  testAllProviders() {
    return tokenPool.testAllTokens();
  }

  updateProvider(id, updates) {
    return tokenPool.updateToken(id, updates);
  }

  recordUsage(id) {
    return tokenPool.recordUsage(id);
  }
}

export const providerManager = new ProviderManagerShim();
export default providerManager;
