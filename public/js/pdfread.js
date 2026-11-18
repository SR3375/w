// Reading a PDF in the browser with pdf.js: the text of each page laid back out in rows and
// columns, and a picture of the page so Claude can see which value sits in which cell.
// pdf.js is loaded only when the first PDF is dropped, and runs in a worker so the page stays responsive.

let loading = null;
function loadPdfJs() {
  loading ??= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'vendor/pdf.min.js';
    s.onload = () => {
      if (!window.pdfjsLib) return rej({ message: 'The PDF reader did not load. Reload the page and try again.' });
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
      res(window.pdfjsLib);
    };
    s.onerror = () => { loading = null; rej({ message: 'The PDF reader (vendor/pdf.min.js) could not be downloaded. Check your connection and try again.' }); };
    document.head.append(s);
  });
  return loading;
}

/** Group the text items of a page into rows by height, then join each row left to right. */
function layout(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4], y = it.transform[5];
    let r = rows.find(r => Math.abs(r.y - y) < 3);
    if (!r) rows.push(r = { y, items: [] });
    r.items.push({ x, w: it.width || 0, s: it.str });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map(r => {
    r.items.sort((a, b) => a.x - b.x);
    let out = '', end = null;
    for (const i of r.items) {
      if (end != null) out += i.x - end > 14 ? '   |   ' : i.x - end > 1 ? ' ' : '';   // a wide gap is a column break
      out += i.s;
      end = i.x + i.w;
    }
    return out;
  }).join('\n');
}

/** Open a PDF file. Returns { pages, text(n), image(n), close() }, pages numbered from 1. */
export async function openPdf(file) {
  const lib = await loadPdfJs();
  let doc;
  try { doc = await lib.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false }).promise; }
  catch (e) {
    throw { message: e?.name === 'PasswordException' ? 'This PDF is password protected. Remove the password and try again.' : 'This file could not be opened as a PDF. It may be damaged.' };
  }
  const texts = new Map();
  return {
    pages: doc.numPages,
    text(n) {
      if (!texts.has(n)) texts.set(n, doc.getPage(n).then(p => p.getTextContent()).then(tc => layout(tc.items)));
      return texts.get(n);
    },
    async image(n) {
      const page = await doc.getPage(n), base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: Math.min(2.2, 1500 / base.width) });
      const c = document.createElement('canvas');
      c.width = vp.width; c.height = vp.height;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
      c.width = c.height = 0;   // release the bitmap
      return blob;
    },
    close() { doc.destroy(); },
  };
}
