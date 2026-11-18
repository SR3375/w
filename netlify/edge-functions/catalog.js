// GET /api/catalog  — the shared price data (plans, phones, offers).
// PUT /api/catalog  — replace one of the three lists: { kind, items }.
// Stored in Netlify Blobs, so everyone using the site sees the same data.
import { getStore } from "@netlify/blobs";
import { checkAccess, json, safely } from "../lib/access.js";

const KINDS = ["plans", "devices", "promos"];
const STORE = "quote-desk";

// Read the freshest copy when the platform allows it; where a strongly consistent read is not
// available, fall back to the normal read instead of failing the whole page.
async function read(key) {
  try { return await getStore({ name: STORE, consistency: "strong" }).get(key, { type: "json" }); }
  catch (err) {
    if (err?.name !== "BlobsConsistencyError") throw err;
    return await getStore(STORE).get(key, { type: "json" });
  }
}

export default safely(async (request) => {
  const denied = checkAccess(request);
  if (denied) return denied;

  if (request.method === "GET") {
    const [plans, devices, promos] = await Promise.all(KINDS.map(read));
    return json(200, { plans: plans || [], devices: devices || [], promos: promos || [], ai: !!Netlify.env.get("ANTHROPIC_API_KEY") });
  }

  if (request.method === "PUT") {
    let body;
    try { body = await request.json(); } catch { return json(400, { error: "Body must be JSON." }); }
    if (!KINDS.includes(body.kind) || !Array.isArray(body.items)) return json(400, { error: "Expected { kind, items }." });
    if (JSON.stringify(body.items).length > 3_000_000) return json(413, { error: "That list is too large to save." });
    await getStore(STORE).setJSON(body.kind, body.items);
    return json(200, { ok: true });
  }

  return json(405, { error: "GET or PUT only" });
});

export const config = { path: "/api/catalog" };
