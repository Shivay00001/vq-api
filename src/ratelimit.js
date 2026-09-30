/* Tiered rate limiting — sliding window via Upstash Redis (REST).
 * Falls back to in-memory (local dev / Upstash unreachable: gateway keeps
 * serving — documented degradation, single-isolate only).
 * Tiers: free 10/min, pro 60/min, business 300/min, enterprise 1000/min.
 * Global IP abuse cap: 1000/min.
 */
import { err } from './index.js';

const TIER_LIMITS = { free: 10, business: 300, pro: 60, enterprise: 1000 };
const mem = new Map(); // key -> array of timestamps (dev fallback)

function memCheck(id, limit, windowMs) {
  const now = Date.now();
  let arr = mem.get(id) || [];
  arr = arr.filter(t => now - t < windowMs);
  if (arr.length >= limit) return { limited: true, retryAfter: Math.ceil((arr[0] + windowMs - now) / 1000) };
  arr.push(now);
  mem.set(id, arr);
  return { limited: false };
}

async function redisEval(env, key, limit, windowSec) {
  const url = env.UPSTASH_REDIS_REST_URL, token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const now = Date.now();
  const member = now + ':' + Math.random().toString(36).slice(2);
  // pipeline: ZADD, ZREMRANGEBYSCORE, ZCARD, EXPIRE
  const body = [
    ['ZADD', key, String(now), member],
    ['ZREMRANGEBYSCORE', key, '0', String(now - windowSec * 1000)],
    ['ZCARD', key],
    ['EXPIRE', key, String(windowSec + 5)],
  ];
  try {
    const r = await fetch(url + '/pipeline', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const count = j?.result?.[2]?.result ?? 0;
    if (count > limit) {
      await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify(['ZREM', key, member]) });
      return { limited: true, retryAfter: windowSec };
    }
    return { limited: false };
  } catch { return null; }
}

async function check(env, id, limit, windowSec = 60) {
  const useRedis = !(env.LOCAL_DEV === '1');
  if (useRedis) {
    const r = await redisEval(env, 'rl:' + id, limit, windowSec);
    if (r) return r;
  }
  return memCheck(id, limit, windowSec * 1000);
}

export async function checkRateLimit(env, key) {
  const tierLimit = TIER_LIMITS[key.tier] || TIER_LIMITS.free;
  const k = await check(env, 'key:' + key.id, tierLimit);
  if (k.limited) {
    return { error: err('rate_limited', `Rate limit exceeded: ${tierLimit} requests/minute for tier '${key.tier}'.`, 429,
      { limit: tierLimit, window: '60s' }), retryAfter: k.retryAfter };
  }
  return { ok: true };
}

/* Per-IP limits applied to EVERY endpoint (before auth): global abuse cap +
 * stricter brute-force cap on the admin plane. */
export async function checkIpLimit(env, req) {
  const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'unknown';
  const url = new URL(req.url);
  if (url.pathname.startsWith('/v1/admin/')) {
    const a = await check(env, 'ipadm:' + ip, 60);
    if (a.limited) {
      return { error: err('rate_limited', 'Too many admin attempts from this IP.', 429, { limit: 60, window: '60s' }), retryAfter: a.retryAfter };
    }
  }
  const g = await check(env, 'ip:' + ip, 1000);
  if (g.limited) {
    return { error: err('rate_limited', 'Global abuse cap exceeded for this IP.', 429, { limit: 1000, window: '60s' }), retryAfter: g.retryAfter };
  }
  return { ok: true };
}
