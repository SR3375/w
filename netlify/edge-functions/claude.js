// POST /api/claude — one Claude turn, streamed back to the page as server-sent events.
// The API key stays on the server; the page only ever talks to this route.
import Anthropic from "@anthropic-ai/sdk";
import { checkAccess, json, safely, withCors } from "../lib/access.js";

export default withCors(safely(async (request) => {
  if (request.method !== "POST") return json(405, { error: "POST only" });
  const denied = checkAccess(request);
  if (denied) return denied;

  // Trimmed: a space or line break pasted along with the key makes Claude reject it.
  const apiKey = (Netlify.env.get("ANTHROPIC_API_KEY") || "").trim();
  if (!apiKey) return json(500, { error: "ANTHROPIC_API_KEY is not set on this site." });

  let body;
  try { body = await request.json(); } catch { return json(400, { error: "Body must be JSON." }); }
  if (!Array.isArray(body.messages) || !body.messages.length) return json(400, { error: "messages is required." });

  // "extract" = reading one page of a plan sheet or promo grid into rows (careful, longer output).
  // "chat"    = the sales assistant (shorter, faster).
  const extract = body.kind === "extract";
  const client = new Anthropic({ apiKey });
  const model = Netlify.env.get("CLAUDE_MODEL") || "claude-opus-5-5";
  // Haiku models have no server-side refusal fallback, so the fallback options are left out for them.
  const fallback = /haiku/i.test(model) ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };

  try {
    const upstream = await client.beta.messages
      .create({
        model,
        max_tokens: extract ? 64000 : 16000,
        thinking: { type: "adaptive" },
        output_config: { effort: extract ? "high" : "medium" },
        // If a safety classifier declines a request, let the API retry it on a fallback model.
        ...fallback,
        ...(typeof body.system === "string" && body.system ? { system: body.system } : {}),
        ...(Array.isArray(body.tools) && body.tools.length ? { tools: body.tools } : {}),
        messages: body.messages,
        stream: true,
      })
      .asResponse();
    // Pass the event stream straight through; the page assembles the message.
    return new Response(upstream.body, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
    });
  } catch (err) {
    // Claude's own explanation, e.g. "invalid x-api-key", without the raw JSON around it.
    const why = err?.error?.error?.message || err?.message || "";
    // 502, not 401/403: to the page, 401 means a wrong team access code.
    if (err instanceof Anthropic.AuthenticationError)
      return json(502, { code: "bad_key", error: `Claude rejected this site's API key (${why}). Check ANTHROPIC_API_KEY in Netlify: it should be an API key from platform.claude.com starting with sk-ant-api, copied in full. Then redeploy.` });
    if (err instanceof Anthropic.PermissionDeniedError)
      return json(502, { code: "bad_key", error: `This site's API key is not allowed to make this request (${why}). Check the key's workspace and the model in CLAUDE_MODEL.` });
    if (err instanceof Anthropic.RateLimitError) return json(429, { error: "Claude rate limit reached." });
    if (err instanceof Anthropic.APIError)
      return json(err.status && err.status !== 401 ? err.status : 502, { code: err.status >= 500 ? undefined : "bad_request", error: why });
    return json(502, { error: "Could not reach Claude." });
  }
}));

export const config = { path: "/api/claude" };
