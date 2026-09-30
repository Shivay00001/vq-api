# HARDENING — VisionQuantech API
Anti-vibe-coding pass, 2026-09-26. Controls are **coded**; test evidence is in §5 — read the caveats, not just the table.

## 1. DDoS / abuse
| Control | Where | Test |
|---|---|---|
| Per-key sliding-window rate limit (free 10/min, pro 60, business 300, enterprise 1000) | `src/ratelimit.js` (Upstash Redis; in-mem fallback in dev) | 429 + `Retry-After` |
| Per-IP limits on **every** endpoint, applied before auth: global 1000/min; admin plane 60/min per IP (brute-force mitigation) | `src/ratelimit.js` `checkIpLimit`, wired in `src/index.js` §1b | break tests |
| Key-in-URL rejected (prevents key leakage via logs/referrers) | `src/index.js` | 401 `invalid_auth` |
| Global body ceiling 25 MB (`content-length` pre-check) | `src/index.js` | 413 |
| Per-tier media budgets (free: 1 MB img / 5 MB pdf …) → oversize goes async, never OOMs a request | `src/routes/tools.js` | 202 job |
| Magic-byte sniff on uploads (JPEG/PNG/PDF only) + decode-dimension validation (upng-js returns undefined dims on truncated input instead of throwing) | `src/lib/media.js`, `src/lib/pdfutil.js` | 422 `unsupported_media` |
| Kill switch: `API_KILL_SWITCH=1` → 503 on everything except `/health` | `src/index.js` | `tests/killswitch.mjs` vs `:8788` worker: PASS |
| Cloudflare plan (post-deploy): **Under Attack Mode** = Dashboard → Security → *Under Attack*; WAF managed rules ON; rate-limiting rule 100 req/10s per IP at edge as second layer | runbook below | — |

**Under-Attack runbook:** 1) Cloudflare dashboard → domain → Security → set *Under Attack Mode*. 2) If still burning: `wrangler secret put API_KILL_SWITCH` = `1` (instant 503, zero cost). 3) Rotate `ADMIN_SECRET`; audit key usage for the spike; revoke abusive keys.

## 2. Cost guardrails
- **Quotas ARE spend caps**: free 1k/mo, pro 25k, business 250k, enterprise custom (`quota_override`). Over quota → 402, no overage billing exists in v1 — the bill cannot exceed the plan.
- **Quota metering is atomic in production**: `src/metering.js` uses Upstash Redis `INCR`/`GET` (atomic) when `UPSTASH_REDIS_REST_URL`/`TOKEN` are set; local dev falls back to KV read-modify-write, which is **prototype-grade** — measured locally: 20 concurrent requests vs quota 5 → 10 allowed (2× overshoot), 10 served but only 2 metered (lost increments). Sequential enforcement is exact (3×200 then 402, verified). **Upstash must be configured before production, or spend caps are soft.**
- **Warnings**: `x-vq-quota-warning` header at 70% and 90% of monthly quota (`src/metering.js`).
- **Kill switch** (above) stops all metered compute instantly.
- **Worst-case abuse scenario** (also TRD §7): attacker steals a *business* key (250k quota) and burns it on max-size async PDF jobs. Provisional math (verify live prices before publishing): 250k requests ≈ $0.13 Workers req fees; KV writes 250k ≈ $0 (under 1M free); R2: 250k × 5 MB = 1.25 TB-month ≈ $19 storage if never cleaned (mitigation: job blobs TTL 24h via lifecycle rule — **set this on the bucket**); Upstash ~750k cmds ≈ $1.50. **Worst-case ≈ $21, one time, then key revoked.** With free keys: 1k quota → ≈ $0.02. There is no path to a surprise $10k bill: no per-request paid third-party APIs in the hot path.
- Required prod setting: R2 lifecycle rule — delete `jobs/*` after 1 day.

## 3. No vibe-coding shortcuts
- Every endpoint has contract tests in `tests/run.mjs`: auth missing/invalid (401), key-in-URL (401), revoked key (403), quota exceeded (402), malformed input (400), rate limit (429), idempotent double-submit (replay), webhook bad signature (403), webhook replay (deduped), job ownership (404 for other key's job), kill switch (503).
- Break tests in `tests/break.mjs`: rate-limit burst, 26 MB body → 413, truncated JSON → 400, webhook replay storm (sequential dedupe + 20-way burst), concurrent quota race, media bombs (garbage/truncated → 422).
- No undocumented endpoints: `GET /v1/openapi.json` is served from the bundled spec; CI check `node tests/check-spec.mjs` fails if a route lacks a spec entry (TODO: wire into pre-deploy).
- Dependency scan: `npm audit` was **blocked** by workspace egress policy (HTTP 403 on the audit endpoint) — NOT run. Instead: manual CVE check 2026-09-26 against GitHub Advisory DB / Snyk / NVD via web: **jpeg-js@0.4.4** patches CVE-2022-25851 (infinite-loop DoS, GHSA-xvf7-4v9q-58w6 — affects <0.4.4 only); **upng-js@2.1.0, pdf-lib@1.17.1, qrcode-generator@1.5.2**: no known CVEs found. `imagescript` is dev-only (test fixtures), `wrangler` is dev-only; neither ships in the Worker bundle. `package-lock.json` contains zero `jimp` references. Re-run `npm audit` from an unrestricted network before production.
- Secrets: only via `env` / `.dev.vars` (git-ignored). Secret grep 2026-09-26 across `src/ tests/ postman/ openapi.json wrangler.toml .dev.vars.example`: clean (no live keys, no private keys).

## 4. Payments (test mode)
See `PAYMENTS.md`. Signature verification + replay protection + amount-from-server are coded and contract-tested. **Corrected 2026-09-26**: Razorpay webhook verification was using checkout-style `order_id|payment_id` — wrong for webhooks. Now verifies `HMAC-SHA256(webhook_secret, raw_body)` per current Razorpay docs, before JSON parsing; replay key is `x-razorpay-event-id` (payment id fallback). Live keys arrive later via vault — never chat.

## 5. Verification evidence (2026-09-26, local `wrangler dev`)
| Suite | Result |
|---|---|
| `tests/run.mjs` (contract: 13 calc + 8 text/devops + 2 image + 3 pdf + async jobs + key mgmt + billing + auth/quota/rate/idempotency/ownership + CORS/body guards) | **101 passed, 0 failed** |
| `tests/check-spec.mjs` | **42/42 routes documented** |
| `tests/killswitch.mjs` (separate `:8788` worker, `API_KILL_SWITCH=1`) | **PASS** — `/health` 200 alive, authed path 503 `killed` |
| `tests/break.mjs` (burst/413/400/replay storm/quota race/media bombs) | **15 passed, 0 failed** |
| Postman collection `postman/gen.mjs` (ESM) | 42 requests, schema-valid |

**Bugs found by testing and fixed (not just documented):**
1. `jpeg-js` encoder uses Node `Buffer` (absent in Workers) → `ReferenceError: Buffer is not defined` on every JPEG encode. Fixed: minimal `globalThis.Buffer` shim (`from`/`alloc`) in `src/lib/media.js` + `useTArray:true` on decode.
2. `upng-js` returns `{width: undefined}` instead of throwing on truncated PNG → 400 `bad width/height`. Fixed: dimension validation in `decode()` → 422 `unsupported_media`.
3. Image/PDF route parsing used `split('/')[3]` (the literal `"image"`) instead of `[4]` → 404 on all media ops. Fixed.
4. `OPTIONS` preflight built `new Response('{}', {status: 204})` → throws (204 cannot carry a body) → 500. Fixed: `new Response(null, {status: 204})`.
5. Stripe webhook test put the session id in `metadata` while the handler (correctly, per Stripe) reads `data.object.id` → upgrade silently skipped. Test fixed.
6. Razorpay webhook verified `order_id|payment_id` (checkout scheme) — wrong for webhooks. Fixed to raw-body HMAC per current docs.
7. Validation gaps closed: `json-format` invalid JSON was 500 → 400; `password` length unclamped → 400 outside 4..128; `k8s`/`ci` accepted unknown kind/provider → 400; `salary` accepted unknown state → 400.
8. Per-IP rate limiting previously applied only inside the Bearer-auth flow — admin, webhook, health, and OpenAPI paths had no IP limits. Fixed: `checkIpLimit` runs before auth on every endpoint.

**Known limitations (do NOT call production-ready until resolved):**
- KV read-modify-write fallback races under concurrency (measured above); production requires Upstash Redis env vars.
- 70%/90% warning headers track per-key API quota only — no operator alerts yet for Workers/KV/R2/Queue spend.
- Webhook replay dedupe is KV-write-raced under true concurrency (sequential dedupe verified); the upgrade itself is idempotent so no corruption.
- Audit-tail KV writes are non-atomic (prototype-grade).
- Per-endpoint body caps: the 25 MB global ceiling still stands in for per-tier media caps in some paths; documented business PDF allowance (100 MB) conflicts with the 25 MB ceiling — reconcile before launch.
- Actual request-timeout ceilings and global abuse caps beyond per-IP/per-key are not yet implemented.
- Statutory finance formulas (incl. PF ₹25,000 ceiling) not yet verified against primary current law.
- R2 `jobs/*` 1-day lifecycle deletion: documented, not yet configured (nothing deployed).
