/* Async job lifecycle for media work that exceeds the sync CPU budget.
 * POST /v1/jobs (multipart: file/files + operation + params JSON)
 * GET  /v1/jobs/:id          -> status (owner-only)
 * GET  /v1/jobs/:id/result   -> output file download (owner-only)
 *
 * Production: input -> R2, job record -> KV, Queue -> processor.js.
 * Local dev (LOCAL_DEV=1): processed inline after store (miniflare has no
 * CPU cap), so the full submit->poll->download flow is genuinely exercised.
 */
import { err, json } from '../index.js';
import { formDataOf } from '../idempotency.js';

const OPS = ['image.resize', 'image.convert', 'pdf.merge', 'pdf.split', 'pdf.compress'];

export async function createJob(env, key, spec, filesInput, fromTools) {
  const op = spec.operation;
  if (!OPS.includes(op)) return err('invalid_param', `operation must be one of: ${OPS.join(', ')}`, 400);
  const files = (Array.isArray(filesInput) ? filesInput : [filesInput]).filter(f => f && typeof f.arrayBuffer === 'function');
  if (!files.length) return err('invalid_param', 'multipart "file" required.', 400);
  const id = 'job_' + [...crypto.getRandomValues(new Uint8Array(12))].map(b => b.toString(16).padStart(2, '0')).join('');
  // store inputs in R2
  const inputs = [];
  for (let i = 0; i < files.length; i++) {
    const buf = new Uint8Array(await files[i].arrayBuffer());
    const r2key = `jobs/${id}/input-${i}`;
    await env.R2.put(r2key, buf, { httpMetadata: { contentType: files[i].type || 'application/octet-stream' } });
    inputs.push(r2key);
  }
  const rec = { id, key_id: key.id, tier: key.tier, operation: op, params: spec.params || {},
    inputs, status: 'queued', progress: 0, created_at: new Date().toISOString(), from_tools: !!fromTools };
  await env.KV.put('job:' + id, JSON.stringify(rec), { expirationTtl: 86400 });
  if (env.LOCAL_DEV === '1') {
    // local: process inline (no CPU cap in miniflare) — same code path as the queue consumer
    const { processJob } = await import('../processor.js');
    await processJob(env, { job_id: id });
  } else if (env.QUEUE) {
    await env.QUEUE.send({ job_id: id });
  }
  const fresh = await env.KV.get('job:' + id, 'json');
  const done = fresh.status === 'done';
  return json({ job_id: id, status: fresh.status, operation: op,
    ...(done ? { result_url: `/v1/jobs/${id}/result` } : { poll_url: `/v1/jobs/${id}` }) },
    done ? 200 : 202);
}

async function loadJob(env, key, id) {
  if (!/^job_[0-9a-f]{24}$/.test(id)) return { error: err('job_not_found', 'Unknown job id.', 404) };
  const rec = await env.KV.get('job:' + id, 'json');
  if (!rec || rec.key_id !== key.id) return { error: err('job_not_found', 'Unknown job id.', 404) }; // no IDOR, no enumeration
  return { rec };
}

export async function handleJobs(req, env, key) {
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean); // v1, jobs, [id], [result]
  if (req.method === 'POST' && parts.length === 2) {
    const form = await formDataOf(req);
    const files = form.getAll('files').concat([form.get('file')]).filter(f => f && typeof f.arrayBuffer === 'function');
    let params = {};
    try { params = form.get('params') ? JSON.parse(form.get('params')) : {}; } catch { return err('invalid_param', '"params" must be valid JSON.', 400); }
    return createJob(env, key, { operation: form.get('operation'), params }, files, false);
  }
  if (parts.length >= 3) {
    const id = parts[2];
    const { rec, error } = await loadJob(env, key, id);
    if (error) return error;
    if (req.method === 'GET' && parts.length === 3) {
      const out = { job_id: rec.id, status: rec.status, operation: rec.operation, progress: rec.progress, created_at: rec.created_at };
      if (rec.status === 'done') out.result_url = `/v1/jobs/${id}/result`;
      if (rec.status === 'failed') out.error = rec.error;
      if (rec.meta) out.meta = rec.meta;
      out._status = 200; return out;
    }
    if (req.method === 'GET' && parts[3] === 'result') {
      if (rec.status !== 'done') return err('invalid_param', `Job is ${rec.status}, not done.`, 409);
      const obj = await env.R2.get(`jobs/${id}/output`);
      if (!obj) return err('internal', 'Result missing.', 500);
      return new Response(obj.body, { status: 200, headers: {
        'content-type': rec.mime || 'application/octet-stream',
        'content-disposition': `attachment; filename="${rec.filename || 'vq-result'}"`,
        'x-content-type-options': 'nosniff' } });
    }
  }
  return err('not_found', 'Use POST /v1/jobs, GET /v1/jobs/{id}, GET /v1/jobs/{id}/result', 404);
}
