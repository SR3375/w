// The one place that holds the catalog and the current sale, loads it, and saves it.
// Saving never fails silently: a failed save is retried, kept in this browser, and reported.
import { ls, sleep } from './util.js';
import { KINDS } from './catalog.js';
import { apiFetch } from './api.js';

export const state = {
  plans: [], devices: [], promos: [],
  sel: Object.assign({ carrier: '', plan: null, device: null, pay: 'fin', act: 'NAC', region: 'bcab', prog: 'std', trade: false, extras: {}, tax: 0, taxLabel: '' }, ls.get('sel', {})),
  f: { tx: '', hw: '', line: '' },
  search: '',
};

/** How the page is connected. mode: 'loading' | 'gate' | 'shared' (server) | 'local' (this browser only). */
export const server = { mode: 'loading', ai: false, problem: '', unsaved: new Set(), saving: false, saveError: '', stranded: [] };

// Two kinds of change: 'rows' (lists were added to or replaced: redraw everything) and
// 'cell' (one value was edited in place: only the pricing side needs to follow).
const subs = { rows: new Set(), cell: new Set(), status: new Set() };
export const on = (type, fn) => subs[type].add(fn);
const emit = type => subs[type].forEach(fn => fn());

export function saveSel() { ls.set('sel', state.sel); }

/* ---------- saving ---------- */
const flagUnsaved = () => ls.set('unsaved', [...server.unsaved]);
const version = { plans: 0, devices: 0, promos: 0 };   // bumped on every change, so a save knows if it is stale
let saveLoop = null;
async function runSaves() {
  server.saving = true; emit('status');
  for (let attempt = 0; server.unsaved.size; ) {
    const kind = [...server.unsaved][0];
    const sent = version[kind];
    let status = 0;
    try {
      const r = await apiFetch('/api/catalog', { method: 'PUT', body: JSON.stringify({ kind, items: state[kind] }) });
      status = r.status;
      if (!r.ok) throw r;
      // Only clear the flag if nothing changed while the request was in flight.
      if (version[kind] === sent) { server.unsaved.delete(kind); flagUnsaved(); }
      attempt = 0; server.saveError = '';
      emit('status');
    } catch {
      server.saveError = status === 401 ? 'The access code is no longer accepted. Reload the page and enter it again.'
        : status === 413 ? 'That list is too large to save. Remove some rows.'
        : 'Could not save to the server. Your changes are kept in this browser.';
      if (status === 401 || status === 413 || ++attempt >= 3) break;
      emit('status');
      await sleep(2000 * attempt);
    }
  }
  server.saving = false; saveLoop = null; emit('status');
}

/** Call after any change to state[kind]. `type` says how much of the page must redraw. */
export function commit(kind, type = 'rows') {
  version[kind]++;
  ls.set('cat:' + kind, state[kind]);            // always keep a copy in this browser
  if (server.mode === 'shared') {
    server.unsaved.add(kind); flagUnsaved();
    saveLoop ??= runSaves();
  }
  emit(type); emit('status');
}
export function retrySaves() { if (server.mode === 'shared' && server.unsaved.size) saveLoop ??= runSaves(); }
export const redraw = () => { emit('rows'); emit('status'); };

/* ---------- loading ---------- */
export async function load() {
  let res = null;
  try { res = await apiFetch('/api/catalog'); } catch {}
  const isJson = res && (res.headers.get('content-type') || '').includes('json');
  if (res && res.status === 401) { server.mode = 'gate'; emit('status'); return; }

  if (res && res.ok && isJson) {
    const j = await res.json();
    server.mode = 'shared'; server.ai = !!j.ai;
    server.problem = j.ai ? '' : 'Claude is off: ANTHROPIC_API_KEY is not set on this site. Add it in Netlify > Site configuration > Environment variables and redeploy. PDFs cannot be read until then; rows can still be added by hand.';
    for (const k of KINDS) state[k] = Array.isArray(j[k]) ? j[k] : [];
    // Rows that never reached the server last time (tab closed, connection lost).
    server.stranded = ls.get('unsaved', []).filter(k => KINDS.includes(k) && JSON.stringify(ls.get('cat:' + k, [])) !== JSON.stringify(state[k]));
    if (!server.stranded.length) ls.set('unsaved', []);
  } else {
    server.mode = 'local'; server.ai = false;
    for (const k of KINDS) state[k] = ls.get('cat:' + k, []);
    let why = '';
    if (res && isJson) why = (await res.json().catch(() => ({}))).error || '';
    server.problem = !res ? 'The server did not answer, so this page is working from this browser only and Claude is off. Check your connection and reload.'
      : why ? `The server reported a problem: ${why}`
      : `The server functions are not deployed (/api/catalog answered HTTP ${res.status}). Data is saved in this browser only and Claude is off. On Netlify, check that the netlify/edge-functions folder is in the repository and the deploy log shows no errors.`;
  }
  emit('rows'); emit('status');
}

/** Bring back rows that were edited last time but never reached the server. */
export function restoreStranded() {
  for (const k of server.stranded) { state[k] = ls.get('cat:' + k, []); commit(k); }
  server.stranded = []; emit('status');
}
export function dropStranded() { server.stranded = []; ls.set('unsaved', [...server.unsaved]); emit('status'); }
