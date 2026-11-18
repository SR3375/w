// Pull every complete top-level JSON object out of a piece of model output.
// It does not care whether the objects arrive one per line, inside an array, pretty-printed,
// wrapped in a code fence, or cut off half way: whatever is complete is returned, and the
// unfinished tail is simply ignored. This is what lets an import keep its rows when a reply
// is truncated or the connection drops.
export function scanObjects(text) {
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { if (depth) inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}' && depth) {
      depth--;
      if (depth === 0) {
        try { const o = JSON.parse(text.slice(start, i + 1)); if (o && typeof o === 'object') out.push(o); } catch {}
        start = -1;
      }
    }
  }
  // { "items": [ … ] } wrapper: unwrap it.
  if (out.length === 1 && Array.isArray(out[0].items)) return out[0].items.filter(o => o && typeof o === 'object');
  return out;
}
