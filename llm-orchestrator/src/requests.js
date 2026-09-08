// src/requests.js -- in-memory ring buffer of recent requests.
// Used by the web dashboard to show activity. Not persisted.

const MAX = 200;
const buffer = [];

export function logRequest({ method, path, status, tookMs, model, swap, error, bytes }) {
  const entry = {
    ts: new Date().toISOString(),
    method,
    path,
    status,
    tookMs,
    model: model || null,
    swap: swap || null,
    bytes: bytes || null,
    error: error || null,
  };
  buffer.push(entry);
  if (buffer.length > MAX) buffer.shift();
  return entry;
}

export function listRequests({ limit = 50 } = {}) {
  return buffer.slice(-limit).reverse();
}

export function clearRequests() {
  buffer.length = 0;
}
