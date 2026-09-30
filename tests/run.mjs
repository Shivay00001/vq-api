/* VisionQuantech API — full contract + functional test suite.
 * Run against a local worker:  BASE=http://localhost:8787 ADMIN_SECRET=... node tests/run.mjs
 * Covers: auth fail, quota exceeded, malformed input, rate limit, idempotency
 * double-submit, all calculators, all text/dev tools, media (sync+async),
 * jobs ownership, billing webhooks (signature + replay), revoke/rotate,
 * CORS allowlist, body-size guard, quota warning headers.
 */
import { createHmac, randomBytes } from 'node:crypto';

const BASE = process.env.BASE || 'http://localhost:8787';
const ADMIN = process.env.ADMIN_SECRET || '';
if (!ADMIN) { console.error('ADMIN_SECRET env required'); process.exit(2); }

let pass = 0, fail = 0;
const failures = [];
function t(name, cond, extra) {
  if (cond) { pass++; }
  else { fail++; failures.push(name + (extra ? ' :: ' + extra : '')); console.error('  FAIL:', name, extra || ''); }
}

async function R(method, path, { key, admin, body, form, headers = {}, rawBody } = {}) {
  const h = { ...headers };
  if (key) h['authorization'] = 'Bearer ' + key;
  if (admin) h['x-admin-secret'] = ADMIN;
  let b;
  if (form) b = form;
  else if (rawBody !== undefined) { b = rawBody; h['content-type'] = h['content-type'] || 'application/json'; }
  else if (body !== undefined) { b = JSON.stringify(body); h['content-type'] = 'application/json'; }
  const r = await fetch(BASE + path, { method, headers: h, body: b });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch { /* binary */ }
  return { status: r.status, headers: r.headers, json, text: buf.toString('utf8'), buf };
}
const GET = (p, o) => R('GET', p, o);
const POST = (p, o) => R('POST', p, o);
const rnd = (n = 8) => randomBytes(n).toString('hex');

async function issueKey(name, tier, extra = {}) {
  const r = await POST('/v1/admin/keys', { admin: true, body: { name, tier, test_mode: true, ...extra } });
  t(`issue key ${name} -> 201`, r.status === 201, `got ${r.status} ${r.text.slice(0, 120)}`);
  return { id: r.json.id, key: r.json.api_key };
}

// ---------- fixtures ----------
const { Image } = await import('imagescript');
const { PDFDocument } = await import('pdf-lib');

async function smallPng() {
  const img = new Image(64, 64);
  img.fill(0x2a7fff);
  return Buffer.from(await img.encode());
}
async function bigNoisePng() {
  // >1MB so the free tier is forced into the async path
  const w = 1200, hgt = 1200;
  const img = new Image(w, hgt);
  for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++)
    img.setPixelAt(x + 1, y + 1, (Math.random() * 0xffffff) | 0);
  return Buffer.from(await img.encode());
}
async function pdfPages(n) {
  const d = await PDFDocument.create();
  for (let i = 0; i < n; i++) { const p = d.addPage([400, 400]); p.drawText(`page ${i + 1}`); }
  return Buffer.from(await d.save());
}
function multipart(fields, files) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields || {})) f.append(k, v);
  for (const [k, buf, name, type] of files || []) f.append(k, new Blob([buf], { type }), name);
  return f;
}

// ---------- 1. public ----------
{
  const r = await GET('/health');
  t('GET /health 200', r.status === 200 && r.json.ok === true, r.status);
  const o = await GET('/v1/openapi.json');
  t('GET /v1/openapi.json 200 + has calc/emi', o.status === 200 && !!(o.json.paths || {})['/v1/calc/emi'], o.status);
}

// ---------- 2. auth contracts ----------
{
  let r = await GET('/v1/status');
  t('missing auth -> 401 missing_auth', r.status === 401 && r.json.error.code === 'missing_auth', r.status);
  r = await GET('/v1/status', { key: 'vq_test_deadbeefdeadbeef' });
  t('bad key -> 401 invalid_key', r.status === 401 && r.json.error.code === 'invalid_key', r.status);
  r = await GET('/v1/status?api_key=vq_test_deadbeef');
  t('key in URL -> 401 invalid_auth', r.status === 401 && r.json.error.code === 'invalid_auth', r.status);
  r = await POST('/v1/admin/keys', { admin: false, headers: { 'x-admin-secret': 'wrong' }, body: { name: 'x', tier: 'free' } });
  t('wrong admin secret -> 403', r.status === 403, r.status);
}

// ---------- 3. issue keys ----------
const A = await issueKey('test-functional', 'business');
const B = await issueKey('test-ratelimit', 'free');
const C = await issueKey('test-quota', 'free', { quota_override: 5 });
const D = await issueKey('test-misc', 'free');
const G = await issueKey('test-async', 'free');

// ---------- 4. calculators ----------
{
  let r = await POST('/v1/calc/gst-interest', { key: A.key, body: { type: 'delayed', amount: 100000, due_date: '2026-08-20', pay_date: '2026-09-19' } });
  t('gst-interest values', r.status === 200 && r.json.interest === 1479.45 && r.json.late_fee === 1500 && r.json.total === 2979.45, JSON.stringify(r.json).slice(0, 160));

  r = await POST('/v1/calc/emi', { key: A.key, body: { principal: 5000000, annual_rate_pct: 8.5, months: 240, schedule: true } });
  t('emi sane + schedule len 240', r.status === 200 && r.json.emi > 43000 && r.json.emi < 44000 && r.json.schedule.length === 240, `emi=${r.json.emi}`);

  r = await POST('/v1/calc/gratuity', { key: A.key, body: { monthly_salary: 30000, years: 5 } });
  t('gratuity 86538.46', r.status === 200 && r.json.gratuity === 86538.46, JSON.stringify(r.json).slice(0, 120));

  r = await POST('/v1/calc/salary', { key: A.key, body: { ctc_annual: 1200000, state: 'MH' } });
  t('salary pf 3000/mo (25k ceiling)', r.status === 200 && r.json.pf.employee === 3000 && r.json.in_hand_monthly > 80000, JSON.stringify(r.json).slice(0, 200));

  r = await POST('/v1/calc/pf', { key: A.key, body: { monthly_wage: 30000 } });
  t('pf ceiling 25000', r.status === 200 && r.json.capped_wage === 25000 && r.json.employee_12pct === 3000, JSON.stringify(r.json).slice(0, 120));

  r = await POST('/v1/calc/esi', { key: A.key, body: { monthly_wage: 18000 } });
  t('esi covered @18k', r.status === 200 && r.json.covered === true, r.status);
  r = await POST('/v1/calc/esi', { key: A.key, body: { monthly_wage: 25000 } });
  t('esi not covered @25k', r.status === 200 && r.json.covered === false, r.status);

  r = await POST('/v1/calc/break-even', { key: A.key, body: { fixed_cost: 500000, price_per_unit: 500, variable_cost_per_unit: 300 } });
  t('break-even 2500 units', r.status === 200 && r.json.break_even_units === 2500, JSON.stringify(r.json).slice(0, 100));

  r = await POST('/v1/calc/pricing', { key: A.key, body: { unit_cost: 100, margin_pct: 40 } });
  t('pricing margin 40 -> 166.67', r.status === 200 && r.json.price === 166.67, JSON.stringify(r.json).slice(0, 100));

  r = await POST('/v1/calc/discount', { key: A.key, body: { price: 500, discount_pct: 10, units: 1000, cost_per_unit: 300 } });
  t('discount has profit impact', r.status === 200 && typeof r.json.profit_after === 'number', r.status);

  r = await POST('/v1/calc/overtime', { key: A.key, body: { monthly_salary: 30000, ot_hours: 20 } });
  t('overtime 5769.23', r.status === 200 && r.json.ot_pay === 5769.23, JSON.stringify(r.json).slice(0, 100));

  r = await POST('/v1/calc/retention', { key: A.key, body: { contract_value: 1000000, retention_pct: 10 } });
  t('retention held 100000', r.status === 200 && r.json.retention_held === 100000, r.status);

  r = await POST('/v1/calc/working-capital', { key: A.key, body: { current_assets: 2000000, current_liabilities: 800000 } });
  t('working capital 1200000 ratio 2.5', r.status === 200 && r.json.working_capital === 1200000 && r.json.current_ratio === 2.5, r.status);

  r = await POST('/v1/calc/cash-survival', { key: A.key, body: { cash_in_hand: 5000000, monthly_burn: 1000000 } });
  t('cash runway 150d', r.status === 200 && r.json.survival_days === 150, r.status);
}

// ---------- 5. malformed input contracts ----------
{
  const cases = [
    ['/v1/calc/gst-interest', {}],
    ['/v1/calc/emi', { principal: -5, annual_rate_pct: 8, months: 12 }],
    ['/v1/calc/gratuity', { monthly_salary: 0, years: 5 }],
    ['/v1/calc/salary', { ctc_annual: 1200000, state: 'XX' }],
    ['/v1/calc/break-even', { fixed_cost: 1, price_per_unit: 10, variable_cost_per_unit: 10 }],
    ['/v1/calc/cash-survival', { cash_in_hand: 1, monthly_burn: 0 }],
    ['/v1/tools/json-format', { json: 'not json{{', style: 'pretty' }],
    ['/v1/tools/password', { length: 200 }],
    ['/v1/tools/qr', { data: 'x'.repeat(3000) }],
    ['/v1/tools/cron-explain', { expr: 'nonsense' }],
    ['/v1/tools/k8s', { kind: 'daemonset-x', name: 'a', image: 'i' }],
    ['/v1/tools/ci', { provider: 'circle' }],
    ['/v1/calc/nope', { a: 1 }],
  ];
  for (const [path, body] of cases) {
    const r = await POST(path, { key: A.key, body });
    t(`malformed ${path} -> 4xx`, r.status === 400 || r.status === 422 || r.status === 404, `${path} got ${r.status}`);
  }
  const r = await POST('/v1/calc/emi', { key: A.key, rawBody: '{bad json' });
  t('invalid JSON body -> 400', r.status === 400, r.status);
}

// ---------- 6. text/dev tools ----------
{
  let r = await POST('/v1/tools/word-count', { key: A.key, body: { text: 'Hello world, this is a test.' } });
  t('word-count words=6', r.status === 200 && r.json.words === 6, JSON.stringify(r.json).slice(0, 100));

  r = await POST('/v1/tools/json-format', { key: A.key, body: { json: '{"a":1}', style: 'pretty' } });
  t('json-format pretty', r.status === 200 && r.json.valid === true && r.json.output.includes('\n'), r.status);

  r = await POST('/v1/tools/password', { key: A.key, body: { length: 16, count: 2 } });
  t('password 16ch x2 + entropy', r.status === 200 && r.json.passwords.length === 2 && r.json.passwords[0].length === 16 && r.json.entropy_bits > 90, r.status);

  r = await POST('/v1/tools/qr', { key: A.key, body: { data: 'https://visionquantech.com' } });
  t('qr svg', r.status === 200 && r.json.svg.startsWith('<svg'), r.status);

  r = await POST('/v1/tools/cron-explain', { key: A.key, body: { expr: '*/15 9-17 * * MON-FRI' } });
  t('cron-explain', r.status === 200 && typeof r.json.human === 'string' && r.json.human.length > 10, r.json.human);

  r = await POST('/v1/tools/dockerfile', { key: A.key, body: { base: 'node:20-alpine', port: 3000, cmd: ['node', 'app.js'] } });
  t('dockerfile has FROM', r.status === 200 && r.json.dockerfile.includes('FROM node:20-alpine'), r.status);

  r = await POST('/v1/tools/k8s', { key: A.key, body: { kind: 'deployment', name: 'web', image: 'myapp:1.0', replicas: 2 } });
  t('k8s deployment yaml', r.status === 200 && r.json.yaml.includes('kind: Deployment'), r.status);

  r = await POST('/v1/tools/ci', { key: A.key, body: { provider: 'gha', node_version: '20' } });
  t('ci gha yaml', r.status === 200 && r.json.config.includes('jobs:'), r.status);
}

// ---------- 7. idempotency double-submit ----------
{
  const ik = 'idem-' + rnd();
  const body = { principal: 100000, annual_rate_pct: 10, months: 12 };
  const r1 = await POST('/v1/calc/emi', { key: A.key, body, headers: { 'idempotency-key': ik } });
  const r2 = await POST('/v1/calc/emi', { key: A.key, body, headers: { 'idempotency-key': ik } });
  t('idempotent replay same body', r1.status === 200 && r2.status === 200 &&
    r2.headers.get('x-idempotent-replay') === 'true' && r2.json.emi === r1.json.emi,
    `${r1.status}/${r2.status} replay=${r2.headers.get('x-idempotent-replay')}`);
  const r3 = await POST('/v1/calc/emi', { key: A.key, body: { ...body, months: 24 }, headers: { 'idempotency-key': ik } });
  t('idempotency conflict -> 409', r3.status === 409 && r3.json.error.code === 'idempotency_conflict', r3.status);
  const r4 = await POST('/v1/calc/emi', { key: A.key, body, headers: { 'idempotency-key': 'short' } });
  t('bad idempotency key -> 400', r4.status === 400, r4.status);
}

// ---------- 8. quota exceeded + warnings ----------
{
  for (let i = 0; i < 4; i++) {
    const r = await GET('/v1/status', { key: C.key });
    t(`quota key call ${i + 1} ok`, r.status === 200, r.status);
  }
  const r5 = await GET('/v1/status', { key: C.key });
  t('quota 5th call ok + 70/90% warning header', r5.status === 200 && !!r5.headers.get('x-vq-quota-warning'),
    `${r5.status} warn=${r5.headers.get('x-vq-quota-warning')}`);
  const r6 = await GET('/v1/status', { key: C.key });
  t('quota exceeded -> 402 quota_exceeded', r6.status === 402 && r6.json.error.code === 'quota_exceeded', r6.status);
}

// ---------- 9. rate limit ----------
{
  const rs = await Promise.all(Array.from({ length: 15 }, () => GET('/v1/status', { key: B.key })));
  const limited = rs.filter(r => r.status === 429);
  t('rate limit trips 429 (free 10/min)', limited.length >= 3, `429s=${limited.length}`);
  t('429 has retry-after', limited.every(r => !!r.headers.get('retry-after')), 'missing retry-after');
  t('429 error code rate_limited', limited.every(r => r.json.error.code === 'rate_limited'), 'bad code');
}

// ---------- 10. media ----------
const png = await smallPng();
{
  let r = await POST('/v1/tools/image/resize', { key: A.key, form: multipart({ width: '32', height: '32', format: 'jpeg', quality: '70' }, [['file', png, 't.png', 'image/png']]) });
  t('image resize -> jpeg', r.status === 200 && r.headers.get('content-type').includes('image/jpeg') && r.buf[0] === 0xff && r.buf[1] === 0xd8, `${r.status} ${r.headers.get('content-type')}`);

  r = await POST('/v1/tools/image/convert', { key: A.key, form: multipart({ format: 'png' }, [['file', png, 't.png', 'image/png']]) });
  t('image convert -> png magic', r.status === 200 && r.buf[0] === 0x89 && r.buf[1] === 0x50, r.status);

  r = await POST('/v1/tools/image/resize', { key: A.key, form: multipart({ width: '32' }, [['file', Buffer.from('not an image'), 't.png', 'image/png']]) });
  t('garbage image -> 422 unsupported_media', r.status === 422 && r.json.error.code === 'unsupported_media', r.status);

  const p1 = await pdfPages(1), p2 = await pdfPages(1), p3 = await pdfPages(3);
  r = await POST('/v1/tools/pdf/merge', { key: A.key, form: multipart({}, [['files', p1, 'a.pdf', 'application/pdf'], ['files', p2, 'b.pdf', 'application/pdf']]) });
  t('pdf merge -> %PDF', r.status === 200 && r.buf.slice(0, 5).toString() === '%PDF-', r.status);
  {
    const d = await PDFDocument.load(r.buf);
    t('merged pdf has 2 pages', d.getPageCount() === 2, d.getPageCount());
  }

  r = await POST('/v1/tools/pdf/split', { key: A.key, form: multipart({ ranges: '1-2' }, [['file', p3, 'c.pdf', 'application/pdf']]) });
  t('pdf split 1-2 -> 2 pages', r.status === 200, r.status);
  {
    const d = await PDFDocument.load(r.buf);
    t('split pdf page count 2', d.getPageCount() === 2, d.getPageCount());
  }

  r = await POST('/v1/tools/pdf/split', { key: A.key, form: multipart({}, [['file', p3, 'c.pdf', 'application/pdf']]) });
  t('pdf split default all -> 3 pages', r.status === 200, r.status);
  {
    const d = await PDFDocument.load(r.buf);
    t('default split page count 3', d.getPageCount() === 3, d.getPageCount());
  }

  r = await POST('/v1/tools/pdf/compress', { key: A.key, form: multipart({}, [['file', p3, 'c.pdf', 'application/pdf']]) });
  t('pdf compress -> %PDF + saved_pct', r.status === 200 && r.buf.slice(0, 5).toString() === '%PDF-', r.status);

  r = await POST('/v1/tools/pdf/merge', { key: A.key, form: multipart({}, [['files', Buffer.from('nope'), 'a.pdf', 'application/pdf']]) });
  t('garbage pdf -> 422', r.status === 422, r.status);
}

// ---------- 11. async job (over-budget on free tier) ----------
let asyncJobId = null;
{
  console.log('  (generating 1.4MP noise PNG — takes a few seconds…)');
  const big = await bigNoisePng();
  t('noise fixture >1MB (forces async on free)', big.length > 1e6, big.length);
  const r = await POST('/v1/tools/image/resize', { key: G.key, form: multipart({ width: '200', format: 'jpeg', quality: '60' }, [['file', big, 'big.png', 'image/png']]) });
  t('over-budget -> 202 or inline-200 with job refs', (r.status === 202 || r.status === 200) && !!r.json.job_id, `${r.status} ${r.text.slice(0, 100)}`);
  asyncJobId = r.json.job_id;
  let st = r.json.status, guard = 0, resultUrl = r.json.result_url;
  while (st !== 'done' && guard++ < 30) {
    await new Promise(s => setTimeout(s, 1000));
    const p = await GET(`/v1/jobs/${asyncJobId}`, { key: G.key });
    st = p.json.status; if (p.json.result_url) resultUrl = p.json.result_url;
  }
  t('async job reaches done', st === 'done', st);
  if (resultUrl) {
    const dl = await GET(resultUrl, { key: G.key });
    t('async result downloads as jpeg', dl.status === 200 && dl.buf[0] === 0xff && dl.buf[1] === 0xd8, dl.status);
  } else t('async result downloads as jpeg', false, 'no result_url');

  // direct /v1/jobs submit
  const r2 = await POST('/v1/jobs', { key: G.key, form: multipart({ operation: 'image.convert', params: JSON.stringify({ format: 'png' }) }, [['file', png, 't.png', 'image/png']]) });
  t('POST /v1/jobs submit', (r2.status === 200 || r2.status === 202) && !!r2.json.job_id, r2.status);
  const ru = r2.json.result_url || `/v1/jobs/${r2.json.job_id}/result`;
  const dl2 = await GET(ru, { key: G.key });
  t('job result downloads', dl2.status === 200 && dl2.buf[0] === 0x89, dl2.status);
}

// ---------- 12. job ownership (no IDOR) ----------
{
  const r = await GET(`/v1/jobs/${asyncJobId}`, { key: D.key });
  t("other key's job -> 404", r.status === 404 && r.json.error.code === 'job_not_found', r.status);
  const r2 = await GET('/v1/jobs/job_ffffffffffffffffffffffff', { key: D.key });
  t('bogus job id -> 404', r2.status === 404, r2.status);
}

// ---------- 13. billing: checkout + webhooks ----------
function stripeSig(payload, secret) {
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
  return `t=${ts},v1=${sig}`;
}
{
  // Stripe flow on key A
  const co = await POST('/v1/billing/checkout', { key: A.key, body: { tier: 'pro', provider: 'stripe', success_url: 'https://visionquantech.com/ok' } });
  t('checkout test-mode 201', co.status === 201 && co.json.test_mode === true && !!co.json.checkout_session, `${co.status} ${co.text.slice(0, 100)}`);
  const sid = co.json.checkout_session;
  const evtId = 'evt_' + rnd();
  const payload = JSON.stringify({ id: evtId, type: 'checkout.session.completed', data: { object: { id: sid, metadata: { checkout_session: sid } } } });
  const wsec = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_dev_only';
  let r = await POST('/v1/billing/webhook/stripe', { rawBody: payload, headers: { 'stripe-signature': stripeSig(payload, wsec) } });
  t('stripe webhook valid -> 200 upgraded', r.status === 200, `${r.status} ${r.text.slice(0, 120)}`);
  const st = await GET('/v1/status', { key: A.key });
  t('key A tier now pro', st.json.tier === 'pro', st.json.tier);
  r = await POST('/v1/billing/webhook/stripe', { rawBody: payload, headers: { 'stripe-signature': stripeSig(payload, wsec) } });
  t('stripe webhook replay -> deduped', r.status === 200 && r.json.deduped === true, r.text.slice(0, 80));
  r = await POST('/v1/billing/webhook/stripe', { rawBody: payload, headers: { 'stripe-signature': 't=1,v1=deadbeef' } });
  t('stripe bad signature -> 403', r.status === 403, r.status);

  // Razorpay flow on key D
  const co2 = await POST('/v1/billing/checkout', { key: D.key, body: { tier: 'pro', provider: 'razorpay' } });
  const sid2 = co2.json.checkout_session;
  const rsec = process.env.RAZORPAY_WEBHOOK_SECRET || 'rzp_test_dev_only';
  const payId = 'pay_' + rnd(), orderId = 'order_' + rnd();
  const rp = JSON.stringify({ entity: 'event', event: 'payment.captured', payload: { payment: { entity: { id: payId, order_id: orderId, notes: { checkout_session: sid2 } } } } });
  // Razorpay webhook signature = HMAC-SHA256(webhook_secret, RAW body)
  const rsig = createHmac('sha256', rsec).update(rp).digest('hex');
  const rEvtId = 'evt_rzp_' + rnd();
  r = await POST('/v1/billing/webhook/razorpay', { rawBody: rp, headers: { 'x-razorpay-signature': rsig, 'x-razorpay-event-id': rEvtId } });
  t('razorpay webhook valid -> 200', r.status === 200, `${r.status} ${r.text.slice(0, 120)}`);
  const st2 = await GET('/v1/status', { key: D.key });
  t('key D tier now pro', st2.json.tier === 'pro', st2.json.tier);
  r = await POST('/v1/billing/webhook/razorpay', { rawBody: rp, headers: { 'x-razorpay-signature': rsig, 'x-razorpay-event-id': rEvtId } });
  t('razorpay webhook replay -> deduped', r.status === 200 && r.json.deduped === true, r.text.slice(0, 80));
  r = await POST('/v1/billing/webhook/razorpay', { rawBody: rp, headers: { 'x-razorpay-signature': 'bad', 'x-razorpay-event-id': 'evt_rzp_' + rnd() } });
  t('razorpay bad signature -> 403', r.status === 403, r.status);
}

// ---------- 14. revoke + rotate ----------
{
  const E = await issueKey('test-revoke', 'free');
  let r = await GET('/v1/status', { key: E.key });
  t('fresh key works', r.status === 200, r.status);
  r = await POST(`/v1/admin/keys/${E.id}/revoke`, { admin: true });
  t('revoke 200', r.status === 200 && r.json.revoked === true, r.status);
  r = await GET('/v1/status', { key: E.key });
  t('revoked key -> 403 revoked_key', r.status === 403 && r.json.error.code === 'revoked_key', r.status);

  const F = await issueKey('test-rotate', 'free');
  r = await POST(`/v1/admin/keys/${F.id}/rotate`, { admin: true });
  t('rotate 201 + new key', r.status === 201 && !!r.json.api_key, r.status);
  const F2 = r.json.api_key;
  r = await GET('/v1/status', { key: F.key });
  t('old key dead after rotate', r.status === 403, r.status);
  r = await GET('/v1/status', { key: F2 });
  t('new key works after rotate', r.status === 200, r.status);
}

// ---------- 15. admin reads ----------
{
  let r = await GET('/v1/admin/keys', { admin: true });
  t('admin list keys (no hashes)', r.status === 200 && r.json.keys.length >= 5 && r.json.keys.every(k => !k.hash && !k.api_key), r.status);
  r = await GET(`/v1/admin/keys/${A.id}/usage`, { admin: true });
  t('admin usage used>0', r.status === 200 && r.json.used > 0, JSON.stringify(r.json).slice(0, 100));
  r = await GET(`/v1/admin/keys/${A.id}/audit`, { admin: true });
  t('admin audit has events', r.status === 200 && r.json.events.length > 0, r.status);
}

// ---------- 16. CORS + body guard ----------
{
  const r = await R('OPTIONS', '/v1/calc/emi', { headers: { origin: 'https://visionquantech.com' } });
  t('OPTIONS 204 + ACAO allowlisted', r.status === 204 && r.headers.get('access-control-allow-origin') === 'https://visionquantech.com', r.status);
  const r2 = await GET('/health', { headers: { origin: 'https://evil.example' } });
  t('evil origin gets no ACAO', !r2.headers.get('access-control-allow-origin'), r2.headers.get('access-control-allow-origin'));
  const big = Buffer.alloc(26 * 1024 * 1024, 0);
  const r3 = await POST('/v1/calc/emi', { key: A.key, rawBody: big });
  t('26MB body -> 413', r3.status === 413 && r3.json.error.code === 'file_too_large', r3.status);
}

console.log(`\n==== ${pass} passed, ${fail} failed ====`);
if (failures.length) { console.log('failures:'); failures.forEach(f => console.log(' -', f)); process.exit(1); }
