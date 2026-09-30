# ERROR CATALOG — VisionQuantech API
Generated 2026-09-26 from `src/` (grep-verified, not aspirational). Every error
response is JSON: `{"error":{"code": ..., "message": ..., "status": ...}}`.
`status` is the HTTP status. 5xx never leaks internals — handler wraps throws
as `internal_error` with no stack in the body.

| code | HTTP | Meaning | Where it fires |
|---|---|---|---|
| `invalid_auth` | 401 | Missing / malformed `Authorization: Bearer` header; key passed in URL | `src/index.js` auth gate |
| `invalid_key` | 401 | Bearer token does not match any issued key hash | `src/auth.js` |
| `forbidden` | 403 | Revoked key; disabled key; wrong `ADMIN_SECRET`; bad webhook signature | `src/index.js`, `src/routes/admin.js`, `src/routes/billing.js` |
| `not_found` | 404 | Unknown endpoint; unknown job id; job belongs to another key; unknown key id | routers, `src/routes/jobs.js`, `src/routes/admin.js` |
| `invalid_param` | 400 | Schema/type/range validation failure on request input (46 call sites) | all tool routers |
| `unsupported_media` | 422 | Magic-byte mismatch or decode failure on image/PDF upload | `src/lib/media.js`, `src/lib/pdfutil.js` |
| `too_large` | 413 | `content-length` exceeds the 25 MB global ceiling | `src/index.js` pre-check |
| `rate_limited` | 429 | Per-key tier window or per-IP / admin-plane window exceeded; carries `Retry-After` | `src/ratelimit.js` |
| `quota_exceeded` | 402 | Monthly quota consumed (`quota_override` respected); body carries `limit`/`used`/`resets_at` | `src/metering.js` |
| `killed` | 503 | `API_KILL_SWITCH=1` — everything except `/health` | `src/index.js` |

Notes:
- `invalid_param` details include the offending field name in `message` (safe to show; no secrets echoed).
- Webhook dedupe returns **200** with `{"received":true,"deduped":true}` — not an error.
- `OPTIONS` preflight returns bodyless 204 on the allowlist, never an error payload.
