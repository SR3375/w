// Entry point: loads the catalog, shows the access gate, the status line and problem banner,
// switches between the two steps, and handles backup and restore.
import { $, el, uid } from './util.js';
import { KINDS, PREFIX, clean } from './catalog.js';
import { hasAccessCode, setAccessCode } from './api.js';
import { state, server, on, load, commit, retrySaves, restoreStranded, dropStranded } from './store.js';
import { setUnauthorizedHandler } from './importer.js';
import { initImport, renderTables } from './importView.js';
import { initPricing, renderPricing, syncFilters } from './pricingView.js';
import { initChat } from './chat.js';

/* ---------- routing ---------- */
function route() {
  if (server.mode === 'loading' || server.mode === 'gate') return;
  let v = location.hash.replace('#', '');
  if (v !== 'import' && v !== 'pricing') v = (state.plans.length || state.devices.length) ? 'pricing' : 'import';
  $('view-import').hidden = v !== 'import';
  $('view-pricing').hidden = v !== 'pricing';
  for (const t of ['import', 'pricing']) v === t ? $('tab-' + t).setAttribute('aria-current', 'page') : $('tab-' + t).removeAttribute('aria-current');
}
addEventListener('hashchange', route);

/* ---------- status line and banner ---------- */
function showGate(msg) {
  server.mode = 'gate';
  $('gate').hidden = false; $('view-import').hidden = true; $('view-pricing').hidden = true;
  $('gate-msg').textContent = msg || '';
  $('gate-code').focus();
  renderStatus();
}
function renderStatus() {
  const banner = $('banner'), text = $('banner-text'), retry = $('banner-retry');
  banner.querySelectorAll('.extra').forEach(b => b.remove());
  retry.hidden = true; banner.hidden = true; banner.className = 'banner bad';
  if (server.mode === 'loading') { $('status').textContent = 'Loading saved data…'; return; }
  if (server.mode === 'gate') { $('status').textContent = 'Enter the team access code to load prices.'; return; }

  const n = KINDS.map(k => state[k].length);
  let s = `${n[0]} plan rows · ${n[1]} phones · ${n[2]} offers`;
  if (server.mode === 'local') s += ' · saved in this browser only';
  else if (server.unsaved.size) s += server.saving ? ' · saving…' : ' · not saved yet';
  else s += ' · saved, shared with everyone who has the access code';
  $('status').textContent = s;

  // One banner, most urgent problem first.
  if (server.mode === 'shared' && server.unsaved.size && !server.saving && server.saveError) {
    text.textContent = server.saveError; retry.hidden = false; banner.hidden = false;
  } else if (server.stranded.length) {
    banner.className = 'banner warnish';
    text.textContent = `Changes made on this device last time never reached the server (${server.stranded.join(', ')}).`;
    banner.append(el('span', { class: 'row extra' },
      el('button', { class: 'btn', type: 'button', text: 'Restore them', onclick: restoreStranded }),
      el('button', { class: 'btn ghost', type: 'button', text: 'Discard', onclick: dropStranded })));
    banner.hidden = false;
  } else if (server.problem) {
    banner.className = 'banner warnish'; text.textContent = server.problem; banner.hidden = false;
  }
}

/* ---------- backup ---------- */
function initBackup() {
  $('backup-export').onclick = () => {
    const data = { app: 'quote-desk', v: 2, exported: new Date().toISOString(), plans: state.plans, devices: state.devices, promos: state.promos };
    const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' })), download: `quote-desk-${new Date().toISOString().slice(0, 10)}.backup.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  $('backup-file').onchange = async () => {
    const f = $('backup-file').files[0];
    $('backup-file').value = '';
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      if (!KINDS.every(k => Array.isArray(j[k]))) throw 0;
      for (const k of KINDS) { state[k] = j[k].map(r => ({ ...clean(k, r, r.source || f.name, r.page), id: r.id || uid(PREFIX[k]) })); commit(k); }
      $('backup-msg').textContent = `Restored ${state.plans.length} plan rows, ${state.devices.length} phones and ${state.promos.length} offers from ${f.name}.`;
    } catch { $('backup-msg').textContent = 'That file is not a Quote Desk backup.'; }
  };
}

/* ---------- start ---------- */
async function boot() {
  $('gate').hidden = true;
  await load();
  if (server.mode === 'gate') showGate(hasAccessCode() ? 'That code was not accepted. Check it and try again.' : '');
  else route();   // choose the opening step once; importing rows later must not switch tabs
}

on('rows', () => { if (server.mode === 'gate' || server.mode === 'loading') return; syncFilters(); renderTables(); renderPricing(); });
on('cell', renderPricing);
on('status', renderStatus);

initImport(); initPricing(); initChat(); initBackup();
setUnauthorizedHandler(() => showGate('The access code is no longer accepted. Enter it again.'));
$('gate-form').addEventListener('submit', e => { e.preventDefault(); setAccessCode($('gate-code').value.trim()); boot(); });
$('banner-retry').onclick = retrySaves;
addEventListener('beforeunload', e => { if (server.mode === 'shared' && server.unsaved.size) { e.preventDefault(); e.returnValue = ''; } });
boot();
