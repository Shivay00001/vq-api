/* PDF operations via pdf-lib (pure JS — runs in Workers).
 * merge: concatenate pages of N PDFs. split: extract ranges -> new PDF.
 * compress: rebuild with object streams + metadata strip (lossless;
 * typically 10-40% smaller, less on scanned/image PDFs — stated honestly).
 */
import { PDFDocument } from 'pdf-lib';

function sniffPdf(buf) {
  const h = String.fromCharCode(...buf.slice(0, 5));
  return h === '%PDF-';
}

async function load(buf, label) {
  if (!sniffPdf(buf)) { const e = new Error(`${label}: not a PDF (magic-byte checked)`); e.code = 'unsupported_media'; throw e; }
  return PDFDocument.load(buf, { ignoreEncryption: true });
}

function parseRanges(spec, pageCount) {
  const pages = new Set();
  const s = String(spec).trim().toLowerCase();
  if (s === 'all' || s === '') { for (let p = 0; p < pageCount; p++) pages.add(p); return [...pages]; }
  for (const part of s.split(',')) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) { const e = new Error(`bad range "${part}" — use like "1-3,5"`); e.code = 'invalid_param'; throw e; }
    let a = parseInt(m[1]), b = m[2] ? parseInt(m[2]) : a;
    if (a > b) [a, b] = [b, a];
    for (let p = a; p <= b; p++) { if (p >= 1 && p <= pageCount) pages.add(p - 1); }
  }
  if (!pages.size) { const e = new Error('no valid pages in range'); e.code = 'invalid_param'; throw e; }
  return [...pages].sort((x, y) => x - y);
}

export async function pdfMerge(buffers) {
  if (!buffers.length) { const e = new Error('at least one PDF required'); e.code = 'invalid_param'; throw e; }
  const out = await PDFDocument.create();
  let pages = 0;
  for (let i = 0; i < buffers.length; i++) {
    const src = await load(buffers[i], `file ${i + 1}`);
    const copied = await out.copyPages(src, src.getPageIndices());
    copied.forEach(p => out.addPage(p));
    pages += copied.length;
  }
  const bytes = await out.save({ useObjectStreams: true });
  return { bytes, pages, files: buffers.length };
}

export async function pdfSplit(buf, ranges) {
  const src = await load(buf, 'file');
  const idx = parseRanges(ranges, src.getPageCount());
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, idx);
  copied.forEach(p => out.addPage(p));
  const bytes = await out.save({ useObjectStreams: true });
  return { bytes, pages: idx.length };
}

export async function pdfCompress(buf) {
  const src = await load(buf, 'file');
  const before = buf.length;
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, src.getPageIndices());
  copied.forEach(p => out.addPage(p));
  out.setTitle(''); out.setAuthor(''); out.setProducer('VisionQuantech API'); out.setCreator('');
  const bytes = await out.save({ useObjectStreams: true });
  return { bytes, pages: copied.length, before_bytes: before, after_bytes: bytes.length,
    saved_pct: Math.round((1 - bytes.length / before) * 1000) / 10,
    note: 'Lossless rebuild (object streams, metadata stripped). Scanned/image PDFs shrink little — re-rendering pages would lose quality, so we do not do it silently.' };
}
