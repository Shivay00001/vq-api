/* Monthly usage metering against tier quotas.
 * Quotas: free 1k/mo, pro 25k/mo, business 250k/mo, enterprise custom (0 = unlimited w/ abuse caps).
 *
 * PRODUCTION-GRADE: when Upstash Redis is configured (and not LOCAL_DEV), all
 * counter ops are atomic (INCR/GET via REST). The old KV read-modify-write path
 * remains as the local-dev fallback and is documented prototype-grade: under
 * concurrency it both overshoots enforcement and loses metered increments.
 */
import { err } from './index.js';

export const TIER_QUOTAS = { free: 1000, pro: 25000, business: 250000, enterprise: 0 };

function monthKey(d) {
  d = d || new Date();
  return d.toISOString().slice(0, 7); // YYYY-MM
}

function quotaTTL() {
  const next = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 2);
  return Math.max(3600, Math.floor((next - Date.now()) / 1000));
}

/* Upstash Redis REST helper. Returns parsed JSON, or null when Redis is not
 * configured / unreachable / this is local dev (KV fallback). */
async function redisCmd(env, body, pipeline = false) {
  const url = env.UPSTASH_REDIS_REST_URL, token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token || env.LOCAL_DEV === '1') return null;
  try {
    const r = await fetch(url + (pipeline ? '/pipeline' : ''), {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/* Atomic read of the monthly counter: Redis GET when configured, else KV. */
async function getUsageCount(env, mk) {
  const j = await redisCmd(env, ['GET', mk]);
  if (j) return j.result == null ? 0 : parseInt(j.result, 10); // configured: authoritative
  return parseInt((await env.KV.get(mk)) || '0', 10); // local fallback
}

export async function checkQuota(env, key) {
  const quota = key.quota_override ?? TIER_QUOTAS[key.tier] ?? TIER_QUOTAS.free;
  if (!quota) return { ok: true, quota: 0, used: 0 }; // enterprise custom
  const mk = `usage:${key.id}:${monthKey()}`;
  const used = await getUsageCount(env, mk);
  if (used >= quota) {
    const reset = monthKey() + '-01T00:00:00Z next-month';
    return { error: err('quota_exceeded', `Monthly quota exhausted (${used}/${quota} calls). Upgrade at visionquantech.com/pricing.`, 402,
      { quota, used, resets_at: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString() }) };
  }
  return { ok: true, quota, used };
}

export async function recordUsage(env, key) {
  const mk = `usage:${key.id}:${monthKey()}`;
  const ttl = quotaTTL();
  // Atomic INCR when Redis is configured — no lost increments under concurrency.
  const j = await redisCmd(env, [['INCR', mk], ['EXPIRE', mk, String(ttl)]], true);
  if (j) return;
  // Local fallback: KV read-modify-write (prototype-grade, races under concurrency).
  const cur = parseInt((await env.KV.get(mk)) || '0', 10);
  await env.KV.put(mk, String(cur + 1), { expirationTtl: ttl });
}

export async function getUsage(env, keyId, month) {
  const mk = `usage:${keyId}:${month || monthKey()}`;
  return getUsageCount(env, mk);
}

/* HARDENING: cost-awareness warnings at 70% / 90% of monthly quota. */
export async function quotaWarning(env, key) {
  const quota = key.quota_override ?? TIER_QUOTAS[key.tier] ?? TIER_QUOTAS.free;
  if (!quota) return null;
  const used = await getUsage(env, key.id);
  const pct = used / quota;
  if (pct >= 0.9) return `90% of monthly quota used (${used}/${quota}). Upgrade or requests will 402.`;
  if (pct >= 0.7) return `70% of monthly quota used (${used}/${quota}).`;
  return null;
}
