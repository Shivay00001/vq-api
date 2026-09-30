/* API key auth. Keys: vq_live_<32 random bytes base64url> / vq_test_<...>.
 * Only the SHA-256 hash is stored (KV: key:hash -> record). Raw key is
 * shown exactly once at issuance. Prefix stored for identification.
 */
import { err } from './index.js';

async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function keyInUrl(url) {
  for (const v of url.searchParams.values()) {
    if (/^vq_(live|test)_/i.test(v)) return true;
  }
  return false;
}

function newRawKey(testMode) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return (testMode ? 'vq_test_' : 'vq_live_') + b64;
}

export async function issueKey(env, { name, tier, testMode, quotaOverride }) {
  const raw = newRawKey(!!testMode);
  const hash = await sha256Hex(raw);
  const id = 'key_' + hash.slice(0, 12);
  const rec = {
    id, name: String(name || 'unnamed').slice(0, 80),
    tier: tier || 'free',
    prefix: raw.slice(0, 14) + '…',
    hash, created_at: new Date().toISOString(),
    revoked: false, test_mode: !!testMode,
  };
  // per-key monthly spend cap (overrides tier quota); validated by caller
  if (quotaOverride != null) rec.quota_override = quotaOverride;
  await env.KV.put('key:' + hash, JSON.stringify(rec));
  return { record: rec, raw };
}

export async function authenticate(req, env) {
  const h = req.headers.get('authorization') || '';
  const m = h.match(/^Bearer\s+(vq_(live|test)_[A-Za-z0-9\-_]+)\s*$/i);
  if (!m) return { error: err('missing_auth', 'Provide Authorization: Bearer vq_live_… (or vq_test_…).', 401) };
  const raw = m[1];
  const hash = await sha256Hex(raw);
  const recRaw = await env.KV.get('key:' + hash);
  if (!recRaw) return { error: err('invalid_key', 'API key not recognized.', 401) };
  const rec = JSON.parse(recRaw);
  if (rec.revoked) return { error: err('revoked_key', 'This API key has been revoked.', 403) };
  return rec;
}

export async function getKeyById(env, id) {
  // index: keyid:<id> -> key:<hash>
  const ptr = await env.KV.get('keyid:' + id);
  if (!ptr) return null;
  const recRaw = await env.KV.get(ptr);
  return recRaw ? JSON.parse(recRaw) : null;
}

export async function storeKeyRecord(env, rec) {
  await env.KV.put('key:' + rec.hash, JSON.stringify(rec));
  await env.KV.put('keyid:' + rec.id, 'key:' + rec.hash);
}
