# INFRA SETUP — VisionQuantech API (exact steps, nothing deployed yet)
Zero spend so far. Do these in order; every step is reversible. Run `wrangler`
from `~/workspace/products/vq-api` after `wrangler login`.

## 1. Cloudflare (free plan is enough for v1)
1. Create account at dash.cloudflare.com → **Workers & Pages** → note your
   `account_id` (`wrangler whoami` prints it after login).
2. `wrangler kv:namespace create KV` — copy the returned `id`.
3. `wrangler r2 bucket create vq-api-jobs`
4. R2 → bucket → **Settings → Lifecycle rules** → add rule: prefix `jobs/*`,
   delete after **1 day** (required by HARDENING §2; without this, abandoned
   job blobs accumulate storage cost).
5. Queues: **Workers & Pages → Queues → Create** named `vq-api-jobs` (async
   media jobs). If you skip Queues, jobs still work — the code falls back to
   synchronous processing inside the request with tier budgets.
6. In `wrangler.toml`, paste the KV namespace id from step 2.

## 2. Upstash Redis (required for production-grade quota metering)
1. console.upstash.com → create Redis database (any region close to your
   Workers region) → copy **REST URL** and **REST TOKEN**.
2. `wrangler secret put UPSTASH_REDIS_REST_URL`
3. `wrangler secret put UPSTASH_REDIS_REST_TOKEN`
4. Without these, the API runs on the KV read-modify-write fallback, which
   **races under concurrency** (measured: 2× quota overshoot locally) — do
   not take payments-dependent keys live without this step.

## 3. Secrets (all via `wrangler secret put` — never chat, never files)
- `ADMIN_SECRET` — long random string for the admin plane
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`
- `STRIPE_SECRET_KEY` (restricted key), `STRIPE_WEBHOOK_SECRET`
- `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`
- Vars (not secrets) in `wrangler.toml`: `CORS_ORIGINS`
  (comma-separated allowlist), `LOCAL_DEV=0` in production.

## 4. DNS
`api.visionquantech.com` → Workers: either
- `wrangler deploy` then **Workers → your worker → Settings → Domains &
  Routes → Add custom domain**, or
- DNS → CNAME `api` → `<worker>.<subdomain>.workers.dev` (proxied).

## 5. Webhooks (after real gateway credentials are in the vault)
- Stripe dashboard → Developers → Webhooks → add
  `https://api.visionquantech.com/v1/billing/webhook/stripe`,
  event: `checkout.session.completed`. Copy the signing secret →
  `wrangler secret put STRIPE_WEBHOOK_SECRET`.
- Razorpay dashboard → Settings → Webhooks → add
  `https://api.visionquantech.com/v1/billing/webhook/razorpay`,
  event: `payment.captured`. Set a webhook secret → same via
  `RAZORPAY_WEBHOOK_SECRET`. Razorpay signs the **raw body** — our handler
  verifies before JSON parsing (see PAYMENTS.md).

## 6. Go-live checklist
- [ ] `npm audit` re-run from an unrestricted network (was blocked 2026-09-26)
- [ ] Live-price re-check of Workers/KV/R2/Upstash free tiers (cost math in TRD §7 is provisional)
- [ ] PF ₹25,000 ceiling and other statutory formulas re-verified against primary current law
- [ ] R2 `jobs/*` 1-day lifecycle rule confirmed
- [ ] Kill-switch drill: set `API_KILL_SWITCH=1`, confirm 503s, unset
- [ ] Operator alerting for 70%/90% infra spend (not just per-key headers)

## 7. Backup / cleanup
- KV holds: API-key hashes (revocable, re-issuable), quota counters (recomputed
  monthly), audit tail (operational, not financial record), webhook replay ids
  (24h TTL — self-cleaning).
- R2 `jobs/*`: 1-day lifecycle rule auto-deletes; nothing else is persisted.
- No customer PII is stored server-side in v1 (uploads are processed in-memory
  or via job blobs that auto-expire). Backup need: none beyond keeping
  `ADMIN_SECRET` and the issued-key list safe.
