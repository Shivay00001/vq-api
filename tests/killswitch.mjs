/* Kill-switch test — run against a worker started with API_KILL_SWITCH=1. */
const BASE = process.env.BASE || 'http://localhost:8788';
let fail = 0;
const h = await (await fetch(BASE + '/health')).json().catch(() => null);
console.log('health:', h && h.ok === true ? 'PASS (200, still alive)' : 'FAIL');
if (!(h && h.ok === true)) fail++;
const r = await fetch(BASE + '/v1/status');
const j = await r.json().catch(() => ({}));
console.log('authed path:', r.status === 503 && j.error?.code === 'killed' ? 'PASS (503 killed)' : `FAIL (${r.status})`);
if (!(r.status === 503 && j.error?.code === 'killed')) fail++;
process.exit(fail ? 1 : 0);
