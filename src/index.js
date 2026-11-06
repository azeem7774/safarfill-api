// SafarFill licence server (Cloudflare Worker).
// - Licence keys: trial, device limit, expiry, portals, monthly AI quota.
// - Passport parsing: turns the two machine-readable lines into fields (logic kept off the PC).
// - AI reader proxy: sends one image to Anthropic with the server's key. Nothing is stored.
// - Admin dashboard at /admin (protected by ADMIN_KEY, and Cloudflare Access if switched on).
//
// Secrets (Settings -> Variables and Secrets, type "Secret"):
//   ANTHROPIC_KEY  Anthropic API key used for "Read with AI"
//   ADMIN_KEY      long random password for the dashboard
//   SIGNING_KEY    long random text used to sign the 24-hour passes
//   RULES_PRIVATE_KEY  ECDSA P-256 private key (JWK) that signs the rules bundles (v1.9.0)
// Cron Trigger (daily): deletes activity and AI-call logs older than 90 days.
// Binding: D1 database as DB.

import { parseMrz, pickMrzLines } from './mrz.js';
import { TOOL, PROMPT } from './prompt.js';
import ADMIN_HTML from './admin.html';
import ADMIN_JS from './admin.client.js.txt';
import * as p2 from './phase2.js';

const API_VERSION = '1.9.0';
const DAY = 86400000;
const PASS_MS = DAY; // a pass lets the extension keep working offline for up to a day

const ALL_PORTALS = ['akbar', 'alhind', 'airsial', 'muqeem'];

export const PLANS = {
  trial:    { days: 2,  ai_quota: 0,   max_devices: 1, portals: ALL_PORTALS }, // built-in reader only; AI test reads can be given
  starter:  { days: 30, ai_quota: 300, max_devices: 1, portals: ['akbar'] },
  standard: { days: 30, ai_quota: 800, max_devices: 1, portals: ALL_PORTALS },
  owner:    { days: 0,  ai_quota: -1,  max_devices: 5, portals: ALL_PORTALS },
};

// Monthly prices in SAR, used for the income figure on the dashboard.
export const PRICES = { trial: 0, starter: 79, standard: 149, owner: 0 };
// Add-on prices in SAR per month (editable in the dashboard Settings).
export const DEFAULT_RATES = { portal: 30, pc: 25, ai100: 15 };

// Monthly price = plan + add-ons − discount. Add-ons come from the licence's own limits:
// portals beyond Starter's one, computers beyond the plan's, AI reads beyond the plan's (per 100).
// Trial and owner are free. discount: '' | '20' (SAR) | '10%'. The same sum runs in the dashboard.
export function quote(lic, discount, rates) {
  const r = { ...DEFAULT_RATES, ...(rates || {}) };
  const d = PLANS[lic.plan];
  const base = PRICES[lic.plan] || 0;
  if (!d || !base) return { lines: [], subtotal: 0, discount_sar: 0, total: 0 };
  const lines = [[`${lic.plan[0].toUpperCase()}${lic.plan.slice(1)} plan`, base]];
  const portals = lic.plan === 'starter' ? Math.max(0, (lic.portals || []).length - 1) : 0;
  if (portals) lines.push([`+ ${portals} extra portal${portals > 1 ? 's' : ''}`, portals * r.portal]);
  const pcs = Math.max(0, (lic.max_devices || 1) - d.max_devices);
  if (pcs) lines.push([`+ ${pcs} extra computer${pcs > 1 ? 's' : ''}`, pcs * r.pc]);
  const packs = d.ai_quota > 0 && lic.ai_quota > d.ai_quota ? Math.ceil((lic.ai_quota - d.ai_quota) / 100) : 0;
  if (packs) lines.push([`+ ${packs * 100} AI reads`, packs * r.ai100]);
  const subtotal = lines.reduce((a, l) => a + l[1], 0);
  const m = String(discount || '').trim().match(/^(\d+(?:\.\d+)?)(%?)$/);
  let off = m ? (m[2] ? Math.round(subtotal * Math.min(100, +m[1]) / 100) : Math.round(+m[1])) : 0;
  off = Math.min(off, subtotal);
  if (off) lines.push([`− Discount${m[2] ? ` ${m[1]}%` : ''}`, -off]);
  return { lines, subtotal, discount_sar: off, total: subtotal - off };
}
const DISCOUNT_RE = /^(\d+(\.\d+)?%?)?$/;

const MODELS = {
  sonnet: { id: 'claude-sonnet-5-5', inPerM: 2, outPerM: 10, forceTool: false },
  haiku:  { id: 'claude-haiku-4-5-20251001', inPerM: 1, outPerM: 5, forceTool: true },
};

const LIMITS = {
  parsePerMin: 240,
  aiPerMin: 20,
  fillPerMin: 120,
  sessionPerMinPerIp: 30,
  adminFailPerMinPerIp: 10,
  maxImageChars: 6_900_000, // about 5 MB of image, Anthropic's per-image limit
  maxLines: 12,
  maxPairs: 6,
  maxLineLen: 160,
};

// ---------------------------------------------------------------- helpers

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Image-Type, X-Model, X-Read-Start',
  'Access-Control-Max-Age': '86400',
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...CORS, ...extra },
  });
}
const fail = (status, error, message, more = {}) => json({ ok: false, error, message, ...more }, status);

const now = () => Date.now();
const monthOf = (t) => new Date(t).toISOString().slice(0, 7);
const usageMonth = (lic, t) => (lic.plan === 'trial' ? 'trial' : monthOf(t));

const enc = new TextEncoder();
function b64url(bytes) {
  let s = '';
  const u = new Uint8Array(bytes);
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
}

async function hmacKey(env) {
  if (!env.SIGNING_KEY || env.SIGNING_KEY.length < 16) throw new Error('SIGNING_KEY is not set');
  return crypto.subtle.importKey('raw', enc.encode(env.SIGNING_KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signPass(env, payload) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

async function readPass(env, token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(env), b64urlToBytes(sig), enc.encode(body));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(b64urlToBytes(body)));
    return p && p.exp > now() ? p : null;
  } catch (e) {
    return null;
  }
}

function sameText(a, b) {
  const x = enc.encode(String(a || ''));
  const y = enc.encode(String(b || ''));
  if (x.length !== y.length || x.length === 0) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

const KEY_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function newKey() {
  const r = new Uint8Array(12);
  crypto.getRandomValues(r);
  const c = [...r].map((v) => KEY_CHARS[v % KEY_CHARS.length]).join('');
  return `SF-${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}`;
}
const KEY_RE = /^SF-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;
const DEVICE_RE = /^[A-Za-z0-9-]{8,64}$/;

const clientIp = (req) => req.headers.get('cf-connecting-ip') || 'unknown';

// Counts calls per minute. Returns true when the limit is passed.
async function overLimit(env, id, kind, limit) {
  const minute = Math.floor(now() / 60000);
  const row = await env.DB.prepare(
    `INSERT INTO rate (key, kind, minute, n) VALUES (?1, ?2, ?3, 1)
     ON CONFLICT (key, kind, minute) DO UPDATE SET n = n + 1 RETURNING n`
  ).bind(id, kind, minute).first();
  if (Math.random() < 0.02) await env.DB.prepare('DELETE FROM rate WHERE minute < ?1').bind(minute - 5).run();
  return row && row.n > limit;
}

async function getLicence(env, key) {
  const lic = await env.DB.prepare('SELECT * FROM licences WHERE key = ?1').bind(key).first();
  if (lic) lic.portals = safeList(lic.portals);
  return lic;
}
function parseLines(s) {
  try { const a = JSON.parse(s); return Array.isArray(a) ? a.filter((l) => Array.isArray(l) && l.length === 2) : []; } catch (e) { return []; }
}

function safeList(s) {
  try { const a = JSON.parse(s); return Array.isArray(a) ? a.filter((p) => ALL_PORTALS.includes(p)) : []; } catch (e) { return []; }
}

async function getUsage(env, key, month) {
  return (await env.DB.prepare('SELECT * FROM usage WHERE key = ?1 AND month = ?2').bind(key, month).first())
    || { parse_count: 0, ai_count: 0, ai_cost_usd: 0 };
}

async function addUsage(env, key, month, parse, ai, cost) {
  await env.DB.prepare(
    `INSERT INTO usage (key, month, parse_count, ai_count, ai_cost_usd) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (key, month) DO UPDATE SET parse_count = parse_count + ?3, ai_count = ai_count + ?4, ai_cost_usd = ai_cost_usd + ?5`
  ).bind(key, month, parse, ai, cost).run();
}

// Activity feed. kind: ok | info | warn | bad. `sees` is what the agent was shown.
// The same refusal for the same key is recorded once per `quietMin` minutes, so a computer
// retrying all day does not flood the list.
async function addEvent(env, key, kind, code, what, sees = '', quietMin = 0) {
  const t = now();
  if (quietMin > 0) {
    const seen = await env.DB.prepare('SELECT 1 FROM events WHERE key = ?1 AND code = ?2 AND done = 0 AND at > ?3 LIMIT 1')
      .bind(key, code, t - quietMin * 60000).first();
    if (seen) return;
  }
  await env.DB.prepare('INSERT INTO events (at, key, kind, code, what, sees, done) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)')
    .bind(t, key, kind, code, what, sees).run();
}
// Marks open refusals as handled once you have acted on them.
function closeEvents(env, key, codes) {
  return env.DB.prepare(`UPDATE events SET done = 1 WHERE key = ?1 AND done = 0 AND code IN (${codes.map((_, i) => `?${i + 2}`).join(',')})`)
    .bind(key, ...codes).run();
}
const REFUSED = {
  blocked: 'Tried to use a blocked key',
  expired: 'Tried to use an expired licence',
  trial_over: 'Tried to use SafarFill after the trial ended',
  device_removed: 'A removed computer tried to use the key',
};

// Why a licence cannot be used right now, or null if it can.
function licenceProblem(lic, t) {
  if (!lic) return ['unknown_key', 'This licence key does not exist. Check it, or contact Sahl Labs.'];
  if (lic.status === 'blocked') return ['blocked', 'This licence has been switched off. Contact Sahl Labs.'];
  if (lic.expires_at && lic.expires_at <= t) {
    return lic.plan === 'trial'
      ? ['trial_over', 'Your free trial has ended. Contact Sahl Labs to continue.']
      : ['expired', 'Your licence has expired. Contact Sahl Labs to renew.'];
  }
  return null;
}

function aiLeft(lic, usage) {
  return lic.ai_quota < 0 ? null : Math.max(0, lic.ai_quota - (usage.ai_count || 0));
}

function licenceView(lic, usage) {
  return {
    plan: lic.plan,
    agency: lic.agency,
    portals: lic.portals,
    expires_at: lic.expires_at,
    ai_quota: lic.ai_quota,
    ai_used: usage.ai_count || 0,
    ai_left: aiLeft(lic, usage),
  };
}

// The pass proves "this key on this PC was valid a moment ago". Every call that costs
// money or uses the parser also re-checks the licence live.
// what: the action name for the activity log ('' = do not log refusals here, e.g. AI calls have their own log).
async function requireLicence(env, req, what = '') {
  const auth = req.headers.get('authorization') || '';
  const pass = await readPass(env, auth.replace(/^Bearer\s+/i, ''));
  if (!pass) return { error: fail(401, 'pass_invalid', 'Please reopen SafarFill to refresh your licence.') };
  const refuse = async (code) => { if (what) await p2.logActivity(env, req, pass.k, pass.d, pass.v, 'refused', `${what}: ${code}`); };
  const lic = await getLicence(env, pass.k);
  const t = now();
  const problem = licenceProblem(lic, t);
  if (problem) {
    if (lic) await addEvent(env, lic.key, 'bad', problem[0], REFUSED[problem[0]], problem[1], 60);
    if (lic) await refuse(problem[0]);
    return { error: fail(403, problem[0], problem[1]) };
  }
  const dev = await env.DB.prepare('SELECT 1 FROM devices WHERE key = ?1 AND device = ?2').bind(pass.k, pass.d).first();
  if (!dev) {
    const msg = 'This computer is no longer on your licence. Contact Sahl Labs.';
    await addEvent(env, lic.key, 'warn', 'device_removed', REFUSED.device_removed, msg, 60);
    await refuse('device_removed');
    return { error: fail(403, 'device_removed', msg) };
  }
  const minVersion = await getSetting(env, 'min_version');
  if (minVersion && olderThan(pass.v, minVersion)) {
    await addEvent(env, lic.key, 'warn', 'update_required', `Uses old SafarFill ${pass.v || '(unknown)'}; ${minVersion} or newer needed`, UPDATE_MSG, 60);
    await refuse('update_required');
    return { error: fail(426, 'update_required', UPDATE_MSG) };
  }
  return { lic, pass, t };
}

// ---------------------------------------------------------------- extension API

async function session(env, req) {
  if (await overLimit(env, `ip:${clientIp(req)}`, 'session', LIMITS.sessionPerMinPerIp)) {
    const msg = 'Too many attempts. Wait a minute and try again.';
    await addEvent(env, 'SYSTEM', 'warn', 'too_many_keys', 'Many key attempts from one internet address; paused for a minute', msg, 10);
    return fail(429, 'too_many', msg);
  }
  let body;
  try { body = await req.json(); } catch (e) { return fail(400, 'bad_request', 'Bad request.'); }
  const key = String(body.key || '').trim().toUpperCase();
  const device = String(body.device || '');
  const version = String(body.version || '').slice(0, 20);
  if (!KEY_RE.test(key)) return fail(400, 'bad_key', 'The licence key should look like SF-XXXX-XXXX-XXXX.');
  if (!DEVICE_RE.test(device)) return fail(400, 'bad_device', 'Bad request.');

  const t = now();
  let lic = await getLicence(env, key);
  // A trial's clock starts the first time it is used.
  if (lic && lic.plan === 'trial' && !lic.activated_at && lic.status === 'active') {
    await env.DB.prepare('UPDATE licences SET activated_at = ?2, expires_at = ?3 WHERE key = ?1')
      .bind(key, t, t + (lic.trial_days || PLANS.trial.days) * DAY).run();
    lic = await getLicence(env, key);
    await addEvent(env, key, 'ok', 'trial_started', `Trial started: ${lic.trial_days || PLANS.trial.days} days, ${lic.ai_quota > 0 ? `${lic.ai_quota} AI reads` : 'built-in reader only'}`);
  } else if (lic && !lic.activated_at) {
    await env.DB.prepare('UPDATE licences SET activated_at = ?2 WHERE key = ?1').bind(key, t).run();
  }
  const problem = licenceProblem(lic, t);
  if (problem) {
    if (lic) await addEvent(env, key, 'bad', problem[0], REFUSED[problem[0]], problem[1], 60);
    else await addEvent(env, 'SYSTEM', 'warn', 'unknown_key', 'Someone entered a key that does not exist', problem[1], 10);
    if (lic) await p2.logActivity(env, req, key, device, version, 'refused', `session: ${problem[0]}`);
    return fail(403, problem[0], problem[1], lic ? { expires_at: lic.expires_at } : {});
  }

  const minVersion = await getSetting(env, 'min_version');
  if (minVersion && olderThan(version, minVersion)) {
    await addEvent(env, key, 'warn', 'update_required', `Uses old SafarFill ${version || '(unknown)'}; ${minVersion} or newer needed`, UPDATE_MSG, 60);
    await p2.logActivity(env, req, key, device, version, 'refused', 'session: update_required');
    return fail(426, 'update_required', UPDATE_MSG);
  }

  const known = await env.DB.prepare('SELECT 1 FROM devices WHERE key = ?1 AND device = ?2').bind(key, device).first();
  if (known) {
    await env.DB.prepare('UPDATE devices SET last_seen = ?3, version = ?4 WHERE key = ?1 AND device = ?2').bind(key, device, t, version).run();
  } else {
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE key = ?1').bind(key).first();
    if ((n ? n.n : 0) >= lic.max_devices) {
      const msg = `This licence is already used on ${lic.max_devices} computer(s). Contact Sahl Labs to add this one.`;
      await addEvent(env, key, 'warn', 'device_limit', `Refused: key already used on ${lic.max_devices} computer(s). A new computer, or Chrome was reinstalled`, msg, 60);
      await p2.logActivity(env, req, key, device, version, 'refused', 'session: device_limit');
      return fail(403, 'device_limit', msg);
    }
    await env.DB.prepare('INSERT INTO devices (key, device, version, first_seen, last_seen) VALUES (?1, ?2, ?3, ?4, ?4)')
      .bind(key, device, version, t).run();
    await addEvent(env, key, 'info', 'device_added', `Computer added (${await deviceLabel(env, key, device)})`);
  }

  const exp = lic.expires_at ? Math.min(t + PASS_MS, lic.expires_at) : t + PASS_MS;
  const pass = await signPass(env, { k: key, d: device, p: lic.portals, plan: lic.plan, v: version, exp });
  const usage = await getUsage(env, key, usageMonth(lic, t));
  await p2.logActivity(env, req, key, device, version, 'session');
  return json({ ok: true, pass, pass_expires: exp, licence: licenceView(lic, usage), support: await getSupport(env),
    rules_version: await p2.rulesVersionFor(env, lic), portal_status: await p2.portalStatus(env) });
}

function cleanLines(list, max) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, max).map((s) => String(s || '').slice(0, LIMITS.maxLineLen));
}

async function parse(env, req) {
  const g = await requireLicence(env, req, req.headers.get('x-read-start') === '1' ? 'parse' : '');
  if (g.error) return g.error;
  if (await overLimit(env, g.lic.key, 'parse', LIMITS.parsePerMin)) return fail(429, 'too_many', 'Too many reads at once. Wait a minute.');
  let body;
  try { body = await req.json(); } catch (e) { return fail(400, 'bad_request', 'Bad request.'); }

  const out = { ok: true };
  // lines: every text line the reader found on one page. The server finds the two
  // machine-readable lines among them and reads them.
  if (body.lines) {
    // Only lines shaped roughly like a machine-readable line are examined (cheap first test),
    // keeping each request well inside the free plan's time limit.
    const lines = cleanLines(body.lines, 40)
      .map((text, i) => ({ text, i, n: text.toUpperCase().replace(/[^A-Z0-9<«‹＜]/g, '').length }))
      .filter((l) => l.n >= 20 && l.n <= 64)
      .slice(0, LIMITS.maxLines);
    const pick = pickMrzLines(lines.map((l) => l.text));
    out.pick = pick ? { i1: pick.i1 >= 0 ? lines[pick.i1].i : -1, i2: lines[pick.i2].i, score: pick.score } : null;
    out.parsed = pick ? parseMrz(pick.i1 >= 0 ? lines[pick.i1].text : '', lines[pick.i2].text) : null;
  }
  // pairs: [line1, line2] candidates from a closer read. Each is read; the caller keeps the best.
  if (body.pairs) {
    const pairs = Array.isArray(body.pairs) ? body.pairs.slice(0, LIMITS.maxPairs) : [];
    out.results = pairs.map((p) => {
      const [a, b] = cleanLines(Array.isArray(p) ? p : [], 2);
      return parseMrz(a || '', b || '');
    });
  }
  // "Reads" = passport pages read: the extension sends X-Read-Start: 1 on the first call for a page only.
  if (req.headers.get('x-read-start') === '1') {
    await addUsage(env, g.lic.key, usageMonth(g.lic, g.t), 1, 0, 0);
    await p2.logActivity(env, req, g.pass.k, g.pass.d, g.pass.v, 'parse page');
  }
  return json(out);
}

// "May I fill?" Asked by the extension every time Fill form is pressed.
async function fillCheck(env, req) {
  const g = await requireLicence(env, req, 'fill');
  if (g.error) return g.error;
  if (await overLimit(env, g.lic.key, 'fill', LIMITS.fillPerMin)) return fail(429, 'too_many', 'Too many fills at once. Wait a minute.');
  let body = {};
  try { body = await req.json(); } catch (e) { /* empty body is fine */ }
  const portal = String(body.portal || '');
  if (!ALL_PORTALS.includes(portal)) return fail(400, 'bad_portal', 'Unknown portal.');
  if (!g.lic.portals.includes(portal)) {
    const msg = 'This portal is not in your plan. Contact Sahl Labs to add it.';
    await addEvent(env, g.lic.key, 'warn', 'portal_not_in_plan', `Tried to fill ${portal}, which is not in their plan`, msg, 60);
    await p2.logActivity(env, req, g.pass.k, g.pass.d, g.pass.v, 'refused', `fill ${portal}: portal_not_in_plan`);
    return fail(403, 'portal_not_in_plan', msg);
  }
  // Portal switched off in the dashboard: no filling until it is switched on again.
  const ps = (await p2.portalStatus(env))[portal];
  if (ps && !ps.on) {
    await p2.logActivity(env, req, g.pass.k, g.pass.d, g.pass.v, 'refused', `fill ${portal}: portal_paused`);
    return fail(423, 'portal_paused', ps.message);
  }
  await env.DB.prepare(
    `INSERT INTO usage (key, month, fill_count) VALUES (?1, ?2, 1)
     ON CONFLICT (key, month) DO UPDATE SET fill_count = fill_count + 1`
  ).bind(g.lic.key, usageMonth(g.lic, g.t)).run();
  await p2.logActivity(env, req, g.pass.k, g.pass.d, g.pass.v, 'fill', portal);
  return json({ ok: true });
}

function friendlyAi(status, message) {
  const m = (message || '').toLowerCase();
  if (status === 401 || status === 403 || m.includes('credit balance')) {
    return ['ai_unavailable', 'The AI reader is not available right now. Contact Sahl Labs.'];
  }
  if (status === 413) return ['too_large', 'The image is too large to send.'];
  if (status === 429 || status === 529 || status >= 500) return ['ai_busy', 'The AI service is busy. Wait a moment and try again.'];
  return ['ai_refused', 'The AI service could not read this image. Try a clearer photo or type the details.'];
}

// Every /v1/ai call is logged per computer (counts and result only; never the image or passport details).
async function aiRead(env, req) {
  const pass = await readPass(env, (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  const size = Math.round((+(req.headers.get('content-length') || 0)) * 3 / 4);
  const g = await requireLicence(env, req);
  const res = g.error ? g.error : await aiCall(env, req, g);
  if (pass) {
    let body = {};
    try { body = await res.clone().json(); } catch (e) { /* not JSON */ }
    try { await logAiCall(env, req, pass, body.ok ? 'ok' : String(body.error || 'error').slice(0, 30), body.ai_left == null ? null : body.ai_left, size); } catch (e) { /* logging must never break a read */ }
  }
  return res;
}

const AI_BURST = 30;   // AI calls by one computer in one hour
const AI_REFUSED = 5;  // refused AI calls (quota / not in plan) by one computer in one hour
async function logAiCall(env, req, pass, result, aiLeft, size) {
  const t = now();
  const w = p2.where(req);
  await env.DB.prepare('INSERT INTO ai_calls (at, key, device, version, result, ai_left, size, ip, city, country) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)')
    .bind(t, pass.k, pass.d, String(pass.v || '').slice(0, 20), result, aiLeft, size, w.ip, w.city, w.country).run();
  await p2.afterAiCall(env, pass.k, pass.d, t);
  const c = await env.DB.prepare(
    "SELECT COUNT(*) AS n, SUM(CASE WHEN result IN ('quota', 'ai_not_in_plan') THEN 1 ELSE 0 END) AS refused FROM ai_calls WHERE key = ?1 AND device = ?2 AND at > ?3"
  ).bind(pass.k, pass.d, t - 3600000).first();
  const dev = pass.d.slice(0, 8);
  if (c && c.n === AI_BURST + 1) {
    await addEvent(env, pass.k, 'warn', 'ai_burst', `Computer ${dev} made more than ${AI_BURST} AI calls in one hour`, '', 60);
  }
  if (c && c.refused === AI_REFUSED + 1) {
    await addEvent(env, pass.k, 'warn', 'ai_refused_burst', `Computer ${dev} had more than ${AI_REFUSED} refused AI calls (limit / not in plan) in one hour`, '', 60);
  }
}

async function aiCall(env, req, g) {
  const { lic, t } = g;
  const month = usageMonth(lic, t);
  const usage = await getUsage(env, lic.key, month);
  if (lic.ai_quota === 0) {
    const msg = lic.plan === 'trial'
      ? 'Read with AI is not included in the free trial. Contact Sahl Labs to try it.'
      : 'Read with AI is not included in your plan. Contact Sahl Labs.';
    await addEvent(env, lic.key, 'warn', 'ai_not_in_trial', 'Pressed Read with AI, which is off on this licence (wants to try AI)', msg, 60);
    return fail(402, 'ai_not_in_plan', msg, { ai_left: 0 });
  }
  if (lic.ai_quota > 0 && usage.ai_count >= lic.ai_quota) {
    const msg = lic.plan === 'trial'
      ? 'Your AI test reads are used up. Contact Sahl Labs to continue.'
      : 'This month\'s AI reads are used up. Contact Sahl Labs for more.';
    await addEvent(env, lic.key, 'bad', 'quota', `AI limit reached (${lic.ai_quota}/${lic.ai_quota}); AI read refused`, msg, 60);
    return fail(402, 'quota', msg, { ai_left: 0 });
  }
  if (await overLimit(env, lic.key, 'ai', LIMITS.aiPerMin)) return fail(429, 'too_many', 'Too many AI reads at once. Wait a minute.');
  if (!env.ANTHROPIC_KEY) {
    const msg = 'The AI reader is not set up yet. Contact Sahl Labs.';
    await addEvent(env, 'SYSTEM', 'bad', 'ai_unavailable', 'AI reads are failing: ANTHROPIC_KEY is not set on the server', msg, 30);
    return fail(503, 'ai_unavailable', msg);
  }

  const type = (req.headers.get('x-image-type') || 'image/jpeg').toLowerCase();
  if (!/^image\/(jpeg|png|webp|gif)$/.test(type)) return fail(400, 'bad_image', 'Unsupported image type.');
  const len = +(req.headers.get('content-length') || 0);
  if (len > LIMITS.maxImageChars) return fail(413, 'too_large', 'The image is too large to send.');
  const b64 = (await req.text()).trim();
  // Cheap check (the free plan allows about 10 ms of work per request): the text must start
  // like base64 and contain nothing that could break out of the JSON string it is placed in.
  // Anything else that is not real base64 is refused by Anthropic and not counted.
  if (!b64 || b64.length > LIMITS.maxImageChars || !/^[A-Za-z0-9+/]{16}/.test(b64)
    || b64.indexOf('"') !== -1 || b64.indexOf('\\') !== -1 || b64.indexOf('\n') !== -1 || b64.indexOf('\r') !== -1) {
    return fail(400, 'bad_image', 'The image could not be read. Add it again.');
  }
  const spec = MODELS[(req.headers.get('x-model') || '').toLowerCase()] || MODELS[env.AI_MODEL] || MODELS.sonnet;

  // The image is placed into the request text as it is, without decoding it.
  const template = JSON.stringify({
    model: spec.id,
    max_tokens: 1500,
    tools: [TOOL],
    tool_choice: spec.forceTool ? { type: 'tool', name: TOOL.name } : { type: 'auto' },
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: type, data: '@@IMAGE@@' } },
      { type: 'text', text: PROMPT },
    ] }],
  });
  const at = template.indexOf('@@IMAGE@@');
  const payload = template.slice(0, at) + b64 + template.slice(at + 9);

  let res;
  try {
    res = await fetch(env.AI_URL || 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: payload,
    });
  } catch (e) {
    return fail(502, 'ai_busy', 'Could not reach the AI service. Try again in a moment.');
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok) {
    const [code, message] = friendlyAi(res.status, data && data.error && data.error.message);
    if (code === 'ai_unavailable') {
      await addEvent(env, 'SYSTEM', 'bad', 'ai_unavailable', `AI reads are failing: Anthropic refused the key or the credit is empty (error ${res.status})`, message, 30);
    }
    return fail(502, code, message);
  }
  const u = data.usage || {};
  const cost = ((u.input_tokens || 0) * spec.inPerM + (u.output_tokens || 0) * spec.outPerM) / 1e6;
  // Every answered call is paid for, so it counts, whether or not the details came back.
  await addUsage(env, lic.key, month, 0, 1, cost);
  const left = lic.ai_quota < 0 ? null : Math.max(0, lic.ai_quota - usage.ai_count - 1);
  const block = (data.content || []).find((b) => b.type === 'tool_use');
  if (!block || !block.input) {
    return fail(200, 'no_details', 'The AI did not return the details this time. Press "Read with AI again" to try once more, or type them from the image.', { ai_left: left });
  }
  return json({ ok: true, fields: block.input, ai_left: left });
}

// ---------------------------------------------------------------- admin

const ADMIN_HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

async function requireAdmin(env, req) {
  const ip = clientIp(req);
  const auth = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.ADMIN_KEY || env.ADMIN_KEY.length < 16) return fail(503, 'not_set_up', 'ADMIN_KEY is not set (at least 16 characters).');
  if (sameText(auth, env.ADMIN_KEY)) return null;
  if (await overLimit(env, `ip:${ip}`, 'adminfail', LIMITS.adminFailPerMinPerIp)) return fail(429, 'too_many', 'Too many wrong attempts. Wait a minute.');
  return fail(401, 'wrong_admin_key', 'Wrong admin password.');
}

// Brings a database made by an older version up to date (once per running copy of the Worker).
let schemaChecked = false;
async function ensureSchema(env) {
  if (schemaChecked) return;
  for (const sql of [
    'ALTER TABLE licences ADD COLUMN price INTEGER',
    'ALTER TABLE usage ADD COLUMN fill_count INTEGER NOT NULL DEFAULT 0',
    'CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL)',
    `CREATE TABLE IF NOT EXISTS quotes (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, agency TEXT NOT NULL DEFAULT '',
      contact TEXT NOT NULL DEFAULT '', plan TEXT NOT NULL, portals TEXT NOT NULL, max_devices INTEGER NOT NULL, ai_quota INTEGER NOT NULL,
      discount TEXT NOT NULL DEFAULT '', lines TEXT NOT NULL, price INTEGER NOT NULL, valid_until INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'sent', key TEXT, notes TEXT NOT NULL DEFAULT '')`,
    `CREATE TABLE IF NOT EXISTS ai_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, key TEXT NOT NULL, device TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT '', result TEXT NOT NULL, ai_left INTEGER, size INTEGER NOT NULL DEFAULT 0)`,
    'CREATE INDEX IF NOT EXISTS ai_calls_key ON ai_calls (key, at)',
    'CREATE INDEX IF NOT EXISTS ai_calls_dev ON ai_calls (key, device, at)',
    'CREATE TABLE IF NOT EXISTS device_names (key TEXT NOT NULL, device TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (key, device))',
    ...p2.SCHEMA_SQL,
  ]) {
    try { await env.DB.prepare(sql).run(); } catch (e) { /* already there */ }
  }
  let added = false;
  try { await env.DB.prepare("ALTER TABLE licences ADD COLUMN discount TEXT NOT NULL DEFAULT ''").run(); added = true; } catch (e) { /* already there */ }
  if (added) {
    // Older versions stored a typed price: keep what each agency pays by turning it into a discount.
    const rates = await getRates(env);
    const { results } = await env.DB.prepare('SELECT * FROM licences').all();
    for (const row of results) {
      const lic = { ...row, portals: safeList(row.portals) };
      const auto = quote(lic, '', rates).total;
      const disc = row.price != null && row.price < auto ? String(auto - row.price) : '';
      await env.DB.prepare('UPDATE licences SET discount = ?2, price = ?3 WHERE key = ?1').bind(row.key, disc, quote(lic, disc, rates).total).run();
    }
  }
  await p2.seedRules(env);
  schemaChecked = true;
}

async function getRates(env) {
  try { return { ...DEFAULT_RATES, ...JSON.parse((await getSetting(env, 'rates')) || '{}') }; } catch (e) { return { ...DEFAULT_RATES }; }
}

// Works out and saves the monthly price after any change to a licence.
async function reprice(env, key) {
  const lic = await getLicence(env, key);
  if (!lic) return 0;
  const total = quote(lic, lic.discount, await getRates(env)).total;
  await env.DB.prepare('UPDATE licences SET price = ?2 WHERE key = ?1').bind(key, total).run();
  return total;
}

// Names you give computers in the dashboard. Kept when a computer is removed, so it gets its name back if it returns.
async function deviceLabel(env, key, device) {
  const r = await env.DB.prepare('SELECT name FROM device_names WHERE key = ?1 AND device = ?2').bind(key, device).first();
  return r ? `${device.slice(0, 8)} · ${r.name}` : device.slice(0, 8);
}

async function getSupport(env) {
  return { whatsapp: (await getSetting(env, 'support_whatsapp')) || '', email: (await getSetting(env, 'support_email')) || '' };
}

async function setSetting(env, name, value) {
  if (value) await env.DB.prepare('INSERT INTO settings (name, value) VALUES (?1, ?2) ON CONFLICT (name) DO UPDATE SET value = ?2').bind(name, value).run();
  else await env.DB.prepare('DELETE FROM settings WHERE name = ?1').bind(name).run();
}

async function getSetting(env, name) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE name = ?1').bind(name).first();
  return row ? row.value : '';
}

// True when version a is older than version b ("1.1.0" < "1.2").
function olderThan(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  }
  return false;
}
const UPDATE_MSG = 'A newer SafarFill is needed. Open chrome://extensions, turn on Developer mode and press Update, or reinstall SafarFill from the Chrome Web Store.';

const cleanText = (s, n = 200) => String(s == null ? '' : s).trim().slice(0, n);
const intOr = (v, d) => (Number.isFinite(+v) && v !== '' && v !== null ? Math.trunc(+v) : d);

async function adminList(env) {
  const t = now();
  const { results } = await env.DB.prepare(
    `SELECT l.*,
       (SELECT COUNT(*) FROM devices d WHERE d.key = l.key) AS devices_used,
       (SELECT MAX(last_seen) FROM devices d WHERE d.key = l.key) AS last_seen,
       u.parse_count, u.ai_count, u.ai_cost_usd, u.fill_count
     FROM licences l
     LEFT JOIN usage u ON u.key = l.key AND u.month = CASE WHEN l.plan = 'trial' THEN 'trial' ELSE ?1 END
     ORDER BY l.created_at DESC`
  ).bind(monthOf(t)).all();
  const totals = await env.DB.prepare(
    "SELECT COALESCE(SUM(ai_count),0) AS ai, COALESCE(SUM(ai_cost_usd),0) AS cost, COALESCE(SUM(parse_count),0) AS parse, COALESCE(SUM(fill_count),0) AS fills FROM usage WHERE month = ?1 OR month = 'trial'"
  ).bind(monthOf(t)).first();
  const feed = (await env.DB.prepare(
    `SELECT e.*, l.agency FROM events e LEFT JOIN licences l ON l.key = e.key ORDER BY e.at DESC LIMIT 60`
  ).all()).results;
  // Open refusals from the last two days that you may want to act on.
  const open = (await env.DB.prepare(
    `SELECT e.*, l.agency FROM events e LEFT JOIN licences l ON l.key = e.key
     WHERE e.done = 0 AND e.at > ?1 AND e.code IN ('device_limit', 'ai_not_in_trial', 'ai_unavailable', 'device_removed', 'portal_not_in_plan', 'ai_burst', 'ai_refused_burst', 'geo_country', 'geo_city', 'ip_many')
     ORDER BY e.at DESC LIMIT 30`
  ).bind(t - 2 * DAY).all()).results;
  return json({ ok: true, now: t, month: monthOf(t), plans: PLANS, prices: PRICES, rates: await getRates(env), portals: ALL_PORTALS,
    licences: results.map((r) => ({ ...r, portals: safeList(r.portals) })), totals, feed, open,
    quotes: (await env.DB.prepare('SELECT * FROM quotes ORDER BY id DESC LIMIT 50').all()).results.map((q) => ({ ...q, portals: safeList(q.portals), lines: parseLines(q.lines) })),
    settings: { min_version: await getSetting(env, 'min_version'), support: await getSupport(env), payment: await getSetting(env, 'payment') },
    portal_status: await p2.portalStatus(env), announcements: await p2.listAnnouncements(env) });
}

async function adminCreate(env, req) {
  return createLicence(env, await req.json().catch(() => ({})));
}

async function createLicence(env, b) {
  const plan = PLANS[b.plan] ? b.plan : null;
  if (!plan) return fail(400, 'bad_plan', 'Choose a plan.');
  const d = PLANS[plan];
  const t = now();
  const portals = Array.isArray(b.portals) ? b.portals.filter((p) => ALL_PORTALS.includes(p)) : d.portals;
  if (!portals.length) return fail(400, 'no_portals', 'Choose at least one portal.');
  const days = intOr(b.days, d.days);
  const discount = cleanText(b.discount, 10).replace(/\s/g, '');
  if (!DISCOUNT_RE.test(discount)) return fail(400, 'bad_discount', 'Write the discount as SAR (e.g. 20) or percent (e.g. 10%).');
  let key = newKey();
  for (let i = 0; i < 3 && (await getLicence(env, key)); i++) key = newKey();
  await env.DB.prepare(
    `INSERT INTO licences (key, agency, contact, plan, portals, max_devices, ai_quota, trial_days, expires_at, status, notes, created_at, discount)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'active', ?10, ?11, ?12)`
  ).bind(
    key, cleanText(b.agency, 120), cleanText(b.contact, 40), plan, JSON.stringify(portals),
    Math.max(1, intOr(b.max_devices, d.max_devices)), intOr(b.ai_quota, d.ai_quota),
    plan === 'trial' ? days : 0,
    plan === 'trial' || plan === 'owner' || days <= 0 ? null : t + days * DAY,
    cleanText(b.notes, 500), t, discount,
  ).run();
  const total = await reprice(env, key);
  await addEvent(env, key, 'info', 'created', `Key created (${plan}${total ? `, ${total} SAR/month` : ''})${b.from_quote ? ` from quote Q-${String(b.from_quote).padStart(4, '0')}` : ''}`);
  return json({ ok: true, key });
}

// ---------------------------------------------------------------- quotes

const QUOTE_DAYS = 7;

async function adminQuote(env, req) {
  const b = await req.json().catch(() => ({}));
  const plan = b.plan === 'starter' || b.plan === 'standard' ? b.plan : null;
  if (!plan) return fail(400, 'bad_plan', 'Quotes are for Starter or Standard.');
  const d = PLANS[plan];
  const portals = Array.isArray(b.portals) ? b.portals.filter((p) => ALL_PORTALS.includes(p)) : d.portals;
  if (!portals.length) return fail(400, 'no_portals', 'Choose at least one portal.');
  const discount = cleanText(b.discount, 10).replace(/\s/g, '');
  if (!DISCOUNT_RE.test(discount)) return fail(400, 'bad_discount', 'Write the discount as SAR (e.g. 20) or percent (e.g. 10%).');
  const lic = { plan, portals, max_devices: Math.max(1, intOr(b.max_devices, d.max_devices)), ai_quota: Math.max(d.ai_quota, intOr(b.ai_quota, d.ai_quota)) };
  const q = quote(lic, discount, await getRates(env));
  const t = now();
  const r = await env.DB.prepare(
    `INSERT INTO quotes (created_at, agency, contact, plan, portals, max_devices, ai_quota, discount, lines, price, valid_until, status, notes)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'sent', ?12)`
  ).bind(t, cleanText(b.agency, 120), cleanText(b.contact, 40), plan, JSON.stringify(portals), lic.max_devices, lic.ai_quota,
    discount, JSON.stringify(q.lines), q.total, t + QUOTE_DAYS * DAY, cleanText(b.notes, 500)).run();
  const id = r.meta.last_row_id;
  await addEvent(env, 'SYSTEM', 'info', 'quote', `Quote Q-${String(id).padStart(4, '0')} for ${cleanText(b.agency, 120) || 'an agency'}: ${q.total} SAR/month`);
  return json({ ok: true, quote: await getQuote(env, id) });
}

async function getQuote(env, id) {
  const q = await env.DB.prepare('SELECT * FROM quotes WHERE id = ?1').bind(intOr(id, 0)).first();
  if (q) { q.portals = safeList(q.portals); q.lines = parseLines(q.lines); }
  return q;
}

async function quoteAction(env, b) {
  const q = await getQuote(env, b.id);
  if (!q) return fail(404, 'not_found', 'No such quote.');
  const no = `Q-${String(q.id).padStart(4, '0')}`;
  if (b.action === 'quote_status') {
    const st = ['sent', 'declined'].includes(b.status) ? b.status : null;
    if (!st || q.status === 'accepted') return fail(400, 'bad_status', 'This quote cannot be changed.');
    await env.DB.prepare('UPDATE quotes SET status = ?2 WHERE id = ?1').bind(q.id, st).run();
    await addEvent(env, 'SYSTEM', 'info', 'quote', `${no} (${q.agency || 'agency'}) marked ${st}`);
    return json({ ok: true, quote: await getQuote(env, q.id) });
  }
  // quote_accept: make the licence with exactly the quoted settings and price.
  if (q.status === 'accepted') return fail(400, 'already', `${no} already has a key: ${q.key}`);
  const res = await createLicence(env, { plan: q.plan, agency: q.agency, contact: q.contact, portals: q.portals, max_devices: q.max_devices,
    ai_quota: q.ai_quota, discount: q.discount, notes: q.notes, from_quote: q.id });
  const made = await res.json();
  if (!made.ok) return json(made, 400);
  const lic = await getLicence(env, made.key);
  const now_ = quote(lic, lic.discount, await getRates(env));
  if (now_.total !== q.price) {
    // Add-on prices changed since the quote: keep the quoted price.
    await env.DB.prepare('UPDATE licences SET discount = ?2 WHERE key = ?1').bind(made.key, String(Math.max(0, now_.subtotal - q.price))).run();
    await reprice(env, made.key);
  }
  await env.DB.prepare("UPDATE quotes SET status = 'accepted', key = ?2 WHERE id = ?1").bind(q.id, made.key).run();
  return json({ ok: true, key: made.key, quote: await getQuote(env, q.id) });
}

async function adminDetail(env, key) {
  const lic = await getLicence(env, key);
  if (!lic) return fail(404, 'not_found', 'No such key.');
  const devices = (await env.DB.prepare(
    'SELECT d.*, n.name FROM devices d LEFT JOIN device_names n ON n.key = d.key AND n.device = d.device WHERE d.key = ?1 ORDER BY d.first_seen'
  ).bind(key).all()).results;
  const names = Object.fromEntries((await env.DB.prepare('SELECT device, name FROM device_names WHERE key = ?1').bind(key).all()).results.map((r) => [r.device, r.name]));
  const usage = (await env.DB.prepare('SELECT * FROM usage WHERE key = ?1 ORDER BY month DESC LIMIT 12').bind(key).all()).results;
  const log = (await env.DB.prepare('SELECT * FROM events WHERE key = ?1 ORDER BY at DESC LIMIT 40').bind(key).all()).results;
  // AI reads per computer (answered calls: ok or no_details), this month and in total, plus the last 50 AI calls.
  const d = new Date(now());
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const aiByDevice = (await env.DB.prepare(
    `SELECT device, SUM(CASE WHEN result IN ('ok', 'no_details') THEN 1 ELSE 0 END) AS total,
       SUM(CASE WHEN result IN ('ok', 'no_details') AND at >= ?2 THEN 1 ELSE 0 END) AS month, COUNT(*) AS calls, MAX(at) AS last
     FROM ai_calls WHERE key = ?1 GROUP BY device ORDER BY last DESC`
  ).bind(key, monthStart).all()).results;
  const aiCalls = (await env.DB.prepare('SELECT at, device, version, result, ai_left, size FROM ai_calls WHERE key = ?1 ORDER BY at DESC, id DESC LIMIT 50').bind(key).all()).results;
  const act = await p2.activityFor(env, key);
  return json({ ok: true, licence: lic, devices, names, usage, log, places: act.places, actions: act.actions, ai_by_device: aiByDevice, ai_calls: aiCalls, quote: quote(lic, lic.discount, await getRates(env)) });
}

async function adminAction(env, req) {
  const b = await req.json().catch(() => ({}));
  if (b.action === 'set_min_version') {
    const v = cleanText(b.version, 20);
    if (v && !/^\d+(\.\d+){0,2}$/.test(v)) return fail(400, 'bad_version', 'Write the version like 1.1.0, or leave it empty.');
    if (v) await env.DB.prepare('INSERT INTO settings (name, value) VALUES (\'min_version\', ?1) ON CONFLICT (name) DO UPDATE SET value = ?1').bind(v).run();
    else await env.DB.prepare('DELETE FROM settings WHERE name = \'min_version\'').run();
    await addEvent(env, 'SYSTEM', 'info', 'min_version', v ? `Minimum SafarFill version set to ${v}` : 'Minimum SafarFill version removed', v ? UPDATE_MSG : '');
    return json({ ok: true, min_version: v });
  }
  if (b.action === 'set_support') {
    const wa = String(b.whatsapp || '').replace(/[\s\-()+]/g, '');
    const email = cleanText(b.email, 100);
    if (wa && !/^\d{8,15}$/.test(wa)) return fail(400, 'bad_whatsapp', 'Write the WhatsApp number with country code, e.g. 966512345678.');
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, 'bad_email', 'That email does not look right.');
    await setSetting(env, 'support_whatsapp', wa);
    await setSetting(env, 'support_email', email);
    await addEvent(env, 'SYSTEM', 'info', 'support', `Support contact set: ${wa ? '+' + wa : 'no WhatsApp'}, ${email || 'no email'}`);
    return json({ ok: true, support: { whatsapp: wa, email } });
  }
  if (b.action === 'set_rates') {
    const r = {};
    for (const k of Object.keys(DEFAULT_RATES)) {
      const v = intOr(b.rates && b.rates[k], -1);
      if (v < 0 || v > 10000) return fail(400, 'bad_rate', 'Add-on prices must be 0 to 10000 SAR.');
      r[k] = v;
    }
    await setSetting(env, 'rates', JSON.stringify(r));
    await addEvent(env, 'SYSTEM', 'info', 'rates', `Add-on prices: portal ${r.portal}, computer ${r.pc}, 100 AI reads ${r.ai100} SAR`);
    return json({ ok: true, rates: r });
  }
  if (b.action === 'set_payment') {
    await setSetting(env, 'payment', String(b.text || '').trim().slice(0, 800));
    await addEvent(env, 'SYSTEM', 'info', 'payment', 'Payment details for quotes updated');
    return json({ ok: true });
  }
  if (b.action === 'quote_status' || b.action === 'quote_accept') return quoteAction(env, b);
  if (b.action === 'set_portal') {
    const err = await p2.setPortal(env, String(b.portal || ''), !!b.on, b.message);
    return err || json({ ok: true, portal_status: await p2.portalStatus(env) });
  }
  if (b.action === 'add_announcement') {
    const err = await p2.addAnnouncement(env, b);
    return err || json({ ok: true, announcements: await p2.listAnnouncements(env) });
  }
  if (b.action === 'delete_announcement') {
    await p2.deleteAnnouncement(env, b.id);
    return json({ ok: true, announcements: await p2.listAnnouncements(env) });
  }
  if (b.action === 'dismiss') {
    await env.DB.prepare('UPDATE events SET done = 1 WHERE id = ?1').bind(intOr(b.event_id, 0)).run();
    return json({ ok: true });
  }
  const key = cleanText(b.key, 20).toUpperCase();
  const lic = await getLicence(env, key);
  if (!lic) return fail(404, 'not_found', 'No such key.');
  const t = now();
  const run = (sql, ...args) => env.DB.prepare(sql).bind(key, ...args).run();
  switch (b.action) {
    case 'extend': {
      const days = intOr(b.days, 30);
      if (days < 1 || days > 3660) return fail(400, 'bad_days', 'Days must be between 1 and 3660.');
      const base = lic.expires_at && lic.expires_at > t ? lic.expires_at : t;
      await run('UPDATE licences SET expires_at = ?2 WHERE key = ?1', base + days * DAY);
      await closeEvents(env, key, ['expired', 'trial_over']);
      await addEvent(env, key, 'ok', 'renewed', `Payment received: +${days} days`, 'SafarFill works again the next time they open it.');
      break;
    }
    case 'make_paid': {
      // Trial -> paid plan: new plan defaults, 30 days from today, usage counts restart.
      const plan = PLANS[b.plan] && b.plan !== 'trial' ? b.plan : null;
      if (!plan) return fail(400, 'bad_plan', 'Choose a paid plan.');
      const d = PLANS[plan];
      let portals = Array.isArray(b.portals) && b.portals.length ? b.portals.filter((p) => ALL_PORTALS.includes(p)) : d.portals;
      if (plan === 'starter' && !(Array.isArray(b.portals) && b.portals.length)) portals = lic.portals.length < ALL_PORTALS.length ? lic.portals : d.portals;
      const discount = b.discount != null ? cleanText(b.discount, 10).replace(/\s/g, '') : lic.discount;
      if (!DISCOUNT_RE.test(discount)) return fail(400, 'bad_discount', 'Write the discount as SAR (e.g. 20) or percent (e.g. 10%).');
      await run(
        'UPDATE licences SET plan = ?2, portals = ?3, ai_quota = ?4, max_devices = MAX(max_devices, ?5), expires_at = ?6, status = \'active\', discount = ?7 WHERE key = ?1',
        plan, JSON.stringify(portals), d.ai_quota, d.max_devices, plan === 'owner' ? null : t + intOr(b.days, d.days) * DAY, discount,
      );
      const total = await reprice(env, key);
      await closeEvents(env, key, ['expired', 'trial_over', 'ai_not_in_trial', 'quota']);
      await addEvent(env, key, 'ok', 'plan_changed', `Now on ${plan}${total ? ` (${total} SAR/month)` : ''}`, 'Their key keeps working; nothing to reinstall.');
      break;
    }
    case 'update': {
      const f = b.fields || {};
      const portals = Array.isArray(f.portals) ? f.portals.filter((p) => ALL_PORTALS.includes(p)) : lic.portals;
      if (!portals.length) return fail(400, 'no_portals', 'Choose at least one portal.');
      const discount = f.discount != null ? cleanText(f.discount, 10).replace(/\s/g, '') : lic.discount;
      if (!DISCOUNT_RE.test(discount)) return fail(400, 'bad_discount', 'Write the discount as SAR (e.g. 20) or percent (e.g. 10%).');
      const before = lic.price || 0;
      await run(
        'UPDATE licences SET agency = ?2, contact = ?3, portals = ?4, max_devices = ?5, ai_quota = ?6, notes = ?7, discount = ?8 WHERE key = ?1',
        f.agency != null ? cleanText(f.agency, 120) : lic.agency,
        f.contact != null ? cleanText(f.contact, 40) : lic.contact,
        JSON.stringify(portals),
        Math.max(1, intOr(f.max_devices, lic.max_devices)),
        intOr(f.ai_quota, lic.ai_quota),
        f.notes != null ? cleanText(f.notes, 500) : lic.notes,
        discount,
      );
      const total = await reprice(env, key);
      await closeEvents(env, key, ['portal_not_in_plan']);
      await addEvent(env, key, 'info', 'details', total !== before ? `Details changed (price ${before} → ${total} SAR)` : 'Details changed');
      break;
    }
    case 'delete_licence': {
      // Permanently removes a key with its computers, usage and history (for test keys).
      await env.DB.batch([
        env.DB.prepare('DELETE FROM devices WHERE key = ?1').bind(key),
        env.DB.prepare('DELETE FROM usage WHERE key = ?1').bind(key),
        env.DB.prepare('DELETE FROM events WHERE key = ?1').bind(key),
        env.DB.prepare('DELETE FROM ai_calls WHERE key = ?1').bind(key),
        env.DB.prepare('DELETE FROM device_names WHERE key = ?1').bind(key),
        env.DB.prepare('DELETE FROM activity WHERE key = ?1').bind(key),
        env.DB.prepare("DELETE FROM announcements WHERE target_type = 'licence' AND target = ?1").bind(key),
        env.DB.prepare('DELETE FROM licences WHERE key = ?1').bind(key),
      ]);
      await addEvent(env, 'SYSTEM', 'info', 'deleted', `Key ${key}${lic.agency ? ` (${lic.agency})` : ''} deleted`);
      return json({ ok: true, deleted: key });
    }
    case 'set_rules_tester':
      await run('UPDATE licences SET rules_tester = ?2 WHERE key = ?1', b.on ? 1 : 0);
      await addEvent(env, key, 'info', 'rules_tester', b.on ? 'Marked as rules tester (gets test rules)' : 'No longer a rules tester');
      break;
    case 'block':
      await run("UPDATE licences SET status = 'blocked' WHERE key = ?1");
      await addEvent(env, key, 'info', 'blocked_by_you', 'Blocked by you', 'This licence has been switched off. Contact Sahl Labs.');
      break;
    case 'unblock':
      await run("UPDATE licences SET status = 'active' WHERE key = ?1");
      await addEvent(env, key, 'ok', 'unblocked', 'Unblocked', 'SafarFill works again.');
      break;
    case 'reset_devices':
      await run('DELETE FROM devices WHERE key = ?1');
      await closeEvents(env, key, ['device_limit', 'device_removed']);
      await addEvent(env, key, 'info', 'devices_reset', 'All computers removed', 'They enter the key again on each computer.');
      break;
    case 'remove_device': {
      const label = await deviceLabel(env, key, cleanText(b.device, 64));
      await run('DELETE FROM devices WHERE key = ?1 AND device = ?2', cleanText(b.device, 64));
      await closeEvents(env, key, ['device_limit', 'device_removed']);
      await addEvent(env, key, 'info', 'device_removed_by_you', `Computer removed (${label})`, 'That computer must enter the key again.');
      break;
    }
    case 'name_device': {
      const device = cleanText(b.device, 64);
      const name = cleanText(b.name, 40);
      const known = await env.DB.prepare('SELECT 1 FROM devices WHERE key = ?1 AND device = ?2').bind(key, device).first();
      if (!known) return fail(404, 'not_found', 'That computer is not on this licence.');
      if (name) await run('INSERT INTO device_names (key, device, name) VALUES (?1, ?2, ?3) ON CONFLICT (key, device) DO UPDATE SET name = ?3', device, name);
      else await run('DELETE FROM device_names WHERE key = ?1 AND device = ?2', device);
      await addEvent(env, key, 'info', 'device_named', name ? `Computer ${device.slice(0, 8)} named "${name}"` : `Name removed from computer ${device.slice(0, 8)}`);
      break;
    }
    case 'add_ai': {
      const n = intOr(b.amount, 100);
      if (n < 1 || n > 100000) return fail(400, 'bad_amount', 'Amount must be between 1 and 100000.');
      await run('UPDATE licences SET ai_quota = ai_quota + ?2 WHERE key = ?1 AND ai_quota >= 0', n);
      const total = await reprice(env, key);
      await closeEvents(env, key, ['quota', 'ai_not_in_trial']);
      await addEvent(env, key, 'ok', 'ai_added', `+${n} AI reads a month${total ? ` (now ${total} SAR/month)` : ''}`, 'Read with AI works again straight away.');
      break;
    }
    case 'ai_test': {
      // A few AI reads for a trial agency that wants to try the AI reader.
      const n = intOr(b.amount, 10);
      if (n < 1 || n > 50) return fail(400, 'bad_amount', 'AI test reads must be between 1 and 50.');
      await run('UPDATE licences SET ai_quota = MAX(ai_quota, 0) + ?2 WHERE key = ?1 AND ai_quota >= 0', n);
      await closeEvents(env, key, ['quota', 'ai_not_in_trial']);
      await addEvent(env, key, 'ok', 'ai_test', `AI test: ${n} reads given`, 'Read with AI now works until these reads are used.');
      break;
    }
    case 'add_device_slot':
      await run('UPDATE licences SET max_devices = max_devices + 1 WHERE key = ?1');
      { const total = await reprice(env, key);
        await closeEvents(env, key, ['device_limit']);
        await addEvent(env, key, 'ok', 'device_slot', `Computers allowed: ${lic.max_devices + 1}${total ? ` (now ${total} SAR/month)` : ''}`, 'They can now enter the key on one more computer.'); }
      break;
    default:
      return fail(400, 'bad_action', 'Unknown action.');
  }
  return adminDetail(env, key);
}

// ---------------------------------------------------------------- router

const WEBSITE = 'https://sahllabs.com';
p2.setup({ json, fail, now, readPass, getLicence, addEvent, cleanText, intOr, getSetting, ALL_PORTALS });

export default {
  // Daily Cron Trigger: keeps 90 days of activity and AI-call logs.
  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    await ensureSchema(env);
    ctx.waitUntil(p2.cleanUp(env));
  },

  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    try {
      if (!env.DB) return fail(503, 'not_set_up', 'The database (DB) is not connected to this Worker.');
      if (path.startsWith('/v1/') || path.startsWith('/admin/api/')) await ensureSchema(env);

      if (path === '/') return new Response('SafarFill API', { headers: { 'content-type': 'text/plain' } });
      if (path === '/favicon.ico') return new Response(null, { status: 204 });
      if (path === '/v1/ping') return json({ ok: true, version: API_VERSION });
      if (path === '/v1/support') {
        return json({ ok: true, ...(await getSupport(env)), website: WEBSITE, announcements: await p2.announcementsFor(env, req) });
      }
      if (path === '/v1/rules' && req.method === 'GET') {
        const g = await requireLicence(env, req, 'rules');
        return g.error || await p2.getRules(env, req, g);
      }
      if (path === '/v1/session' && req.method === 'POST') return await session(env, req);
      if (path === '/v1/parse' && req.method === 'POST') return await parse(env, req);
      if (path === '/v1/ai' && req.method === 'POST') return await aiRead(env, req);
      if (path === '/v1/fill' && req.method === 'POST') return await fillCheck(env, req);

      if (path === '/admin' && req.method === 'GET') {
        return new Response(ADMIN_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', ...ADMIN_HEADERS } });
      }
      if (path === '/admin/app.js' && req.method === 'GET') {
        return new Response(ADMIN_JS, { headers: { 'content-type': 'text/javascript; charset=utf-8', ...ADMIN_HEADERS } });
      }
      if (path.startsWith('/admin/api/')) {
        const denied = await requireAdmin(env, req);
        if (denied) return denied;
        if (path === '/admin/api/licences' && req.method === 'GET') return await adminList(env);
        if (path === '/admin/api/licences' && req.method === 'POST') return await adminCreate(env, req);
        if (path === '/admin/api/licence' && req.method === 'GET') return await adminDetail(env, cleanText(url.searchParams.get('key'), 20).toUpperCase());
        if (path === '/admin/api/action' && req.method === 'POST') return await adminAction(env, req);
        if (path === '/admin/api/quotes' && req.method === 'POST') return await adminQuote(env, req);
        if (path === '/admin/api/rules' && req.method === 'GET') return await p2.adminRules(env, url);
        if (path === '/admin/api/rules' && req.method === 'POST') return await p2.adminRulesAction(env, req);
      }
      return fail(404, 'not_found', 'Not found.');
    } catch (e) {
      console.error(e && e.stack ? e.stack : e);
      return fail(500, 'server_error', 'Something went wrong on the server. Try again.');
    }
  },
};
