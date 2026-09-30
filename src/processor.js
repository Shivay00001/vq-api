/* Queue consumer — runs media/PDF jobs. Same code in production (Queue)
 * and local dev (inline via LOCAL_DEV=1). Reads inputs from R2, writes
 * output to R2, updates the KV job record. Never fakes: failures are
 * recorded with the real error message (sanitized).
 */
import { processImage } from './lib/media.js';
import { pdfMerge, pdfSplit, pdfCompress } from './lib/pdfutil.js';

export async function processJob(env, { job_id }) {
  const k = 'job:' + job_id;
  const rec = await env.KV.get(k, 'json');
  if (!rec || rec.status === 'done') return;
  rec.status = 'processing'; rec.progress = 10;
  await env.KV.put(k, JSON.stringify(rec), { expirationTtl: 86400 });
  try {
    const bufs = [];
    for (const r2key of rec.inputs) {
      const obj = await env.R2.get(r2key);
      if (!obj) throw new Error('input missing from storage');
      bufs.push(new Uint8Array(await obj.arrayBuffer()));
    }
    let out, mime, filename, meta = {};
    const p = rec.params || {};
    switch (rec.operation) {
      case 'image.resize':
      case 'image.convert': {
        const r = await processImage(bufs[0], { op: rec.operation === 'image.resize' ? 'resize' : 'convert',
          width: p.width, height: p.height, format: p.format, quality: p.quality });
        out = r.bytes; mime = r.mime; filename = `vq-${rec.operation.split('.')[1]}.${r.format === 'jpeg' ? 'jpg' : r.format}`;
        meta = { width: r.width, height: r.height, saved_pct: r.saved_pct };
        break;
      }
      case 'pdf.merge': { const r = await pdfMerge(bufs); out = r.bytes; mime = 'application/pdf'; filename = 'vq-merged.pdf'; meta = { pages: r.pages }; break; }
      case 'pdf.split': { const r = await pdfSplit(bufs[0], p.ranges || 'all'); out = r.bytes; mime = 'application/pdf'; filename = 'vq-split.pdf'; meta = { pages: r.pages }; break; }
      case 'pdf.compress': { const r = await pdfCompress(bufs[0]); out = r.bytes; mime = 'application/pdf'; filename = 'vq-compressed.pdf'; meta = { saved_pct: r.saved_pct }; break; }
      default: throw new Error('unknown operation');
    }
    await env.R2.put(`jobs/${job_id}/output`, out, { httpMetadata: { contentType: mime } });
    rec.status = 'done'; rec.progress = 100; rec.mime = mime; rec.filename = filename; rec.meta = meta;
    rec.completed_at = new Date().toISOString();
  } catch (e) {
    rec.status = 'failed'; rec.error = String((e && e.message) || 'processing failed').slice(0, 300);
  }
  await env.KV.put(k, JSON.stringify(rec), { expirationTtl: 86400 });
}
