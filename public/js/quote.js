// The quote engine: monthly total and PC Optimum points for one sale. Pure functions of
// (catalog, selection) so the page, the assistant's quote tool and the tests all get the same answer.
import { blank, num, fmt, money, list, words, norm } from './util.js';
import { canon, sameCarrier, isPrepaid } from './catalog.js';

export const ACT = { NAC: 'New customer', AAL: 'Add a line', HUP: 'Upgrade' };

/** Ways to pay for a phone: [value, label]. */
export function payOptions(d) {
  if (!d) return [];
  const o = [];
  if (!blank(d.finMonthly)) o.push(['fin', `Financing, ${money(num(d.finMonthly))}/mo × 24`]);
  if (!blank(d.finDefMonthly)) o.push(['def', `Financing with ${money(num(d.defPmt))} deferred, ${money(num(d.finDefMonthly))}/mo`]);
  o.push(['out', `Pay in full, ${money(o.length ? num(d.msrp) : num(d.price) || num(d.msrp))}`]);
  return o;
}

/** Why offer `o` does not apply to sale `c`, or null when it does. */
export function reasonFor(o, c) {
  const acts = list(o.acts).map(a => a.toUpperCase());
  if (acts.length && !acts.includes(c.act)) return `${ACT[c.act]} not eligible (${acts.join(' / ')} only)`;
  if (o.purchase === 'byod' && c.purchase !== 'byod') return 'BYOD activations only';
  if (o.purchase === 'fin' && c.purchase !== 'fin') return c.purchase === 'byod' ? 'Excludes BYOD' : 'Needs 2-year financing';
  if (o.region === 'bcab' && c.region !== 'bcab') return 'BC / AB activations only';
  if (o.trade && !c.trade) return 'Needs a device trade-in';
  if (o.devExclude && c.dev) {
    const dw = words(c.dev.name);
    for (const kw of list(o.devExclude)) if (words(kw).every(t => dw.some(w => w.startsWith(t)))) return `Excludes ${kw}`;
  }
  if (o.noTT && c.plan && /talk/i.test(c.plan.name)) return 'Excludes talk & text plans';
  if (o.plans) {
    const need = list(o.plans);
    if (!c.plan) return `Choose a plan (${need.join(' / ')} qualify)`;
    const pw = words(c.plan.name);
    if (!need.some(k => words(k).every(t => pw.includes(t)))) return `Plan must be ${need.join(' / ')}`;
  }
  if (num(o.minPlanPrice)) {
    if (!c.plan) return `Choose a plan of ${money(num(o.minPlanPrice))} or more`;
    if (num(c.plan.monthlyPrice) < num(o.minPlanPrice)) return `Plan must be ${money(num(o.minPlanPrice))} or more`;
  }
  if (!o.eppLS && c.prog === 'ls') return 'Excludes all EPP / RPP, including Loblaw and Student';
  return null;
}

/**
 * @param cat { plans, devices, promos }
 * @param s   the selection: { carrier, plan, device, pay, act, region, prog, trade, extras, tax }
 */
export function quote(cat, s) {
  const plan = cat.plans.find(p => p.id === s.plan) || null;
  const dev = cat.devices.find(d => d.id === s.device) || null;
  const carrier = s.carrier, pre = isPrepaid(carrier), opts = payOptions(dev);
  const pay = opts.some(o => o[0] === s.pay) ? s.pay : opts[0]?.[0] || null;
  const purchase = !dev ? (pre ? 'pre' : 'byod') : pay === 'out' ? (pre ? 'pre' : 'out') : 'fin';
  const devM = pay === 'fin' ? num(dev.finMonthly) : pay === 'def' ? num(dev.finDefMonthly) : 0;
  const due = !dev ? 0 : pay === 'out' ? (opts.length > 1 ? num(dev.msrp) : num(dev.price) || num(dev.msrp)) : num(dev.price);
  const sub = (plan ? num(plan.monthlyPrice) : 0) + devM, rate = num(s.tax) / 100;
  const c = { act: s.act, purchase, region: s.region, trade: s.trade, prog: s.prog, plan, dev };
  // THUP and EPP/RPP earn nothing; Loblaw / Student EPP only on Rogers and Bell.
  const blocked = s.prog === 'epp' || s.prog === 'thup' || (s.prog === 'ls' && !['rogers', 'bell'].includes(norm(canon(carrier))));
  const NOPTS = 'THUP / EPP / RPP not eligible for points';
  const applied = [], out = [], notes = [];

  const offers = cat.promos.filter(o => o.stack !== 'extra' && sameCarrier(o.carrier, carrier));
  if (dev && num(dev.pco)) offers.push({ id: 'devpco', name: `Device points: ${dev.name}`, points: num(dev.pco), stack: 'bpo', purchase: 'fin', region: 'all', eppLS: true, device: true });

  if (blocked) offers.forEach(o => out.push({ o, why: NOPTS }));
  else {
    const ok = [];
    offers.forEach(o => { const r = reasonFor(o, c); r ? out.push({ o, why: r }) : ok.push(o); });
    const excl = ok.filter(o => o.stack === 'excl'), bpo = ok.filter(o => o.stack === 'bpo'), perk = ok.filter(o => o.stack === 'perk');
    const sum = a => a.reduce((t, o) => t + num(o.points), 0), eP = sum(excl), bP = sum(bpo);
    // An exclusive offer cannot combine with BPOs or device points: apply whichever side earns more.
    if (excl.length && bpo.length) {
      if (eP >= bP) { applied.push(...excl); bpo.forEach(o => out.push({ o, why: `Doesn't stack with ${excl[0].name} (${fmt(eP)} ${eP > bP ? 'beats' : 'matches'} ${fmt(bP)})` })); }
      else { applied.push(...bpo); excl.forEach(o => out.push({ o, why: `Doesn't stack with BPOs or device points, which earn more here (${fmt(bP)})` })); }
    } else applied.push(...excl, ...bpo);
    applied.push(...perk);
    for (const o of applied) {
      if (dev && /iphone\s*18/i.test(dev.name) && /excl\.?\s*iphone\s*18\s*series/i.test(o.coupon || '')) notes.push(`${o.name}: the grid allows this phone, but the coupon name says "excl. iPhone 18 series". Confirm the coupon applies in RQ.`);
      if (o.notes && !o.device) notes.push(`${o.name}: ${o.notes}`);
    }
    if (carrier && !cat.promos.some(o => o.stack !== 'extra' && sameCarrier(o.carrier, carrier))) notes.push(`No points offers are listed for ${carrier} on the imported promo grid.`);
  }

  const extras = cat.promos.filter(o => o.stack === 'extra' && (!o.carrier || sameCarrier(o.carrier, carrier)));
  for (const o of extras) if (s.extras?.[o.id]) (blocked ? out.push({ o, why: NOPTS }) : applied.push(o));

  const now = applied.filter(o => !o.pending).reduce((t, o) => t + num(o.points), 0);
  const later = applied.filter(o => o.pending).reduce((t, o) => t + num(o.points), 0);
  if (dev && num(dev.bpo) && !blocked) notes.push(`The price sheet lists up to ${fmt(num(dev.bpo))} BPO points for this phone on the best plan. The offers above are worked out from the promo grid for the plan and sale details you picked.`);
  return { s, carrier, plan, dev, pre, opts, pay, purchase, devM, due, sub, tax: sub * rate, total: sub * (1 + rate), blocked, applied, out, notes, extras, now, later };
}
