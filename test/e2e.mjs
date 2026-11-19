// Browser test of the import flow against test/dev-server.mjs. Needs Playwright:
//   node test/dev-server.mjs &   then   node test/e2e.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const { chromium } = createRequire(import.meta.url)('playwright');
const BASE = process.env.BASE || 'http://localhost:8899';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qd-'));
const mode = m => fetch(BASE + '/__mode', { method: 'POST', body: JSON.stringify(m) });
const seen = async () => (await fetch(BASE + '/__seen')).json();
const step = async (name, fn) => { await fn(); console.log('ok  -', name); };

const browser = await chromium.launch();

// Make PDFs to import: a 5-page plan sheet, a 2-page promo grid, and a 1-page one.
async function makePdf(name, pages) {
  const p = await browser.newPage();
  await p.setContent(Array.from({ length: pages }, (_, i) => `<div style="page-break-after:always"><h1>Rogers ${name} page ${i + 1}</h1><table border=1>${Array.from({ length: 6 }, (_, r) => `<tr><td>5G+ Plan ${r}</td><td>BYOD</td><td>$${80 + r}</td><td>Financing - Max</td><td>$${95 + r}</td></tr>`).join('')}</table></div>`).join(''));
  const file = path.join(tmp, name + '.pdf');
  await p.pdf({ path: file });
  await p.close();
  return file;
}
const plans5 = await makePdf('plans', 5), promos2 = await makePdf('promos', 2), single = await makePdf('single', 1);

const page = await browser.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
const text = sel => page.textContent(sel);
const rows = kind => page.locator(`#tbl-${kind} tbody tr`).count();
const jobDone = (kind, re) => page.waitForFunction(([k, r]) => new RegExp(r).test(document.querySelector(`#jobs-${k}`)?.textContent || ''), [kind, re.source], { timeout: 90000 });

await step('asks for the access code, rejects a wrong one, accepts the right one', async () => {
  await mode({ reset: true });
  await page.goto(BASE + '/#import');
  await page.waitForSelector('#gate:not([hidden])');
  await page.fill('#gate-code', 'wrong'); await page.click('#gate-form button');
  await page.waitForFunction(() => /not accepted/.test(document.querySelector('#gate-msg').textContent));
  await page.fill('#gate-code', 'test'); await page.click('#gate-form button');
  await page.waitForSelector('#view-import:not([hidden])');
  assert.match(await text('#status'), /shared with everyone/);
});

await step('imports a 5-page PDF page by page; a busy server, a truncated page and a dropped page do not lose the rest', async () => {
  await mode({ overloadOnce: 2, truncate: 3, cut: 4, slow: 60 });
  await page.setInputFiles('#file-plans', plans5);
  // Dropping a second file while the first is running must queue it, not ignore it.
  await page.setInputFiles('#file-promos', promos2);
  await page.waitForFunction(() => /Waiting for the file before it/.test(document.querySelector('#jobs-promos').textContent));
  await jobDone('plans', /rows imported/);
  // pages 1, 2 (after the automatic retry) and 5 give 3 rows each; pages 3 and 4 keep the 2 complete rows.
  assert.equal(await rows('plans'), 13);
  assert.equal(await page.locator('#jobs-plans .pg.ok').count(), 3);
  assert.equal(await page.locator('#jobs-plans .pg.partial').count(), 2);
  assert.match(await text('#jobs-plans'), /Page 3: The reply was cut off/);
  assert.match(await text('#jobs-plans'), /Page 4: .*dropped/);
  assert.doesNotMatch(await text('#jobs-plans'), /Page 2:/, 'a page that worked on retry shows no leftover message');
  await jobDone('promos', /4 rows imported/);
  assert.equal(await rows('promos'), 4);
});

await step('Retry re-reads only the incomplete pages and replaces their rows', async () => {
  await mode({});
  const before = (await seen()).requests;
  await page.click('#jobs-plans button:has-text("Retry 2 pages")');
  await page.waitForFunction(() => document.querySelectorAll('#jobs-plans .pg.ok').length === 5, null, { timeout: 30000 });
  assert.equal(await rows('plans'), 15);
  assert.equal((await seen()).requests - before, 2);
  assert.deepEqual((await seen()).store, { plans: 15, devices: 0, promos: 4 });
});

await step('importing the same file again replaces its rows instead of doubling them', async () => {
  await page.setInputFiles('#file-plans', single);
  await jobDone('plans', /single\.pdf — 3 rows imported/);
  await page.setInputFiles('#file-plans', single);
  await page.waitForFunction(() => document.querySelectorAll('#jobs-plans .job.ok').length === 3, null, { timeout: 30000 });
  assert.equal(await rows('plans'), 18);
});

await step('a rejected API key is reported with the reason and not retried', async () => {
  await mode({ badKey: true });
  const before = (await seen()).requests;
  await page.setInputFiles('#file-plans', single);
  await page.waitForFunction(() => /single\.pdf — .*invalid x-api-key/.test(document.querySelector('#jobs-plans').textContent), null, { timeout: 30000 });
  assert.doesNotMatch(await page.locator('#jobs-plans .job').last().textContent(), /Trying again/);
  assert.equal((await seen()).requests - before, 1);
  await page.click('#jobs-plans .job.err button[aria-label="Hide this message"]');
  await mode({});
});

await step('a file that is not a PDF gets a message', async () => {
  const txt = path.join(tmp, 'notes.txt');
  fs.writeFileSync(txt, 'hello');
  await page.setInputFiles('#file-plans', txt);
  await page.waitForFunction(() => /notes\.txt — Only PDF files/.test(document.querySelector('#jobs-plans').textContent));
});

await step('pasted price sheet is read exactly; an odd layout goes to Claude', async () => {
  await page.fill('#paste-devices', ['Rogers', 'iPhone 17 128GB', '1,129.00', '0.00', '50,000', '100,000', '47.04', '120.00', '5/1/2026 9:30 AM'].join('\n'));
  await page.click('#parse-devices');
  await page.waitForFunction(() => /1 phones lined up/.test(document.querySelector('#jobs-devices').textContent));
  await page.check('#devices-append');
  await page.fill('#paste-devices', 'Rogers Test Phone five hundred dollars');
  await page.click('#parse-devices');
  await jobDone('devices', /1 rows imported/);
  assert.equal(await rows('devices'), 2);
});

await step('a failed save is shown, kept, and goes through on Retry', async () => {
  await mode({ failSaves: true });
  await page.click('[data-add="plans"]');
  await page.waitForSelector('#banner:not([hidden])', { timeout: 30000 });
  assert.match(await text('#banner-text'), /Could not save to the server/);
  assert.match(await text('#status'), /not saved yet/);
  assert.equal((await seen()).store.plans, 18);
  await mode({});
  await page.click('#banner-retry');
  await page.waitForFunction(() => document.querySelector('#banner').hidden);
  assert.equal((await seen()).store.plans, 19);
});

await step('data survives a reload, and pricing and the assistant work', async () => {
  await page.goto(BASE + '/');
  await page.waitForSelector('#view-pricing:not([hidden])');
  assert.match(await text('#status'), /19 plan rows · 2 phones · 4 offers/);
  await page.click('#pick-devices tr:has-text("iPhone 17")');
  await page.click('#pick-plans tbody tr >> nth=0');
  assert.match(await text('#slip-total'), /\$\d+\.\d\d/);
  assert.notEqual(await text('#slip-pts'), '0');
  await page.fill('#chat-in', 'What is the cheapest plan?');
  await page.click('#chat-send');
  await page.waitForFunction(() => /this is a test answer/.test(document.querySelector('#msgs').textContent), null, { timeout: 30000 });
});

assert.deepEqual(errors, [], 'no errors in the browser console');
await page.screenshot({ path: path.join(tmp, 'pricing.png'), fullPage: true });
await page.goto(BASE + '/#import');
await page.waitForSelector('#view-import:not([hidden])');
await page.screenshot({ path: path.join(tmp, 'import.png'), fullPage: true });
await browser.close();
console.log('\nAll browser checks passed. Screenshots in', tmp);
