// Small helpers shared by every module. Nothing here touches the page at import time,
// so the pure modules (catalog, quote, sheet, jsonl) can also be loaded by the tests in Node.

export const $ = id => document.getElementById(id);

/** Build an element: el('td', { class: 'r', text: '…', onclick: fn }, child, child). */
export function el(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) for (const k in props) {
    const v = props[k];
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids) if (c != null) e.append(c);
  return e;
}

export const money = v => new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(v || 0);
export const fmt = n => Math.round(n || 0).toLocaleString('en-CA');
export const num = v => {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const n = parseFloat(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? n : 0;
};
export const blank = v => v === '' || v == null;
export const str = v => blank(v) ? '' : String(v).trim();
export const norm = s => str(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
export const words = s => str(s).toLowerCase().split(/[^a-z0-9$]+/).filter(Boolean);
export const list = s => str(s).split(/[,;/]+/).map(x => x.trim()).filter(Boolean);
export const uid = p => p + Math.random().toString(36).slice(2, 7);
export const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej({ code: 'cancelled' }); }, { once: true });
});

/** localStorage that never throws (private windows, blocked storage). */
export const ls = {
  get(k, d) { try { const v = localStorage.getItem('qd2:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('qd2:' + k, JSON.stringify(v)); } catch {} },
};
