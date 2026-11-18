// "Ask Claude": the rep types a customer question; Claude answers from the imported catalog only
// and names its best match, which the page can show as an exact quote.
import { $, el, blank, num, fmt, money } from './util.js';
import { canon, sameCarrier } from './catalog.js';
import { ACT } from './quote.js';
import { converse, ERR } from './api.js';
import { state, server, saveSel } from './store.js';
import { quote, carriers, renderPricing } from './pricingView.js';

const turns = [];
let ctl = null;

/** The whole catalog as compact pipe-separated text for the system prompt. */
function catalogText() {
  const q = quote(), c = state.sel.carrier, L = [];
  L.push(`CARRIER ON SCREEN: ${c || 'none'}. Other carriers with data: ${carriers().filter(x => !sameCarrier(x, c)).join(', ') || 'none'}.`);
  L.push('', 'PLANS (id | carrier | plan | data | type | hardware | line | net $/month | regular $ | includes | plan offers)');
  for (const p of state.plans) L.push([p.id, p.carrier, p.name, p.data, p.transaction, p.hardware, p.line, num(p.monthlyPrice), blank(p.regularPrice) ? '' : num(p.regularPrice), p.features, p.notes].join(' | '));
  L.push('', 'PHONES (id | carrier | phone | MSRP | price due today when financed | financing $/month over 24 | deferred payment | $/month with deferral | device PCO points | best-case BPO points)');
  for (const d of state.devices) L.push([d.id, d.carrier, d.name, num(d.msrp), num(d.price), blank(d.finMonthly) ? 'no financing' : num(d.finMonthly), blank(d.defPmt) ? '' : num(d.defPmt), blank(d.finDefMonthly) ? '' : num(d.finDefMonthly), num(d.pco), num(d.bpo)].join(' | '));
  L.push('', 'POINTS OFFERS (offer | carrier, blank = any | points | stacking | activation types | purchase | region | needs trade-in | plan must be | min plan $ | excluded phones | Loblaw/Student EPP ok | credited later | notes)');
  for (const o of state.promos) L.push([o.name, o.carrier, num(o.points), o.stack, o.acts, o.purchase, o.region, o.trade ? 'yes' : 'no', o.plans, num(o.minPlanPrice) || '', o.devExclude, o.eppLS ? 'yes' : 'no', o.pending ? 'yes' : 'no', o.notes].join(' | '));
  L.push('', `SALE DETAILS ON SCREEN: ${ACT[state.sel.act]} (${state.sel.act}), region ${state.sel.region === 'bcab' ? 'BC / AB' : 'rest of Canada'}, program ${state.sel.prog}, trade-in ${state.sel.trade ? 'yes' : 'no'}.`);
  L.push(`SELECTED ON SCREEN: plan ${q.plan ? q.plan.id : 'none'}, phone ${q.dev ? q.dev.id : 'none'}. Exact result for it: ${money(q.sub)}/month before tax, ${fmt(q.now)} points today${q.later ? `, ${fmt(q.later)} later` : ''} (${q.applied.map(o => `${o.name} ${fmt(num(o.points))}`).join('; ') || 'no offers'}).`);
  return L.join('\n');
}

const rules = () => `You are helping a sales rep at a Canadian wireless retail counter (The Mobile Shop style: carrier plans, phones, PC Optimum points). The rep types what a customer asked or needs. Using ONLY the catalog below, write:

Say to the customer: 2 to 5 friendly sentences the rep can read out, with exact prices.
Best match: carrier, plan, phone if any, monthly total before tax (plan net price + phone monthly payment), and the PC Optimum points earned with the offers that produce them.
Alternative: one other option only if it is a real trade-off (cheaper, more data, more points).

Rules: never invent a price, plan, phone or offer. If the catalog lacks something, say what is missing. Match the plan row to the sale: new customers use NAC rows, upgrades use HUP rows, a financed phone needs a Financing hardware row, no phone uses BYOD. Points: "excl" offers do not combine with "bpo" offers or device PCO points, so count whichever side is larger; "perk" offers always add; "extra" offers only if the rep says so. Device PCO points need a financed phone. THUP and EPP/RPP activations earn nothing, except Loblaw / Student EPP on Rogers or Bell. 1,000 points = $1. You have a quote tool that returns the exact monthly total and points for a plan id and phone id under the sale details on screen: call it for your best match (and the alternative) before you answer, at most 3 calls, and use its numbers. Reply in the language the rep wrote in. Plain text only, no markdown symbols.
End with one final line, exactly in this form, naming your best match by id (null where none): @@PICK {"plan":"<plan id or null>","device":"<phone id or null>"}

CATALOG
${catalogText()}`;

/** Split the answer from its trailing "@@PICK {...}" line. */
function splitPick(text) {
  const i = text.indexOf('@@');
  if (i < 0) return { body: text.trim(), pick: null };
  let pick = null;
  const m = text.slice(i).match(/\{[\s\S]*\}/);
  if (m) { try { pick = JSON.parse(m[0]); } catch {} }
  return { body: text.slice(0, i).trim(), pick };
}
function pickSel(pick) {
  const plan = state.plans.find(p => p.id === pick?.plan) || null, dev = state.devices.find(d => d.id === pick?.device) || null;
  if (!plan && !dev) return null;
  return { carrier: canon((plan || dev).carrier), plan: plan?.id ?? null, device: dev && (!plan || sameCarrier(dev.carrier, plan.carrier)) ? dev.id : null };
}

const TOOLS = [{
  name: 'quote',
  description: 'Exact monthly total before tax and exact PC Optimum points for one plan and/or phone under the sale details currently on screen. Returns monthlyBeforeTax, phoneMonthly, dueToday, pointsToday, pointsLater, appliedOffers and notApplied with reasons.',
  inputSchema: { type: 'object', properties: { plan: { type: 'string', description: 'plan id, or empty' }, device: { type: 'string', description: 'phone id, or empty for BYOD' } } },
  execute(input) {
    const s = pickSel({ plan: String(input.plan || ''), device: String(input.device || '') });
    if (!s) throw new Error('Unknown plan and phone id');
    const q = quote(s);
    return {
      carrier: q.carrier, monthlyBeforeTax: +q.sub.toFixed(2), phoneMonthly: +q.devM.toFixed(2), dueToday: q.due, pointsToday: q.now, pointsLater: q.later,
      appliedOffers: q.applied.map(o => ({ offer: o.name, points: num(o.points) })),
      notApplied: q.out.slice(0, 8).map(({ o, why }) => ({ offer: o.name, why })),
    };
  },
}];

function addMsg(role, text) {
  const m = el('div', { class: 'msg ' + (role === 'user' ? 'user' : 'bot'), text });
  $('msgs').append(m);
  return m;
}
function addPick(pick) {
  const s = pickSel(pick);
  if (!s) return;
  const q = quote(s);
  const show = () => {
    Object.assign(state.sel, s);
    state.f = { tx: '', hw: '', line: '' };
    saveSel(); renderPricing();
    document.querySelector('.slip').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
  };
  $('msgs').append(el('div', { class: 'pickbar' },
    el('span', { class: 'num' }, el('b', { text: [q.carrier, q.plan && `${q.plan.name} (${q.plan.hardware})`, q.dev?.name].filter(Boolean).join(' · ') }), ` · ${money(q.sub)}/mo before tax · ${fmt(q.now)} pts`),
    el('button', { class: 'btn', type: 'button', text: 'Show this quote', onclick: show })));
}

async function ask() {
  const text = $('chat-in').value.trim();
  if (!text || ctl) return;
  if (!server.ai) { $('chat-note').textContent = server.problem || 'Claude is not connected.'; return; }
  if (!state.plans.length && !state.devices.length) { $('chat-note').textContent = 'Import plans or phones first so Claude has prices to work from.'; return; }
  $('chat-in').value = ''; $('chat-note').textContent = ''; $('starters').hidden = true;
  addMsg('user', text);
  turns.push({ role: 'user', content: text });
  const bubble = addMsg('bot', 'Thinking…');
  ctl = new AbortController();
  $('chat-send').disabled = true; $('chat-stop').hidden = false;
  try {
    const recent = turns.slice(-12);
    while (recent[0].role !== 'user') recent.shift();
    const { text: ans, truncated } = await converse(recent, {
      kind: 'chat', system: rules(), tools: TOOLS, signal: ctl.signal,
      onText: ({ text }) => { bubble.textContent = splitPick(text).body || 'Thinking…'; },
    });
    const { body, pick } = splitPick(ans);
    bubble.textContent = body;
    turns.push({ role: 'assistant', content: body });
    addPick(pick);
    if (truncated) $('chat-note').textContent = 'The answer was cut short. Ask a narrower question.';
  } catch (e) {
    const kept = e?.text ? splitPick(e.text).body : '';
    if (kept) { bubble.textContent = kept; turns.push({ role: 'assistant', content: kept }); }
    else { bubble.remove(); turns.pop(); }           // nothing came back: forget the unanswered question
    if (e?.code !== 'cancelled') $('chat-note').textContent = (ERR[e?.code] || e?.message || 'Claude could not answer just now.') + ' Ask again.';
  }
  ctl = null;
  $('chat-send').disabled = false; $('chat-stop').hidden = true;
}

export function initChat() {
  $('chat-send').onclick = ask;
  $('chat-stop').onclick = () => ctl?.abort();
  $('chat-in').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ask(); } });
  $('chat-clear').onclick = () => { if (ctl) return; turns.length = 0; $('msgs').textContent = ''; $('starters').hidden = false; $('chat-note').textContent = ''; };
  $('starters').querySelectorAll('button').forEach(b => b.onclick = () => { $('chat-in').value = b.textContent; $('chat-in').focus(); });
}
