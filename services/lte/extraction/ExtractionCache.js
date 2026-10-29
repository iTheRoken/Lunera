'use strict';

const fs = require('fs');
const path = require('path');

function clone(value) {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function sanitizeValue(value, key = '') {
  const blockedKeys = new Set([
    'audioUrl', 'httpHeaders', 'headers', 'cookies', 'cookie',
    'authorization', 'signature', 'sig', 'sourceUrl', 'approvedAddress'
  ]);

  if (blockedKeys.has(key)) return undefined;
  if (Array.isArray(value)) return value.map(item => sanitizeValue(item)).filter(item => item !== undefined);
  if (!value || typeof value !== 'object') return value;

  const output = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (blockedKeys.has(childKey)) continue;
    // A format URL can be signed and is never useful after the current
    // resolution. Keep its identifying fields, not the temporary address.
    if (childKey === 'url' && /^(formats|requested_formats)$/i.test(key)) continue;
    const sanitized = sanitizeValue(childValue, childKey);
    if (sanitized !== undefined) output[childKey] = sanitized;
  }
  return output;
}

class TurboMetadataCache {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.ttlMs = Math.max(1, Number(options.ttlMs) || 10 * 60 * 1000);
    this.maxEntries = Math.max(10, Number(options.maxEntries) || 250);
    this.persistencePath = options.persistencePath || '';
    this.entries = new Map();
    this.resolvedEntries = new Map();
    this.initialized = false;
    this.writePromise = Promise.resolve();
    this.stats = { hits: 0, misses: 0, expired: 0, writes: 0, resolvedHits: 0, resolvedMisses: 0 };
  }

  async initialize() {
    if (this.initialized) return this.getStats();
    this.initialized = true;
    if (!this.persistencePath) return this.getStats();
    try {
      const raw = await fs.promises.readFile(this.persistencePath, 'utf8');
      const payload = JSON.parse(raw);
      const records = Array.isArray(payload?.entries) ? payload.entries : [];
      const current = this.now();
      for (const record of records) {
        if (!record || typeof record.key !== 'string' || !record.value) continue;
        if (!Number.isFinite(Number(record.expiresAt)) || Number(record.expiresAt) <= current) continue;
        this.entries.set(record.key, {
          value: sanitizeValue(record.value),
          createdAt: Number(record.createdAt) || current,
          expiresAt: Number(record.expiresAt),
          lastUsedAt: Number(record.lastUsedAt) || current
        });
      }
      this.prune();
    } catch (error) {
      // A corrupt metadata cache must never prevent playback. The next valid
      // resolution replaces it; ENOENT is the normal first-launch path.
      if (error?.code !== 'ENOENT') this.entries.clear();
    }
    return this.getStats();
  }

  get(key) {
    const normalizedKey = String(key);
    const entry = this.entries.get(normalizedKey);
    if (!entry) {
      this.stats.misses += 1;
      return null;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(normalizedKey);
      this.stats.expired += 1;
      this.stats.misses += 1;
      this.schedulePersist();
      return null;
    }
    entry.lastUsedAt = this.now();
    this.stats.hits += 1;
    return clone(entry.value);
  }

  set(key, value, options = {}) {
    const normalizedKey = String(key || '');
    if (!normalizedKey || !value || typeof value !== 'object') return false;
    const now = this.now();
    const ttlMs = Math.max(1, Number(options.ttlMs) || this.ttlMs);
    this.entries.set(normalizedKey, {
      value: sanitizeValue(value),
      createdAt: now,
      expiresAt: now + ttlMs,
      lastUsedAt: now
    });
    this.stats.writes += 1;
    this.prune();
    if (options.persist !== false) this.schedulePersist();
    return true;
  }

  getResolved(key) {
    const normalizedKey = String(key);
    const entry = this.resolvedEntries.get(normalizedKey);
    if (!entry) {
      this.stats.resolvedMisses += 1;
      return null;
    }
    if (entry.expiresAt <= this.now()) {
      this.resolvedEntries.delete(normalizedKey);
      this.stats.expired += 1;
      this.stats.resolvedMisses += 1;
      return null;
    }
    entry.lastUsedAt = this.now();
    this.stats.resolvedHits += 1;
    return clone(entry.value);
  }

  setResolved(key, extraction, options = {}) {
    const normalizedKey = String(key || '');
    if (!normalizedKey || !extraction?.audioUrl) return false;
    const now = this.now();
    const expiresAt = Math.max(
      now + 1_000,
      Number(options.expiresAt || extraction?.sourcePolicy?.expiresAt || extraction?.expiresAt || now + this.ttlMs)
    );
    this.resolvedEntries.set(normalizedKey, {
      value: clone(extraction),
      createdAt: now,
      expiresAt,
      lastUsedAt: now
    });
    this.pruneResolved();
    return true;
  }

  delete(key) {
    const normalizedKey = String(key);
    const removed = this.entries.delete(normalizedKey) || this.resolvedEntries.delete(normalizedKey);
    if (removed) this.schedulePersist();
    return removed;
  }

  clear() {
    const count = this.entries.size + this.resolvedEntries.size;
    this.entries.clear();
    this.resolvedEntries.clear();
    this.schedulePersist();
    return count;
  }

  prune() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        this.stats.expired += 1;
      }
    }
    if (this.entries.size <= this.maxEntries) return;
    const oldest = [...this.entries.entries()]
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)
      .slice(0, this.entries.size - this.maxEntries);
    oldest.forEach(([key]) => this.entries.delete(key));
  }

  pruneResolved() {
    const now = this.now();
    for (const [key, entry] of this.resolvedEntries) {
      if (entry.expiresAt <= now) this.resolvedEntries.delete(key);
    }
    const limit = Math.min(40, this.maxEntries);
    if (this.resolvedEntries.size <= limit) return;
    const oldest = [...this.resolvedEntries.entries()]
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)
      .slice(0, this.resolvedEntries.size - limit);
    oldest.forEach(([key]) => this.resolvedEntries.delete(key));
  }

  schedulePersist() {
    if (!this.persistencePath) return;
    this.writePromise = this.writePromise.catch(() => {}).then(() => this.persist()).catch(() => {});
  }

  async persist() {
    if (!this.persistencePath) return;
    const records = [...this.entries.entries()].map(([key, entry]) => ({
      key,
      value: sanitizeValue(entry.value),
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      lastUsedAt: entry.lastUsedAt
    }));
    const temporaryPath = `${this.persistencePath}.tmp`;
    await fs.promises.mkdir(path.dirname(this.persistencePath), { recursive: true });
    await fs.promises.writeFile(temporaryPath, JSON.stringify({ version: 1, entries: records }), 'utf8');
    await fs.promises.rename(temporaryPath, this.persistencePath);
  }

  async dispose() {
    await this.writePromise.catch(() => {});
  }

  async flush() {
    await this.writePromise.catch(() => {});
    return this.getStats();
  }

  getStats() {
    return {
      ...this.stats,
      entries: this.entries.size,
      resolvedEntries: this.resolvedEntries.size,
      ttlMs: this.ttlMs,
      maxEntries: this.maxEntries
    };
  }
}

module.exports = { TurboMetadataCache, sanitizeTurboMetadata: sanitizeValue };

