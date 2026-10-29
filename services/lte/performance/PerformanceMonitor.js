'use strict';

function safeNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function sanitizeMessage(value) {
  return String(value || '')
    .replace(/https?:\/\/[^\s)\]}]+/gi, '[url privada]')
    .replace(/[?&](?:sig|signature|token|expire|authorization)=[^&\s]+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return sorted[index];
}

function average(values) {
  if (!values.length) return null;
  return Math.round(values.reduce((total, value) => total + value, 0) / values.length);
}

class PerformanceMonitor {
  constructor(options = {}) {
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.maxSamples = Math.max(5, Math.min(500, Number(options.maxSamples) || 100));
    this.active = new Map();
    this.history = [];
    this.errors = [];
    this.counters = {
      started: 0,
      completed: 0,
      failed: 0,
      bufferingEvents: 0,
      bufferingMs: 0,
      streamFirstBytes: 0
    };
    this.lastCpuSample = { at: this.now(), usage: process.cpuUsage() };
  }

  start(requestId, details = {}) {
    const id = String(requestId || `lte-${this.now()}`);
    const startedAt = this.now();
    const record = {
      requestId: id,
      startedAt,
      updatedAt: startedAt,
      state: 'resolving',
      details: { ...details },
      stages: { click: startedAt },
      bufferingMs: 0
    };
    this.active.set(id, record);
    this.counters.started += 1;
    return this.toSample(record, startedAt);
  }

  ensure(requestId, details = {}) {
    const id = String(requestId || '');
    return this.active.get(id) || this.start(id, details);
  }

  mark(requestId, stage, details = {}) {
    const id = String(requestId || '');
    let record = this.active.get(id);
    if (!record) {
      this.start(id, details);
      record = this.active.get(id);
    }
    const current = this.now();
    const normalizedStage = String(stage || 'progress');
    record.updatedAt = current;
    record.details = { ...record.details, ...details };
    record.stages[normalizedStage] = current;

    if (['extraction-ready', 'resolved', 'metadata-ready'].includes(normalizedStage)) {
      record.state = 'preparing-stream';
      if (!record.extractionReadyAt) record.extractionReadyAt = current;
    } else if (['stream-ready', 'proxy-ready', 'source-ready'].includes(normalizedStage)) {
      record.state = 'stream-ready';
      record.streamReadyAt = current;
    } else if (['first-byte', 'first-data'].includes(normalizedStage)) {
      record.firstByteAt = current;
      this.counters.streamFirstBytes += 1;
    } else if (['first-audio', 'playing'].includes(normalizedStage)) {
      record.firstAudioAt = current;
      record.state = 'playing';
      return this.complete(id, record);
    } else if (normalizedStage === 'buffering') {
      const durationMs = Math.max(0, Number(details.durationMs) || 0);
      record.bufferingMs += durationMs;
      this.counters.bufferingEvents += 1;
      this.counters.bufferingMs += durationMs;
    }
    return this.toSample(record, current);
  }

  fail(requestId, error, details = {}) {
    const id = String(requestId || '');
    const record = this.active.get(id);
    const now = this.now();
    if (record) {
      record.state = 'error';
      record.updatedAt = now;
      record.error = sanitizeMessage(error?.message || error);
      record.details = { ...record.details, ...details };
      this.active.delete(id);
    }
    this.errors.unshift({ at: now, requestId: id.slice(0, 96), message: sanitizeMessage(error?.message || error) });
    this.errors = this.errors.slice(0, 20);
    this.counters.failed += 1;
  }

  complete(requestId, record = this.active.get(String(requestId))) {
    if (!record) return null;
    const sample = this.toSample(record, record.firstAudioAt || this.now());
    this.history.push(sample);
    if (this.history.length > this.maxSamples) this.history.splice(0, this.history.length - this.maxSamples);
    this.active.delete(String(requestId));
    this.counters.completed += 1;
    return sample;
  }

  reset() {
    this.active.clear();
    this.history = [];
    this.errors = [];
    this.counters = {
      started: 0,
      completed: 0,
      failed: 0,
      bufferingEvents: 0,
      bufferingMs: 0,
      streamFirstBytes: 0
    };
    this.lastCpuSample = { at: this.now(), usage: process.cpuUsage() };
  }

  getCurrent(requestId) {
    const record = this.active.get(String(requestId || ''));
    return record ? this.toSample(record, this.now()) : null;
  }

  toSample(record, now) {
    const extractionReadyAt = record.extractionReadyAt || null;
    const streamReadyAt = record.streamReadyAt || null;
    const firstByteAt = record.firstByteAt || null;
    const firstAudioAt = record.firstAudioAt || null;
    return {
      requestId: record.requestId,
      state: record.state,
      source: record.details.source || null,
      engine: record.details.engine || null,
      extractor: record.details.extractor || null,
      startedAt: record.startedAt,
      elapsedMs: Math.max(0, now - record.startedAt),
      extractionMs: extractionReadyAt ? Math.max(0, extractionReadyAt - record.startedAt) : null,
      preparationMs: extractionReadyAt && streamReadyAt ? Math.max(0, streamReadyAt - extractionReadyAt) : null,
      timeToFirstByteMs: firstByteAt ? Math.max(0, firstByteAt - record.startedAt) : null,
      timeToFirstAudioMs: firstAudioAt ? Math.max(0, firstAudioAt - record.startedAt) : null,
      bufferingMs: record.bufferingMs || 0,
      stages: { ...record.stages }
    };
  }

  systemUsage() {
    const currentAt = this.now();
    const currentUsage = process.cpuUsage();
    const elapsedMs = Math.max(1, currentAt - this.lastCpuSample.at);
    const cpuMicros = (currentUsage.user - this.lastCpuSample.usage.user) + (currentUsage.system - this.lastCpuSample.usage.system);
    const cpuPercent = Math.max(0, Math.round((cpuMicros / (elapsedMs * 1000)) * 1000) / 10);
    this.lastCpuSample = { at: currentAt, usage: currentUsage };
    const memory = process.memoryUsage();
    return {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      cpuPercent
    };
  }

  snapshot() {
    const metric = name => this.history.map(item => safeNumber(item[name])).filter(value => value !== null);
    const aggregate = {};
    const percentiles = {};
    for (const key of ['extractionMs', 'preparationMs', 'timeToFirstByteMs', 'timeToFirstAudioMs', 'bufferingMs']) {
      const values = metric(key);
      aggregate[key] = average(values);
      percentiles[key] = percentile(values, 95);
    }
    return {
      samples: this.history.length,
      active: [...this.active.values()].map(record => this.toSample(record, this.now())),
      average: aggregate,
      median: Object.fromEntries(Object.keys(aggregate).map(key => [key, percentile(metric(key), 50)])),
      percentiles: { p95: percentiles },
      counters: { ...this.counters },
      recent: this.history.slice(-10),
      recentErrors: [...this.errors],
      system: this.systemUsage()
    };
  }
}

module.exports = { PerformanceMonitor, sanitizePerformanceMessage: sanitizeMessage };

