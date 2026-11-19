// Everything that talks to this site's own server routes: /api/catalog and /api/claude.
// Errors are thrown as { code, message } so callers can show a plain sentence.
import { API_BASE } from './config.js';

let accessCode = '';
try { accessCode = localStorage.getItem('qd2:code') || ''; } catch {}
export const hasAccessCode = () => !!accessCode;
export function setAccessCode(code) { accessCode = code; try { localStorage.setItem('qd2:code', code); } catch {} }

export const apiFetch = (path, opts = {}) =>
  fetch(API_BASE + path, { ...opts, headers: { 'content-type': 'application/json', 'x-access-code': accessCode, ...(opts.headers || {}) } });

export const ERR = {
  unauthorized: 'The access code is no longer accepted. Reload the page and enter it again.',
  rate_limited: 'Claude is busy or the API rate limit was reached.',
  prompt_too_large: 'That is too much for one request.',
  refused: 'Claude declined this content.',
  empty_completion: 'Claude returned nothing.',
  no_server: 'The server did not answer. Check your connection.',
  cancelled: 'Cancelled.',
};
export const errText = e => ERR[e?.code] || (e?.message ? String(e.message) : 'Something went wrong talking to Claude.');
export const retryable = e => e?.code === 'rate_limited' || e?.code === 'upstream_error' || e?.code === 'no_server' || e?.code === 'cut';

const b64 = blob => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1]);
  r.onerror = rej;
  r.readAsDataURL(blob);
});

/** One request to /api/claude. Reads the event stream and rebuilds the message. */
async function claudeTurn(body, signal, onDelta) {
  let res;
  try { res = await apiFetch('/api/claude', { method: 'POST', body: JSON.stringify(body), signal }); }
  catch { throw { code: signal?.aborted ? 'cancelled' : 'no_server' }; }
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    const code = res.status === 401 ? 'unauthorized' : res.status === 429 || res.status === 529 ? 'rate_limited' : res.status === 413 ? 'prompt_too_large' : res.status === 404 ? 'no_route' : 'upstream_error';
    throw { code, message: j.error || `The server answered with HTTP ${res.status}.` };
  }
  const blocks = [], bufs = {};
  let stop = null, pending = '';
  const handle = ev => {
    if (ev.type === 'content_block_start') {
      blocks[ev.index] = { ...ev.content_block };
      if (ev.content_block.type === 'tool_use') bufs[ev.index] = '';
    } else if (ev.type === 'content_block_delta') {
      const b = blocks[ev.index], d = ev.delta;
      if (!b) return;
      if (d.type === 'text_delta') { b.text += d.text; onDelta(d.text); }
      else if (d.type === 'input_json_delta') bufs[ev.index] += d.partial_json;
      else if (d.type === 'thinking_delta') b.thinking += d.thinking;
      else if (d.type === 'signature_delta') b.signature = d.signature;
    } else if (ev.type === 'content_block_stop') {
      if (ev.index in bufs) {
        try { blocks[ev.index].input = JSON.parse(bufs[ev.index] || '{}'); }
        catch { blocks[ev.index].input = {}; blocks[ev.index]._bad = true; }
      }
    } else if (ev.type === 'message_delta') {
      if (ev.delta?.stop_reason) stop = ev.delta.stop_reason;
    } else if (ev.type === 'error') {
      throw { code: /overloaded|rate_limit/.test(ev.error?.type || '') ? 'rate_limited' : 'upstream_error', message: ev.error?.message };
    }
  };
  const reader = res.body.getReader(), dec = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += dec.decode(value, { stream: true });
      let i;
      while ((i = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, i).trim();
        pending = pending.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const t = line.slice(5).trim();
        if (t && t !== '[DONE]') handle(JSON.parse(t));
      }
    }
  } catch (e) {
    if (e?.code) throw e;
    throw { code: signal?.aborted ? 'cancelled' : 'cut', message: 'The connection dropped before Claude finished.' };
  }
  // The stream ended without a stop reason: the connection was cut part way through.
  if (!stop) throw { code: 'cut', message: 'The connection dropped before Claude finished.' };
  return { content: blocks.filter(Boolean), stop };
}

/**
 * Ask Claude and get the full text back, running any tool calls on the way.
 * @param input  a prompt string, or [{ role, content }] turns
 * @param o      { kind: 'chat' | 'extract', system, images: Blob[], tools, signal, onText({ text, delta }) }
 * @returns      { text, truncated }. A thrown error carries `text` with whatever had arrived.
 */
export async function converse(input, o = {}) {
  const turns = typeof input === 'string' ? [{ role: 'user', content: input }] : input.map(t => ({ role: t.role, content: t.content }));
  if (o.images?.length) {
    const last = turns[turns.length - 1], imgs = [];
    for (const b of o.images) imgs.push({ type: 'image', source: { type: 'base64', media_type: b.type || 'image/jpeg', data: await b64(b) } });
    last.content = [...imgs, { type: 'text', text: last.content }];
  }
  const tools = (o.tools || []).map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema || { type: 'object', properties: {} } }));
  let text = '', truncated = false;
  try {
    for (let round = 0; round < 6; round++) {
      let first = true;
      const { content, stop } = await claudeTurn(
        { kind: o.kind || 'chat', system: o.system, messages: turns, tools: tools.length ? tools : undefined },
        o.signal,
        d => { if (first && text) d = '\n\n' + d; first = false; text += d; o.onText?.({ text, delta: d }); },
      );
      if (stop === 'refusal') throw { code: 'refused' };
      if (stop === 'max_tokens') { truncated = true; break; }
      if (stop === 'pause_turn') { turns.push({ role: 'assistant', content }); continue; }
      if (stop !== 'tool_use') break;
      const results = await Promise.all(content.filter(b => b.type === 'tool_use').map(async b => {
        const bad = b._bad; delete b._bad;
        if (bad) return { type: 'tool_result', tool_use_id: b.id, content: 'Error: the tool input was not valid JSON', is_error: true };
        try {
          const t = o.tools.find(x => x.name === b.name);
          if (!t) throw new Error('Unknown tool');
          const r = await t.execute(b.input || {}, { signal: o.signal });
          return { type: 'tool_result', tool_use_id: b.id, content: typeof r === 'string' ? r : JSON.stringify(r) };
        } catch (e) { return { type: 'tool_result', tool_use_id: b.id, content: 'Error: ' + (e?.message || e), is_error: true }; }
      }));
      turns.push({ role: 'assistant', content }, { role: 'user', content: results });
    }
  } catch (e) {
    throw { code: e?.code || 'upstream_error', message: e?.message, text };
  }
  if (!text.trim()) throw { code: 'empty_completion', text: '' };
  return { text: text.trim(), truncated };
}
