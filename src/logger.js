/* Audit log: capped tail per key (last 100), plus admin action log. */
export async function audit(env, keyId, action, detail) {
  try {
    const k = 'audit:' + (keyId || 'anon');
    const list = (await env.KV.get(k, 'json')) || [];
    list.push({ t: new Date().toISOString(), action, detail: detail || {} });
    await env.KV.put(k, JSON.stringify(list.slice(-100)));
  } catch { /* audit must never break the request */ }
}

export async function getAudit(env, keyId, limit) {
  const list = (await env.KV.get('audit:' + keyId, 'json')) || [];
  return list.slice(-(limit || 50)).reverse();
}
