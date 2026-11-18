// The shape of the three lists (plans, phones, offers) and how a raw row is normalised.
import { blank, num, str, norm, uid } from './util.js';

export const KINDS = ['plans', 'devices', 'promos'];
export const KNOWN = ['Rogers', 'Bell', 'Fido', 'Virgin Plus', 'Telus', 'Koodo', 'Freedom', 'Chatr', 'PC Mobile', 'Lucky Mobile', 'Public Mobile'];
const PREPAID = ['chatr', 'pcmobile', 'luckymobile', 'publicmobile'];

/** "rogers", "ROGERS WIRELESS" -> "Rogers". Unknown carriers are kept as typed. */
export const canon = c => {
  const n = norm(c);
  if (!n) return '';
  return KNOWN.find(k => norm(k) === n) || KNOWN.find(k => n.length > 3 && (norm(k).startsWith(n) || n.startsWith(norm(k)))) || str(c);
};
export const sameCarrier = (a, b) => !!a && !!b && norm(canon(a)) === norm(canon(b));
export const isPrepaid = c => PREPAID.includes(norm(canon(c)));

// Column types: (none) text, 'w' wide text, 'n' number, 'b' checkbox, 's' select with options `o`.
export const COLS = {
  plans: [
    { k: 'carrier', l: 'Carrier' }, { k: 'name', l: 'Plan', t: 'w' }, { k: 'data', l: 'Data' }, { k: 'transaction', l: 'Type' },
    { k: 'hardware', l: 'Hardware' }, { k: 'line', l: 'Line' }, { k: 'monthlyPrice', l: 'Net $/mo', t: 'n' }, { k: 'regularPrice', l: 'Regular $', t: 'n' },
    { k: 'code', l: 'Plan code' }, { k: 'features', l: 'Includes', t: 'w' }, { k: 'notes', l: 'Plan offers / notes', t: 'w' },
  ],
  devices: [
    { k: 'carrier', l: 'Carrier' }, { k: 'name', l: 'Product', t: 'w' }, { k: 'msrp', l: 'MSRP', t: 'n' }, { k: 'price', l: 'Price', t: 'n' },
    { k: 'pco', l: 'PCO', t: 'n' }, { k: 'bpo', l: 'BPO', t: 'n' }, { k: 'finMonthly', l: 'Fin. mthly', t: 'n' }, { k: 'finSaving', l: 'Fin. saving', t: 'n' },
    { k: 'defPmt', l: 'Def. pmt', t: 'n' }, { k: 'finDefMonthly', l: 'Fin + def mthly', t: 'n' }, { k: 'updated', l: 'Last update' },
  ],
  promos: [
    { k: 'name', l: 'Offer', t: 'w' }, { k: 'carrier', l: 'Carrier' }, { k: 'points', l: 'Points', t: 'n' },
    { k: 'stack', l: 'Stacking', t: 's', o: [['bpo', 'Standard BPO'], ['excl', 'Exclusive (no BPOs)'], ['perk', 'Perk, always stacks'], ['extra', 'Optional extra']] },
    { k: 'acts', l: 'Activation types' },
    { k: 'purchase', l: 'Purchase', t: 's', o: [['any', 'Any'], ['fin', 'Financing only'], ['byod', 'BYOD only']] },
    { k: 'region', l: 'Region', t: 's', o: [['all', 'National'], ['bcab', 'BC / AB only']] },
    { k: 'trade', l: 'Needs trade-in', t: 'b' }, { k: 'plans', l: 'Plan must be', t: 'w' }, { k: 'minPlanPrice', l: 'Min plan $', t: 'n' },
    { k: 'noTT', l: 'Excl. talk & text', t: 'b' }, { k: 'devExclude', l: 'Excluded phones', t: 'w' }, { k: 'eppLS', l: 'Loblaw / Student OK', t: 'b' },
    { k: 'pending', l: 'Credited later', t: 'b' }, { k: 'sku', l: 'RQ SKU', t: 'w' }, { k: 'coupon', l: 'Coupon', t: 'w' }, { k: 'notes', l: 'Notes', t: 'w' },
  ],
};
export const PREFIX = { plans: 'p', devices: 'd', promos: 'r' };

/** Turn anything row-shaped (Claude output, a backup, a hand-added row) into a clean row with an id. */
export function clean(kind, raw, source, page) {
  const o = { id: uid(PREFIX[kind]), source };
  if (page) o.page = page;
  for (const c of COLS[kind]) {
    const v = raw?.[c.k];
    if (c.t === 'n') o[c.k] = blank(v) ? '' : num(v);
    else if (c.t === 'b') o[c.k] = v === true || v === 'true';
    else if (c.t === 's') o[c.k] = c.o.some(x => x[0] === str(v).toLowerCase()) ? str(v).toLowerCase() : c.o[0][0];
    else o[c.k] = Array.isArray(v) ? v.join(', ') : str(v);
  }
  if (kind !== 'promos' || o.carrier) o.carrier = canon(o.carrier);
  return o;
}

/** A row Claude produced is only worth keeping if it carries the essentials. */
export function usable(kind, row) {
  if (kind === 'plans') return !!row.name && !blank(row.monthlyPrice);
  if (kind === 'devices') return !!row.name;
  return !!row.name && !blank(row.points);
}
