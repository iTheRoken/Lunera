const { BaseExtractor } = require('./BaseExtractor');
const { LSEError } = require('../core/errors');
const { getRemoteUrl } = require('./DirectMediaExtractor');

function isDashCandidate(source) {
  const url = getRemoteUrl(source);
  if (source && typeof source === 'object' && source.type === 'dash') return true;
  return !!url && /\.mpd(?:$|[?#])/i.test(url.toString());
}

class DASHExtractor extends BaseExtractor {
  constructor(options = {}) {
    super({
      id: 'lse-dash',
      name: 'DASH directo',
      capabilities: {
        detection: true,
        dash: true,
        playback: false,
        progressiveStreaming: false,
        reason: 'Electron no incluye un adaptador DASH integrado en LSE todavia'
      },
      ...options
    });
  }

  async canHandle(source) {
    return isDashCandidate(source);
  }

  async resolve(source, context = {}) {
    const url = getRemoteUrl(source);
    if (!url) throw new LSEError('INVALID_SOURCE', 'La manifestacion DASH no tiene una URL valida', { provider: this.id });
    const probe = await context.networkManager.probe(url.toString(), {
      signal: context.signal,
      timeoutMs: context.options?.timeoutMs
    });
    const isDash = /dash\+xml|application\/xml/i.test(probe.contentType) || /\.mpd(?:$|[?#])/i.test(probe.url);
    if (!isDash) {
      throw new LSEError('SOURCE_UNSUPPORTED', 'La URL no parece ser una manifestacion DASH valida', {
        provider: this.id,
        recoverable: false,
        details: { contentType: probe.contentType || 'desconocido' }
      });
    }
    throw new LSEError('PLAYBACK_UNSUPPORTED', 'LSE detecto DASH, pero esta version no declara reproduccion DASH sin un adaptador MSE real.', {
      provider: this.id,
      recoverable: false,
      details: { protocol: 'dash', contentType: probe.contentType || null }
    });
  }
}

module.exports = { DASHExtractor, isDashCandidate };
