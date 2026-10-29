'use strict';

class BufferManager {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.sessions = new Map();
  }

  getStartupTarget(settings = {}) {
    if (settings.bufferMode === 'low-latency' || settings.startupPriority === 'fast') return 0.5;
    if (settings.bufferMode === 'stable' || settings.stabilityPriority === 'stable') return 2.5;
    return 1.25;
  }

  begin(sessionId, settings = {}) {
    const record = {
      sessionId,
      startedAt: this.now(),
      firstByteAt: null,
      bytes: 0,
      stalls: 0,
      stallMs: 0,
      startupTargetSeconds: this.getStartupTarget(settings),
      recommendedStartupSeconds: this.getStartupTarget(settings),
      dynamicBuffering: settings.dynamicBuffering !== false,
      throughputBps: null,
      lastChunkAt: null,
      lastUpdatedAt: this.now()
    };
    this.sessions.set(sessionId, record);
    return record;
  }

  recordFirstByte(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    if (!session.firstByteAt) session.firstByteAt = this.now();
    session.lastUpdatedAt = this.now();
    return session;
  }

  recordChunk(sessionId, size) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const bytes = Math.max(0, Number(size) || 0);
    const now = this.now();
    if (bytes > 0 && session.lastChunkAt) {
      const elapsedMs = Math.max(1, now - session.lastChunkAt);
      const instantaneousBps = Math.round((bytes * 1000) / elapsedMs);
      session.throughputBps = session.throughputBps === null
        ? instantaneousBps
        : Math.round((session.throughputBps * 0.7) + (instantaneousBps * 0.3));
    }
    session.bytes += bytes;
    session.lastChunkAt = now;
    session.lastUpdatedAt = now;
    return session;
  }

  recordStall(sessionId, durationMs = 0) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    session.stalls += 1;
    session.stallMs += Math.max(0, Number(durationMs) || 0);
    if (session.dynamicBuffering) {
      const instabilityPenalty = Math.min(3, session.stalls * 0.35);
      const longStallPenalty = Math.min(1.5, session.stallMs / 10_000);
      session.recommendedStartupSeconds = Math.min(
        6,
        Math.round((session.startupTargetSeconds + instabilityPenalty + longStallPenalty) * 100) / 100
      );
    }
    session.lastUpdatedAt = this.now();
    return session;
  }

  remove(sessionId) {
    return this.sessions.delete(sessionId);
  }

  getSnapshot(sessionId = null) {
    const serialise = record => ({
      sessionId: record.sessionId,
      firstByteMs: record.firstByteAt ? Math.max(0, record.firstByteAt - record.startedAt) : null,
      bytes: record.bytes,
      stalls: record.stalls,
      stallMs: record.stallMs,
      startupTargetSeconds: record.startupTargetSeconds,
      recommendedStartupSeconds: record.recommendedStartupSeconds,
      throughputBps: record.throughputBps
    });
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      return session ? serialise(session) : null;
    }
    return [...this.sessions.values()].map(serialise);
  }
}

module.exports = { BufferManager };

