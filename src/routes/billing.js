/* Billing: checkout stubs (TEST MODE ONLY — no real charges) + signature-
 * verified webhooks. On a verified checkout.session.completed the key's
 * tier is upgraded server-side from OUR price map (never client amounts).
 */
import { err } from '../index.js';
import { getKeyById, storeKeyRecord } from '../auth.js';
import { audit } from '../logger.js';

const PRICES = { // server-side price map — the ONLY source of truth
  pro: { inr_monthly: 1599, usd_monthly: 19, quota: 25000 },
  business: { inr_monthly: 7999, usd_monthly: 99, quota: 250000 },
};

async function hmacHex(secret, data) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data));
  return [...new Uint8Array(s)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const teq = (a, b) => a.length === b.length && [...a].every((c, i) => c === b[i]);

export async function handleBilling(req, env, key) {
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const body = async () => { try { return req._rawBody ? JSON.parse(new TextDecoder().decode(req._rawBody)) : await req.json(); } catch { return {}; } };
  const rawText = async () => req._rawBody ? new TextDecoder().decode(req._rawBody) : await req.text();

  // POST /v1/billing/checkout  {tier: pro|business, provider: stripe|razorpay, success_url}
  if (req.method === 'POST' && parts.length === 3 && parts[2] === 'checkout') {
    const b = await body();
    if (!PRICES[b.tier]) return err('invalid_param', 'tier must be pro or business', 400);
    if (!['stripe', 'razorpay'].includes(b.provider)) return err('invalid_param', 'provider must be stripe or razorpay', 400);
    const sid = 'cs_test_' + [...crypto.getRandomValues(new Uint8Array(12))].map(x => x.toString(16).padStart(2, '0')).join('');
    await env.KV.put('checkout:' + sid, JSON.stringify({ key_id: key.id, tier: b.tier, provider: b.provider, test_mode: true }),
      { expirationTtl: 3600 });
    await audit(env, key.id, 'checkout_created', { tier: b.tier, provider: b.provider });
    return { _status: 201, test_mode: true, checkout_session: sid,
      checkout_url: `https://checkout.visionquantech.com/test/${sid}`,
      amount: PRICES[b.tier], note: 'TEST MODE — no charge. Webhook simulation: POST /v1/billing/webhook/simulate {checkout_session}' };
  }

  // POST /v1/billing/webhook/stripe  (public; signature-verified)
  if (req.method === 'POST' && parts[3] === 'stripe') {
    const secret = env.STRIPE_WEBHOOK_SECRET || 'whsec_test';
    const sig = req.headers.get('stripe-signature') || '';
    const payload = await rawText();
    const m = sig.match(/t=(\d+),v1=([0-9a-f]+)/);
    if (!m) return err('forbidden', 'Bad Stripe signature.', 403);
    const expect = await hmacHex(secret, `${m[1]}.${payload}`);
    if (Math.abs(Date.now() / 1000 - +m[1]) > 300 || !teq(expect, m[2])) return err('forbidden', 'Bad Stripe signature.', 403);
    let evt; try { evt = JSON.parse(payload); } catch { return err('invalid_param', 'Bad JSON.', 400); }
    // HARDENING: replay protection — each Stripe event id processed once (24h)
    if (evt.id) {
      const seen = await env.KV.get('webhook:stripe:' + evt.id);
      if (seen) return { _status: 200, received: true, deduped: true };
      await env.KV.put('webhook:stripe:' + evt.id, '1', { expirationTtl: 86400 });
    }
    if (evt.type === 'checkout.session.completed') {
      const sid = evt.data?.object?.id;
      const co = sid ? await env.KV.get('checkout:' + sid, 'json') : null;
      if (co) {
        const rec = await getKeyById(env, co.key_id);
        if (rec) { rec.tier = co.tier; rec.quota_override = PRICES[co.tier].quota; await storeKeyRecord(env, rec);
          await audit(env, rec.id, 'tier_upgraded', { tier: co.tier, via: 'stripe' }); }
      }
    }
    return { _status: 200, received: true };
  }

  // POST /v1/billing/webhook/razorpay  (public; HMAC-SHA256 of RAW body)
  if (req.method === 'POST' && parts[3] === 'razorpay') {
    const secret = env.RAZORPAY_WEBHOOK_SECRET || 'test_secret';
    const sig = req.headers.get('x-razorpay-signature') || '';
    const payload = await rawText();
    // Razorpay webhooks: signature = HMAC-SHA256(webhook_secret, RAW body).
    // (order_id|payment_id is checkout payment verification, NOT webhooks.)
    // Verify BEFORE parsing — re-serializing JSON would break the signature.
    const expect = await hmacHex(secret, payload);
    if (!teq(expect, sig)) return err('forbidden', 'Bad Razorpay signature.', 403);
    let evt; try { evt = JSON.parse(payload); } catch { return err('invalid_param', 'Bad JSON.', 400); }
    const pay = evt.payload?.payment?.entity || {};
    // HARDENING: replay protection — x-razorpay-event-id is unique per event (24h), after verification
    const eventId = req.headers.get('x-razorpay-event-id') || pay.id;
    if (eventId) {
      const seen = await env.KV.get('webhook:rzp:' + eventId);
      if (seen) return { _status: 200, received: true, deduped: true };
      await env.KV.put('webhook:rzp:' + eventId, '1', { expirationTtl: 86400 });
    }
    const sid = pay.notes?.checkout_session;
    const co = sid ? await env.KV.get('checkout:' + sid, 'json') : null;
    if (co && evt.event === 'payment.captured') {
      const rec = await getKeyById(env, co.key_id);
      if (rec) { rec.tier = co.tier; rec.quota_override = PRICES[co.tier].quota; await storeKeyRecord(env, rec);
        await audit(env, rec.id, 'tier_upgraded', { tier: co.tier, via: 'razorpay' }); }
    }
    return { _status: 200, received: true };
  }

  // POST /v1/billing/webhook/simulate  {checkout_session} — test-mode only helper
  if (req.method === 'POST' && parts[3] === 'simulate') {
    const b = await body();
    const co = b.checkout_session ? await env.KV.get('checkout:' + b.checkout_session, 'json') : null;
    if (!co) return err('not_found', 'Checkout session not found.', 404);
    const rec = await getKeyById(env, co.key_id);
    if (!rec) return err('not_found', 'Key not found.', 404);
    rec.tier = co.tier; rec.quota_override = PRICES[co.tier].quota;
    await storeKeyRecord(env, rec);
    await audit(env, rec.id, 'tier_upgraded', { tier: co.tier, via: 'simulate(test)' });
    return { _status: 200, test_mode: true, upgraded: rec.id, tier: rec.tier };
  }

  return err('not_found', 'Unknown billing endpoint.', 404);
}
