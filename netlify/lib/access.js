// Shared by every API route: JSON replies, and the team access code check.
export const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** Returns null when the caller sent the right access code, or the error response to send back. */
export function checkAccess(request) {
  const expected = Netlify.env.get("ACCESS_CODE");
  if (!expected) return json(500, { error: "ACCESS_CODE is not set on this site. Add it in Netlify > Site configuration > Environment variables, then redeploy." });
  const given = request.headers.get("x-access-code") || "";
  // Compare every character so the time taken does not reveal how much of the code matched.
  let diff = given.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ (given.charCodeAt(i) || 0);
  return diff === 0 ? null : json(401, { error: "Wrong or missing access code." });
}

/** Wrap a route so a crash comes back as a readable JSON error instead of a blank 500 page. */
export const safely = (handler) => async (request, context) => {
  try { return await handler(request, context); }
  catch (err) {
    console.error(err);
    return json(500, { error: `${err?.name || "Error"}: ${err?.message || "the server function crashed"}` });
  }
};

// The page can also be served from GitHub Pages, which is a different site, so the browser
// asks these routes for permission first (CORS). Extra sites can be listed in ALLOWED_ORIGINS,
// separated by commas.
const DEFAULT_ORIGINS = ["https://sr3375.github.io"];
function allowedOrigin(request) {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const extra = (Netlify.env.get("ALLOWED_ORIGINS") || "").split(",").map((s) => s.trim()).filter(Boolean);
  return [...DEFAULT_ORIGINS, ...extra].includes(origin) ? origin : null;
}

/** Wrap a route so an allowed other site may call it: answers the preflight and labels every reply. */
export const withCors = (handler) => async (request, context) => {
  const origin = allowedOrigin(request);
  const cors = origin ? {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, PUT, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-access-code",
    "access-control-max-age": "86400",
    vary: "Origin",
  } : { vary: "Origin" };
  if (request.method === "OPTIONS") return new Response(null, { status: origin ? 204 : 403, headers: cors });
  const res = await handler(request, context);
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
};
