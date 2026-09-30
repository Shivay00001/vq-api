/* POST /v1/tools/* — sync text/dev/media tools.
 * Media guardrail: files over the sync budget -> 202 + async job (honest,
 * not faked). Budgets by tier: free 1MB/5MB pdf, pro 5MB/25MB, business+ 20MB/100MB.
 */
import { wordCount, jsonFormat, genPassword, qrSvg, cronExplain, dockerfileGen, k8sGen, ciGen } from '../lib/textutil.js';
import { processImage } from '../lib/media.js';
import { pdfMerge, pdfSplit, pdfCompress } from '../lib/pdfutil.js';
import { err, json } from '../index.js';
import { formDataOf } from '../idempotency.js';

const SYNC_BUDGET = { free: { img: 1e6, pdf: 5e6 }, pro: { img: 5e6, pdf: 25e6 }, business: { img: 20e6, pdf: 100e6 }, enterprise: { img: 20e6, pdf: 100e6 } };

async function readJsonBody(req) {
  try { return req._rawBody ? JSON.parse(new TextDecoder().decode(req._rawBody)) : await req.json(); }
  catch { throw Object.assign(new Error('Body must be valid JSON.'), { code: 'invalid_param' }); }
}

function fileResponse(bytes, mime, filename, reqId) {
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': mime, 'x-request-id': reqId || '',
      'content-disposition': `attachment; filename="${filename}"`,
      'x-content-type-options': 'nosniff',
    },
  });
}

export async function handleTools(req, env, key, ctx) {
  const url = new URL(req.url);
  const tool = url.pathname.replace('/v1/tools/', '').split('/')[0];
  const reqId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());

  try {
    switch (tool) {
      case 'word-count': case 'json-format': case 'password': case 'qr':
      case 'cron-explain': case 'dockerfile': case 'k8s': case 'ci': {
        if (req.method !== 'POST') return err('invalid_param', 'Use POST with a JSON body.', 400);
        const b = await readJsonBody(req);
        const out = {
          'word-count': () => wordCount(b.text), 'json-format': () => jsonFormat(b),
          'password': () => genPassword(b), 'qr': () => qrSvg(b),
          'cron-explain': () => cronExplain(b), 'dockerfile': () => dockerfileGen(b),
          'k8s': () => k8sGen(b), 'ci': () => ciGen(b),
        }[tool]();
        out._status = 200; return out;
      }
      case 'image': {
        const op = url.pathname.split('/')[4]; // resize | convert
        if (!['resize', 'convert'].includes(op)) return err('not_found', 'Use /v1/tools/image/resize or /v1/tools/image/convert', 404);
        if (req.method !== 'POST') return err('invalid_param', 'Use POST multipart with a "file" field.', 400);
        const form = await formDataOf(req);
        const f = form.get('file');
        if (!f || typeof f.arrayBuffer !== 'function') return err('invalid_param', 'multipart field "file" required.', 400);
        const budget = (SYNC_BUDGET[key.tier] || SYNC_BUDGET.free).img;
        if (f.size > budget) {
          // hand off to async jobs — import lazily to avoid cycles
          const { createJob } = await import('./jobs.js');
          return createJob(env, key, { operation: op === 'resize' ? 'image.resize' : 'image.convert', params: Object.fromEntries(form.entries()) }, f, true);
        }
        const buf = new Uint8Array(await f.arrayBuffer());
        const r = await processImage(buf, { op, width: form.get('width'), height: form.get('height'), format: form.get('format'), quality: form.get('quality') });
        return fileResponse(r.bytes, r.mime, `vq-${op}.${r.format === 'jpeg' ? 'jpg' : r.format}`, reqId);
      }
      case 'pdf': {
        const op = url.pathname.split('/')[4]; // merge | split | compress
        if (!['merge', 'split', 'compress'].includes(op)) return err('not_found', 'Use /v1/tools/pdf/merge|split|compress', 404);
        if (req.method !== 'POST') return err('invalid_param', 'Use POST multipart with file field(s).', 400);
        const form = await formDataOf(req);
        const files = form.getAll('files').concat([form.get('file')]).filter(x => x && typeof x.arrayBuffer === 'function');
        if (!files.length) return err('invalid_param', 'multipart "file" (or "files[]") required.', 400);
        const total = files.reduce((a, f) => a + f.size, 0);
        const budget = (SYNC_BUDGET[key.tier] || SYNC_BUDGET.free).pdf;
        if (total > budget) {
          const { createJob } = await import('./jobs.js');
          return createJob(env, key, { operation: 'pdf.' + op, params: { ranges: form.get('ranges') } }, files, true);
        }
        const bufs = await Promise.all(files.map(async f => new Uint8Array(await f.arrayBuffer())));
        let r;
        if (op === 'merge') r = await pdfMerge(bufs);
        else if (op === 'split') r = await pdfSplit(bufs[0], form.get('ranges') || 'all');
        else r = await pdfCompress(bufs[0]);
        const res = fileResponse(r.bytes, 'application/pdf', `vq-pdf-${op}.pdf`, reqId);
        res.headers.set('x-vq-meta', JSON.stringify({ pages: r.pages, saved_pct: r.saved_pct ?? null }));
        return res;
      }
      default:
        return err('not_found', 'Unknown tool. See GET /v1/openapi.json', 404);
    }
  } catch (e) {
    const status = e.code === 'invalid_param' ? 400 : e.code === 'unsupported_media' ? 422 : 500;
    return err(e.code || 'internal', status === 500 ? 'Something went wrong.' : e.message, status);
  }
}
