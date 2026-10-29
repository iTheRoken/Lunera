'use strict';

const ytdlpService = require('../../ytdlpService');

class YtDlpManager {
  constructor(options = {}) {
    this.resolver = typeof options.resolver === 'function' ? options.resolver : ytdlpService.extract;
    this.diagnosticsProvider = typeof options.diagnosticsProvider === 'function'
      ? options.diagnosticsProvider
      : ytdlpService.getRuntimeDiagnostics;
  }

  async resolve(url, options = {}) {
    return this.resolver(url, {
      quality: options.quality || 'auto',
      manualFormatId: options.manualFormatId,
      preferredCodec: options.preferredCodec,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      jsRuntimePath: options.jsRuntimePath,
      requestId: options.requestId,
      onProgress: options.onProgress
    });
  }

  async getDiagnostics(options = {}) {
    if (typeof this.diagnosticsProvider !== 'function') return { available: false };
    try {
      return await this.diagnosticsProvider(options);
    } catch (error) {
      return { available: false, error: String(error?.message || error).slice(0, 300) };
    }
  }

  async checkDependencies(options = {}) {
    try {
      if (typeof ytdlpService.getYtDlpVersion === 'function') {
        await ytdlpService.getYtDlpVersion({ timeoutMs: 5000 });
      }
      return await this.getDiagnostics(options);
    } catch (error) {
      return { available: false, error: String(error?.message || error).slice(0, 300) };
    }
  }
}

module.exports = { YtDlpManager };

