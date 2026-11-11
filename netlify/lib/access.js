// Shared gate for every API route: the caller must send the team access code.
export const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export function checkAccess(request) {
  const expected = Netlify.env.get("ACCESS_CODE");
  if (!expected) return json(500, { error: "ACCESS_CODE is not set on this site. Add it in Netlify > Site configuration > Environment variables, then redeploy." });
  const given = request.headers.get("x-access-code") || "";
  let diff = given.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ (given.charCodeAt(i) || 0);
  return diff === 0 ? null : json(401, { error: "Wrong or missing access code." });
}
