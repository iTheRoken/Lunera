const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fileURLToPath, pathToFileURL } = require('url');
const { BaseExtractor } = require('./BaseExtractor');
const { LSEError } = require('../core/errors');
const { normalizeFormat, selectFormat, buildStreamingProfile, inferContainer } = require('../core/FormatSelector');

const SUPPORTED_LOCAL_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'ogg', 'opus', 'webm', 'wav', 'flac', 'mp4']);

function getLocalPath(source) {
  const candidate = typeof source === 'object' && source
    ? source.filePath || source.localPath || source.path || source.url
    : source;
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  if (candidate.startsWith('file:')) {
    try {
      return fileURLToPath(candidate);
    } catch (error) {
      return null;
    }
  }
  return path.isAbsolute(candidate) ? candidate : null;
}

function localId(filePath, stat) {
  return `local-${crypto.createHash('sha256')
    .update(`${filePath}:${stat.size}:${Math.floor(stat.mtimeMs)}`)
    .digest('hex')
    .slice(0, 24)}`;
}

class LocalExtractor extends BaseExtractor {
  constructor(options = {}) {
    super({
      id: 'lse-local',
      name: 'Archivos locales',
      capabilities: {
        local: true,
        progressiveStreaming: false,
        rangeRequests: true,
        playback: true,
        downloads: false
      },
      ...options
    });
  }

  async canHandle(source) {
    if (source && typeof source === 'object' && source.type === 'local') return true;
    return !!getLocalPath(source);
  }

  async resolve(source, context = {}) {
    const filePath = getLocalPath(source);
    if (!filePath) {
      throw new LSEError('INVALID_SOURCE', 'LSE necesita una ruta local absoluta o una URL file://', {
        provider: this.id,
        recoverable: false
      });
    }

    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (error) {
      throw new LSEError('LOCAL_FILE_NOT_FOUND', 'No se encontro el archivo local solicitado', {
        provider: this.id,
        details: { file: path.basename(filePath) },
        cause: error
      });
    }

    if (!stat.isFile()) {
      throw new LSEError('LOCAL_FILE_INVALID', 'La fuente local no es un archivo reproducible', {
        provider: this.id,
        recoverable: false
      });
    }

    const extension = path.extname(filePath).slice(1).toLowerCase();
    if (!SUPPORTED_LOCAL_EXTENSIONS.has(extension)) {
      throw new LSEError('FORMAT_UNSUPPORTED', `El formato .${extension || 'desconocido'} no esta habilitado para LSE`, {
        provider: this.id,
        recoverable: false
      });
    }

    const sourceMetadata = typeof source === 'object' && source ? source : {};
    const format = normalizeFormat({
      id: `local-${extension}`,
      container: inferContainer(pathToFileURL(filePath).toString()),
      url: pathToFileURL(filePath).toString(),
      filesize: stat.size,
      protocol: 'file',
      playable: true
    });
    const selectedFormat = selectFormat([format], context.options || {}) || format;
    const title = sourceMetadata.title || path.basename(filePath, path.extname(filePath));
    const metadata = {
      id: sourceMetadata.id || localId(filePath, stat),
      title,
      artist: sourceMetadata.artist || 'Archivo local',
      thumbnail: sourceMetadata.thumbnail || '',
      duration: Number(sourceMetadata.duration || 0) || 0,
      url: pathToFileURL(filePath).toString(),
      streamingProfile: buildStreamingProfile(selectedFormat, {
        source: 'local',
        extractor: this.id,
        quality: context.options?.quality || 'auto'
      })
    };

    return {
      extractor: this.id,
      audioUrl: pathToFileURL(filePath).toString(),
      metadata,
      formats: [format],
      selectedFormat,
      httpHeaders: {},
      sourcePolicy: {
        type: 'local',
        requiresProxy: false,
        supportsRange: true
      },
      cacheable: false,
      cachePersist: false
    };
  }
}

module.exports = {
  LocalExtractor,
  getLocalPath,
  SUPPORTED_LOCAL_EXTENSIONS
};
