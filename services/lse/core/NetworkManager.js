const http = require('http');
const https = require('https');
const dns = require('dns');
const net = require('net');
const { LSEError, toLSEError } = require('./errors');

const dnsLookup = dns.promises.lookup;

function stripIpv6Brackets(value = '') {
  return String(value).replace(/^\[|\]$/g, '').toLowerCase();
}

function parseIPv4(value) {
  const parts = String(value).split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part))) return null;
  const numbers = parts.map(Number);
  return numbers.every(part => part >= 0 && part <= 255) ? numbers : null;
}

function isPrivateIpv4(address) {
  const parts = parseIPv4(address);
  if (!parts) return false;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0)
    || (a === 192 && b === 2)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51)
    || (a === 203 && b === 0 && parts[2] === 113)
    || a >= 224;
}

function isPrivateIpv6(address) {
  const normalized = stripIpv6Brackets(address);
  if (!normalized) return true;
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('2001:db8:')) return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true;
  const mappedMatch = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return !!mappedMatch && isPrivateIpv4(mappedMatch[1]);
}

function isUnsafeIp(address) {
  const family = net.isIP(stripIpv6Brackets(address));
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

function isBlockedHostname(hostname = '') {
  const value = String(hostname).trim().toLowerCase();
  return !value
    || value === 'localhost'
    || value.endsWith('.localhost')
    || value.endsWith('.local')
    || value.endsWith('.internal')
    || value.endsWith('.home.arpa');
}

function getContentLength(headers = {}) {
  const raw = headers['content-length'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const length = Number(value);
  return Number.isFinite(length) && length >= 0 ? length : null;
}

function getHeader(headers = {}, name) {
  const raw = headers[String(name).toLowerCase()];
  return Array.isArray(raw) ? raw[0] : raw || '';
}

function isRedirect(statusCode) {
  return [301, 302, 303, 307, 308].includes(Number(statusCode));
}

function createAbortError() {
  const error = new Error('La operacion fue cancelada');
  error.name = 'AbortError';
  error.code = 'ABORTED';
  return error;
}

class NetworkManager {
  constructor(options = {}) {
    this.allowPrivateNetwork = options.allowPrivateNetwork === true || options.allowPrivateNetworkForTests === true;
    this.lookup = options.lookup || dnsLookup;
    this.defaultTimeoutMs = Math.max(1000, Number(options.defaultTimeoutMs) || 8000);
    this.maxRedirects = Math.max(0, Number(options.maxRedirects) || 4);
    this.maxConnections = Math.max(1, Math.min(8, Number(options.maxConnections) || 4));
    this.activeRequests = 0;
    this.totalRequests = 0;
    this.failedRequests = 0;
    this.pendingRequests = [];
  }

  validateUrl(rawUrl) {
    let url;
    try {
      url = rawUrl instanceof URL ? new URL(rawUrl.toString()) : new URL(String(rawUrl || '').trim());
    } catch (error) {
      throw new LSEError('INVALID_SOURCE', 'La URL de medios no es valida', { recoverable: false });
    }

    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new LSEError('INVALID_SOURCE', 'LSE solo permite URLs HTTP o HTTPS para streaming remoto', { recoverable: false });
    }

    if (url.username || url.password) {
      throw new LSEError('INVALID_SOURCE', 'Las URLs con credenciales no estan permitidas', { recoverable: false });
    }

    if (isBlockedHostname(url.hostname)) {
      throw new LSEError('NETWORK_DESTINATION_BLOCKED', 'El destino de red no esta permitido', {
        recoverable: false,
        details: { hostname: url.hostname }
      });
    }

    return url;
  }

  async resolveHost(url) {
    const hostname = stripIpv6Brackets(url.hostname);
    const directFamily = net.isIP(hostname);
    if (directFamily) {
      if (!this.allowPrivateNetwork && isUnsafeIp(hostname)) {
        throw new LSEError('NETWORK_DESTINATION_BLOCKED', 'No se permiten destinos locales o privados', {
          recoverable: false,
          details: { hostname }
        });
      }
      return { address: hostname, family: directFamily };
    }

    let addresses;
    try {
      addresses = await this.lookup(hostname, { all: true, verbatim: true });
    } catch (error) {
      throw new LSEError('NETWORK_DNS_ERROR', 'No se pudo resolver el servidor de medios', {
        details: { hostname },
        cause: error
      });
    }

    if (!Array.isArray(addresses) || !addresses.length) {
      throw new LSEError('NETWORK_DNS_ERROR', 'El servidor de medios no devolvio una direccion util', {
        details: { hostname }
      });
    }

    if (!this.allowPrivateNetwork && addresses.some(record => isUnsafeIp(record.address))) {
      throw new LSEError('NETWORK_DESTINATION_BLOCKED', 'El destino de red resuelve a una direccion privada', {
        recoverable: false,
        details: { hostname }
      });
    }

    const first = addresses.find(record => record?.address);
    return { address: first.address, family: first.family || net.isIP(first.address) };
  }

  async assertPublicUrl(rawUrl) {
    const url = this.validateUrl(rawUrl);
    const target = await this.resolveHost(url);
    return { url, ...target };
  }

  acquireConnection(signal) {
    if (signal?.aborted) return Promise.reject(createAbortError());
    if (this.activeRequests < this.maxConnections) {
      this.activeRequests += 1;
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const waiter = {
        signal,
        resolve: () => {
          signal?.removeEventListener('abort', waiter.abort);
          resolve();
        },
        reject: (error) => {
          signal?.removeEventListener('abort', waiter.abort);
          reject(error);
        },
        abort: null
      };
      waiter.abort = () => {
        const index = this.pendingRequests.indexOf(waiter);
        if (index >= 0) this.pendingRequests.splice(index, 1);
        waiter.reject(createAbortError());
      };
      if (signal) signal.addEventListener('abort', waiter.abort, { once: true });
      this.pendingRequests.push(waiter);
    });
  }

  releaseConnection() {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    while (this.pendingRequests.length) {
      const waiter = this.pendingRequests.shift();
      if (!waiter || waiter.signal?.aborted) {
        waiter?.reject(createAbortError());
        continue;
      }
      this.activeRequests += 1;
      waiter.resolve();
      break;
    }
  }

  async request(rawUrl, options = {}) {
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || this.defaultTimeoutMs);
    const redirectCount = Number(options.redirectCount) || 0;
    const method = String(options.method || 'GET').toUpperCase();
    const signal = options.signal;

    if (signal?.aborted) throw createAbortError();
    const target = await this.assertPublicUrl(rawUrl);
    const transport = target.url.protocol === 'https:' ? https : http;
    const startedAt = Date.now();
    this.totalRequests += 1;
    let connectionAcquired = false;

    try {
      await this.acquireConnection(signal);
      connectionAcquired = true;
      const response = await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          callback(value);
        };
        const onAbort = () => {
          request.destroy(createAbortError());
          finish(reject, createAbortError());
        };
        const request = transport.request({
          protocol: target.url.protocol,
          hostname: stripIpv6Brackets(target.url.hostname),
          port: target.url.port || undefined,
          path: `${target.url.pathname}${target.url.search}`,
          method,
          headers: {
            'User-Agent': 'Lunera Stream Engine/1.0',
            Accept: 'audio/*,video/*;q=0.7,*/*;q=0.1',
            ...(options.headers || {})
          },
          lookup: (hostname, lookupOptions, callback) => callback(null, target.address, target.family),
          servername: stripIpv6Brackets(target.url.hostname)
        }, (incoming) => finish(resolve, incoming));

        request.setTimeout(timeoutMs, () => {
          const error = new Error('Tiempo de conexion agotado');
          error.code = 'ETIMEDOUT';
          request.destroy(error);
        });
        request.once('error', error => finish(reject, error));
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        request.end();
      });

      if (isRedirect(response.statusCode) && getHeader(response.headers, 'location')) {
        response.resume();
        if (redirectCount >= this.maxRedirects) {
          throw new LSEError('NETWORK_REDIRECT_LIMIT', 'El recurso de medios excedio el limite de redirecciones', {
            details: { url: target.url.origin }
          });
        }
        const redirectedUrl = new URL(getHeader(response.headers, 'location'), target.url).toString();
        // Liberar el cupo antes de seguir la redirección: con un límite de una
        // conexión, retenerlo durante la llamada recursiva causaría un bloqueo.
        if (connectionAcquired) {
          this.releaseConnection();
          connectionAcquired = false;
        }
        return this.request(redirectedUrl, { ...options, redirectCount: redirectCount + 1 });
      }

      return {
        url: target.url.toString(),
        statusCode: response.statusCode || 0,
        headers: response.headers || {},
        response,
        elapsedMs: Date.now() - startedAt,
        address: target.address
      };
    } catch (error) {
      this.failedRequests += 1;
      if (error instanceof LSEError) throw error;
      if (error?.code === 'ETIMEDOUT') {
        throw new LSEError('NETWORK_TIMEOUT', 'El servidor de medios tardo demasiado en responder', { cause: error });
      }
      throw toLSEError(error, 'NETWORK_ERROR');
    } finally {
      if (connectionAcquired) this.releaseConnection();
    }
  }

  async probe(rawUrl, options = {}) {
    const timeoutMs = options.timeoutMs || this.defaultTimeoutMs;
    let requestResult = await this.request(rawUrl, {
      method: 'HEAD',
      timeoutMs,
      signal: options.signal,
      headers: options.headers
    });
    requestResult.response.resume();

    if ([405, 501].includes(requestResult.statusCode)) {
      requestResult = await this.request(requestResult.url, {
        method: 'GET',
        timeoutMs,
        signal: options.signal,
        headers: { Range: 'bytes=0-0', ...(options.headers || {}) }
      });
      requestResult.response.resume();
    }

    if (requestResult.statusCode < 200 || requestResult.statusCode >= 300) {
      throw new LSEError('NETWORK_RESPONSE_ERROR', `El servidor de medios respondio HTTP ${requestResult.statusCode}`, {
        details: { statusCode: requestResult.statusCode, url: requestResult.url }
      });
    }

    const contentType = String(getHeader(requestResult.headers, 'content-type')).split(';')[0].trim().toLowerCase();
    return {
      url: requestResult.url,
      statusCode: requestResult.statusCode,
      headers: requestResult.headers,
      contentType,
      contentLength: getContentLength(requestResult.headers),
      acceptsRanges: /bytes/i.test(String(getHeader(requestResult.headers, 'accept-ranges'))),
      elapsedMs: requestResult.elapsedMs,
      address: requestResult.address
    };
  }

  isTemporaryUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);
      return [...url.searchParams.keys()].some(key => /^(token|sig|signature|expires?|x-amz-|policy|key-pair-id)/i.test(key));
    } catch (error) {
      return false;
    }
  }

  getStats() {
    return {
      activeRequests: this.activeRequests,
      totalRequests: this.totalRequests,
      failedRequests: this.failedRequests,
      queuedRequests: this.pendingRequests.length,
      maxConnections: this.maxConnections
    };
  }
}

module.exports = {
  NetworkManager,
  isUnsafeIp,
  isPrivateIpv4,
  isPrivateIpv6,
  isBlockedHostname,
  createAbortError
};
