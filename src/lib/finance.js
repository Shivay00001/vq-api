/* VisionQuantech API — finance computation library.
 * Formulas ported 1:1 from the tested VisionQuantech Business Suite web apps
 * (see vq-business-suite apps directory, each app.js), each verified by
 * the suite's own node test runs. Statutory constants stamped Sep 2026.
 * Pure functions, no I/O — safe to run in Workers.
 */
'use strict';

const r2 = (n) => Math.round((n + 1e-9) * 100) / 100;
const num = (v, name) => {
  const n = Number(v);
  if (!isFinite(n)) throw Object.assign(new Error(`${name} must be a number`), { code: 'invalid_param' });
  return n;
};
const pos = (v, name) => { const n = num(v, name); if (!(n > 0)) throw Object.assign(new Error(`${name} must be > 0`), { code: 'invalid_param' }); return n; };

/* ---------------- GST interest & late fee (Sec 50 / Sec 47 CGST) ---------------- */
const GST = {
  RATE_DELAYED: 18, RATE_WRONG_ITC: 24, RATE_REVERSAL: 18,
  FEE_DAY: 50, FEE_DAY_NIL: 20,
  CAP_NIL: 500, CAP_1_5CR: 2000, CAP_5CR: 5000, CAP_ABOVE: 10000,
};
function daysBetween(dueISO, payISO) {
  const d = new Date(String(dueISO).slice(0, 10) + 'T00:00:00');
  const p = new Date(String(payISO).slice(0, 10) + 'T00:00:00');
  if (isNaN(d) || isNaN(p)) throw Object.assign(new Error('due_date/pay_date must be YYYY-MM-DD'), { code: 'invalid_param' });
  return Math.max(0, Math.floor((p - d) / 86400000));
}
function gstInterest({ type, amount, due_date, pay_date, is_nil_return, turnover }) {
  const amt = pos(amount, 'amount');
  const days = daysBetween(due_date, pay_date);
  const rate = type === 'itc-wrong' ? GST.RATE_WRONG_ITC : GST.RATE_DELAYED; // itc-reversal also 18
  const interest = is_nil_return ? 0 : r2(amt * (rate / 100) / 365 * days);
  const feeDay = is_nil_return ? GST.FEE_DAY_NIL : GST.FEE_DAY;
  let cap;
  if (is_nil_return) cap = GST.CAP_NIL;
  else { const t = Number(turnover) || 0; cap = !(t > 0) ? GST.CAP_5CR : t <= 15000000 ? GST.CAP_1_5CR : t <= 50000000 ? GST.CAP_5CR : GST.CAP_ABOVE; }
  const late_fee = Math.min(days * feeDay, cap);
  return { type, rate_pct: rate, days_delayed: days, interest: r2(interest), late_fee, total: r2(interest + late_fee),
    basis: 'Sec 50 CGST (18% delayed / 24% wrong ITC); Sec 47 late fee ₹50/day (₹20 nil) with statutory caps' };
}

/* ---------------- EMI + amortization (reducing balance) ---------------- */
function emiCalc({ principal, annual_rate_pct, months, prepayments, mode, schedule }) {
  const P = pos(principal, 'principal'), n = Math.round(pos(months, 'months'));
  const r = num(annual_rate_pct, 'annual_rate_pct') / 1200;
  if (r < 0) throw Object.assign(new Error('annual_rate_pct must be >= 0'), { code: 'invalid_param' });
  const E = r === 0 ? P / n : (P * r * Math.pow(1 + r, n)) / (Math.pow(1 + r, n) - 1);
  if (!isFinite(E) || E <= 0) throw Object.assign(new Error('cannot compute EMI for these inputs'), { code: 'unprocessable' });
  const pre = {};
  (prepayments || []).forEach(p => { const m = Math.round(num(p.month, 'prepayments[].month')), a = num(p.amount, 'prepayments[].amount'); if (m >= 1 && a > 0) pre[m] = (pre[m] || 0) + a; });
  const m2 = mode === 'emi' ? 'emi' : 'tenure';
  let bal = P, mon = 0, totI = 0, totP = 0, e = E;
  const rows = [];
  while (bal > 0.005 && mon < 1200) {
    mon++; const interest = bal * r; let princ = e - interest;
    let extra = pre[mon] || 0;
    if (extra > Math.max(0, bal - princ)) extra = Math.max(0, bal - princ);
    princ += extra; if (princ > bal) princ = bal;
    const paid = princ + interest; bal = Math.max(0, bal - princ);
    totI += interest; totP += paid;
    if (schedule) rows.push({ month: mon, emi: r2(paid), principal: r2(princ), interest: r2(interest), balance: r2(bal), extra: r2(extra) });
    if (m2 === 'emi' && extra > 0 && n - mon > 0 && bal > 0.005) e = (bal * r * Math.pow(1 + r, n - mon)) / (Math.pow(1 + r, n - mon) - 1);
  }
  return { emi: r2(E), months: n, total_interest: r2(totI), total_payable: r2(totP),
    months_taken: mon, ...(schedule ? { schedule: rows.slice(0, 360) } : {}) };
}

/* ---------------- Gratuity (Payment of Gratuity Act 1972) ---------------- */
function gratuity({ monthly_salary, years, extra_months, covered, special_case }) {
  const sal = pos(monthly_salary, 'monthly_salary');
  const y = num(years, 'years'), mo = num(extra_months || 0, 'extra_months');
  if (!Number.isInteger(y) || y < 0 || y > 60 || !Number.isInteger(mo) || mo < 0 || mo > 11)
    throw Object.assign(new Error('years 0-60 integer; extra_months 0-11 integer'), { code: 'invalid_param' });
  const billable = y + (mo > 6 ? 1 : 0);
  let eligible = true, reason = '5+ years of continuous service completed.';
  if (!covered) { eligible = false; reason = 'Establishment not covered (needs 10+ employees).'; }
  else if (special_case) { eligible = true; reason = 'Payable on death/disablement regardless of tenure.'; }
  else if (billable < 5) { eligible = false; reason = `Only ${billable} billable year(s) — 5 years required.`; }
  const raw = (sal * 15 * billable) / 26;
  const capped = Math.min(raw, 2000000);
  return { billable_years: billable, eligible, reason, gratuity: r2(capped), capped_at_20lakh: raw > 2000000,
    formula: '(monthly_salary × 15 × billable_years) ÷ 26' };
}

/* ---------------- Salary / payroll (India, FY 2025-26) ---------------- */
const PF_CEILING = 25000, PF_CEILING_BEFORE = 15000, PF_CUTOFF = '2026-09-17';
const ESI_CEILING = 21000, ESI_EE = 0.0075, ESI_ER = 0.0325;
const PT = { // monthly professional tax
  MH: s => s <= 7500 ? 0 : s <= 10000 ? 175 : 200, KA: s => s <= 15000 ? 0 : 200,
  WB: s => s <= 8500 ? 0 : s <= 10000 ? 90 : s <= 15000 ? 110 : s <= 25000 ? 130 : s <= 40000 ? 150 : 200,
  TN: s => s <= 21000 ? 0 : s <= 30000 ? 23 : s <= 45000 ? 53 : s <= 60000 ? 115 : s <= 75000 ? 171 : 208,
  GJ: s => s <= 6000 ? 0 : s <= 9000 ? 80 : s <= 12000 ? 150 : 200,
  AP: s => s <= 15000 ? 0 : s <= 20000 ? 150 : 200, TG: s => s <= 15000 ? 0 : s <= 20000 ? 150 : 200,
  KL: s => s <= 12000 ? 0 : s <= 18000 ? 20 : s <= 24000 ? 30 : s <= 30000 ? 50 : s <= 36000 ? 75 : s <= 42000 ? 100 : s <= 48000 ? 125 : s <= 54000 ? 167 : 208,
  DL: () => 0, OTHER: () => 0,
};
const NEW_SLABS = [[400000, 0], [800000, .05], [1200000, .10], [1600000, .15], [2000000, .20], [2400000, .25], [Infinity, .30]];
const OLD_SLABS = [[250000, 0], [500000, .05], [1000000, .20], [Infinity, .30]];
function slabTax(t, slabs) { let x = 0, prev = 0; for (const [cap, rt] of slabs) { if (t > prev) x += (Math.min(t, cap) - prev) * rt; if (t <= cap) break; prev = cap; } return x; }
function incomeTax(taxable, regime) {
  taxable = Math.max(0, taxable);
  if (regime === 'old') {
    let tax = slabTax(taxable, OLD_SLABS);
    const rebate = taxable <= 500000 ? tax : 0; tax -= rebate;
    const sur = tax * (taxable > 5e7 ? .37 : taxable > 2e7 ? .25 : taxable > 1e7 ? .15 : taxable > 5e6 ? .10 : 0);
    const cess = (tax + sur) * .04;
    return { regime: 'old', tax: r2(tax + sur + cess), rebate: r2(rebate) };
  }
  let tax = slabTax(taxable, NEW_SLABS), rebate = 0;
  if (taxable <= 1200000) { rebate = tax; tax = 0; }
  else { const ex = taxable - 1200000; if (tax > ex) tax = ex; } // marginal relief
  const sur = tax * (taxable > 2e7 ? .25 : taxable > 1e7 ? .15 : taxable > 5e6 ? .10 : 0);
  const cess = (tax + sur) * .04;
  return { regime: 'new', tax: r2(tax + sur + cess), rebate: r2(rebate) };
}
function salary({ ctc_annual, basic_pct, state, regime }) {
  const ctc = pos(ctc_annual, 'ctc_annual');
  const basicPct = basic_pct == null ? 50 : num(basic_pct, 'basic_pct');
  const st = String(state || 'OTHER').toUpperCase();
  if (!PT[st]) { const e = new Error(`unknown state "${state}" — use one of ${Object.keys(PT).join(', ')}`); e.code = 'invalid_param'; throw e; }
  const monthly = ctc / 12, basic = monthly * basicPct / 100;
  const ceil = PF_CEILING; // current law (w.e.f. 17-09-2026, S.O. 5109(E))
  const pfWage = Math.min(basic, ceil);
  const pf_ee = r2(pfWage * 0.12), pf_er = r2(pfWage * 0.12);
  const eps = Math.round(pfWage * 0.0833), epf_er = Math.round(pfWage * 0.12) - eps;
  const esiBase = monthly <= ESI_CEILING ? monthly : 0;
  const esi_ee = r2(esiBase * ESI_EE), esi_er = r2(esiBase * ESI_ER);
  const pt = (PT[st] || PT.OTHER)(monthly);
  const grossAnnual = ctc; // taxable approx = ctc - employer PF - std deduction
  const taxableNew = Math.max(0, grossAnnual - pf_er * 12 - 75000);
  const taxableOld = Math.max(0, grossAnnual - pf_er * 12 - 50000);
  const taxNew = incomeTax(taxableNew, 'new'), taxOld = incomeTax(taxableOld, 'old');
  const chosen = (regime || 'new').toLowerCase() === 'old' ? taxOld : taxNew;
  const monthlyTax = r2(chosen.tax / 12);
  const inHand = r2(monthly - pf_ee - esi_ee - pt - monthlyTax);
  return { ctc_annual: ctc, monthly_ctc: r2(monthly), basic_monthly: r2(basic),
    pf: { employee: pf_ee, employer: pf_er, eps, epf_employer: epf_er, wage_ceiling: ceil, note: '12% of Basic+DA up to ₹25,000/mo (w.e.f. 17-09-2026)' },
    esi: { employee: esi_ee, employer: esi_er, covered: esiBase > 0, wage_ceiling: ESI_CEILING },
    professional_tax_monthly: pt, state: st,
    income_tax: { ...chosen, annual: chosen.tax, monthly: monthlyTax, taxable_income: r2(chosen.regime === 'old' ? taxableOld : taxableNew) },
    in_hand_monthly: inHand,
    disclaimer: 'Estimate for FY 2025-26; confirm with your CA before payroll filing.' };
}
function pfCheck({ monthly_wage, as_of_date }) {
  const w = pos(monthly_wage, 'monthly_wage');
  const before = as_of_date && String(as_of_date).slice(0, 10) < PF_CUTOFF;
  const ceil = before ? PF_CEILING_BEFORE : PF_CEILING;
  const capped = Math.min(w, ceil);
  const eps = Math.round(capped * 0.0833);
  return { wage: w, ceiling: ceil, ceiling_note: before ? '₹15,000 (before 17-09-2026)' : '₹25,000 (w.e.f. 17-09-2026, S.O. 5109(E))',
    capped_wage: capped, employee_12pct: r2(capped * 0.12),
    employer: { eps: eps, epf: Math.round(capped * 0.12) - eps, total: Math.round(capped * 0.12) },
    edli_0_5pct: r2(capped * 0.005), admin_0_5pct: r2(capped * 0.005) };
}
function esiCheck({ monthly_wage }) {
  const w = pos(monthly_wage, 'monthly_wage');
  if (w > ESI_CEILING) return { wage: w, covered: false, note: `Exceeds ₹${ESI_CEILING.toLocaleString('en-IN')} ceiling — exits ESI coverage.` };
  return { wage: w, covered: true, employee_0_75pct: r2(w * ESI_EE), employer_3_25pct: r2(w * ESI_ER), ceiling: ESI_CEILING };
}

/* ---------------- Business math ---------------- */
function breakEven({ fixed_cost, price_per_unit, variable_cost_per_unit }) {
  const f = pos(fixed_cost, 'fixed_cost'), p = pos(price_per_unit, 'price_per_unit'), v = num(variable_cost_per_unit, 'variable_cost_per_unit');
  if (v >= p) throw Object.assign(new Error('variable_cost_per_unit must be < price_per_unit'), { code: 'unprocessable' });
  const units = f / (p - v);
  return { break_even_units: r2(units), break_even_revenue: r2(units * p), contribution_per_unit: r2(p - v) };
}
function pricing({ unit_cost, margin_pct, markup_pct }) {
  const c = pos(unit_cost, 'unit_cost');
  if (margin_pct != null) { const m = num(margin_pct, 'margin_pct') / 100; if (!(m > 0 && m < 1)) throw Object.assign(new Error('margin_pct in (0,100)'), { code: 'invalid_param' });
    const price = c / (1 - m); return { price: r2(price), margin_pct: m * 100, markup_pct: r2((price - c) / c * 100) }; }
  if (markup_pct != null) { const u = num(markup_pct, 'markup_pct') / 100; if (!(u > 0)) throw Object.assign(new Error('markup_pct > 0'), { code: 'invalid_param' });
    const price = c * (1 + u); return { price: r2(price), markup_pct: u * 100, margin_pct: r2((price - c) / price * 100) }; }
  throw Object.assign(new Error('provide margin_pct or markup_pct'), { code: 'invalid_param' });
}
function discountImpact({ price, discount_pct, units, cost_per_unit }) {
  const p = pos(price, 'price'), d = num(discount_pct, 'discount_pct'), u = pos(units, 'units');
  if (d < 0 || d > 100) throw Object.assign(new Error('discount_pct 0-100'), { code: 'invalid_param' });
  const dp = p * (1 - d / 100), revBefore = p * u, revAfter = dp * u;
  const out = { discounted_price: r2(dp), revenue_before: r2(revBefore), revenue_after: r2(revAfter), revenue_lost: r2(revBefore - revAfter) };
  if (cost_per_unit != null) { const c = num(cost_per_unit, 'cost_per_unit'); out.profit_before = r2((p - c) * u); out.profit_after = r2((dp - c) * u); out.profit_lost = r2(out.profit_before - out.profit_after); }
  return out;
}
function overtime({ monthly_salary, ot_hours, ot_multiplier }) {
  const s = pos(monthly_salary, 'monthly_salary'), h = num(ot_hours, 'ot_hours'), m = ot_multiplier == null ? 2 : num(ot_multiplier, 'ot_multiplier');
  if (h < 0 || m <= 0) throw Object.assign(new Error('ot_hours >= 0, ot_multiplier > 0'), { code: 'invalid_param' });
  const hourly = s / 208; // 26 days × 8 hrs
  return { hourly_rate: r2(hourly), ot_hours: h, multiplier: m, ot_pay: r2(h * hourly * m) };
}
function retention({ contract_value, retention_pct, released }) {
  const v = pos(contract_value, 'contract_value'), pct = num(retention_pct, 'retention_pct');
  if (pct < 0 || pct > 100) throw Object.assign(new Error('retention_pct 0-100'), { code: 'invalid_param' });
  const held = v * pct / 100, rel = Math.min(num(released || 0, 'released'), held);
  return { retention_held: r2(held), released: r2(rel), balance_held: r2(held - rel) };
}
function workingCapital({ current_assets, current_liabilities, inventory_days, receivable_days, payable_days }) {
  const ca = pos(current_assets, 'current_assets'), cl = pos(current_liabilities, 'current_liabilities');
  const out = { working_capital: r2(ca - cl), current_ratio: r2(ca / cl) };
  if (inventory_days != null && receivable_days != null && payable_days != null)
    out.cash_conversion_cycle_days = r2(num(inventory_days, 'inventory_days') + num(receivable_days, 'receivable_days') - num(payable_days, 'payable_days'));
  return out;
}
function cashSurvival({ cash_in_hand, monthly_burn }) {
  const c = num(cash_in_hand, 'cash_in_hand'), b = pos(monthly_burn, 'monthly_burn');
  if (c < 0) throw Object.assign(new Error('cash_in_hand >= 0'), { code: 'invalid_param' });
  return { cash_in_hand: c, monthly_burn: b, survival_days: Math.floor(c / b * 30), survival_months: r2(c / b) };
}

export const Finance = {
  gstInterest, emiCalc, gratuity, salary, pfCheck, esiCheck,
  breakEven, pricing, discountImpact, overtime, retention, workingCapital, cashSurvival,
};
