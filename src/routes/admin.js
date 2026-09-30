/* Admin plane: API key lifecycle + usage + audit.
 * Guarded by X-Admin-Secret (never an API key). All actions audited.
 */
import { issueKey, storeKeyRecord, getKeyById } from '../auth.js';
import { getUsage, TIER_QUOTAS } from '../metering.js';
import { getAudit, audit } from '../logger.js';
import { err } from '../index.js';
import { jsonBodyOf } from '../idempotency.js';

const TIERS = ['free', 'pro', 'business', 'enterprise'];

function checkAdmin(req, env) {
  const s = req.headers.get('x-admin-secret') || '';
  if (!env.ADMIN_SECRET || s !== env.ADMIN_SECRET)
    return err('forbidden', 'Admin access denied.', 403);
  return null;
}

export async function handleAdmin(req, env) {
  const denied = checkAdmin(req, env);
  if (denied) return denied;
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean); // v1, admin, keys, [id], [action]
  const method = req.method;

  const body = async () => { try { return await jsonBodyOf(req); } catch { return {}; } };

  // POST /v1/admin/keys  {name, tier, test_mode}
  if (method === 'POST' && parts.length === 3 && parts[2] === 'keys') {
    const b = await body();
    if (!TIERS.includes(b.tier)) return err('invalid_param', `tier must be one of ${TIERS.join(', ')}`, 400);
    let quotaOverride = null;
    if (b.quota_override != null) {
      quotaOverride = parseInt(b.quota_override, 10);
      if (!Number.isInteger(quotaOverride) || quotaOverride < 1 || quotaOverride > 10000000)
        return err('invalid_param', 'quota_override must be an integer 1..10000000.', 400);
    }
    const { record, raw } = await issueKey(env, { name: b.name, tier: b.tier, testMode: b.test_mode !== false, quotaOverride });
    await storeKeyRecord(env, record);
    await audit(env, 'admin', 'key_issued', { id: record.id, tier: record.tier, name: record.name });
    return { _status: 201, id: record.id, name: record.name, tier: record.tier,
      api_key: raw, warning: 'Store this key now — it will never be shown again.' };
  }
  // GET /v1/admin/keys
  if (method === 'GET' && parts.length === 3 && parts[2] === 'keys') {
    const list = await env.KV.list({ prefix: 'key:' });
    const out = [];
    for (const k of list.keys.slice(0, 100)) {
      const r = await env.KV.get(k.name, 'json');
      if (r) { const { hash, ...pub } = r; out.push({ ...pub, quota: TIER_QUOTAS[pub.tier] ?? 0 }); }
    }
    return { _status: 200, keys: out };
  }
  // POST /v1/admin/keys/{id}/revoke | /rotate ; GET /usage ; GET /audit
  if (parts.length >= 4 && parts[2] === 'keys') {
    const rec = await getKeyById(env, parts[3]);
    if (!rec) return err('not_found', 'Key id not found.', 404);
    const action = parts[4];
    if (method === 'POST' && action === 'revoke') {
      rec.revoked = true; await storeKeyRecord(env, rec);
      await audit(env, 'admin', 'key_revoked', { id: rec.id });
      return { _status: 200, id: rec.id, revoked: true };
    }
    if (method === 'POST' && action === 'rotate') {
      rec.revoked = true; await storeKeyRecord(env, rec);
      const { record, raw } = await issueKey(env, { name: rec.name + ' (rotated)', tier: rec.tier, testMode: rec.test_mode });
      record.quota_override = rec.quota_override;
      await storeKeyRecord(env, record);
      await audit(env, 'admin', 'key_rotated', { old: rec.id, new: record.id });
      return { _status: 201, id: record.id, api_key: raw, warning: 'Old key revoked. Store the new key now.' };
    }
    if (method === 'GET' && action === 'usage') {
      const month = url.searchParams.get('month') || new Date().toISOString().slice(0, 7);
      const used = await getUsage(env, rec.id, month);
      return { _status: 200, id: rec.id, month, used, quota: rec.quota_override ?? TIER_QUOTAS[rec.tier] ?? 0, tier: rec.tier };
    }
    if (method === 'GET' && action === 'audit') {
      return { _status: 200, id: rec.id, events: await getAudit(env, rec.id, 50) };
    }
  }
  return err('not_found', 'Unknown admin endpoint.', 404);
}
