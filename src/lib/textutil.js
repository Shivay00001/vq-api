/* Text + dev-tool utilities. Pure, sync, tiny CPU. */
import qrcode from 'qrcode-generator';

export function wordCount(text) {
  const t = String(text ?? '');
  const words = (t.trim().match(/\S+/g) || []).length;
  const sentences = (t.match(/[^.!?]+[.!?]+/g) || []).length;
  return { words, characters: t.length, characters_no_spaces: t.replace(/\s/g, '').length,
    sentences, reading_minutes: Math.max(1, Math.round(words / 200)) };
}

export function jsonFormat({ json, style }) {
  let v;
  try { v = JSON.parse(json); }
  catch { const e = new Error('invalid JSON'); e.code = 'invalid_param'; throw e; }
  if (style === 'mini') return { valid: true, output: JSON.stringify(v) };
  if (style === 'validate') return { valid: true };
  return { valid: true, output: JSON.stringify(v, null, 2) };
}

export function genPassword({ length, numbers, symbols, count }) {
  const len = parseInt(length);
  const L = Number.isNaN(len) ? 20 : len;
  if (!Number.isInteger(L) || L < 4 || L > 128) { const e = new Error('length must be an integer 4..128'); e.code = 'invalid_param'; throw e; }
  const n = Math.min(20, Math.max(1, parseInt(count) || 1));
  const useLen = L;
  let alpha = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  if (numbers !== false) alpha += '0123456789';
  if (symbols !== false) alpha += '!@#$%^&*()-_=+[]{}<>?';
  const out = [];
  for (let i = 0; i < n; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(useLen));
    let p = '';
    for (const b of bytes) p += alpha[b % alpha.length];
    out.push(p);
  }
  const entropy = Math.log2(alpha.length) * useLen;
  return { passwords: out, length: useLen, entropy_bits: Math.round(entropy * 10) / 10 };
}

export function qrSvg({ data, size }) {
  const d = String(data ?? '');
  if (!d) { const e = new Error('data is required'); e.code = 'invalid_param'; throw e; }
  if (d.length > 2000) { const e = new Error('data too long (max 2000 chars)'); e.code = 'invalid_param'; throw e; }
  const qr = qrcode(0, 'M');
  qr.addData(d); qr.make();
  const count = qr.getModuleCount();
  const s = Math.min(1024, Math.max(128, parseInt(size) || 256));
  const cell = s / count;
  let rects = '';
  for (let r = 0; r < count; r++) for (let c = 0; c < count; c++)
    if (qr.isDark(r, c)) rects += `<rect x="${(c * cell).toFixed(2)}" y="${(r * cell).toFixed(2)}" width="${(cell + 0.5).toFixed(2)}" height="${(cell + 0.5).toFixed(2)}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}"><rect width="${s}" height="${s}" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
  return { svg, size: s, modules: count, data_uri: 'data:image/svg+xml;base64,' + btoa(svg) };
}

/* --- cron explainer (standard 5-field) --- */
const CRON = {
  month: ['*', 'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'],
  dow: ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'],
};
function fieldDesc(f, name, names) {
  if (f === '*') return `every ${name}`;
  const named = names ? f.replace(new RegExp(`\\b(${names.slice(1).join('|')})\\b`, 'gi'), m => { const i = names.findIndex(x => x.toUpperCase() === m.toUpperCase()); return String(i >= 0 ? i : m); }) : f;
  if (/^\*\/(\d+)$/.test(named)) return `every ${named.slice(2)} ${name}s`;
  if (/^(\d+)-(\d+)$/.test(named)) { const [, a, b] = named.match(/^(\d+)-(\d+)$/); return `${name}s ${a} through ${b}`; }
  if (/^(\d+)(,\d+)*$/.test(named)) return `${name}${named.includes(',') ? 's' : ''} ${named}`;
  return `${name} = ${named}`;
}
export function cronExplain({ expr }) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) { const e = new Error('cron needs exactly 5 fields: min hour dom month dow'); e.code = 'invalid_param'; throw e; }
  const [mi, h, dom, mon, dow] = parts;
  return { expr: parts.join(' '),
    human: `At ${fieldDesc(mi, 'minute')}, ${fieldDesc(h, 'hour')}, ${fieldDesc(dom, 'day of month')}, ${fieldDesc(mon, 'month', CRON.month)}, ${fieldDesc(dow, 'day of week', CRON.dow)}`.replace(/minute[s]? (\d+)/, 'minute $1').toLowerCase().replace(/^at /, 'At ') };
}

/* --- config generators --- */
export function dockerfileGen({ base, port, cmd, workdir }) {
  const b = String(base || 'node:20-alpine');
  const p = parseInt(port) || 3000;
  const c = Array.isArray(cmd) && cmd.length ? cmd : ['node', 'server.js'];
  return { dockerfile:
`FROM ${b}
WORKDIR ${workdir || '/app'}
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE ${p}
CMD ${JSON.stringify(c)}` };
}
export function k8sGen({ kind, name, image, replicas, port }) {
  const k = String(kind || 'deployment').toLowerCase();
  if (!['deployment', 'service'].includes(k)) { const e = new Error('kind must be deployment or service'); e.code = 'invalid_param'; throw e; }
  const n = String(name || 'app').replace(/[^a-z0-9-]/g, '');
  const img = String(image || 'nginx:latest');
  const rep = Math.min(50, Math.max(1, parseInt(replicas) || 2));
  const po = parseInt(port) || 80;
  if (k === 'service') return { yaml:
`apiVersion: v1
kind: Service
metadata:
  name: ${n}
spec:
  selector:
    app: ${n}
  ports:
    - port: ${po}
      targetPort: ${po}
  type: ClusterIP` };
  return { yaml:
`apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${n}
spec:
  replicas: ${rep}
  selector:
    matchLabels:
      app: ${n}
  template:
    metadata:
      labels:
        app: ${n}
    spec:
      containers:
        - name: ${n}
          image: ${img}
          ports:
            - containerPort: ${po}
          resources:
            requests: { cpu: "100m", memory: "128Mi" }
            limits: { cpu: "500m", memory: "512Mi" }` };
}
export function ciGen({ provider, node_version, steps }) {
  const p = String(provider || 'gha').toLowerCase();
  if (!['gha', 'jenkins'].includes(p)) { const e = new Error('provider must be gha or jenkins'); e.code = 'invalid_param'; throw e; }
  const nv = String(node_version || '20');
  const st = Array.isArray(steps) && steps.length ? steps : ['npm ci', 'npm test'];
  if (p === 'jenkins') return { config:
`pipeline {
  agent any
  tools { nodejs '${nv}' }
  stages {
    stage('Build') { steps { sh 'npm ci' } }
    stage('Test') { steps { sh '${st.join("' } }\n    stage('Next') { steps { sh '").replace(/'/g, "\\'")}' } }
  }
}` };
  return { config:
`name: CI
on: [push, pull_request]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '${nv}' }
${st.map(s => `      - run: ${s}`).join('\n')}` };
}
