// A local stand-in for the deployed site, for testing without Netlify or an API key.
//   node test/dev-server.mjs            -> http://localhost:8899  (access code: test)
// It serves public/, runs the REAL netlify/edge-functions/claude.js handler against a fake
// Claude API, and keeps the catalog in memory. POST /__mode {…} switches on failures to test:
//   { overloadOnce: 2 }  page 2 answers "overloaded" once, then works
//   { truncate: 3 }      page 3 stops at max_tokens half way through a row
//   { cut: 4 }           page 4's connection drops mid-reply
//   { failSaves: true }  PUT /api/catalog answers 500
//   { slow: 400 }        milliseconds between streamed rows
//   { reset: true }      empty the catalog
// ALLOWED_ORIGINS=http://localhost:8898 lets a copy of the page on another port call these routes.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.join(here, '..', 'public');
const PORT = Number(process.env.PORT || 8899), FAKE = PORT + 1;
const mode = {};
const seen = { requests: 0, overloaded: new Set() };

/* ---------- fake Claude API ---------- */
const sse = (res, ev) => res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
const wait = ms => new Promise(r => setTimeout(r, ms));
function rowsFor(prompt, page) {
  if (/promo grid/.test(prompt)) return [1, 2].map(i => ({ name: `Rogers offer p${page}-${i}`, carrier: 'Rogers', points: 25000 * i, stack: 'bpo', acts: 'NAC, AAL, HUP', purchase: 'fin', region: 'all', eppLS: true, sku: 'ACRORB00452' + i }));
  if (/phone price list/.test(prompt)) return [{ carrier: 'Rogers', name: 'Test Phone', msrp: 500, price: 0, pco: 10000, bpo: 20000, finMonthly: 20.83 }];
  return ['Primary', 'Line 2', 'Line 3'].map((line, i) => ({ carrier: 'Rogers', name: `Plan P${page}`, data: 'Unlimited', transaction: 'NAC', hardware: i ? 'BYOD' : 'Financing - Max', line, monthlyPrice: 80 + page + i, regularPrice: 100, code: 'C' + page + i, features: 'CAN+US', notes: 'note with } brace' }));
}
http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  seen.requests++;
  const body = JSON.parse(raw);
  const last = body.messages.at(-1).content;
  const prompt = typeof last === 'string' ? last : last.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const page = Number((prompt.match(/PAGE (\d+) of/) || [])[1] || 1);
  const isExtract = /JSON Lines/.test(prompt);

  if (isExtract && mode.overloadOnce === page && !seen.overloaded.has(page)) {
    seen.overloaded.add(page);
    res.writeHead(529, { 'content-type': 'application/json', 'x-should-retry': 'false' });
    return res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  sse(res, { type: 'message_start', message: { id: 'msg_test', role: 'assistant', content: [] } });
  sse(res, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
  sse(res, { type: 'content_block_stop', index: 0 });
  sse(res, { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
  const lines = isExtract ? rowsFor(prompt, page).map(r => JSON.stringify(r) + '\n') : ['Say to the customer: this is a test answer.\n', '@@PICK {"plan":null,"device":null}'];
  for (const [i, line] of lines.entries()) {
    await wait(mode.slow || 30);
    const stopHere = isExtract && i === lines.length - 1 && (mode.truncate === page || mode.cut === page);
    sse(res, { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: stopHere ? line.slice(0, 40) : line } });
    if (stopHere && mode.cut === page) return res.destroy();
    if (stopHere) { sse(res, { type: 'content_block_stop', index: 1 }); sse(res, { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }); sse(res, { type: 'message_stop' }); return res.end(); }
  }
  sse(res, { type: 'content_block_stop', index: 1 });
  sse(res, { type: 'message_delta', delta: { stop_reason: 'end_turn' } });
  sse(res, { type: 'message_stop' });
  res.end();
}).listen(FAKE);

/* ---------- the site ---------- */
process.env.ANTHROPIC_BASE_URL = `http://localhost:${FAKE}`;
const env = { ACCESS_CODE: 'test', ANTHROPIC_API_KEY: process.env.NO_KEY ? '' : 'sk-test', ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || '' };
globalThis.Netlify = { env: { get: k => env[k] } };
const { default: claude } = await import('../netlify/edge-functions/claude.js');
const { checkAccess, json, withCors } = await import('../netlify/lib/access.js');

const store = { plans: [], devices: [], promos: [] };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.txt': 'text/plain' };

// Stand-in for netlify/edge-functions/catalog.js (Netlify Blobs only runs on Netlify).
const catalog = withCors(async (request) => {
  const denied = checkAccess(request);
  if (denied) return denied;
  if (request.method === 'PUT') {
    if (mode.failSaves) return json(500, { error: 'test: save failed' });
    const j = await request.json();
    store[j.kind] = j.items;
    return json(200, { ok: true });
  }
  return json(200, { ...store, ai: !!env.ANTHROPIC_API_KEY });
});

async function send(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) return res.end();
  try { for await (const chunk of response.body) res.write(chunk); res.end(); }
  catch { res.destroy(); }                       // upstream dropped: drop the browser's connection too
}
http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const request = new Request(url, { method: req.method, headers: req.headers, body: body.length ? body : undefined });

  if (url.pathname === '/__mode') { for (const k in mode) delete mode[k]; Object.assign(mode, JSON.parse(body.toString() || '{}')); seen.overloaded.clear(); if (mode.reset) for (const k in store) store[k] = []; return send(res, json(200, mode)); }
  if (url.pathname === '/__seen') return send(res, json(200, { requests: seen.requests, store: { plans: store.plans.length, devices: store.devices.length, promos: store.promos.length } }));
  if (url.pathname === '/api/claude') return send(res, await claude(request));
  if (url.pathname === '/api/catalog') return send(res, await catalog(request));
  const file = path.join(pub, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(pub) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`Quote Desk test server: http://localhost:${PORT}  (access code: test)`));
