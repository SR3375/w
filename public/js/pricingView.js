// Step 2, "Pricing": sale details, the plan and phone tables, and the quote slip.
import { $, el, blank, num, fmt, money, norm, words } from './util.js';
import { KNOWN, canon, sameCarrier } from './catalog.js';
import { quote as runQuote, ACT } from './quote.js';
import { state, saveSel } from './store.js';

export const quote = (over = {}) => runQuote(state, { ...state.sel, ...over });

/* ---------- selection and filters ---------- */
export function carriers() {
  const set = new Map();
  for (const k of ['plans', 'devices']) for (const i of state[k]) if (i.carrier) set.set(norm(canon(i.carrier)), canon(i.carrier));
  const rank = c => (KNOWN.indexOf(c) + 99) % 99;      // known carriers first, in their usual order
  return [...set.values()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}
const carrierPlans = () => state.plans.filter(p => sameCarrier(p.carrier, state.sel.carrier));
const planVisible = p =>
  (!state.f.tx || p.transaction === state.f.tx) &&
  (!state.f.hw || (state.f.hw === 'byod' ? /byod/i : /fin/i).test(p.hardware)) &&
  (!state.f.line || p.line === state.f.line);

/** Point the plan filters at the rows that fit the sale (new vs upgrade, phone vs BYOD, first vs extra line). */
export function syncFilters() {
  const ps = carrierPlans(), txs = [...new Set(ps.map(p => p.transaction).filter(Boolean))];
  const hasDev = !!state.devices.find(d => d.id === state.sel.device);
  state.f.tx = (state.sel.act === 'HUP' ? txs.find(t => /hup|upgrade/i.test(t)) : txs.find(t => /^nac/i.test(t))) || '';
  const inTx = ps.filter(p => !state.f.tx || p.transaction === state.f.tx);
  state.f.hw = inTx.some(p => (hasDev ? /fin/i : /byod/i).test(p.hardware)) ? (hasDev ? 'fin' : 'byod') : '';
  const lines = [...new Set(inTx.map(p => p.line).filter(Boolean))];
  state.f.line = (state.sel.act === 'AAL' ? lines.find(l => /2/.test(l)) : lines.find(l => /primary|single/i.test(l))) || '';
  // If the chosen plan fell out of view, swap to the same plan name under the new filters.
  const cur = state.plans.find(p => p.id === state.sel.plan);
  if (cur && !(sameCarrier(cur.carrier, state.sel.carrier) && planVisible(cur))) {
    const swap = ps.filter(planVisible).filter(p => p.name === cur.name)
      .sort((a, b) => (b.hardware === cur.hardware) - (a.hardware === cur.hardware) || num(a.monthlyPrice) - num(b.monthlyPrice))[0];
    state.sel.plan = swap ? swap.id : null;
  }
}
export function select(patch, resync = true) {
  Object.assign(state.sel, patch);
  if (resync) syncFilters();
  saveSel(); renderPricing();
}
function fillSelect(sel, values, cur) {
  sel.textContent = '';
  sel.append(el('option', { value: '', text: 'All' }));
  for (const v of values) sel.append(el('option', { value: v, text: v }));
  sel.value = values.includes(cur) ? cur : '';
}

/* ---------- tables ---------- */
function renderPlans() {
  const ps = carrierPlans(), host = $('pick-plans');
  fillSelect($('f-tx'), [...new Set(ps.map(p => p.transaction).filter(Boolean))], state.f.tx);
  fillSelect($('f-line'), [...new Set(ps.filter(p => !state.f.tx || p.transaction === state.f.tx).map(p => p.line).filter(Boolean))], state.f.line);
  $('f-hw').value = state.f.hw;
  host.textContent = '';
  const shown = ps.filter(planVisible).sort((a, b) => num(a.monthlyPrice) - num(b.monthlyPrice));
  if (!state.plans.length) return host.append(el('div', { class: 'empty' }, 'No plans yet. ', el('a', { href: '#import', text: 'Import a carrier plan sheet' }), ' to fill this table.'));
  if (!ps.length) return host.append(el('div', { class: 'empty' }, `No plan sheet imported for ${state.sel.carrier} yet. Phone prices and device points still work. `, el('a', { href: '#import', text: 'Import its plan sheet' }), ' to add plan prices and plan-based offers.'));
  if (!shown.length) return host.append(el('div', { class: 'empty', text: 'No plans match these filters. Set a filter back to All.' }));
  const tb = el('tbody');
  for (const p of shown) {
    const on = p.id === state.sel.plan;
    tb.append(el('tr', { class: on ? 'on' : '', onclick: () => select({ plan: on ? null : p.id }, false) },
      el('td', null, el('input', { type: 'radio', name: 'plan', 'aria-label': `${p.name} ${p.hardware} ${p.line}`, checked: on })),
      el('td', { class: 'wrapok' }, el('b', { text: p.name }), el('div', { class: 'muted small', text: [p.features, p.notes].filter(Boolean).join(' · ') })),
      el('td', { text: p.data }), el('td', { text: p.hardware }), el('td', { text: [p.transaction, p.line].filter(Boolean).join(' · ') }),
      el('td', { class: 'r price num' }, money(num(p.monthlyPrice)),
        !blank(p.regularPrice) && num(p.regularPrice) !== num(p.monthlyPrice) ? el('div', { class: 'muted small', style: 'font-weight:400', text: `reg. ${money(num(p.regularPrice))}` }) : null)));
  }
  const head = el('tr', null, el('th'), el('th', { text: 'Plan' }), el('th', { text: 'Data' }), el('th', { text: 'Hardware' }), el('th', { text: 'Type · line' }), el('th', { class: 'r', text: 'Net $/mo' }));
  host.append(el('div', { class: 'scroll' }, el('table', { class: 'pick' }, el('thead', null, head), tb)));
}

function renderDevices() {
  const host = $('pick-devices');
  host.textContent = '';
  const ds = state.devices.filter(d => sameCarrier(d.carrier, state.sel.carrier)), q = words(state.search);
  if (!state.devices.length) return host.append(el('div', { class: 'empty' }, 'No phones yet. ', el('a', { href: '#import', text: 'Paste the Digital Price Sheet' }), ' to fill this table.'));
  if (!ds.length) return host.append(el('div', { class: 'empty', text: `No phones on the price sheet for ${state.sel.carrier}.` }));
  const tb = el('tbody'), dash = v => blank(v) ? '—' : money(num(v));
  tb.append(el('tr', { class: !state.sel.device ? 'on' : '', onclick: () => select({ device: null }) },
    el('td', null, el('input', { type: 'radio', name: 'device', 'aria-label': 'No phone', checked: !state.sel.device })),
    el('td', { colspan: 6 }, el('b', { text: 'No phone' }), el('span', { class: 'muted', text: '  · customer brings their own (BYOD)' }))));
  for (const d of ds.filter(d => q.every(t => d.name.toLowerCase().includes(t))).sort((a, b) => a.name.localeCompare(b.name))) {
    const on = d.id === state.sel.device;
    tb.append(el('tr', { class: on ? 'on' : '', onclick: () => select({ device: d.id }) },
      el('td', null, el('input', { type: 'radio', name: 'device', 'aria-label': d.name, checked: on })),
      el('td', null, el('b', { text: d.name })), el('td', { class: 'r num', text: dash(d.msrp) }), el('td', { class: 'r num', text: dash(d.price) }),
      el('td', { class: 'r price num', text: dash(d.finMonthly) }),
      el('td', { class: 'r num' }, dash(d.finDefMonthly), blank(d.defPmt) ? null : el('div', { class: 'muted small', text: `${money(num(d.defPmt))} deferred` })),
      el('td', { class: 'r num' }, el('span', { class: num(d.pco) ? 'pill' : 'muted', text: fmt(num(d.pco)) }), ' / ', el('span', { class: num(d.bpo) ? 'pill' : 'muted', text: fmt(num(d.bpo)) }))));
  }
  const head = el('tr', null, el('th'), el('th', { text: 'Phone' }), el('th', { class: 'r', text: 'MSRP' }), el('th', { class: 'r', text: 'Price' }), el('th', { class: 'r', text: 'Fin. $/mo' }), el('th', { class: 'r', text: 'With deferral' }), el('th', { class: 'r', text: 'PCO / BPO pts' }));
  host.append(el('div', { class: 'scroll' }, el('table', { class: 'pick' }, el('thead', null, head), tb)));
}

export function renderPricing() {
  // Keep the selection valid as lists change underneath it.
  const cs = carriers();
  if (!cs.some(c => sameCarrier(c, state.sel.carrier))) { state.sel.carrier = cs.find(c => state.plans.some(p => sameCarrier(p.carrier, c))) || cs[0] || ''; syncFilters(); }
  if (!state.plans.some(p => p.id === state.sel.plan)) state.sel.plan = null;
  const dv = state.devices.find(d => d.id === state.sel.device);
  if (!dv || !sameCarrier(dv.carrier, state.sel.carrier)) state.sel.device = null;

  const cc = $('carrier-chips');
  cc.textContent = '';
  if (!cs.length) cc.append(el('span', { class: 'muted small', text: 'Carriers appear here once plans or phones are imported.' }));
  for (const c of cs) {
    const on = sameCarrier(c, state.sel.carrier);
    cc.append(el('button', { class: 'chip' + (on ? ' sel' : ''), type: 'button', 'aria-pressed': String(on), text: c, onclick: () => select({ carrier: c, plan: null, device: null }) }));
  }
  for (const a of ['NAC', 'AAL', 'HUP']) $('act-' + a).checked = state.sel.act === a;
  $('region-bcab').checked = state.sel.region === 'bcab';
  $('region-other').checked = state.sel.region !== 'bcab';
  $('prog').value = state.sel.prog;
  $('trade').checked = !!state.sel.trade;
  renderPlans(); renderDevices(); renderSlip();
}

/* ---------- quote slip ---------- */
const SKU = /[A-Z]{6}\d{6}/g;
async function copy(text, btn, label) {
  let ok = true;
  try { await navigator.clipboard.writeText(text); } catch { ok = false; }
  btn.textContent = ok ? 'Copied' : 'Copy blocked here';
  setTimeout(() => { btn.textContent = label; }, 1400);
}
function offerRow(o, why) {
  const row = el('div', { class: 'of' + (why ? ' out' : '') },
    el('span', { class: 'nm' }, o.name || 'Offer', o.stack === 'perk' && !why ? el('span', { class: 'tag', style: 'margin-left:6px', text: 'Perk' }) : null),
    el('span', { class: 'pt', text: (o.pending && !why ? '+' : '') + fmt(num(o.points)) }));
  if (why) { row.append(el('span', { class: 'meta', text: why })); return row; }
  if (o.pending) row.append(el('span', { class: 'meta', text: "Credited later, not on today's receipt." }));
  if (o.sku) {   // each SKU code becomes a button that copies it
    const m = el('span', { class: 'meta' }, 'SKU ');
    let last = 0;
    for (const x of o.sku.matchAll(SKU)) {
      m.append(o.sku.slice(last, x.index), el('button', { class: 'code', type: 'button', title: 'Copy ' + x[0], text: x[0], onclick: e => copy(x[0], e.currentTarget, x[0]) }));
      last = x.index + x[0].length;
    }
    m.append(o.sku.slice(last));
    row.append(m);
  }
  if (o.coupon) row.append(el('span', { class: 'meta', text: 'Coupon: ' + o.coupon }));
  return row;
}
function renderSlip() {
  const q = quote(), L = $('slip-lines');
  L.textContent = '';
  $('slip-title').textContent = q.carrier ? `Quote · ${q.carrier}` : 'Quote';
  const ln = (a, b) => L.append(el('div', { class: 'ln' }, el('dt', { text: a }), el('span', { class: 'dots' }), el('dd', { text: b })));
  ln(q.plan ? `${q.plan.name} · ${q.plan.hardware}` : 'No plan chosen', q.plan ? money(num(q.plan.monthlyPrice)) : '—');
  ln(q.dev ? q.dev.name : 'No phone (BYOD)', q.dev ? (q.pay === 'out' ? 'paid in full' : money(q.devM)) : money(0));
  if (num(q.s.tax)) { ln('Before tax', money(q.sub)); ln(`Tax ${num(q.s.tax)}%`, money(q.tax)); }
  if (q.due) ln('Due today for phone', money(q.due));
  if (q.pay === 'def') ln('Deferred to end of term', money(num(q.dev.defPmt)));

  const pr = $('pay');
  $('pay-row').hidden = q.opts.length < 2;
  pr.textContent = '';
  for (const [v, t] of q.opts) pr.append(el('option', { value: v, text: t }));
  if (q.pay) pr.value = q.pay;

  $('slip-total').textContent = money(q.total);
  $('slip-pts').textContent = fmt(q.now);
  $('slip-ptsval').textContent = (q.now ? `worth ${money(q.now / 1000)}` : 'no offer applies') + (q.later ? ` · plus ${fmt(q.later)} later` : '');
  $('slip-block').textContent = '';
  if (q.blocked) $('slip-block').append(el('div', { class: 'block', text: q.s.prog === 'ls' ? 'Only Bell and Rogers Loblaw / Student EPP is eligible for points. This activation earns none.' : "THUP and EPP / RPP activations aren't eligible for any points offers." }));

  const A = $('slip-applied'), core = q.applied.filter(o => o.stack !== 'extra');
  A.textContent = '';
  if (core.length) { A.append(el('h3', { text: 'Applied offers' })); core.forEach(o => A.append(offerRow(o))); }

  const X = $('slip-extras');
  X.textContent = '';
  if (q.extras.length) {
    X.append(el('h3', { text: 'Optional extras' }));
    for (const o of q.extras) {
      const id = 'ex-' + o.id, cb = el('input', { type: 'checkbox', id });
      cb.checked = !!q.s.extras?.[o.id];
      cb.onchange = () => { state.sel.extras = { ...state.sel.extras, [o.id]: cb.checked }; saveSel(); renderSlip(); };
      X.append(el('label', { class: 'check', for: id }, cb, el('span', null, `${o.name}: ${fmt(num(o.points))} pts`,
        o.notes ? el('div', { class: 'muted small', text: o.notes }) : null,
        cb.checked && !q.blocked && (o.sku || o.coupon) ? el('div', { class: 'muted small', text: [o.sku && 'SKU ' + o.sku, o.coupon && 'Coupon: ' + o.coupon].filter(Boolean).join(' · ') }) : null)));
    }
  }
  $('slip-outwrap').hidden = !q.out.length;
  $('slip-outsum').textContent = `Not applied (${q.out.length})`;
  const O = $('slip-out');
  O.textContent = '';
  q.out.forEach(({ o, why }) => O.append(offerRow(o, why)));
  const N = $('slip-notes');
  N.textContent = '';
  q.notes.forEach(n => N.append(el('div', { class: 'warn', text: n })));
}
function quoteText() {
  const q = quote(), out = [`${q.carrier || 'Quote'} · ${ACT[q.s.act]}`];
  out.push(`Plan: ${q.plan ? `${q.plan.name} (${q.plan.data}, ${q.plan.hardware}) ${money(num(q.plan.monthlyPrice))}/mo` : 'none selected'}`);
  out.push(`Phone: ${q.dev ? `${q.dev.name}, ${q.pay === 'out' ? 'paid in full' : money(q.devM) + '/mo for 24 months'}${q.due ? `, ${money(q.due)} due today` : ''}${q.pay === 'def' ? `, ${money(num(q.dev.defPmt))} deferred` : ''}` : 'none (BYOD)'}`);
  out.push(`Monthly total: ${money(q.total)}${num(q.s.tax) ? ` including ${num(q.s.tax)}% tax` : ' before tax'}`);
  out.push(`PC Optimum points: ${fmt(q.now)}${q.now ? ` (worth ${money(q.now / 1000)})` : ''}${q.later ? ` + ${fmt(q.later)} later` : ''}`);
  for (const o of q.applied) out.push(`  - ${o.name}: ${fmt(num(o.points))}${o.sku ? ` · SKU ${o.sku}` : ''}${o.coupon ? ` · Coupon: ${o.coupon}` : ''}`);
  return out.join('\n');
}

/* ---------- wiring ---------- */
const TAX = [['0', 'Show before tax'], ['5', 'AB / territories 5%'], ['12', 'BC 12%'], ['12', 'MB 12%'], ['15', 'NB 15%'], ['15', 'NL 15%'], ['14', 'NS 14%'], ['13', 'ON 13%'], ['15', 'PE 15%'], ['14.975', 'QC 14.975%'], ['11', 'SK 11%']];

export function initPricing() {
  $('copy-quote').onclick = e => copy(quoteText(), e.currentTarget, 'Copy quote');
  $('copy-skus').onclick = e => {
    const btn = e.currentTarget, codes = [...new Set(quote().applied.flatMap(o => (o.sku || '').match(SKU) || []))];
    if (codes.length) return copy(codes.join(', '), btn, 'Copy offer SKUs');
    btn.textContent = 'No SKUs on this quote';
    setTimeout(() => { btn.textContent = 'Copy offer SKUs'; }, 1400);
  };
  for (const r of document.getElementsByName('act')) r.onchange = () => select({ act: r.value });
  for (const r of document.getElementsByName('region')) r.onchange = () => select({ region: r.value }, false);
  $('prog').onchange = () => select({ prog: $('prog').value }, false);
  $('trade').onchange = () => select({ trade: $('trade').checked }, false);
  $('pay').onchange = () => select({ pay: $('pay').value }, false);
  for (const k of ['tx', 'hw', 'line']) $('f-' + k).onchange = () => { state.f[k] = $('f-' + k).value; renderPricing(); };
  $('dev-search').oninput = () => { state.search = $('dev-search').value; renderDevices(); };
  TAX.forEach(([, t], i) => $('tax').append(el('option', { value: i, text: t })));
  $('tax').value = Math.max(0, TAX.findIndex(([, t]) => t === state.sel.taxLabel));
  $('tax').onchange = () => { const [v, t] = TAX[$('tax').value]; select({ tax: num(v), taxLabel: t }, false); };
}
