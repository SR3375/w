// Checks the GitHub Pages setup: the page served from one address calls the routes on another.
//   ALLOWED_ORIGINS=http://localhost:8898 node test/dev-server.mjs &
//   node test/cross-origin.mjs
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const API = 'http://localhost:8899', PAGE = 'http://localhost:8898', OTHER = 'http://localhost:8897';
const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
// A plain static server, like GitHub Pages: no /api routes at all.
const statics = [8898, 8897].map(port => http.createServer((req, res) => {
  const file = path.join(pub, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  if (!file.startsWith(pub) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(port));

await fetch(API + '/__mode', { method: 'POST', body: JSON.stringify({ reset: true }) });
const browser = await chromium.launch();
async function open(origin) {
  const p = await browser.newPage();
  await p.addInitScript(api => { window.QD_API_BASE = api; localStorage.setItem('qd2:code', 'test'); }, API);
  await p.goto(origin + '/#import');
  await p.waitForFunction(() => !/Loading/.test(document.querySelector('#status').textContent));
  return p;
}

const p = await open(PAGE);
assert.match(await p.textContent('#status'), /shared with everyone/, 'allowed site loads the shared catalog');
await p.fill('#paste-devices', ['Rogers', 'Apple iPhone 17 256', '1,335.84', '0.00', '0', '125,000', '45.66', '240.00', '688.00', '17.00', '18/11/26 02:49 AM'].join('\n'));
await p.click('#parse-devices');
await p.waitForFunction(() => /not saved yet|saving/.test(document.querySelector('#status').textContent) === false && /1 phones/.test(document.querySelector('#status').textContent));
assert.equal((await (await fetch(API + '/__seen')).json()).store.devices, 1, 'save went through across sites');
await p.fill('#paste-devices', 'odd layout text');
await p.click('#parse-devices');
await p.waitForFunction(() => /rows imported/.test(document.querySelector('#jobs-devices').textContent), null, { timeout: 30000 });
console.log('ok  - an allowed site reads, saves and streams Claude replies across sites');

const q = await open(OTHER);
assert.match(await q.textContent('#status'), /this browser only/, 'a site not on the list is refused');
assert.match(await q.textContent('#banner-text'), /could not reach the server routes at http:\/\/localhost:8899/);
console.log('ok  - a site not on the list is refused, with a message that says why');

await browser.close();
statics.forEach(s => s.close());
