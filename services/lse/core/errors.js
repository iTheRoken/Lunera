class LSEError extends Error {
  constructor(code, message, options = {}) {
    super(message || 'Error en Lunera Stream Engine');
    this.name = 'LSEError';
    this.code = code || 'LSE_ERROR';
    this.recoverable = options.recoverable !== false;
    this.provider = options.provider || null;
    this.details = sanitizeDetails(options.details);
    if (options.cause) this.cause = options.cause;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      recoverable: this.recoverable,
      provider: this.provider,
      details: this.details
    };
  }
}

function sanitizeDetails(value, depth = 0) {
  if (depth > 3 || value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value
      .replace(/(authorization|cookie|token|signature|sig)=?[^\s&,]+/gi, '$1=[redacted]')
      .slice(0, 1200);
  }
  if (Array.isArray(value)) return value.slice(0, 30).map(item => sanitizeDetails(item, depth + 1));
  if (typeof value === 'object') {
    return Object.entries(value).reduce((result, [key, item]) => {
      if (/authorization|cookie|token|signature|secret|password/i.test(key)) {
        result[key] = '[redacted]';
      } else {
        result[key] = sanitizeDetails(item, depth + 1);
      }
      return result;
    }, {});
  }
  return value;
}

function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORTED' || error?.code === 'ERR_ABORTED';
}

function toLSEError(error, fallbackCode = 'LSE_ERROR', options = {}) {
  if (error instanceof LSEError) return error;
  if (isAbortError(error)) {
    return new LSEError('ABORTED', 'La operacion de streaming fue cancelada', {
      recoverable: true,
      ...options,
      cause: error
    });
  }

  return new LSEError(
    fallbackCode,
    String(error?.message || error || 'Error desconocido en LSE').slice(0, 600),
    { ...options, cause: error }
  );
}

module.exports = {
  LSEError,
  toLSEError,
  isAbortError,
  sanitizeDetails
};
