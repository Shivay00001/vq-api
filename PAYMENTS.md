# PAYMENTS — VisionQuantech API billing wiring
**Status: TEST MODE.** No real money moves. When Shivay shares live gateway keys (via secure vault, never in chat), wiring takes minutes — follow the table below.

## Where each key goes (env only — never in code, never in chat)

| Secret | Wrangler command | Used by |
|---|---|---|
| `STRIPE_SECRET_KEY` | `wrangler secret put STRIPE_SECRET_KEY` | (future) creating live checkout sessions |
| `STRIPE_WEBHOOK_SECRET` | `wrangler secret put STRIPE_WEBHOOK_SECRET` | `POST /v1/billing/webhook/stripe` — verifies `Stripe-Signature` (HMAC-SHA256, 5-min tolerance) |
| `RAZORPAY_KEY_ID` | `wrangler secret put RAZORPAY_KEY_ID` | (future) creating live Razorpay orders |
| `RAZORPAY_KEY_SECRET` | `wrangler secret put RAZORPAY_KEY_SECRET` | orders API auth |
| `RAZORPAY_WEBHOOK_SECRET` | `wrangler secret put RAZORPAY_WEBHOOK_SECRET` | `POST /v1/billing/webhook/razorpay` — verifies `x-razorpay-signature` = HMAC-SHA256(webhook_secret, **raw request body**) |
| `ADMIN_SECRET` | `wrangler secret put ADMIN_SECRET` | admin plane (`X-Admin-Secret` header) |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | `wrangler secret put …` | rate limiting (prod) |

## How money flows (design — amounts ONLY from the server price map)
1. Customer calls `POST /v1/billing/checkout {tier, provider}` → we create a **test-mode** checkout session (stub URL, no charge) and store `{key_id, tier}` in KV under the session id.
2. Provider webhook fires → we **verify the signature first** (Stripe: `t,v1` HMAC over `t.payload`; Razorpay: HMAC-SHA256 over the **raw body** — verified before any JSON parsing), then **replay-protect** (Stripe event id / Razorpay `x-razorpay-event-id` header, falling back to payment id, stored 24h; duplicates acked without effect), then look up the session and upgrade the key's tier from `PRICES` in `src/routes/billing.js` — the client-supplied amount is never trusted.
3. Test-mode simulation: `POST /v1/billing/webhook/simulate {checkout_session}` performs the same upgrade path for QA.

## Going live (checklist for Shivay)
1. Share via secure vault: Stripe **restricted** secret key + webhook signing secret; Razorpay key id + key secret + webhook secret.
2. Run the 5 `wrangler secret put` commands above.
3. In Stripe dashboard: add webhook endpoint `https://api.visionquantech.com/v1/billing/webhook/stripe`, events: `checkout.session.completed`. In Razorpay: webhook `https://api.visionquantech.com/v1/billing/webhook/razorpay`, event: `payment.captured`.
4. Flip `test_mode` handling: set `BILLING_LIVE=1` env; the stub checkout URL is replaced by a real Stripe/Razorpay session/order call (code marked `TODO(live)` in billing.js).
5. Run the webhook contract tests in `tests/run.mjs` against the live URL with a real test payment.

## Anti-fraud rules (already coded)
- Signature verified before any state change; timestamp tolerance 5 min (Stripe).
- Replay: same event/payment id processed once.
- Idempotency: checkout creation accepts `Idempotency-Key` (gateway-level).
- Refunds/disputes: do NOT auto-downgrade on `charge.refunded` in v1 — it pages to the audit log for manual review (avoids webhook-spoof downgrade games).
