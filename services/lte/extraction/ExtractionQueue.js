'use strict';

const PRIORITY = Object.freeze({
  playback: 0,
  recovery: 1,
  preload: 2,
  background: 3
});

function createAbortError(message = 'La extracciÃ³n fue cancelada') {
  const error = new Error(message);
  error.name = 'AbortError';
  error.code = 'ABORTED';
  return error;
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORTED';
}

class ExtractionQueue {
  constructor(options = {}) {
    this.maxConcurrent = Math.max(1, Math.min(4, Number(options.maxConcurrent) || 2));
    this.active = 0;
    this.sequence = 0;
    this.jobs = new Map();
    this.pending = [];
    this.stats = { submitted: 0, completed: 0, failed: 0, cancelled: 0, deduplicated: 0 };
  }

  setMaxConcurrent(value) {
    this.maxConcurrent = Math.max(1, Math.min(4, Number(value) || 2));
    this.pump();
  }

  run(key, work, options = {}) {
    const normalizedKey = String(key || '');
    if (!normalizedKey || typeof work !== 'function') throw new TypeError('La cola LTE necesita una clave y una tarea');
    const existing = this.jobs.get(normalizedKey);
    if (existing) {
      this.stats.deduplicated += 1;
      this.promote(existing, options.priority);
      return { promise: existing.promise, shared: true, job: existing };
    }

    const controller = new AbortController();
    let resolvePromise;
    let rejectPromise;
    const job = {
      key: normalizedKey,
      work,
      controller,
      priority: this.priorityOf(options.priority),
      kind: options.kind || 'playback',
      createdAt: Date.now(),
      sequence: this.sequence += 1,
      state: 'queued',
      resolve: null,
      reject: null,
      promise: null
    };
    job.promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    job.resolve = resolvePromise;
    job.reject = rejectPromise;
    this.jobs.set(normalizedKey, job);
    this.pending.push(job);
    this.stats.submitted += 1;
    this.pump();
    return { promise: job.promise, shared: false, job };
  }

  priorityOf(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    return PRIORITY[value] ?? PRIORITY.playback;
  }

  promote(job, priority) {
    const next = this.priorityOf(priority);
    if (next < job.priority) job.priority = next;
  }

  pump() {
    while (this.active < this.maxConcurrent && this.pending.length) {
      this.pending.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence);
      const job = this.pending.shift();
      if (!job || job.state !== 'queued') continue;
      this.start(job);
    }
  }

  start(job) {
    job.state = 'running';
    this.active += 1;
    let workPromise;
    try {
      // Invoke immediately so a resolver can attach its AbortSignal listener
      // before a caller changes track in the same event turn.
      workPromise = job.work({ signal: job.controller.signal, key: job.key, kind: job.kind });
    } catch (error) {
      workPromise = Promise.reject(error);
    }
    const releaseSlot = () => {
      this.active = Math.max(0, this.active - 1);
      // Remove before notifying subscribers. An immediately-following forced
      // refresh must create a new job instead of attaching to a completed one.
      if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
      this.pump();
    };

    Promise.resolve(workPromise)
      .then((result) => {
        if (job.controller.signal.aborted) throw createAbortError();
        job.state = 'completed';
        this.stats.completed += 1;
        releaseSlot();
        job.resolve(result);
      })
      .catch((error) => {
        const normalized = isAbortError(error) || job.controller.signal.aborted ? createAbortError() : error;
        job.state = normalized.code === 'ABORTED' ? 'cancelled' : 'failed';
        if (job.state === 'cancelled') this.stats.cancelled += 1;
        else this.stats.failed += 1;
        releaseSlot();
        job.reject(normalized);
      });
  }

  cancel(key, reason = 'La extracciÃ³n ya no es necesaria') {
    const normalizedKey = String(key || '');
    const job = this.jobs.get(normalizedKey);
    if (!job || ['completed', 'failed', 'cancelled'].includes(job.state)) return false;
    job.controller.abort();
    if (job.state === 'queued') {
      job.state = 'cancelled';
      this.pending = this.pending.filter(item => item !== job);
      this.jobs.delete(job.key);
      this.stats.cancelled += 1;
      job.reject(createAbortError(reason));
    }
    return true;
  }

  cancelWhere(predicate, reason) {
    let cancelled = 0;
    for (const job of [...this.jobs.values()]) {
      if (typeof predicate === 'function' && !predicate(job)) continue;
      if (this.cancel(job.key, reason)) cancelled += 1;
    }
    return cancelled;
  }

  getJob(key) {
    return this.jobs.get(String(key || '')) || null;
  }

  getJobs() {
    return [...this.jobs.values()];
  }

  getStats() {
    return {
      ...this.stats,
      active: this.active,
      pending: this.pending.filter(job => job.state === 'queued').length,
      maxConcurrent: this.maxConcurrent,
      jobs: [...this.jobs.values()].map(job => ({
        key: job.key,
        kind: job.kind,
        state: job.state,
        priority: job.priority,
        ageMs: Math.max(0, Date.now() - job.createdAt)
      }))
    };
  }
}

module.exports = { ExtractionQueue, PRIORITY, createAbortError, isAbortError };

