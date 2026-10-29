const crypto = require('crypto');
const { BaseExtractor } = require('./BaseExtractor');
const { LSEError } = require('../core/errors');
const { normalizeFormat, selectFormat, buildStreamingProfile, inferContainer } = require('../core/FormatSelector');

const DIRECT_MEDIA_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'webm', 'wav', 'flac', 'mp4']);
const MANIFEST_EXTENSIONS = new Set(['m3u8', 'mpd']);
const PROVIDER_PAGE_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'music.youtube.com', 'youtu.be',
  'vimeo.com', 'www.vimeo.com', 'spotify.com', 'open.spotify.com'
]);

function getRemoteUrl(source) {
  const candidate = typeof source === 'object' && source
    ? source.url || source.sourceUrl || source.audioUrl
    : source;
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  try {
    return new URL(candidate.trim());
  } catch (error) {
    return null;
  }
}

function getExtension(url) {
  const match = new URL(url).pathname.toLowerCase().match(/\.([a-z0-9]{2,5})$/);
  return match ? match[1] : '';
}

function isManifestUrl(url) {
  return MANIFEST_EXTENSIONS.has(getExtension(url));
}

function isProviderPage(url) {
  const host = new URL(url).hostname.toLowerCase();
  return PROVIDER_PAGE_HOSTS.has(host) || [...PROVIDER_PAGE_HOSTS].some(item => host.endsWith(`.${item}`));
}

function isDirectMediaType(contentType = '') {
  const value = String(contentType).toLowerCase();
  return value.startsWith('audio/')
    || value === 'application/ogg'
    || value === 'application/octet-stream'
    || value === 'video/mp4'
    || value === 'video/webm';
}

function stableMediaId(url) {
  return `direct-${crypto.createHash('sha256').update(url).digest('hex').slice(0, 24)}`;
}

function defaultTitle(url) {
  try {
    const filename = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'Audio directo');
    return filename.replace(/\.[a-z0-9]{2,5}$/i, '') || 'Audio directo';
  } catch (error) {
    return 'Audio directo';
  }
}

class DirectMediaExtractor extends BaseExtractor {
  constructor(options = {}) {
    super({
      id: 'lse-direct',
      name: 'Medios directos HTTP',
      capabilities: {
        directMedia: true,
        progressiveStreaming: true,
        rangeRequests: true,
        playback: true,
        downloads: true
      },
      ...options
    });
  }

  async canHandle(source) {
    const url = getRemoteUrl(source);
    if (!url || !['http:', 'https:'].includes(url.protocol)) return false;
    // Las manifestaciones las atienden sus extractores específicos. Las páginas
    // de proveedores pasan por este extractor únicamente para devolver una
    // restricción explícita, en lugar de fingir que son medios directos.
    if (isManifestUrl(url.toString())) return false;
    return true;
  }

  async resolve(source, context = {}) {
    const url = getRemoteUrl(source);
    if (!url) {
      throw new LSEError('INVALID_SOURCE', 'La fuente directa no contiene una URL valida', {
        provider: this.id,
        recoverable: false
      });
    }
    if (isProviderPage(url.toString())) {
      throw new LSEError('PROVIDER_RESTRICTION', 'LSE no extrae audio de paginas de proveedores. Usa un recurso directo autorizado.', {
        provider: this.id,
        recoverable: false
      });
    }

    const probe = await context.networkManager.probe(url.toString(), {
      signal: context.signal,
      timeoutMs: context.options?.timeoutMs
    });
    const extension = getExtension(probe.url);
    if (!isDirectMediaType(probe.contentType) && !DIRECT_MEDIA_EXTENSIONS.has(extension)) {
      throw new LSEError('SOURCE_UNSUPPORTED', 'La URL no expone un recurso de audio o video directo reproducible', {
        provider: this.id,
        recoverable: false,
        details: { contentType: probe.contentType || 'desconocido' }
      });
    }

    const sourceMetadata = typeof source === 'object' && source ? source : {};
    const progressiveStreaming = context.options?.progressiveStreamingEnabled !== false;
    const format = normalizeFormat({
      id: `direct-${inferContainer(probe.url, probe.contentType)}`,
      url: probe.url,
      contentType: probe.contentType,
      container: inferContainer(probe.url, probe.contentType),
      filesize: probe.contentLength,
      protocol: progressiveStreaming ? 'progressive' : 'sequential',
      playable: true,
      note: progressiveStreaming && probe.acceptsRanges ? 'HTTP Range' : 'Streaming secuencial'
    });
    const selectedFormat = selectFormat([format], context.options || {}) || format;
    const temporaryUrl = context.networkManager.isTemporaryUrl(probe.url);
    const metadata = {
      id: sourceMetadata.id || stableMediaId(probe.url),
      title: sourceMetadata.title || defaultTitle(probe.url),
      artist: sourceMetadata.artist || 'Fuente directa',
      thumbnail: sourceMetadata.thumbnail || '',
      duration: Number(sourceMetadata.duration || 0) || 0,
      url: probe.url,
      streamingProfile: buildStreamingProfile(selectedFormat, {
        source: 'network',
        extractor: this.id,
        quality: context.options?.quality || 'auto'
      })
    };

    return {
      extractor: this.id,
      audioUrl: probe.url,
      metadata,
      formats: [format],
      selectedFormat,
      httpHeaders: { 'User-Agent': 'Lunera Stream Engine/1.0' },
      sourcePolicy: {
        type: 'direct-media',
        requiresProxy: true,
        publicNetworkOnly: true,
        supportsRange: progressiveStreaming && probe.acceptsRanges,
        progressiveStreaming,
        approvedHost: new URL(probe.url).hostname,
        // El proxy local fija esta dirección al reproducir. Así una resolución
        // DNS posterior no puede redirigir un stream ya validado a una red
        // privada o interna.
        approvedAddress: probe.address || null,
        contentType: probe.contentType || null
      },
      cacheable: !temporaryUrl,
      cachePersist: !temporaryUrl,
      cacheTtlMs: temporaryUrl ? 30000 : 10 * 60 * 1000
    };
  }
}

module.exports = {
  DirectMediaExtractor,
  getRemoteUrl,
  isManifestUrl,
  isProviderPage,
  isDirectMediaType,
  DIRECT_MEDIA_EXTENSIONS
};
