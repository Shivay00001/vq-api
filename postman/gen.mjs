// Generates the Postman collection from openapi.json (single source of truth).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(fs.readFileSync(path.join(here, '..', 'openapi.json'), 'utf8'));

const SAMPLE = {
  '/v1/calc/gst-interest': { type: 'delayed', amount: 100000, due_date: '2026-08-20', pay_date: '2026-09-19' },
  '/v1/calc/emi': { principal: 5000000, annual_rate_pct: 8.5, months: 240 },
  '/v1/calc/gratuity': { monthly_salary: 30000, years: 5 },
  '/v1/calc/salary': { ctc_annual: 1200000, state: 'MH' },
  '/v1/calc/pf': { monthly_wage: 30000 },
  '/v1/calc/esi': { monthly_wage: 18000 },
  '/v1/calc/break-even': { fixed_cost: 500000, price_per_unit: 500, variable_cost_per_unit: 300 },
  '/v1/calc/pricing': { unit_cost: 100, margin_pct: 40 },
  '/v1/calc/discount': { price: 500, discount_pct: 10, units: 1000, cost_per_unit: 300 },
  '/v1/calc/overtime': { monthly_salary: 30000, ot_hours: 20 },
  '/v1/calc/retention': { contract_value: 1000000, retention_pct: 10 },
  '/v1/calc/working-capital': { current_assets: 2000000, current_liabilities: 800000 },
  '/v1/calc/cash-survival': { cash_in_hand: 5000000, monthly_burn: 1000000 },
  '/v1/tools/word-count': { text: 'Hello world, this is a test.' },
  '/v1/tools/json-format': { json: '{"a":1,"b":[2,3]}', style: 'pretty' },
  '/v1/tools/password': { length: 16, count: 3 },
  '/v1/tools/qr': { data: 'https://visionquantech.com' },
  '/v1/tools/cron-explain': { expr: '*/15 9-17 * * MON-FRI' },
  '/v1/tools/dockerfile': { base: 'node:20-alpine', port: 3000, cmd: ['node', 'app.js'] },
  '/v1/tools/k8s': { kind: 'deployment', name: 'web', image: 'myapp:1.0', replicas: 2 },
  '/v1/tools/ci': { provider: 'gha', node_version: '20' },
};

const items = [];
for (const [path, ops] of Object.entries(spec.paths)) {
  for (const [method, op] of Object.entries(ops)) {
    const isMultipart = op.requestBody?.content?.['multipart/form-data'];
    const sample = SAMPLE[path];
    const req = {
      name: `${method.toUpperCase()} ${path}`,
      request: {
        method: method.toUpperCase(),
        header: [
          { key: 'Authorization', value: 'Bearer {{vq_api_key}}' },
          ...(method === 'post' && (sample || !isMultipart)
            ? [{ key: 'Content-Type', value: 'application/json' }, { key: 'Idempotency-Key', value: '{{$guid}}' }] : []),
        ],
        url: { raw: `{{base_url}}${path}`, host: ['{{base_url}}'], path: path.split('/').filter(Boolean) },
        ...(sample ? { body: { mode: 'raw', raw: JSON.stringify(sample, null, 2) } } : {}),
      },
    };
    items.push(req);
  }
}

const col = {
  info: { name: 'VisionQuantech API', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    description: 'Generated from openapi.json. Set vq_api_key + base_url variables.' },
  variable: [
    { key: 'base_url', value: 'https://api.visionquantech.com' },
    { key: 'vq_api_key', value: 'vq_test_YOUR_KEY' },
  ],
  item: items,
};
fs.writeFileSync(path.join(here, 'visionquantech-api.postman_collection.json'), JSON.stringify(col, null, 2));
console.log('wrote', items.length, 'requests');
