// GET /api/catalog  — the shared price data (plans, phones, offers).
// PUT /api/catalog  — replace one of the three lists: { kind, items }.
// Stored in Netlify Blobs, so everyone using the site sees the same data.
import { getStore } from "@netlify/blobs";
import { checkAccess, json } from "../lib/access.js";

const KINDS = ["plans", "devices", "promos"];

export default async (request) => {
  const denied = checkAccess(request);
  if (denied) return denied;
  const store = getStore({ name: "quote-desk", consistency: "strong" });

  if (request.method === "GET") {
    const [plans, devices, promos] = await Promise.all(KINDS.map((k) => store.get(k, { type: "json" })));
    return json(200, { plans: plans || [], devices: devices || [], promos: promos || [], ai: !!Netlify.env.get("ANTHROPIC_API_KEY") });
  }

  if (request.method === "PUT") {
    let body;
    try { body = await request.json(); } catch { return json(400, { error: "Body must be JSON." }); }
    if (!KINDS.includes(body.kind) || !Array.isArray(body.items)) return json(400, { error: "Expected { kind, items }." });
    if (JSON.stringify(body.items).length > 3_000_000) return json(413, { error: "That list is too large to save." });
    await store.setJSON(body.kind, body.items);
    return json(200, { ok: true });
  }

  return json(405, { error: "GET or PUT only" });
};

export const config = { path: "/api/catalog" };
