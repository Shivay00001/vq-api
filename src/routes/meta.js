/* Meta: /health (public), /v1/status (auth), /v1/openapi.json (public). */
import { err } from '../index.js';
import { getUsage, TIER_QUOTAS } from '../metering.js';
import OPENAPI from '../../openapi.json';

export async function handleMeta(req, env, key) {
  const p = new URL(req.url).pathname;
  if (p === '/health') return { _status: 200, ok: true, service: 'vq-api', version: '1.0.0', time: new Date().toISOString() };
  if (p === '/v1/openapi.json') return new Response(JSON.stringify(OPENAPI), {
    status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } });
  if (p === '/v1/status') {
    const month = new Date().toISOString().slice(0, 7);
    const used = await getUsage(env, key.id, month);
    const quota = key.quota_override ?? TIER_QUOTAS[key.tier] ?? 0;
    return { _status: 200, key_id: key.id, name: key.name, tier: key.tier, test_mode: key.test_mode,
      usage: { month, used, quota, remaining: quota ? Math.max(0, quota - used) : null } };
  }
  return err('not_found', 'Unknown endpoint.', 404);
}
