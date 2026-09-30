/* Spec-coverage check: every implemented route must be documented in openapi.json.
 * If you add a route, add it here AND in openapi.json — CI fails otherwise.
 */
const BASE = process.env.BASE || 'http://localhost:8787';
const EXPECTED = [
  ['get', '/health'], ['get', '/v1/status'], ['get', '/v1/openapi.json'],
  ['post', '/v1/calc/gst-interest'], ['post', '/v1/calc/emi'], ['post', '/v1/calc/gratuity'],
  ['post', '/v1/calc/salary'], ['post', '/v1/calc/pf'], ['post', '/v1/calc/esi'],
  ['post', '/v1/calc/break-even'], ['post', '/v1/calc/pricing'], ['post', '/v1/calc/discount'],
  ['post', '/v1/calc/overtime'], ['post', '/v1/calc/retention'], ['post', '/v1/calc/working-capital'],
  ['post', '/v1/calc/cash-survival'],
  ['post', '/v1/tools/word-count'], ['post', '/v1/tools/json-format'], ['post', '/v1/tools/password'],
  ['post', '/v1/tools/qr'], ['post', '/v1/tools/cron-explain'], ['post', '/v1/tools/dockerfile'],
  ['post', '/v1/tools/k8s'], ['post', '/v1/tools/ci'],
  ['post', '/v1/tools/image/resize'], ['post', '/v1/tools/image/convert'],
  ['post', '/v1/tools/pdf/merge'], ['post', '/v1/tools/pdf/split'], ['post', '/v1/tools/pdf/compress'],
  ['post', '/v1/jobs'], ['get', '/v1/jobs/{id}'], ['get', '/v1/jobs/{id}/result'],
  ['post', '/v1/admin/keys'], ['get', '/v1/admin/keys'],
  ['post', '/v1/admin/keys/{id}/revoke'], ['post', '/v1/admin/keys/{id}/rotate'],
  ['get', '/v1/admin/keys/{id}/usage'], ['get', '/v1/admin/keys/{id}/audit'],
  ['post', '/v1/billing/checkout'],
  ['post', '/v1/billing/webhook/stripe'], ['post', '/v1/billing/webhook/razorpay'],
  ['post', '/v1/billing/webhook/simulate'],
];
const spec = await (await fetch(BASE + '/v1/openapi.json')).json();
let missing = [];
for (const [m, p] of EXPECTED) {
  const ops = spec.paths?.[p];
  if (!ops || !ops[m]) missing.push(`${m.toUpperCase()} ${p}`);
}
if (missing.length) { console.error('UNDOCUMENTED ROUTES:\n - ' + missing.join('\n - ')); process.exit(1); }
console.log(`spec coverage OK: ${EXPECTED.length}/${EXPECTED.length} routes documented`);
