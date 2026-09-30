/* Break tests: rate-limit burst, oversized/malformed bodies, webhook replay
 * storm, concurrent quota race, media bombs.
 * Run: BASE=http://localhost:8787 ADMIN_SECRET=... node tests/break.mjs
 */
import { createHmac, randomBytes } from 'node:crypto';
const BASE = process.env.BASE || 'http://localhost:8787';
const ADMIN = process.env.ADMIN_SECRET || 'dev-admin-secret-change-me';
let pass = 0, fail = 0;
const rnd = () => randomBytes(6).toString('hex');
function t(name, ok, detail = '') {
  if (ok) { pass++; console.log('  PASS:', name); }
  else { fail++; console.log('  FAIL:', name, detail); }
}
async function R(method, path, { key, body, headers = {}, rawBody } = {}) {
  const h = { ...headers };
  if (key) h.authorization = 'Bearer ' + key;
  const b = rawBody !== undefined ? rawBody : (body !== undefined ? JSON.stringify(body) : undefined);
  if (b !== undefined && !h['content-type']) h['content-type'] = 'application/json';
  const r = await fetch(BASE + path, { method, headers: h, body: b });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, headers: r.headers, text, json };
}
async function issueKey(name, tier, extra = {}) {
  const r = await R('POST', '/v1/admin/keys', { headers: { 'x-admin-secret': ADMIN }, body: { name, tier, test_mode: true, ...extra } });
  if (r.status !== 201) throw new Error('issueKey failed: ' + r.text.slice(0, 120));
  return r.json;
}

// ---------- 1. rate-limit burst (free: 60/min) ----------
{
  const k = await issueKey('break-ratelimit', 'free');
  const reqs = Array.from({ length: 75 }, () => R('POST', '/v1/calc/emi', { key: k.api_key, body: { principal: 100, annual_rate_pct: 5, months: 12 } }));
  const rs = await Promise.all(reqs);
  const ok200 = rs.filter(r => r.status === 200).length;
  const r429 = rs.filter(r => r.status === 429);
  t('burst: some 200s', ok200 > 0, ok200);
  t('burst: rate limited (429s)', r429.length > 0, `429s=${r429.length}`);
  t('burst: 429 carries retry-after', r429.every(r => r.headers.get('retry-after')), 'missing header');
  t('burst: 429 code=rate_limited', r429.every(r => r.json?.error?.code === 'rate_limited'), 'wrong code');
}

// ---------- 2. oversized body -> 413 ----------
{
  const k = await issueKey('break-body', 'free');
  const big = 'x'.repeat(26 * 1024 * 1024);
  const r = await R('POST', '/v1/tools/word-count', { key: k.api_key, rawBody: big, headers: { 'content-type': 'text/plain' } });
  t('26MB body -> 413', r.status === 413 && r.json?.error?.code === 'file_too_large', r.status);
}

// ---------- 3. malformed JSON -> 400 ----------
{
  const k = await issueKey('break-malformed', 'free');
  const r = await R('POST', '/v1/calc/emi', { key: k.api_key, rawBody: '{"principal":', headers: { 'content-type': 'application/json' } });
  t('truncated JSON -> 400', r.status === 400, r.status);
}

// ---------- 4. webhook replay storm (20x same event) ----------
{
  const k = await issueKey('break-webhook', 'free');
  const co = await R('POST', '/v1/billing/checkout', { key: k.api_key, body: { tier: 'pro', provider: 'stripe', success_url: 'https://visionquantech.com/ok' } });
  const sid = co.json.checkout_session;
  const secret = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_dev_only';
  const evtId = 'evt_' + rnd();
  const payload = JSON.stringify({ id: evtId, type: 'checkout.session.completed', data: { object: { id: sid } } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex')}`;
  // sequential replays -> deduped (24h replay window)
  const seq = [];
  for (let i = 0; i < 5; i++) seq.push(await R('POST', '/v1/billing/webhook/stripe', { rawBody: payload, headers: { 'stripe-signature': sig, 'content-type': 'application/json' } }));
  t('replay sequential: all 200', seq.every(r => r.status === 200), seq.map(r => r.status).join(','));
  t('replay sequential: 4 deduped', seq.filter(r => r.json?.deduped === true).length === 4, seq.map(r => r.json?.deduped).join(','));
  // concurrent burst: app must not 500; 503s (if any) are local workerd throttling, not app logic
  const evtId2 = 'evt_' + rnd();
  const payload2 = JSON.stringify({ id: evtId2, type: 'checkout.session.completed', data: { object: { id: sid } } });
  const ts2 = Math.floor(Date.now() / 1000);
  const sig2 = `t=${ts2},v1=${createHmac('sha256', secret).update(`${ts2}.${payload2}`).digest('hex')}`;
  const rs = await Promise.all(Array.from({ length: 20 }, () =>
    R('POST', '/v1/billing/webhook/stripe', { rawBody: payload2, headers: { 'stripe-signature': sig2, 'content-type': 'application/json' } })));
  t('replay burst: no 500s', rs.every(r => r.status !== 500), rs.map(r => r.status).join(','));
  console.log(`  INFO: burst statuses: ${rs.map(r => r.status).join(',')}`);
  const st = await R('GET', '/v1/status', { key: k.api_key });
  t('replay storm: tier ends at pro (idempotent upgrade)', st.json?.tier === 'pro', st.json?.tier);
}

// ---------- 5. concurrent quota race (quota_override=5, 20 concurrent) ----------
// Local dev uses the KV read-modify-write fallback (prototype-grade): expect
// enforcement overshoot + lost metered increments. Production with Upstash
// Redis uses atomic INCR/GET (metering exact; enforcement overshoot bounded by
// in-flight concurrency only).
{
  const k = await issueKey('break-quota-race', 'free', { quota_override: 5 });
  const rs = await Promise.all(Array.from({ length: 20 }, () =>
    R('POST', '/v1/calc/emi', { key: k.api_key, body: { principal: 100, annual_rate_pct: 5, months: 12 } })));
  const codes = {};
  rs.forEach(r => { codes[r.status] = (codes[r.status] || 0) + 1; });
  const ok200 = codes[200] || 0;
  t('quota race: no 500s', !codes[500], JSON.stringify(codes));
  t('quota race: rate limiter backstop engaged', (codes[429] || 0) > 0, JSON.stringify(codes));
  const u = await R('GET', `/v1/admin/keys/${k.id}/usage`, { headers: { 'x-admin-secret': ADMIN } });
  console.log(`  INFO: quota=5, concurrent=20 -> ${JSON.stringify(codes)}, metered_used=${u.json?.used} (KV fallback: overshoot + lost increments expected locally)`);
  // sequential quota enforcement still exact:
  const k2 = await issueKey('break-quota-seq', 'free', { quota_override: 3 });
  const seq = [];
  for (let i = 0; i < 5; i++) seq.push((await R('POST', '/v1/calc/emi', { key: k2.api_key, body: { principal: 100, annual_rate_pct: 5, months: 12 } })).status);
  t('quota sequential: 3x200 then 402 quota_exceeded', seq.slice(0, 3).every(s => s === 200) && seq[3] === 402 && seq[4] === 402, seq.join(','));
}

// ---------- 6. media bombs ----------
{
  const k = await issueKey('break-media', 'pro');
  const fd = new FormData();
  fd.append('file', new Blob(['not an image at all'], { type: 'image/png' }), 'fake.png');
  fd.append('width', '100');
  let r = await fetch(BASE + '/v1/tools/image/resize', { method: 'POST', headers: { authorization: 'Bearer ' + k.api_key }, body: fd });
  t('garbage image -> 422', r.status === 422, r.status);
  const fd2 = new FormData();
  fd2.append('file', new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0])], { type: 'image/png' }), 'trunc.png');
  r = await fetch(BASE + '/v1/tools/image/resize', { method: 'POST', headers: { authorization: 'Bearer ' + k.api_key }, body: fd2 });
  t('truncated PNG -> 422', r.status === 422, r.status);
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
process.exit(fail ? 1 : 0);
