// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanObjects } from '../public/js/jsonl.js';
import { parseSheet } from '../public/js/sheet.js';
import { clean, canon, usable } from '../public/js/catalog.js';
import { quote } from '../public/js/quote.js';

test('scanObjects reads JSON Lines, arrays, fences and pretty-printed objects', () => {
  assert.equal(scanObjects('{"a":1}\n{"a":2}\n').length, 2);
  assert.equal(scanObjects('```json\n[{"a":1},\n {"a":2}]\n```').length, 2);
  assert.equal(scanObjects('Here you go:\n{\n  "a": {"b": "}"}\n}\n').length, 1);
  assert.deepEqual(scanObjects('{"items":[{"a":1},{"a":2},{"a":3}]}'), [{ a: 1 }, { a: 2 }, { a: 3 }]);
  assert.deepEqual(scanObjects('NONE'), []);
});

test('scanObjects keeps complete rows from a reply that was cut off', () => {
  const rows = scanObjects('{"name":"A","notes":"has } and \\" inside"}\n{"name":"B"}\n{"name":"C","no');
  assert.deepEqual(rows.map(r => r.name), ['A', 'B']);
});

test('parseSheet lines up the pasted price sheet', () => {
  const text = ['Rogers', 'iPhone 17 128GB', '1,129.00', '0.00', '50,000', '100,000', '47.04', '120.00', '5/1/2026 9:30 AM',
    'Bell', 'Galaxy A17', '$299.99', '$0.00', '0', '25000', '5/1/2026 9:30 AM'].join('\n');
  const rows = parseSheet(text);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].carrier, rows[0].name, rows[0].msrp, rows[0].pco, rows[0].finMonthly], ['Rogers', 'iPhone 17 128GB', 1129, 50000, 47.04]);
  assert.equal(rows[1].finMonthly, '');
  assert.equal(parseSheet('just some words\nand more words'), null);
});

test('clean normalises rows and usable drops empty ones', () => {
  const p = clean('plans', { carrier: 'rogers', name: ' 5G+ Popular ', monthlyPrice: '$105.00', regularPrice: null }, 'a.pdf', 2);
  assert.deepEqual([p.carrier, p.name, p.monthlyPrice, p.regularPrice, p.source, p.page], ['Rogers', '5G+ Popular', 105, '', 'a.pdf', 2]);
  assert.equal(usable('plans', p), true);
  assert.equal(usable('plans', clean('plans', { name: 'x' }, 'a.pdf')), false);
  assert.equal(clean('promos', { stack: 'EXCL', trade: 'true' }, '').stack, 'excl');
  assert.equal(canon('virgin plus'), 'Virgin Plus');
});

test('quote adds plan and phone, and applies the larger side of exclusive vs BPO offers', () => {
  const cat = {
    plans: [{ id: 'p1', carrier: 'Rogers', name: '5G+ Popular', hardware: 'Financing - Max', monthlyPrice: 105 }],
    devices: [{ id: 'd1', carrier: 'Rogers', name: 'iPhone 17', msrp: 1129, price: 0, pco: 50000, bpo: 100000, finMonthly: 47.04, finDefMonthly: '', defPmt: '' }],
    promos: [
      { id: 'r1', name: 'Rogers BPO', carrier: 'Rogers', points: 75000, stack: 'bpo', acts: 'NAC, AAL, HUP', purchase: 'fin', region: 'all', eppLS: true },
      { id: 'r2', name: 'Rogers 100K', carrier: 'Rogers', points: 100000, stack: 'excl', acts: 'NAC', purchase: 'any', region: 'all', eppLS: true },
      { id: 'r3', name: 'TMS Perk', carrier: 'Rogers', points: 10000, stack: 'perk', acts: 'NAC', purchase: 'any', region: 'all', plans: 'Popular', eppLS: true },
      { id: 'r4', name: 'Bell BPO', carrier: 'Bell', points: 999999, stack: 'bpo', acts: 'NAC', purchase: 'any', region: 'all', eppLS: true },
    ],
  };
  const sel = { carrier: 'Rogers', plan: 'p1', device: 'd1', pay: 'fin', act: 'NAC', region: 'bcab', prog: 'std', trade: false, extras: {}, tax: 5 };
  const q = quote(cat, sel);
  assert.equal(+q.sub.toFixed(2), 152.04);
  assert.equal(+q.total.toFixed(2), 159.64);
  // BPO 75K + device 50K = 125K beats the exclusive 100K; the perk stacks on top.
  assert.equal(q.now, 135000);
  assert.deepEqual(q.out.map(x => x.o.name), ['Rogers 100K']);
  // BYOD: device points and the financing-only BPO drop out, so the exclusive offer wins.
  const byod = quote(cat, { ...sel, device: null });
  assert.equal(byod.now, 110000);
  // Other EPP earns nothing.
  assert.equal(quote(cat, { ...sel, prog: 'epp' }).now, 0);
});
