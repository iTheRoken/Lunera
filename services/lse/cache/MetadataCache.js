const fs = require('fs');
const path = require('path');

function clone(value) {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

class MetadataCache {
  constructor(options = {}) {
    this.storagePath = options.storagePath || null;
    this.maxEntries = Math.max(10, Number(options.maxEntries) || 200);
    this.defaultTtlMs = Math.max(1000, Number(options.defaultTtlMs) || 10 * 60 * 1000);
    this.entries = new Map();
    this.hits = 0;
    this.misses = 0;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    this.initialized = true;
    if (!this.storagePath) return;

    try {
      const raw = await fs.promises.readFile(this.storagePath, 'utf8');
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
      const now = Date.now();
      entries.forEach(([key, entry]) => {
        if (!key || !entry || Number(entry.expiresAt) <= now) return;
        this.entries.set(key, {
          value: entry.value,
          createdAt: Number(entry.createdAt) || now,
          lastAccessedAt: Number(entry.lastAccessedAt) || now,
          expiresAt: Number(entry.expiresAt),
          reusable: entry.reusable !== false,
          persist: true
        });
      });
      this.prune();
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.entries.clear();
      }
    }
  }

  get(key) {
    const entry = this.entries.get(key);
    if (!entry || Number(entry.expiresAt) <= Date.now() || entry.reusable === false) {
      this.entries.delete(key);
      this.misses += 1;
      return null;
    }

    entry.lastAccessedAt = Date.now();
    this.hits += 1;
    return clone(entry.value);
  }

  async set(key, value, options = {}) {
    if (!key || value === undefined) return;
    const now = Date.now();
    const ttlMs = Math.max(1000, Number(options.ttlMs) || this.defaultTtlMs);
    this.entries.set(String(key), {
      value: clone(value),
      createdAt: now,
      lastAccessedAt: now,
      expiresAt: now + ttlMs,
      reusable: options.reusable !== false,
      persist: options.persist !== false
    });
    this.prune();
    await this.persist();
  }

  async delete(key) {
    this.entries.delete(key);
    await this.persist();
  }

  async clear() {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
    if (!this.storagePath) return;
    try {
      await fs.promises.unlink(this.storagePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  prune() {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (!entry || Number(entry.expiresAt) <= now) this.entries.delete(key);
    }

    if (this.entries.size <= this.maxEntries) return;
    const overflow = [...this.entries.entries()]
      .sort((left, right) => left[1].lastAccessedAt - right[1].lastAccessedAt)
      .slice(0, this.entries.size - this.maxEntries);
    overflow.forEach(([key]) => this.entries.delete(key));
  }

  async persist() {
    if (!this.storagePath) return;
    const entries = [...this.entries.entries()]
      .filter(([, entry]) => entry.persist !== false)
      .map(([key, entry]) => [key, {
        value: entry.value,
        createdAt: entry.createdAt,
        lastAccessedAt: entry.lastAccessedAt,
        expiresAt: entry.expiresAt,
        reusable: entry.reusable
      }]);
    const payload = JSON.stringify({ version: 1, entries });
    await fs.promises.mkdir(path.dirname(this.storagePath), { recursive: true });
    await fs.promises.writeFile(this.storagePath, payload, 'utf8');
  }

  getStats() {
    let persistentEntries = 0;
    for (const entry of this.entries.values()) {
      if (entry.persist !== false) persistentEntries += 1;
    }
    return {
      entries: this.entries.size,
      persistentEntries,
      hits: this.hits,
      misses: this.misses,
      hitRate: this.hits + this.misses > 0
        ? Math.round((this.hits / (this.hits + this.misses)) * 100)
        : 0,
      maxEntries: this.maxEntries
    };
  }
}

module.exports = { MetadataCache };
