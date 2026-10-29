const { BaseExtractor } = require('./BaseExtractor');
const { LSEError } = require('../core/errors');
const { getRemoteUrl } = require('./DirectMediaExtractor');

function isHlsCandidate(source) {
  const url = getRemoteUrl(source);
  if (source && typeof source === 'object' && source.type === 'hls') return true;
  return !!url && /\.m3u8(?:$|[?#])/i.test(url.toString());
}

class HLSExtractor extends BaseExtractor {
  constructor(options = {}) {
    super({
      id: 'lse-hls',
      name: 'HLS directo',
      capabilities: {
        detection: true,
        hls: true,
        playback: false,
        progressiveStreaming: false,
        reason: 'Electron no incluye un adaptador HLS integrado en LSE todavia'
      },
      ...options
    });
  }

  async canHandle(source) {
    return isHlsCandidate(source);
  }

  async resolve(source, context = {}) {
    const url = getRemoteUrl(source);
    if (!url) throw new LSEError('INVALID_SOURCE', 'La manifestacion HLS no tiene una URL valida', { provider: this.id });
    const probe = await context.networkManager.probe(url.toString(), {
      signal: context.signal,
      timeoutMs: context.options?.timeoutMs
    });
    const isHls = /mpegurl|vnd\.apple\.mpegurl/i.test(probe.contentType) || /\.m3u8(?:$|[?#])/i.test(probe.url);
    if (!isHls) {
      throw new LSEError('SOURCE_UNSUPPORTED', 'La URL no parece ser una manifestacion HLS valida', {
        provider: this.id,
        recoverable: false,
        details: { contentType: probe.contentType || 'desconocido' }
      });
    }
    throw new LSEError('PLAYBACK_UNSUPPORTED', 'LSE detecto HLS, pero esta version no declara reproduccion HLS sin un adaptador MSE real.', {
      provider: this.id,
      recoverable: false,
      details: { protocol: 'hls', contentType: probe.contentType || null }
    });
  }
}

module.exports = { HLSExtractor, isHlsCandidate };
