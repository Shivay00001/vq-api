/* Image ops: pure-JS JPEG/PNG pipeline (jpeg-js + upng-js + hand-rolled
 * bilinear resize). Zero native deps, zero wasm, zero node builtins —
 * bundles cleanly into Cloudflare Workers/workerd.
 * v1 supports JPEG/PNG decode + JPEG/PNG encode. WebP is Phase-2.
 */
import * as _jpeg from 'jpeg-js';
import * as _upng from 'upng-js';
const JPEG = _jpeg.default || _jpeg;
const UPNG = _upng.default || _upng;

/* Cloudflare Workers have no Node Buffer; jpeg-js only touches Buffer at
 * encode/decode call time (Buffer.from on encode, Buffer.alloc on decode),
 * so a minimal global shim installed at module load is sufficient.
 * Decode additionally uses useTArray:true to get a Uint8Array directly. */
if (typeof globalThis.Buffer === 'undefined') {
  globalThis.Buffer = {
    from: (arr) => (arr instanceof Uint8Array ? new Uint8Array(arr) : Uint8Array.from(arr || [])),
    alloc: (n) => new Uint8Array(Number(n) >>> 0),
    isBuffer: () => false,
  };
}

export const IMAGE_FORMATS = ['jpeg', 'jpg', 'png'];

function sniff(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  return null;
}

function decode(u8, kind) {
  try {
    if (kind === 'jpeg') {
      const d = JPEG.decode(u8, { maxMemoryUsageInMB: 512, useTArray: true });
      if (!Number.isFinite(d.width) || !Number.isFinite(d.height) || d.width <= 0 || d.height <= 0) throw new Error('bad dims');
      return { data: new Uint8Array(d.data), w: d.width, h: d.height };
    }
    const img = UPNG.decode(u8);
    // upng-js returns {width:undefined} instead of throwing on truncated input
    if (!img || !Number.isFinite(img.width) || !Number.isFinite(img.height) || img.width <= 0 || img.height <= 0) throw new Error('bad dims');
    const rgba = UPNG.toRGBA8(img);
    return { data: new Uint8Array(rgba[0]), w: img.width, h: img.height };
  } catch {
    const e = new Error('could not decode image'); e.code = 'unsupported_media'; throw e;
  }
}

/* Bilinear resample of RGBA bytes. */
function resizeRGBA(src, sw, sh, dw, dh) {
  const out = new Uint8Array(dw * dh * 4);
  const xr = sw / dw, yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = (y + 0.5) * yr - 0.5;
    const y0 = Math.max(0, Math.min(sh - 1, Math.floor(sy)));
    const y1 = Math.min(sh - 1, y0 + 1);
    const wy = Math.max(0, Math.min(1, sy - y0));
    for (let x = 0; x < dw; x++) {
      const sx = (x + 0.5) * xr - 0.5;
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(sx)));
      const x1 = Math.min(sw - 1, x0 + 1);
      const wx = Math.max(0, Math.min(1, sx - x0));
      const o = (y * dw + x) * 4;
      const a00 = (y0 * sw + x0) * 4, a10 = (y0 * sw + x1) * 4;
      const a01 = (y1 * sw + x0) * 4, a11 = (y1 * sw + x1) * 4;
      for (let c = 0; c < 4; c++) {
        const top = src[a00 + c] * (1 - wx) + src[a10 + c] * wx;
        const bot = src[a01 + c] * (1 - wx) + src[a11 + c] * wx;
        out[o + c] = Math.round(top * (1 - wy) + bot * wy);
      }
    }
  }
  return out;
}

export async function processImage(buf, { op, width, height, format, quality }) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const kind = sniff(u8);
  if (!kind) { const e = new Error('unsupported_media: JPEG/PNG only in v1 (magic-byte checked)'); e.code = 'unsupported_media'; throw e; }
  const fmt = String(format || (kind === 'jpeg' ? 'jpeg' : 'png')).toLowerCase().replace('jpg', 'jpeg');
  if (!IMAGE_FORMATS.includes(fmt)) {
    const e = new Error(`unsupported format "${format}" — v1 supports: jpeg, png (webp is Phase-2)`);
    e.code = 'invalid_param'; throw e;
  }
  const dec = decode(u8, kind);
  const w = width ? Math.min(8000, Math.max(1, parseInt(width))) : dec.w;
  const h = height ? Math.min(8000, Math.max(1, parseInt(height))) : dec.h;
  if (!Number.isFinite(w) || !Number.isFinite(h)) { const e = new Error('bad width/height'); e.code = 'invalid_param'; throw e; }
  let data = dec.data, dw = dec.w, dh = dec.h;
  if (op === 'resize' || w !== dec.w || h !== dec.h) { data = resizeRGBA(dec.data, dec.w, dec.h, w, h); dw = w; dh = h; }
  const q = Math.min(100, Math.max(1, parseInt(quality) || 80));
  let bytes, mime;
  if (fmt === 'jpeg') {
    bytes = new Uint8Array(JPEG.encode({ data, width: dw, height: dh }, q).data);
    mime = 'image/jpeg';
  } else {
    bytes = new Uint8Array(UPNG.encode([data.buffer], dw, dh, 0));
    mime = 'image/png';
  }
  return { bytes, mime, width: dw, height: dh, format: fmt,
    original_bytes: u8.length, output_bytes: bytes.length,
    saved_pct: Math.round((1 - bytes.length / u8.length) * 1000) / 10 };
}
