// The Digital Price Sheet, pasted from a web table: every cell lands on its own line and each
// phone ends with its "last update" date. This reads that layout exactly, without Claude.
import { num } from './util.js';

const DATE = /^\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?$/i;
const NUMRE = /^-?\$?\d[\d,]*(\.\d+)?$/;

/** Returns the phone rows, or null when the text is not in the price sheet layout. */
export function parseSheet(text) {
  const cells = text.split(/[\t\r\n]+/).map(s => s.trim()).filter(Boolean);
  const rows = [];
  let cur = [];
  for (const c of cells) {
    if (DATE.test(c)) { rows.push({ cells: cur, date: c }); cur = []; }
    else cur.push(c);
  }
  if (!rows.length || cur.some(c => NUMRE.test(c))) return null;
  const out = [];
  for (const r of rows) {
    const c = [...r.cells], texts = [];
    while (c.length && !NUMRE.test(c[0])) texts.push(c.shift());
    // 4 numbers = no financing, 6 = financing, 8 = financing with a deferred payment.
    if (!texts.length || ![4, 6, 8].includes(c.length) || !c.every(x => NUMRE.test(x))) return null;
    const name = texts.pop(), n = c.map(num);
    out.push({ carrier: texts.pop() || '', name, msrp: n[0], price: n[1], pco: n[2], bpo: n[3], finMonthly: n[4] ?? '', finSaving: n[5] ?? '', defPmt: n[6] ?? '', finDefMonthly: n[7] ?? '', updated: r.date });
  }
  return out;
}
