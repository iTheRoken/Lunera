'use strict';

function parseRangeHeader(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return null;
  const start = match[1] === '' ? null : Number(match[1]);
  const end = match[2] === '' ? null : Number(match[2]);
  if ((start !== null && (!Number.isSafeInteger(start) || start < 0)) || (end !== null && (!Number.isSafeInteger(end) || end < 0))) {
    return null;
  }
  if (start !== null && end !== null && end < start) return null;
  return { start, end, raw: `bytes=${match[1]}-${match[2]}` };
}

function isRangeStatus(statusCode) {
  return [200, 206, 416].includes(Number(statusCode));
}

module.exports = { parseRangeHeader, isRangeStatus };

