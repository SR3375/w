// Where the server routes (/api/catalog, /api/claude) live.
// On Netlify the page and the routes share one address, so the base is empty.
// On GitHub Pages there is no server, so the page calls the routes on the Netlify site.
export const NETLIFY_SITE = 'https://lsrwork.netlify.app';
export const ON_GITHUB_PAGES = location.hostname.endsWith('github.io');
export const API_BASE = globalThis.QD_API_BASE ?? (ON_GITHUB_PAGES ? NETLIFY_SITE : '');
