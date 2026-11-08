// Bounded LRU cache with idle TTL. Used for conversation -> DeepSeek session bindings so that
// per-turn response-id aliases do not accumulate forever in long-running proxy processes.
export class BoundedCache {
  constructor({ maxEntries = 1000, ttlMs = 12 * 60 * 60 * 1000 } = {}) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.map = new Map();
  }

  get size() {
    return this.map.size;
  }

  has(key) {
    return this.get(key) !== undefined;
  }

  get(key) {
    if (key == null) return undefined;
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.touchedAt > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    // Refresh recency
    this.map.delete(key);
    entry.touchedAt = Date.now();
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (key == null) return this;
    this.map.delete(key);
    this.map.set(key, { value, touchedAt: Date.now() });
    while (this.map.size > this.maxEntries) {
      this.map.delete(this.map.keys().next().value);
    }
    return this;
  }

  delete(key) {
    return this.map.delete(key);
  }

  // Remove every alias pointing at the given value (e.g. when a session is discarded)
  deleteValue(value) {
    for (const [key, entry] of this.map) {
      if (entry.value === value) this.map.delete(key);
    }
  }

  prune() {
    const now = Date.now();
    for (const [key, entry] of this.map) {
      if (now - entry.touchedAt > this.ttlMs) this.map.delete(key);
    }
  }
}
