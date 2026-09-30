# VisionQuantech API — TRD (Technical Requirements Document)
**api.visionquantech.com** · v1.0 · 2026-09-26 · Status: built, local-verified, NOT deployed

## 1. Problem & scope
Every VisionQuantech product (utility suite: image/PDF/QR tools; business suite: ~59 calculators/trackers) currently runs client-side only. There is no programmatic access and no enterprise tier. This API is the monetization layer: free tier (1k calls/mo) → Pro ($19, 25k) → Business ($99, 250k) → Enterprise (custom).

**Non-goals (v1):** four-panel web app (the API has an admin-key plane only), realtime websockets, video processing, OCR, background removal (needs GPU — documented in ROADMAP).

## 2. Architecture

```
Client ──HTTPS──▶ Cloudflare Workers (api.visionquantech.com)
                        │ ① Auth: Bearer key → SHA-256 → KV lookup
                        │ ② Quota: KV monthly counter vs tier quota
                        │ ③ Rate limit: Upstash Redis sliding window (in-mem fallback in dev)
                        │ ④ Idempotency-Key replay (KV, 24h, POST only)
                        ▼
   ┌─────────────┬──────────────┬───────────────┬──────────────┐
   │ /v1/calc/*  │ /v1/tools/*  │ /v1/jobs      │ /v1/admin/*  │
   │ sync JSON   │ sync (small) │ async media   │ key mgmt     │
   │ finance.js  │ textutil/    │ R2 in/out     │ (admin secret│
   │ textutil.js │ media/pdf.js │ Queue→        │  + audit)    │
   │             │              │ processor.js  │ /v1/billing/*│
   └─────────────┴──────────────┴───────────────┴──────────────┘
   KV: keys, usage counters, idempotency, job records, audit tail
   R2: job input/output blobs (10 GB free)
   Upstash Redis: rate-limit windows, (prod) job dedupe
```

**Request lifecycle:** CORS → auth → quota → rate-limit → idempotency → route → meter → log → JSON response (or 202 + job).

## 3. Tech stack (all free-tier at launch)
| Layer | Choice | Free tier |
|---|---|---|
| Gateway | Cloudflare Workers | 100k req/day, 10ms CPU (paid: 50ms @ $5/mo) |
| Key/usage/job store | Workers KV | 100k reads/day, 1M writes/mo |
| Blobs | Workers R2 | 10 GB, zero egress |
| Rate limiting | Upstash Redis (REST) | 10k cmds/day; in-memory fallback in local dev |
| Media (images) | imagescript (pure JS, WASM-free) | runs in Workers; CPU-bound → async for large files |
| PDF | pdf-lib (pure JS) | merge/split/rebuild-compress in Workers |
| QR | qrcode-generator → SVG | trivial CPU |
| Async | Workers Queues | 1M ops/mo free |
| Payments | Stripe + Razorpay (test mode) | $0 until revenue |

**Why not Supabase here:** the gateway is stateless key-auth; KV+R2 keeps p99 low and cost at $0. Supabase remains the choice for the four-panel apps (job board etc.).

## 4. Endpoint contracts (v1)
Base `https://api.visionquantech.com`. Auth: `Authorization: Bearer vq_live_…` (test keys: `vq_test_…`). All POST bodies JSON unless noted.

**Meta**
- `GET /health` → `{ok:true, version, time}` (no auth)
- `GET /v1/status` → tier, quota used/remaining (auth)
- `GET /v1/openapi.json` → OpenAPI 3.1 (no auth)

**Calculators** `POST /v1/calc/{tool}` — pure functions, sync, <1ms CPU:
| Endpoint | Inputs | Notes |
|---|---|---|
| `/v1/calc/gst-interest` | `{type: delayed\|itc-wrong\|itc-reversal, amount, due_date, pay_date, is_nil_return, turnover}` | Sec 50(1) 18%, 50(3) 24%, Rule 37 18%; late fee ₹50/₹20/day with caps (Notif 19/2021-CT) |
| `/v1/calc/emi` | `{principal, annual_rate_pct, months, prepayments?:[{month,amount}], mode?: tenure\|emi, schedule?: bool}` | reducing-balance; schedule capped at 360 rows |
| `/v1/calc/gratuity` | `{monthly_salary, years, extra_months, covered, special_case}` | (15/26) formula, ₹20L cap, 5-yr rule |
| `/v1/calc/salary` | `{ctc_annual, basic_pct?, state: MH\|KA\|WB\|TN\|GJ\|AP\|TG\|KL\|DL\|OTHER, regime?: new\|old}` | FY25-26 slabs, 87A, PF 12% (₹25k ceiling w.e.f. 17-09-2026), ESI 0.75/3.25% (₹21k), PT tables |
| `/v1/calc/pf` | `{monthly_wage, headcount, as_of_date?}` | 12%+12%, ceiling 25k (15k before 17-09-2026) |
| `/v1/calc/esi` | `{monthly_wage}` | 0.75% ee / 3.25% er, ₹21k ceiling |
| `/v1/calc/break-even` | `{fixed_cost, price_per_unit, variable_cost_per_unit}` | units + revenue; what-if |
| `/v1/calc/pricing` | `{unit_cost, margin_pct? , markup_pct?}` | margin↔markup |
| `/v1/calc/discount` | `{price, discount_pct, units, cost_per_unit?}` | profit impact |
| `/v1/calc/overtime` | `{monthly_salary, ot_hours, ot_multiplier?}` | hourly = salary/26/8 |
| `/v1/calc/retention` | `{contract_value, retention_pct, released?}` | |
| `/v1/calc/working-capital` | `{current_assets, current_liabilities, inventory_days?, receivable_days?, payable_days?}` | ratio + CCC |
| `/v1/calc/cash-survival` | `{cash_in_hand, monthly_burn}` | days |

**Text/dev tools** `POST /v1/tools/*` — sync:
- `/v1/tools/word-count` `{text}` → words/chars/sentences/reading time
- `/v1/tools/json-format` `{json, style: pretty|mini|validate}` 
- `/v1/tools/password` `{length?, numbers?, symbols?, count?}` — crypto RNG + entropy bits
- `/v1/tools/qr` `{data, size?}` → SVG string (+ data URI)
- `/v1/tools/cron-explain` `{expr}` → human description of cron
- `/v1/tools/dockerfile` `{base, port, cmd[]}` → Dockerfile text
- `/v1/tools/k8s` `{kind: deployment|service, name, image, replicas?, port?}` → YAML
- `/v1/tools/ci` `{provider: gha|jenkins, node_version?, steps[]}` → pipeline config

**Media (images/PDF)** — sync-with-guardrail OR async:
- `POST /v1/tools/image/resize` (multipart `file`, `width?`, `height?`, `format?: jpeg|png`, `quality?`) — sync if file ≤1 MB else **202 + job**
- `POST /v1/tools/image/convert` (multipart, `format: jpeg|png`) — same guardrail
- `POST /v1/tools/pdf/merge` (multipart `files[]`) — sync if total ≤5 MB else 202
- `POST /v1/tools/pdf/split` (multipart `file`, `ranges: "1-3,5"`) — same
- `POST /v1/tools/pdf/compress` (multipart `file`) — pdf-lib rebuild (lossless object-stream; honest 10–40% typical)
- `POST /v1/jobs` (multipart `file` + `operation` JSON) → `{job_id, status: queued}` · `GET /v1/jobs/{id}` → status · `GET /v1/jobs/{id}/result` → file download
- Local dev (`LOCAL_DEV=1`): jobs process inline (miniflare has no CPU cap) so the full flow is genuinely exercised. Production: Queue → processor.js.

**Admin** (requires `X-Admin-Secret` + IP allowlist via env):
- `POST /v1/admin/keys` `{name, tier}` → issues key (raw shown ONCE)
- `GET /v1/admin/keys` → list (prefixes + metadata only, never hashes)
- `POST /v1/admin/keys/{id}/revoke`, `POST /v1/admin/keys/{id}/rotate` → new raw key once
- `GET /v1/admin/keys/{id}/usage?month=` → counters
- `GET /v1/admin/audit?key_id=` → recent audit tail

**Billing** (test mode):
- `POST /v1/billing/checkout` `{tier, provider: stripe|razorpay, success_url}` → stub session (no charge)
- `POST /v1/billing/webhook/stripe`, `POST /v1/billing/webhook/razorpay` → signature-verified; on `checkout.completed` → tier upgrade + audit

**Errors** (catalog in §8): `400 invalid_param`, `401 missing/invalid key`, `402 quota_exceeded`, `403 revoked/forbidden`, `409 idempotency_conflict`, `413 file_too_large`, `422 unprocessable`, `429 rate_limited` (with `Retry-After`), `5xx`.

## 5. Redis plan (Upstash)
- `rl:{keyId}:{window}` sliding-window counters (ZADD/ZREMRANGEBYSCORE/ZCARD, 1-min windows) — ~3 cmds/call.
- `idem:{key}` idempotency payload-hash → response (24h TTL).
- Prod job dedupe: `job:filehash` → job_id (24h).
- **Fallback:** in-memory Map in local dev / if Upstash unreachable — gateway keeps serving (documented degradation; single-isolate only, fine for dev).

## 6. Security
- Keys: `vq_live_` + 32 random bytes (base64url); **SHA-256 hash stored**, raw never persisted; prefix (`vq_live_ab12…`) stored for identification.
- Keys in `Authorization` header ONLY — rejected if present in URL/query (logged as warning).
- Per-key monthly quotas + per-minute rate limits; global abuse cap per IP (1000/min).
- Admin plane: separate secret, never the same as API keys; all admin actions → audit log.
- Webhooks: Stripe (`Stripe-Signature`, HMAC-SHA256, 5-min tolerance) + Razorpay (`order_id|payment_id` HMAC) verified before any tier change; amounts from server-side price map, never client.
- Uploads: magic-byte sniff (JPEG/PNG/PDF only), size caps per tier, stored in R2 (never executed), served as attachment with `X-Content-Type-Options: nosniff`.
- Error responses never leak stack traces, key material, or user-enumeration signals.
- CORS: allowlist from `CORS_ORIGINS` env (default: visionquantech.com + localhost).

## 7. Scaling & cost
| Monthly calls | Infra cost | Notes |
|---|---|---|
| 1k | **$0** | all free tiers |
| 100k | **$0–5** | Workers free (3M req/day budget ok); KV writes ~100k < 1M free; Upstash ~300k cmds < 300k free-ish |
| 1M | **≈$10–13** | Workers Paid $5 + $0.50/M req; KV writes ~1M borderline free; Upstash ~$4; R2 ~$1 |
| 10M | ≈$60–80 | Workers $5 + $5/M; KV + Upstash scale linearly |

**Worst-case abuse scenario (hardening):** attacker steals a *business* key (250k quota) and burns it on max-size async PDF jobs: 250k requests ≈ $0.13; KV writes 250k ≈ $0 (under 1M free); R2 250k × 5 MB = 1.25 TB-month ≈ $19 **unless** the `jobs/*` 1-day lifecycle rule is set (required prod setting); Upstash ~750k cmds ≈ $1.50. **Worst case ≈ $21 one-time, then the key is revoked.** Free-key abuse ≈ $0.02. No per-request paid third-party API exists in the hot path, so there is no surprise-$10k path. Kill switch (`API_KILL_SWITCH=1`) stops all metered compute instantly.

Media CPU: free Workers = 10ms CPU/request — large images MUST go async (documented, enforced by guardrail). Workers Paid = 50ms CPU — covers most images/PDFs via Queue consumers.

## 8. Error catalog
`invalid_param` (400) · `missing_auth`/`invalid_key` (401) · `quota_exceeded` (402, `resets_at`) · `revoked_key`/`forbidden` (403) · `idempotency_key_in_use`/`payload_mismatch` (409) · `file_too_large`/`unsupported_media` (413/422) · `rate_limited` (429, `Retry-After`, `limit`, `window`) · `job_not_found` (404) · `internal` (500, `request_id` only).

## 9. Go-live checklist (for Shivay)
1. Create Cloudflare account → `wrangler login` → `wrangler kv:namespace create` ×3, `wrangler r2 bucket create`, Queue create.
2. Upstash account → Redis REST URL + token → `wrangler secret put`.
3. `wrangler secret put ADMIN_SECRET`; set `CORS_ORIGINS`.
4. `wrangler deploy`; point `api.visionquantech.com` DNS at Workers.
5. Issue first live key via admin endpoint; run `npm test` against prod URL.
6. Stripe/Razorpay: flip test→live keys, register webhook URLs.
