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
