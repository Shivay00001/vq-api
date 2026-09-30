/* POST /v1/calc/{tool} — synchronous JSON calculators. */
import { Finance } from '../lib/finance.js';
import { err, json } from '../index.js';

const TOOLS = {
  'gst-interest': { fn: Finance.gstInterest, fields: ['type', 'amount', 'due_date', 'pay_date', 'is_nil_return', 'turnover'] },
  'emi': { fn: Finance.emiCalc, fields: ['principal', 'annual_rate_pct', 'months', 'prepayments', 'mode', 'schedule'] },
  'gratuity': { fn: Finance.gratuity, fields: ['monthly_salary', 'years', 'extra_months', 'covered', 'special_case'] },
  'salary': { fn: Finance.salary, fields: ['ctc_annual', 'basic_pct', 'state', 'regime'] },
  'pf': { fn: Finance.pfCheck, fields: ['monthly_wage', 'as_of_date'] },
  'esi': { fn: Finance.esiCheck, fields: ['monthly_wage'] },
  'break-even': { fn: Finance.breakEven, fields: ['fixed_cost', 'price_per_unit', 'variable_cost_per_unit'] },
  'pricing': { fn: Finance.pricing, fields: ['unit_cost', 'margin_pct', 'markup_pct'] },
  'discount': { fn: Finance.discountImpact, fields: ['price', 'discount_pct', 'units', 'cost_per_unit'] },
  'overtime': { fn: Finance.overtime, fields: ['monthly_salary', 'ot_hours', 'ot_multiplier'] },
  'retention': { fn: Finance.retention, fields: ['contract_value', 'retention_pct', 'released'] },
  'working-capital': { fn: Finance.workingCapital, fields: ['current_assets', 'current_liabilities', 'inventory_days', 'receivable_days', 'payable_days'] },
  'cash-survival': { fn: Finance.cashSurvival, fields: ['cash_in_hand', 'monthly_burn'] },
};

export function calcToolList() { return Object.keys(TOOLS); }

export async function handleCalc(req, env, key) {
  const tool = new URL(req.url).pathname.replace('/v1/calc/', '').split('/')[0];
  const spec = TOOLS[tool];
  if (!spec) return err('not_found', `Unknown calculator. Available: ${Object.keys(TOOLS).join(', ')}`, 404);
  if (req.method !== 'POST') return err('invalid_param', 'Use POST with a JSON body.', 400);
  let body;
  try { body = req._rawBody ? JSON.parse(new TextDecoder().decode(req._rawBody)) : await req.json(); }
  catch { return err('invalid_param', 'Body must be valid JSON.', 400); }
  try {
    const result = spec.fn(body || {});
    result._status = 200;
    result.tool = tool;
    return result;
  } catch (e) {
    const status = e.code === 'invalid_param' ? 400 : 422;
    return err(e.code || 'unprocessable', e.message, status);
  }
}
