const { LSEError } = require('../core/errors');

class BaseExtractor {
  constructor(options = {}) {
    this.id = options.id || 'base';
    this.name = options.name || this.id;
    this.capabilities = { ...(options.capabilities || {}) };
    this.enabled = options.enabled !== false;
    this.lastError = null;
    this.resolutionCount = 0;
    this.totalResolutionMs = 0;
  }

  async canHandle() {
    return false;
  }

  async resolve() {
    throw new LSEError('EXTRACTOR_NOT_IMPLEMENTED', `El extractor ${this.name} no implementa resolucion`, {
      provider: this.id,
      recoverable: false
    });
  }

  recordResolution(durationMs, error = null) {
    this.resolutionCount += 1;
    this.totalResolutionMs += Math.max(0, Number(durationMs) || 0);
    this.lastError = error ? String(error.message || error).slice(0, 300) : null;
  }

  getStatus() {
    return {
      id: this.id,
      name: this.name,
      enabled: this.enabled,
      capabilities: { ...this.capabilities },
      lastError: this.lastError,
      averageResolutionMs: this.resolutionCount
        ? Math.round(this.totalResolutionMs / this.resolutionCount)
        : null,
      resolutionCount: this.resolutionCount
    };
  }
}

module.exports = { BaseExtractor };
