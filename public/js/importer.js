// The import pipeline. Every dropped file becomes a job in a queue; a job is a list of units
// (one per PDF page, or one for a pasted text) and each unit is one small request to Claude.
//
// Why page by page: a whole plan sheet in one request can outgrow the reply limit and lose
// everything. One page per request keeps each reply short, shows progress as it happens,
// keeps the pages that worked when one fails, and lets a failed page be retried on its own.
import { sleep } from './util.js';
import { clean, usable } from './catalog.js';
import { converse, errText, retryable } from './api.js';
import { scanObjects } from './jsonl.js';
import { openPdf } from './pdfread.js';
import { state, server, commit } from './store.js';

const FORMAT = `Reply in JSON Lines: one JSON object per line, each object complete on its own line. No array brackets, no code fences, no commentary before or after. If there is nothing to extract, reply with the single word NONE.`;

const SHAPE = {
  plans: `This is a carrier's internal plan sheet for a Canadian wireless retailer. It is a grid: plan families across the top (each split into hardware tiers such as BYOD or "Financing - Max"), and rows for line position (single / primary line, cross-sell, additional line 2, 3, 4+). Later sections cover upgrades (HUP/PPC), talk & text, migrations and data-only plans.
Output ONE object for every priced cell: each combination of plan, hardware tier, transaction type and line. Each object:
{"carrier": string, "name": plan name e.g. "5G+ Popular", "data": e.g. "100 GB" or "Unlimited", "transaction": "NAC" | "HUP" | short label for migrations or "Data only", "hardware": "BYOD" or the financing tier exactly as printed e.g. "Financing - Max", "line": "Primary" | "Cross-sell" | "Line 2" | "Line 3" | "Line 4+" | "Line 2+", "monthlyPrice": the large price = net monthly fee after all discounts, "regularPrice": the price in brackets before discounts or null, "code": plan code printed beside the bracket price or "", "features": short summary of what the plan includes, "notes": the plan offers / discounts listed for that cell and any eligibility footnote, short}
Skip cells showing "-". Do not invent prices.
Example line: {"carrier":"Rogers","name":"5G+ Popular","data":"Unlimited","transaction":"NAC","hardware":"Financing - Max","line":"Primary","monthlyPrice":105,"regularPrice":120,"code":"CONM424B2","features":"CAN+US+MEX+CARIB usage 24 mo","notes":"$5 Auto-Pay, $10 TAGSRAJRZ"}`,
  devices: `This is a phone price list copied from a web table, so every cell landed on its own line. The source columns are: Carrier, Product, MSRP, Price, PCO (points), BPO (points), Fin. Mthly, Fin. Saving, Def. Pmt, Fin. + Def. Mthly, Last Update. Rows without financing stop after BPO; rows without a deferred payment stop after Fin. Saving. Each object:
{"carrier": string, "name": product name, "msrp": number, "price": number, "pco": number, "bpo": number, "finMonthly": number or null, "finSaving": number or null, "defPmt": number or null, "finDefMonthly": number or null, "updated": string}
Do not guess a value that is not in the text; use null.`,
  promos: `This is a retailer's promo grid of PC Optimum points offers by carrier. Turn every points offer into a rule. Each object:
{"name": short offer name including the carrier, e.g. "Rogers BC/AB BPO" or "TMS Perk: Bell 5G+ Ultra",
 "carrier": carrier name, or "" for offers open to any carrier (listed under Additional Offers),
 "points": number of PC Optimum points (75K = 75000),
 "stack": "perk" for TMS Exclusive Customer Perks tied to a plan (stack with everything) | "excl" for an offer that says it is NOT stackable with device points offers or BPOs | "extra" for any-carrier optional offers the rep adds by hand (unlock your offer, targeted email, accessories spend & earn) | "bpo" for everything else (BPOs, bonus trade, regional BPOs, prepaid offers),
 "acts": which activation types qualify, from NAC, AAL, HUP, comma separated. "New/HUP" means "NAC, AAL, HUP". An AAL-only offer is "AAL". "New activations" only is "NAC, AAL",
 "purchase": "fin" if it needs a financed device / excludes BYOD | "byod" if BYOD only | "any" (use "any" for prepaid offers),
 "region": "bcab" if limited to BC / AB, else "all",
 "trade": true if it needs a device trade-in,
 "plans": plan names that qualify, comma separated, e.g. "Ultimate, Popular" or "Ultra, Select"; "" if any plan,
 "minPlanPrice": minimum monthly plan price if stated (e.g. 25), else 0,
 "noTT": true if talk and text plans are excluded,
 "devExclude": excluded phones, comma separated, as name prefixes: "iPhone 18 series" -> "iPhone 18"; "iPhone 18 Pro / 18 Pro Max / Duo" -> "iPhone 18 Pro, iPhone Duo"; "" if none,
 "eppLS": true if Loblaw and Student EPP/RPP plans still qualify ("except Loblaw and Student plans"), false if the offer excludes ALL EPP activations. True when nothing is said,
 "pending": true if points are credited later (e.g. after 2 months of service),
 "sku": the offer SKU with its label, e.g. "ACRORB004526 [Rogers - BPO Offer]", or "",
 "coupon": the coupon name to apply, or "",
 "notes": anything else a rep must know (free SIM, limits, caps), short}
One object per offer row, each written on a single line. Ignore SKU reference tables that are not points offers (supplemental SKUs, residential SKUs).`,
};

const PAGE_CHARS = 60000;      // far more than one page of a price sheet holds
const CONTEXT_CHARS = 5000;
const PARALLEL = 3;            // pages of one file sent to Claude at the same time
const RETRIES = 2;             // automatic retries for a busy or dropped connection

/* ---------- jobs ---------- */
export const jobs = [];
const listeners = new Set();
export const onJobs = fn => listeners.add(fn);
let notifyQueued = false;
function notify() {            // coalesce bursts (streaming updates) into one redraw per frame
  if (notifyQueued) return;
  notifyQueued = true;
  requestAnimationFrame(() => { notifyQueued = false; listeners.forEach(fn => fn()); });
}
let onUnauthorized = () => {};
export const setUnauthorizedHandler = fn => { onUnauthorized = fn; };
let seq = 0;
const newJob = (kind, name, extra) => ({ id: ++seq, kind, name, source: name, state: 'queued', units: [], message: '', ctl: null, ...extra });

/** Queue PDF files for one list ('plans' or 'promos'). Files are never dropped silently. */
export function addPdfJobs(kind, files) {
  for (const f of files) {
    const job = newJob(kind, f.name, { file: f });
    if (!/pdf$/i.test(f.type) && !/\.pdf$/i.test(f.name)) { job.state = 'failed'; job.message = 'Only PDF files can be imported here.'; }
    else if (!server.ai) { job.state = 'failed'; job.message = server.problem || 'Claude is not connected, so PDFs cannot be read. Rows can still be added by hand.'; }
    jobs.push(job);
  }
  notify(); pump();
}

/** Queue pasted text that did not match the exact price sheet layout. */
export function addTextJob(kind, text, source, replaceAll) {
  const job = newJob(kind, source, { text, replaceAll });
  if (!server.ai) { job.state = 'failed'; job.message = server.problem || 'Claude is not connected.'; }
  jobs.push(job); notify(); pump();
  return job;
}

export function cancelJob(job) {
  if (job.state === 'queued') job.state = 'cancelled';
  job.ctl?.abort();
  notify();
}
export function dismissJob(job) { const i = jobs.indexOf(job); if (i >= 0) jobs.splice(i, 1); notify(); }

/** Run the pages that failed or came back incomplete again. */
export function retryJob(job) {
  if (job.state === 'queued' || job.state === 'running' || job.state === 'reading') return;
  for (const u of job.units) if (u.status === 'err' || u.status === 'partial') { u.status = 'wait'; u.error = ''; }
  job.state = 'queued'; job.message = '';
  notify(); pump();
}

/* ---------- running ---------- */
let running = false;
async function pump() {
  if (running) return;
  running = true;
  for (let job; (job = jobs.find(j => j.state === 'queued')); ) {
    try { await runJob(job); }
    catch (e) { job.state = e?.code === 'cancelled' ? 'cancelled' : 'failed'; job.message = errText(e); }
    job.ctl = null;
    notify();
  }
  running = false;
}

async function prepare(job) {
  if (job.units.length) return;                       // a retry: units already exist
  if (job.text != null) {
    job.units = [{ label: 'text', status: 'wait', rows: [], load: async () => ({ text: job.text.slice(0, 150000), cut: job.text.length > 150000 }) }];
    return;
  }
  job.state = 'reading'; notify();
  const pdf = job.pdf = await openPdf(job.file);
  for (let n = 1; n <= pdf.pages; n++) {
    job.units.push({
      label: String(n), page: n, status: 'wait', rows: [],
      async load() {
        const [text, image, before] = await Promise.all([pdf.text(n), pdf.image(n).catch(() => null), n > 1 ? pdf.text(n - 1) : '']);
        if (text.replace(/\s/g, '').length < 40 && !image) throw { message: 'This page is a scan with no readable text and could not be turned into a picture.' };
        return { text: text.slice(0, PAGE_CHARS), cut: text.length > PAGE_CHARS, image, before, first: n > 1 ? await pdf.text(1) : '' };
      },
    });
  }
}

function prompt(job, unit, src) {
  const L = [SHAPE[job.kind], '', FORMAT, 'Use only what is in the source. Numbers are plain numbers without $ or commas.'];
  if (unit.page) {
    L.push('', `FILE: ${job.name}. You are reading PAGE ${unit.page} of ${job.units.length}. Other pages are handled separately, so extract ONLY what is printed on this page. A page with only notes, legal text or a cover is NONE.`);
    if (src.image) L.push('A picture of this page is attached; use it to see which value belongs to which cell.');
    if (unit.page > 1) {
      const head = src.first.slice(0, 1200);
      L.push('', 'CONTEXT ONLY, DO NOT EXTRACT FROM IT. Use it for the carrier name, section titles and column headings that continue onto this page.');
      L.push(`--- top of page 1 ---\n${head}`);
      if (unit.page > 2) L.push(`--- end of page ${unit.page - 1} ---\n${src.before.slice(-CONTEXT_CHARS)}`);
    }
    L.push('', `SOURCE (page ${unit.page}):`, src.text || '(no text layer on this page; read the picture)');
  } else L.push('', 'SOURCE:', src.text);
  return L.join('\n');
}

const toRows = (job, unit, text) => scanObjects(text).map(r => clean(job.kind, r, job.source, unit.page)).filter(r => usable(job.kind, r));

async function runUnit(job, unit) {
  unit.status = 'run'; unit.error = ''; unit.live = 0; notify();
  const signal = job.ctl.signal;
  try {
    const src = await unit.load();
    const ask = prompt(job, unit, src);
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await converse(ask, { kind: 'extract', images: src.image ? [src.image] : undefined, signal, onText: ({ text }) => { unit.live = scanObjects(text).length; notify(); } });
        unit.rows = toRows(job, unit, res.text);
        unit.status = res.truncated || src.cut ? 'partial' : 'ok';
        if (res.truncated) unit.error = 'The reply was cut off, so some rows may be missing.';
        else if (src.cut) unit.error = 'The text was too long and only the first part was read.';
        break;
      } catch (e) {
        if (signal.aborted) throw { code: 'cancelled' };
        if (retryable(e) && attempt < RETRIES && !signal.aborted) { unit.error = `${errText(e)} Trying again…`; notify(); await sleep(4000 * (attempt + 1) ** 2, signal); continue; }
        // Out of retries: keep whatever complete rows had already arrived.
        const kept = e?.text ? toRows(job, unit, e.text) : [];
        if (kept.length) { unit.rows = kept; unit.status = 'partial'; unit.error = `${errText(e)} ${kept.length} rows arrived before that.`; break; }
        throw e;
      }
    }
  } catch (e) {
    if (e?.code === 'cancelled' || signal.aborted) { unit.status = 'wait'; throw { code: 'cancelled' }; }
    unit.status = 'err'; unit.error = errText(e);
    if (e?.code === 'unauthorized') { job.ctl.abort(); onUnauthorized(); }
  }
  unit.live = 0;
  apply(job);
  notify();
}

/** Put the job's rows into the catalog, replacing rows from an earlier import of the same file. */
function apply(job) {
  const rows = job.units.flatMap(u => u.rows);
  if (!rows.length && !job.applied) return;            // nothing yet: leave the existing rows alone
  job.applied = true;
  state[job.kind] = state[job.kind].filter(i => i.source !== job.source && !job.replaceAll).concat(rows);
  commit(job.kind);
}

async function runJob(job) {
  job.ctl = new AbortController();
  job.message = '';
  await prepare(job);
  job.state = 'running'; notify();
  const todo = job.units.filter(u => u.status === 'wait');
  let cancelled = false;
  await Promise.all(Array.from({ length: Math.min(PARALLEL, todo.length) }, async () => {
    for (let u; !cancelled && !job.ctl.signal.aborted && (u = todo.shift()); ) {
      try { await runUnit(job, u); } catch (e) { if (e?.code === 'cancelled') cancelled = true; else throw e; }
    }
  }));
  const count = job.units.reduce((n, u) => n + u.rows.length, 0);
  const bad = job.units.filter(u => u.status === 'err').length, partial = job.units.filter(u => u.status === 'partial').length;
  if (cancelled || job.ctl.signal.aborted) { job.state = 'cancelled'; job.message = count ? `Stopped. ${count} rows from the finished pages were kept.` : 'Stopped.'; }
  else if (bad === job.units.length) { job.state = 'failed'; job.message = job.units[0]?.error || 'Nothing could be read.'; }
  else {
    job.state = 'done';
    job.message = !count ? 'Finished, but no rows were found in this file. Check that it was dropped in the right panel.'
      : `${count} rows imported.` + (bad || partial ? '' : ' Check them against the source and fix anything that looks off.');
  }
  if (job.state !== 'done' || bad || partial) return;
  job.pdf?.close(); job.pdf = null; job.file = null;   // fully done: free the PDF
}
