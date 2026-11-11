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
| `public/index.html` | The whole page (HTML, CSS and JavaScript in one file) |
| `netlify/edge-functions/claude.js` | `/api/claude`: sends a request to the Claude API with the site's key |
| `netlify/edge-functions/catalog.js` | `/api/catalog`: loads and saves the shared price data (Netlify Blobs) |
| `netlify/lib/access.js` | Checks the team access code on every API call |
| `netlify.toml`, `package.json` | Netlify settings and the two dependencies |

## Deploy on Netlify

1. Push this folder to a GitHub repository. **Make the repository private**, and keep price data out of it (see below).
2. In Netlify: **Add new site > Import an existing project**, pick the repository. Leave the build command empty; the publish directory is `public` (already set in `netlify.toml`).
3. In **Site configuration > Environment variables**, add:

   | Variable | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | An API key from https://platform.claude.com (billed to that account) |
   | `ACCESS_CODE` | A passphrase you choose. Staff type it once per device to unlock the site |
   | `CLAUDE_MODEL` | Optional. Defaults to `claude-opus-5-5` |

4. Trigger a deploy (**Deploys > Trigger deploy**) so the variables take effect.
5. Open the site, enter the access code, go to **Import data > Backup > Restore from backup** and choose your backup file, or import the PDFs and paste the price sheet fresh.

## Things to know

- **The access code is the only lock.** Anyone with the site address and the code can read the prices and spend API credit. Use a long code, share it only with staff, and change it in Netlify if it leaks. For stronger protection, turn on Netlify's password protection or put the site behind your company login.
- **Do not commit price data.** Carrier sheets and promo grids are internal documents. Price data lives in Netlify Blobs, not in the repository; `.gitignore` already excludes `*.backup.json`.
- **Claude costs money per use.** Importing a plan sheet or promo grid is one larger request; each assistant question is one or a few small ones. Pasting the Digital Price Sheet is free (it is read without Claude).
- **Refusal fallback is on.** If a safety filter declines a request, the API retries it on a fallback model automatically.
- **Saving is last-write-wins.** If two people edit the same list at once, the later save replaces the earlier one. Download a backup before big changes.

## Run locally (optional)

```bash
npm install
```

```bash
npx netlify dev
```

Put `ANTHROPIC_API_KEY` and `ACCESS_CODE` in a `.env` file first (it is ignored by git).
