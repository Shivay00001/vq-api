# VQ API

`api.visionquantech.com` — Cloudflare Worker API backbone for VisionQuantech
services. Rate limiting, auth, request metering, idempotency, structured
logging, and a background job processor.

## Layout

- `src/` — worker entry, routes, auth, ratelimit, metering, idempotency, logger, processor
- `tests/` — spec checks and test runner
- `openapi.json` — API spec
- `postman/` — Postman collection + generator
- `docs/` — quickstart
- `TRD.md`, `HARDENING.md`, `PAYMENTS.md`, `INFRA_SETUP.md`, `ERROR_CATALOG.md`

## Local dev

```bash
npm install
npx wrangler dev --local
```

## Env vars

Copy `.dev.vars.example` → `.dev.vars` and fill in. Production secrets are set
with `wrangler secret put` — never commit real values.

| Var | Purpose |
|---|---|
| `ADMIN_SECRET` | Admin endpoint auth |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook verification |
| `RAZORPAY_WEBHOOK_SECRET` | Razorpay webhook verification |
| `CORS_ORIGINS` | Allowed origins |
| `API_KILL_SWITCH` | `1` disables the API |
| `LOCAL_DEV` | `1` for local dev |
