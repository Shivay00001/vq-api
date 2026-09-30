/* Idempotency for POST: client sends Idempotency-Key header.
 * Same key + same body hash within 24h -> replay stored response.
 * Same key + different body -> 409. Stored in KV (24h TTL).
 */
import { err } from './index.js';

async function bodyHash(req) {
  const buf = await req.arrayBuffer();
  req._rawBody = buf; // stash for route handlers
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function idempotencyCheck(req, env, key) {
  const ik = req.headers.get('idempotency-key');
  if (!ik) return { ok: true, key: null };
  if (!/^[A-Za-z0-9\-_]{8,128}$/.test(ik)) {
    return { error: err('invalid_param', 'Idempotency-Key must be 8-128 chars [A-Za-z0-9-_].', 400) };
  }
  const hash = await bodyHash(req);
  const kvk = `idem:${key.id}:${ik}`;
  const prev = await env.KV.get(kvk, 'json');
  if (prev) {
    if (prev.hash === hash) return { replay: prev };
    return { error: err('idempotency_conflict', 'Idempotency-Key already used with a different payload.', 409) };
  }
  return { ok: true, key: ik, hash };
}

export async function idempotencyStore(env, key, ik, hash, status, body) {
  if (!ik) return;
  await env.KV.put(`idem:${key.id}:${ik}`, JSON.stringify({ hash, status, body }), { expirationTtl: 86400 });
}

/* Body re-read helpers: idempotencyCheck consumes the body into req._rawBody
 * when an Idempotency-Key is present; route handlers must use these. */
export async function jsonBodyOf(req) {
  if (req._rawBody) return JSON.parse(new TextDecoder().decode(req._rawBody));
  return req.json();
}
export async function formDataOf(req) {
  if (req._rawBody) {
    const r = new Request(req.url, { method: 'POST', headers: req.headers, body: req._rawBody });
    return r.formData();
  }
  return req.formData();
}
