# Quote Desk

A sales counter tool that answers four customer questions:

1. How much is this plan?
2. How much is this phone?
3. What is the total monthly cost?
4. What PC Optimum points do I get for signing up?

**Import data** takes carrier plan sheets (PDF), the pasted Digital Price Sheet (text) and the promo grid (PDF).
**Pricing & assistant** shows the plan and phone tables, the quote with points and RQ SKUs, and a Claude chat for customer questions.

## What is in this folder

| Path | What it is |
|---|---|
| `public/index.html`, `public/styles.css` | The page markup and its styles |
| `public/js/main.js` | Entry point: loading, access gate, status line, backup |
| `public/js/store.js` | Holds the catalog and the current sale; loads and saves it |
| `public/js/api.js` | Talks to `/api/catalog` and `/api/claude` |
| `public/js/importer.js`, `pdfread.js`, `jsonl.js`, `sheet.js` | The import pipeline (see below) |
| `public/js/importView.js`, `pricingView.js`, `chat.js` | The two steps of the page and the assistant |
| `public/js/catalog.js`, `quote.js` | Column definitions and the quote engine (pure logic, covered by tests) |
| `public/vendor/` | pdf.js 3.11.174, which reads PDFs in the browser |
| `netlify/edge-functions/claude.js` | `/api/claude`: sends a request to the Claude API with the site's key |
| `netlify/edge-functions/catalog.js` | `/api/catalog`: loads and saves the shared price data (Netlify Blobs) |
| `netlify/lib/access.js` | Checks the team access code on every API call |
| `test/` | Unit tests, a local test server and a browser test |

There is no build step: the browser loads the files in `public/` as they are.

## How importing a PDF works

1. The browser opens the PDF and, for each page, takes its text and a picture of it.
2. Each page is sent to Claude as its own small request, three pages at a time. Claude replies with one row per line.
3. Rows are added to the table as each page finishes. The job card shows one box per page: done, incomplete or failed.
4. If Claude is busy or the connection drops, the page is retried automatically. If it still fails, the rows that had already arrived are kept and a **Retry** button re-reads only those pages.
5. Files dropped while another import is running wait in a queue.
6. Importing a file with the same name again replaces the rows from that file.

A banner at the top of the page says so whenever something is wrong: the server functions are not deployed, the API key is missing, or a save did not reach the server (with a **Retry** button; the rows are also kept in the browser).

## Deploy on Netlify

1. Push this folder to a GitHub repository. **Make the repository private**, and keep price data out of it (see below).
2. In Netlify: **Add new site > Import an existing project**, pick the repository. Leave the build command empty; the base directory is the repository root (`.`) and the publish directory is `public` (both set in `netlify.toml`). Keep the folder layout shown above when pushing the files.
3. In **Site configuration > Environment variables**, add:

   | Variable | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | An API key from https://platform.claude.com (billed to that account) |
   | `ACCESS_CODE` | A passphrase you choose. Staff type it once per device to unlock the site |
   | `CLAUDE_MODEL` | Optional. Defaults to `claude-opus-5-5` |

4. Trigger a deploy (**Deploys > Trigger deploy**) so the variables take effect.
5. Open the site, enter the access code, go to **Import data > Backup > Restore from backup** and choose your backup file, or import the PDFs and paste the price sheet fresh.

## Also on GitHub Pages (optional)

The page can be served from GitHub Pages while the server routes stay on Netlify. On Pages, the page calls `https://srlwork.netlify.app/api/...` (set in `public/js/config.js`); the routes allow calls from `https://sr3375.github.io`, and further sites can be added in a Netlify variable `ALLOWED_ORIGINS` (comma separated).

1. Netlify must be deployed once with this code, so the routes allow calls from GitHub Pages.
2. In GitHub: **Settings > Pages > Build and deployment > Source: GitHub Actions**. A private repository needs a paid GitHub plan for Pages; the published site is public either way.
3. Every change to `public/` on `main` then publishes to `https://sr3375.github.io/w/` through `.github/workflows/pages.yml`.

Opening the Netlify address itself redirects to the Pages copy (set in `netlify.toml`); the `/api` routes are not redirected.

Page-only changes then need no Netlify deploy, which saves Netlify credits; changes under `netlify/` still do. The access code is remembered per address, so staff enter it once more on the Pages address.

## Things to know

- **The access code is the only lock.** Anyone with the site address and the code can read the prices and spend API credit. Use a long code, share it only with staff, and change it in Netlify if it leaks. For stronger protection, turn on Netlify's password protection or put the site behind your company login.
- **Do not commit price data.** Carrier sheets and promo grids are internal documents. Price data lives in Netlify Blobs, not in the repository; `.gitignore` already excludes `*.backup.json`.
- **Claude costs money per use.** Importing a plan sheet or promo grid is one request per page; each assistant question is one or a few small ones. Pasting the Digital Price Sheet is free (it is read without Claude).
- **Refusal fallback is on.** If a safety filter declines a request, the API retries it on a fallback model automatically.
- **Saving is last-write-wins.** If two people edit the same list at once, the later save replaces the earlier one. Download a backup before big changes.

## Run locally (optional)

With Netlify and real keys (put `ANTHROPIC_API_KEY` and `ACCESS_CODE` in a `.env` file first; it is ignored by git):

```bash
npm ci
```

```bash
npx netlify dev
```

Without Netlify or a key, against a fake Claude (access code `test`, data kept in memory):

```bash
node test/dev-server.mjs
```

## Tests

```bash
npm test
```

runs the unit tests for the quote engine, the price sheet reader and the row parser. `node test/e2e.mjs` runs the import flow in a real browser against `test/dev-server.mjs`, and `node test/cross-origin.mjs` checks the GitHub Pages setup (start the test server with `ALLOWED_ORIGINS=http://localhost:8898`); both need Playwright installed.
