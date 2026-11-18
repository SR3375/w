// Step 1, "Import data": the drop zones, the job cards that show progress, and the editable tables.
import { $, el, blank, num } from './util.js';
import { KINDS, COLS, clean, canon } from './catalog.js';
import { parseSheet } from './sheet.js';
import { state, server, commit } from './store.js';
import { jobs, onJobs, addPdfJobs, addTextJob, cancelJob, retryJob, dismissJob } from './importer.js';

const EMPTY = {
  plans: 'No plans yet. Drop a carrier plan sheet PDF above.',
  devices: 'No phones yet. Paste rows from the Digital Price Sheet above.',
  promos: 'No offers yet. Drop the promo grid PDF above.',
};
const NOUN = { plans: 'plan rows', devices: 'phones', promos: 'offers' };
const HAND = 'Added by hand';

/* ---------- editable tables ---------- */
function cellInput(kind, it, c) {
  const id = `${kind}-${it.id}-${c.k}`;
  const set = v => { it[c.k] = v; commit(kind, 'cell'); };
  if (c.t === 'b') {
    const inp = el('input', { type: 'checkbox', id, 'aria-label': c.l });
    inp.checked = !!it[c.k];
    inp.onchange = () => set(inp.checked);
    return el('td', { class: 'c' }, inp);
  }
  if (c.t === 's') {
    const inp = el('select', { id, 'aria-label': c.l }, ...c.o.map(([v, t]) => el('option', { value: v, text: t })));
    inp.value = it[c.k] || c.o[0][0];
    inp.onchange = () => set(inp.value);
    return el('td', null, inp);
  }
  const inp = el('input', { type: 'text', id, 'aria-label': c.l, class: c.t || '', inputmode: c.t === 'n' ? 'decimal' : null });
  inp.value = blank(it[c.k]) ? '' : it[c.k];
  inp.onchange = () => set(c.t === 'n' ? (inp.value.trim() === '' ? '' : num(inp.value)) : c.k === 'carrier' ? canon(inp.value) : inp.value.trim());
  return el('td', null, inp);
}

export function renderTables() {
  for (const kind of KINDS) {
    const items = state[kind], host = $('tbl-' + kind), src = $('src-' + kind);
    host.textContent = ''; src.textContent = '';
    // One chip per source file, with a button to remove everything that came from it.
    const counts = new Map();
    for (const it of items) counts.set(it.source || HAND, (counts.get(it.source || HAND) || 0) + 1);
    for (const [name, n] of counts) {
      src.append(el('span', { class: 'chip' }, `${name} · ${n}`, el('button', {
        title: 'Remove these rows', 'aria-label': `Remove rows from ${name}`, text: '×',
        onclick: () => { state[kind] = state[kind].filter(i => (i.source || HAND) !== name); commit(kind); },
      })));
    }
    if (!items.length) { host.append(el('div', { class: 'empty small', text: EMPTY[kind] })); continue; }
    const tb = el('tbody');
    for (const it of items) {
      const tr = el('tr');
      for (const c of COLS[kind]) tr.append(cellInput(kind, it, c));
      tr.append(el('td', { class: 'c' }, el('button', { class: 'btn ghost', title: 'Delete row', 'aria-label': 'Delete row', text: '×', onclick: () => { state[kind] = state[kind].filter(i => i !== it); commit(kind); } })));
      tb.append(tr);
    }
    const head = el('tr');
    for (const c of COLS[kind]) head.append(el('th', { class: c.t === 'n' ? 'r' : '', text: c.l }));
    head.append(el('th'));
    host.append(el('div', { class: 'scroll' }, el('table', { class: 'edit' }, el('thead', null, head), tb)));
  }
}

/* ---------- job cards ---------- */
const STATE = { queued: 'Waiting for the file before it…', reading: 'Opening the PDF…', cancelled: '', failed: '', done: '' };
function jobCard(job) {
  const done = job.units.filter(u => u.status === 'ok' || u.status === 'partial').length;
  const live = job.units.reduce((n, u) => n + (u.live || 0), 0), kept = job.units.reduce((n, u) => n + u.rows.length, 0);
  const active = job.state === 'queued' || job.state === 'reading' || job.state === 'running';
  const problems = job.units.filter(u => u.status === 'err' || u.status === 'partial');
  const waiting = job.units.some(u => u.status === 'wait');
  let line = job.message || STATE[job.state] || '';
  if (job.state === 'running') {
    line = job.units.length > 1 ? `Claude is reading page by page: ${done} of ${job.units.length} pages done` : 'Claude is reading…';
    if (kept + live) line += ` · ${kept + live} ${NOUN[job.kind]} so far`;
  }
  const cls = job.state === 'done' && !problems.length ? ' ok' : job.state === 'failed' ? ' err' : '';
  const card = el('div', { class: 'job' + cls },
    el('div', { class: 'job-head' },
      el('span', null, el('span', { class: 'job-name', text: job.name }), el('span', { class: 'job-state', text: line ? ' — ' + line : '' })),
      el('span', { class: 'row' },
        !active && (problems.length || (job.state === 'cancelled' && waiting) || (job.state === 'failed' && job.units.length))
          ? el('button', { class: 'btn', type: 'button', text: job.state === 'cancelled' && waiting ? 'Resume' : problems.length > 1 ? `Retry ${problems.length} pages` : 'Retry', onclick: () => retryJob(job) }) : null,
        active ? el('button', { class: 'btn ghost', type: 'button', text: job.state === 'queued' ? 'Remove' : 'Stop', onclick: () => cancelJob(job) })
          : el('button', { class: 'btn ghost', type: 'button', title: 'Hide this message', 'aria-label': 'Hide this message', text: '×', onclick: () => dismissJob(job) }))));
  if (job.units.length > 1) {
    const TIP = { wait: 'waiting', run: 'reading', ok: 'done', partial: 'incomplete', err: 'failed' };
    card.append(el('div', { class: 'pages', 'aria-label': 'Pages' }, ...job.units.map(u =>
      el('span', { class: 'pg ' + u.status, title: `Page ${u.label}: ${TIP[u.status]}${u.rows.length ? `, ${u.rows.length} rows` : ''}`, text: u.label }))));
  }
  const errs = job.units.filter(u => u.error);
  if (errs.length) card.append(el('div', { class: 'job-errs' }, ...errs.slice(0, 6).map(u => el('span', { text: (u.page ? `Page ${u.page}: ` : '') + u.error })), errs.length > 6 ? el('span', { text: `…and ${errs.length - 6} more pages.` }) : null));
  return card;
}
let pasteNote = null;   // the one-line result of the last paste: { msg, cls }
function renderJobs() {
  for (const kind of KINDS) {
    const host = $('jobs-' + kind);
    host.textContent = '';
    if (kind === 'devices' && pasteNote) host.append(el('div', { class: 'job ' + pasteNote.cls }, el('span', { class: 'job-state', text: pasteNote.msg })));
    for (const job of jobs) if (job.kind === kind) host.append(jobCard(job));
  }
}

/* ---------- wiring ---------- */
export function initImport() {
  onJobs(renderJobs);

  for (const kind of ['plans', 'promos']) {
    const d = $('drop-' + kind), f = $('file-' + kind);
    f.onchange = () => { addPdfJobs(kind, [...f.files]); f.value = ''; };
    d.addEventListener('dragover', e => { e.preventDefault(); d.classList.add('over'); });
    d.addEventListener('dragleave', () => d.classList.remove('over'));
    d.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); d.classList.remove('over'); addPdfJobs(kind, [...e.dataTransfer.files]); });
  }
  // A file dropped beside a drop zone must not make the browser leave the page to open it.
  addEventListener('dragover', e => e.preventDefault());
  addEventListener('drop', e => e.preventDefault());

  $('parse-devices').onclick = () => {
    const text = $('paste-devices').value.trim();
    const replaceAll = !$('devices-append').checked, now = new Date();
    // When adding to the list, the time keeps a second paste on the same day from replacing the first.
    const source = 'Pasted ' + now.toLocaleDateString('en-CA') + (replaceAll ? '' : ' ' + now.toLocaleTimeString('en-CA', { hour12: false }));
    const say = (msg, cls) => { pasteNote = msg ? { msg, cls } : null; renderJobs(); };
    if (!text) { say('Paste the price list first.', 'err'); return; }
    const exact = parseSheet(text);
    if (exact) {
      const rows = exact.map(r => clean('devices', r, source));
      state.devices = state.devices.filter(i => i.source !== source && !replaceAll).concat(rows);
      commit('devices');
      say(`${rows.length} phones lined up from the price sheet layout.`, 'ok');
    } else if (!server.ai) {
      say("This text doesn't match the price sheet layout, and Claude is not connected to align it. " + server.problem, 'err');
      return;                                                   // keep the pasted text in the box
    } else { say('', ''); addTextJob('devices', text, source, replaceAll); }   // not the usual layout: Claude aligns it
    $('paste-devices').value = '';
  };

  document.querySelectorAll('[data-add]').forEach(b => b.onclick = () => {
    const k = b.dataset.add;
    state[k].push(clean(k, k === 'promos' ? { acts: 'NAC, AAL, HUP', eppLS: true } : {}, ''));
    commit(k);
  });
}
