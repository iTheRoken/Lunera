'use strict';

const crypto = require('crypto');
const { BufferManager } = require('./BufferManager');

function sourceHost(audioUrl) {
  try { return new URL(audioUrl).hostname.toLowerCase(); } catch (error) { return ''; }
}

class StreamManager {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.ttlMs = Math.max(30_000, Number(options.ttlMs) || 2 * 60 * 60 * 1000);
    this.sessions = new Map();
    this.bufferManager = options.bufferManager || new BufferManager({ now: this.now });
    this.stats = { created: 0, expired: 0, requests: 0, firstBytes: 0, bytes: 0, failures: 0 };
  }

  create(extraction = {}, options = {}) {
    if (!extraction.audioUrl) throw new Error('LTE necesita una URL de audio para abrir un stream');
    const now = this.now();
    const id = crypto.randomBytes(24).toString('hex');
    const expiresAt = Math.max(now + 1_000, Number(options.expiresAt || extraction?.sourcePolicy?.expiresAt || now + this.ttlMs));
    const session = {
      id,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: Math.min(now + this.ttlMs, expiresAt),
      audioUrl: extraction.audioUrl,
      httpHeaders: { ...(extraction.httpHeaders || {}) },
      sourcePolicy: extraction.sourcePolicy ? { ...extraction.sourcePolicy } : null,
      requestId: String(options.requestId || '').slice(0, 96),
      resolutionKey: options.resolutionKey || null,
      sourceHost: sourceHost(extraction.audioUrl),
      requestCount: 0,
      status: 'ready'
    };
    this.sessions.set(id, session);
    this.bufferManager.begin(id, options.settings || {});
    this.stats.created += 1;
    this.prune();
    return { ...session, httpHeaders: undefined, audioUrl: undefined };
  }

  get(id) {
    const session = this.sessions.get(String(id || ''));
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.remove(session.id, 'expired');
      return null;
    }
    session.lastUsedAt = this.now();
    return session;
  }

  markRequest(id) {
    const session = this.get(id);
    if (!session) return null;
    session.requestCount += 1;
    session.status = 'streaming';
    this.stats.requests += 1;
    return session;
  }

  refresh(id, extraction = {}) {
    const session = this.sessions.get(String(id || ''));
    if (!session || !extraction.audioUrl) return null;
    const now = this.now();
    const expiresAt = Math.max(now + 1_000, Number(extraction?.sourcePolicy?.expiresAt || extraction?.expiresAt || now + this.ttlMs));
    session.audioUrl = extraction.audioUrl;
    session.httpHeaders = { ...(extraction.httpHeaders || {}) };
    session.sourcePolicy = extraction.sourcePolicy ? { ...extraction.sourcePolicy } : null;
    session.expiresAt = Math.min(now + this.ttlMs, expiresAt);
    session.lastUsedAt = now;
    session.status = 'ready';
    return session;
  }

  markFirstByte(id) {
    const session = this.get(id);
    if (!session) return null;
    const existing = this.bufferManager.sessions.get(session.id);
    const hadFirstByte = !!existing?.firstByteAt;
    const snapshot = this.bufferManager.recordFirstByte(session.id);
    if (snapshot && !hadFirstByte) this.stats.firstBytes += 1;
    return snapshot;
  }

  markChunk(id, length) {
    const session = this.get(id);
    if (!session) return null;
    this.stats.bytes += Math.max(0, Number(length) || 0);
    return this.bufferManager.recordChunk(session.id, length);
  }

  markStallByRequest(requestId, durationMs = 0) {
    const normalizedRequestId = String(requestId || '');
    if (!normalizedRequestId) return null;
    const session = [...this.sessions.values()].find(candidate => candidate.requestId === normalizedRequestId);
    if (!session) return null;
    return this.bufferManager.recordStall(session.id, durationMs);
  }

  markFailure(id) {
    const session = this.get(id);
    if (!session) return null;
    session.status = 'error';
    this.stats.failures += 1;
    return session;
  }

  remove(id, reason = 'removed') {
    const session = this.sessions.get(String(id || ''));
    if (!session) return false;
    this.sessions.delete(session.id);
    this.bufferManager.remove(session.id);
    if (reason === 'expired') this.stats.expired += 1;
    return true;
  }

  clear() {
    const count = this.sessions.size;
    this.sessions.clear();
    this.bufferManager.sessions.clear();
    return count;
  }

  prune() {
    for (const session of [...this.sessions.values()]) {
      if (session.expiresAt <= this.now()) this.remove(session.id, 'expired');
    }
  }

  getDiagnostics() {
    this.prune();
    return {
      ...this.stats,
      activeSessions: this.sessions.size,
      sessions: [...this.sessions.values()].map(session => ({
        id: session.id.slice(0, 12),
        status: session.status,
        sourceHost: session.sourceHost,
        requestCount: session.requestCount,
        expiresAt: session.expiresAt,
        buffer: this.bufferManager.getSnapshot(session.id)
      }))
    };
  }
}

module.exports = { StreamManager };

