/* VisionQuantech API gateway — Cloudflare Workers.
 * Middleware chain: CORS → request-id → auth → quota → rate-limit →
 * idempotency → route → meter → audit → JSON response.
 * Local dev: wrangler dev --local (miniflare). Env LOCAL_DEV=1 enables
 * inline job processing (no CPU cap in miniflare) + in-memory Redis fallback.
 */
import { handleCalc } from './routes/calc.js';
import { handleTools } from './routes/tools.js';
import { handleJobs } from './routes/jobs.js';
import { handleAdmin } from './routes/admin.js';
import { handleBilling } from './routes/billing.js';
import { handleMeta } from './routes/meta.js';
import { authenticate, keyInUrl } from './auth.js';
import { checkRateLimit, checkIpLimit } from './ratelimit.js';
import { checkQuota, recordUsage, quotaWarning } from './metering.js';
import { idempotencyCheck, idempotencyStore } from './idempotency.js';
import { audit } from './logger.js';

export function err(code, message, status, extra) {
  return { error: { code, message, ...(extra || {}) } , _status: status };
}

export function json(data, status, reqId, extraHeaders) {
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  return new Response(body, {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'x-request-id': reqId || '',
      ...(extraHeaders || {}),
    },
  });
}

function corsHeaders(env, req) {
  const allow = (env.CORS_ORIGINS || 'https://visionquantech.com,http://localhost:8787')
    .split(',').map(s => s.trim()).filter(Boolean);
  const origin = req.headers.get('origin') || '';
  const ok = origin && (allow.includes('*') || allow.includes(origin));
  const h = {
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,idempotency-key,x-admin-secret',
    'access-control-max-age': '86400',
  };
  // HARDENING: never reflect or default an ACAO header to a non-allowlisted origin.
  if (ok) h['access-control-allow-origin'] = allow.includes('*') ? '*' : origin;
  return h;
}

const PUBLIC = new Set(['GET /health', 'GET /v1/openapi.json', 'OPTIONS *']);

export default {
  async fetch(req, env, ctx) {
    const reqId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())) ;
    const cors = corsHeaders(env, req);
    const url = new URL(req.url);
    const routeKey = `${req.method} ${url.pathname}`;
    const send = (data, status, extra) => {
      const r = data instanceof Response ? data : json(data, status, reqId, extra);
      Object.entries(cors).forEach(([k, v]) => r.headers.set(k, v));
      return r;
    };
    const sendErr = (e) => {
      const status = e._status || 500;
      const payload = { error: { code: e.error?.code || 'internal', message: e.error?.message || 'internal error', request_id: reqId } };
      return send(payload, status);
    };

    if (req.method === 'OPTIONS') {
      const r = new Response(null, { status: 204 }); // 204 must not carry a body
      Object.entries(cors).forEach(([k, v]) => r.headers.set(k, v));
      return r;
    }

    // HARDENING 1: kill switch — instantly disables all paid/authed paths
    if (env.API_KILL_SWITCH === '1' && url.pathname !== '/health') {
      return sendErr(err('killed', 'API temporarily disabled by operator.', 503));
    }

    // HARDENING 2: global body-size guard (slowloris / large-body abuse).
    // Per-endpoint media caps are enforced in routes/tools.js; this is the ceiling.
    const clen = parseInt(req.headers.get('content-length') || '0', 10);
    if (clen > 25 * 1024 * 1024) {
      return sendErr(err('file_too_large', 'Request body exceeds the 25 MB global ceiling.', 413));
    }

    try {
      // 0. Reject API keys in URL (must be header-only)
      if (keyInUrl(url)) {
        await audit(env, null, 'key_in_url_rejected', { path: url.pathname });
        return sendErr(err('invalid_auth', 'API key must be sent in the Authorization header, never in the URL.', 401));
      }

      // 1b. per-IP limits on EVERY endpoint (before auth): global abuse cap
      // + brute-force cap on the admin plane. Public/health/webhook paths
      // are covered here; per-key limits apply after auth below.
      const iprl = await checkIpLimit(env, req);
      if (iprl.error) {
        const r = sendErr(iprl.error);
        r.headers.set('retry-after', String(iprl.retryAfter || 60));
        return r;
      }

      const isPublic = [...PUBLIC].some(p => {
        const [m, path] = p.split(' ');
        return (m === '*' || m === req.method) && (path === '*' || path === url.pathname);
      });
      // Admin plane uses X-Admin-Secret (not Bearer); webhooks use signatures.
      // Neither goes through key auth, quota, or per-key rate limiting.
      const noKeyAuth = isPublic || url.pathname.startsWith('/v1/admin/') || url.pathname.startsWith('/v1/billing/webhook/');

      let key = null;
      if (!noKeyAuth) {
        key = await authenticate(req, env);
        if (key.error) return sendErr(key.error);
        // 2. quota
        const q = await checkQuota(env, key);
        if (q.error) return sendErr(q.error);
        // 3. rate limit
        const rl = await checkRateLimit(env, key);
        if (rl.error) {
          const r = sendErr(rl.error);
          r.headers.set('retry-after', String(rl.retryAfter || 60));
          return r;
        }
        // 4. idempotency (POST only)
        if (req.method === 'POST') {
          const idem = await idempotencyCheck(req, env, key);
          if (idem.replay) {
            const r = json(idem.replay.body, idem.replay.status, reqId, { 'x-idempotent-replay': 'true' });
            Object.entries(cors).forEach(([k, v]) => r.headers.set(k, v));
            return r;
          }
          if (idem.error) return sendErr(idem.error);
          req._idemKey = idem.key; req._idemHash = idem.hash;
        }
      }

      // 5. route
      const p = url.pathname;
      let out;
      if (p === '/health' || p.startsWith('/v1/status') || p === '/v1/openapi.json') out = await handleMeta(req, env, key);
      else if (p.startsWith('/v1/calc/')) out = await handleCalc(req, env, key);
      else if (p.startsWith('/v1/tools/')) out = await handleTools(req, env, key, ctx);
      else if (p.startsWith('/v1/jobs')) out = await handleJobs(req, env, key, ctx);
      else if (p.startsWith('/v1/admin/')) out = await handleAdmin(req, env, key);
      else if (p.startsWith('/v1/billing/')) out = await handleBilling(req, env, key);
      else out = err('not_found', 'Unknown endpoint. See GET /v1/openapi.json', 404);

      // 6. meter + audit (only for authed calls)
      if (key && !out._skipMeter) {
        ctx.waitUntil(recordUsage(env, key));
        ctx.waitUntil(audit(env, key.id, 'api_call', { method: req.method, path: p, status: out._status || 200 }));
      }
      // HARDENING 3: quota warning headers at 70%/90% (cost awareness per call)
      let warnHeaders = {};
      if (key && !out.error) {
        const w = await quotaWarning(env, key);
        if (w) warnHeaders = { 'x-vq-quota-warning': w };
      }
      if (req._idemKey && out._status && out._status < 500 && !(out instanceof Response)) {
        ctx.waitUntil(idempotencyStore(env, key, req._idemKey, req._idemHash, out._status || 200, out.error ? out : out));
      }

      if (out instanceof Response) {
        Object.entries(cors).forEach(([k, v]) => out.headers.set(k, v));
        Object.entries(warnHeaders).forEach(([k, v]) => out.headers.set(k, v));
        return out;
      }
      if (out.error) return sendErr(out);
      const { _status, _skipMeter, ...clean } = out;
      return send(clean, out._status || 200, warnHeaders);
    } catch (e) {
      // never leak stack traces
      return sendErr(err('internal', 'Something went wrong.', 500));
    }
  },

  // Queue consumer (production async media jobs)
  async queue(batch, env) {
    const { processJob } = await import('./processor.js');
    for (const msg of batch.messages) {
      try { await processJob(env, msg.body); }
      catch (e) { /* job record marked failed inside processJob */ }
      msg.ack();
    }
  },
};
