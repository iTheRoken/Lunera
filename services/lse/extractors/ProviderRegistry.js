const { LSEError, toLSEError } = require('../core/errors');

class ProviderRegistry {
  constructor(extractors = []) {
    this.extractors = [];
    extractors.forEach(extractor => this.register(extractor));
  }

  register(extractor) {
    if (!extractor || typeof extractor.id !== 'string' || typeof extractor.resolve !== 'function') {
      throw new TypeError('El extractor LSE debe incluir id y resolve()');
    }
    if (this.extractors.some(candidate => candidate.id === extractor.id)) {
      throw new Error(`El extractor LSE ${extractor.id} ya fue registrado`);
    }
    this.extractors.push(extractor);
    return extractor;
  }

  setEnabled(id, enabled) {
    const extractor = this.extractors.find(candidate => candidate.id === id);
    if (!extractor) throw new LSEError('EXTRACTOR_NOT_FOUND', `No existe el extractor ${id}`);
    extractor.enabled = enabled !== false;
    return extractor.getStatus();
  }

  async findExtractor(source) {
    for (const extractor of this.extractors) {
      if (!extractor.enabled) continue;
      try {
        if (await extractor.canHandle(source)) return extractor;
      } catch (error) {
        extractor.recordResolution(0, error);
      }
    }
    return null;
  }

  async resolve(source, context = {}) {
    const extractor = await this.findExtractor(source);
    if (!extractor) {
      throw new LSEError('SOURCE_UNSUPPORTED', 'LSE no tiene un extractor compatible con esta fuente', {
        recoverable: false
      });
    }

    const startedAt = Date.now();
    try {
      const resolved = await extractor.resolve(source, context);
      extractor.recordResolution(Date.now() - startedAt);
      return { ...resolved, extractor: resolved.extractor || extractor.id };
    } catch (error) {
      const normalized = toLSEError(error, 'EXTRACTOR_ERROR', { provider: extractor.id });
      extractor.recordResolution(Date.now() - startedAt, normalized);
      throw normalized;
    }
  }

  getStatus() {
    return this.extractors.map(extractor => extractor.getStatus());
  }
}

module.exports = { ProviderRegistry };
