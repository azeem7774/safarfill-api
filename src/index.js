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
// Binding: D1 database as DB.

import { parseMrz, pickMrzLines } from './mrz.js';
import { TOOL, PROMPT } from './prompt.js';
import ADMIN_HTML from './admin.html';
import ADMIN_JS from './admin.client.js.txt';

const API_VERSION = '1.2.0';
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

const MODELS = {
  sonnet: { id: 'claude-sonnet-5-5', inPerM: 2, outPerM: 10, forceTool: false },
  haiku:  { id: 'claude-haiku-4-5-20251001', inPerM: 1, outPerM: 5, forceTool: true },
};

const LIMITS = {
  parsePerMin: 240,
  aiPerMin: 20,
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
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Image-Type, X-Model',
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
async function requireLicence(env, req) {
  const auth = req.headers.get('authorization') || '';
  const pass = await readPass(env, auth.replace(/^Bearer\s+/i, ''));
  if (!pass) return { error: fail(401, 'pass_invalid', 'Please reopen SafarFill to refresh your licence.') };
  const lic = await getLicence(env, pass.k);
  const t = now();
  const problem = licenceProblem(lic, t);
  if (problem) {
    if (lic) await addEvent(env, lic.key, 'bad', problem[0], REFUSED[problem[0]], problem[1], 60);
    return { error: fail(403, problem[0], problem[1]) };
  }
  const dev = await env.DB.prepare('SELECT 1 FROM devices WHERE key = ?1 AND device = ?2').bind(pass.k, pass.d).first();
  if (!dev) {
    const msg = 'This computer is no longer on your licence. Contact Sahl Labs.';
    await addEvent(env, lic.key, 'warn', 'device_removed', REFUSED.device_removed, msg, 60);
    return { error: fail(403, 'device_removed', msg) };
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
    return fail(403, problem[0], problem[1], lic ? { expires_at: lic.expires_at } : {});
  }

  const known = await env.DB.prepare('SELECT 1 FROM devices WHERE key = ?1 AND device = ?2').bind(key, device).first();
  if (known) {
    await env.DB.prepare('UPDATE devices SET last_seen = ?3, version = ?4 WHERE key = ?1 AND device = ?2').bind(key, device, t, version).run();
  } else {
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM devices WHERE key = ?1').bind(key).first();
    if ((n ? n.n : 0) >= lic.max_devices) {
      const msg = `This licence is already used on ${lic.max_devices} computer(s). Contact Sahl Labs to add this one.`;
      await addEvent(env, key, 'warn', 'device_limit', `Refused: key already used on ${lic.max_devices} computer(s). A new computer, or Chrome was reinstalled`, msg, 60);
      return fail(403, 'device_limit', msg);
    }
    await env.DB.prepare('INSERT INTO devices (key, device, version, first_seen, last_seen) VALUES (?1, ?2, ?3, ?4, ?4)')
      .bind(key, device, version, t).run();
    await addEvent(env, key, 'info', 'device_added', `Computer added (${device.slice(0, 8)})`);
  }

  const exp = lic.expires_at ? Math.min(t + PASS_MS, lic.expires_at) : t + PASS_MS;
  const pass = await signPass(env, { k: key, d: device, p: lic.portals, plan: lic.plan, exp });
  const usage = await getUsage(env, key, usageMonth(lic, t));
  return json({ ok: true, pass, pass_expires: exp, licence: licenceView(lic, usage) });
}

function cleanLines(list, max) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, max).map((s) => String(s || '').slice(0, LIMITS.maxLineLen));
}

async function parse(env, req) {
  const g = await requireLicence(env, req);
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
  await addUsage(env, g.lic.key, usageMonth(g.lic, g.t), 1, 0, 0);
  return json(out);
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

async function aiRead(env, req) {
  const g = await requireLicence(env, req);
  if (g.error) return g.error;
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

// Adds the price column to a database made before v1.2 (once per running copy of the Worker).
let priceColumnChecked = false;
async function ensurePriceColumn(env) {
  if (priceColumnChecked) return;
  try { await env.DB.prepare('ALTER TABLE licences ADD COLUMN price INTEGER').run(); } catch (e) { /* already there */ }
  priceColumnChecked = true;
}
const priceOf = (lic) => (lic.price != null ? lic.price : (PRICES[lic.plan] || 0));

const cleanText = (s, n = 200) => String(s == null ? '' : s).trim().slice(0, n);
const intOr = (v, d) => (Number.isFinite(+v) && v !== '' && v !== null ? Math.trunc(+v) : d);

async function adminList(env) {
  const t = now();
  const { results } = await env.DB.prepare(
    `SELECT l.*,
       (SELECT COUNT(*) FROM devices d WHERE d.key = l.key) AS devices_used,
       (SELECT MAX(last_seen) FROM devices d WHERE d.key = l.key) AS last_seen,
       u.parse_count, u.ai_count, u.ai_cost_usd
     FROM licences l
     LEFT JOIN usage u ON u.key = l.key AND u.month = CASE WHEN l.plan = 'trial' THEN 'trial' ELSE ?1 END
     ORDER BY l.created_at DESC`
  ).bind(monthOf(t)).all();
  const totals = await env.DB.prepare(
    "SELECT COALESCE(SUM(ai_count),0) AS ai, COALESCE(SUM(ai_cost_usd),0) AS cost, COALESCE(SUM(parse_count),0) AS parse FROM usage WHERE month = ?1 OR month = 'trial'"
  ).bind(monthOf(t)).first();
  const feed = (await env.DB.prepare(
    `SELECT e.*, l.agency FROM events e LEFT JOIN licences l ON l.key = e.key ORDER BY e.at DESC LIMIT 60`
  ).all()).results;
  // Open refusals from the last two days that you may want to act on.
  const open = (await env.DB.prepare(
    `SELECT e.*, l.agency FROM events e LEFT JOIN licences l ON l.key = e.key
     WHERE e.done = 0 AND e.at > ?1 AND e.code IN ('device_limit', 'ai_not_in_trial', 'ai_unavailable', 'device_removed')
     ORDER BY e.at DESC LIMIT 30`
  ).bind(t - 2 * DAY).all()).results;
  return json({ ok: true, now: t, month: monthOf(t), plans: PLANS, prices: PRICES, portals: ALL_PORTALS,
    licences: results.map((r) => ({ ...r, portals: safeList(r.portals) })), totals, feed, open });
}

async function adminCreate(env, req) {
  const b = await req.json().catch(() => ({}));
  const plan = PLANS[b.plan] ? b.plan : null;
  if (!plan) return fail(400, 'bad_plan', 'Choose a plan.');
  const d = PLANS[plan];
  const t = now();
  const portals = Array.isArray(b.portals) ? b.portals.filter((p) => ALL_PORTALS.includes(p)) : d.portals;
  if (!portals.length) return fail(400, 'no_portals', 'Choose at least one portal.');
  const days = intOr(b.days, d.days);
  let key = newKey();
  for (let i = 0; i < 3 && (await getLicence(env, key)); i++) key = newKey();
  await env.DB.prepare(
    `INSERT INTO licences (key, agency, contact, plan, portals, max_devices, ai_quota, trial_days, expires_at, status, notes, created_at, price)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'active', ?10, ?11, ?12)`
  ).bind(
    key, cleanText(b.agency, 120), cleanText(b.contact, 40), plan, JSON.stringify(portals),
    Math.max(1, intOr(b.max_devices, d.max_devices)), intOr(b.ai_quota, d.ai_quota),
    plan === 'trial' ? days : 0,
    plan === 'trial' || plan === 'owner' || days <= 0 ? null : t + days * DAY,
    cleanText(b.notes, 500), t, Math.max(0, intOr(b.price, PRICES[plan] || 0)),
  ).run();
  await addEvent(env, key, 'info', 'created', `Key created (${plan})`);
  return json({ ok: true, key });
}

async function adminDetail(env, key) {
  const lic = await getLicence(env, key);
  if (!lic) return fail(404, 'not_found', 'No such key.');
  const devices = (await env.DB.prepare('SELECT * FROM devices WHERE key = ?1 ORDER BY first_seen').bind(key).all()).results;
  const usage = (await env.DB.prepare('SELECT * FROM usage WHERE key = ?1 ORDER BY month DESC LIMIT 12').bind(key).all()).results;
  const log = (await env.DB.prepare('SELECT * FROM events WHERE key = ?1 ORDER BY at DESC LIMIT 40').bind(key).all()).results;
  return json({ ok: true, licence: lic, devices, usage, log });
}

async function adminAction(env, req) {
  const b = await req.json().catch(() => ({}));
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
      const portals = Array.isArray(b.portals) && b.portals.length ? b.portals.filter((p) => ALL_PORTALS.includes(p)) : d.portals;
      await run(
        'UPDATE licences SET plan = ?2, portals = ?3, ai_quota = ?4, max_devices = MAX(max_devices, ?5), expires_at = ?6, status = \'active\', price = ?7 WHERE key = ?1',
        plan, JSON.stringify(portals), d.ai_quota, d.max_devices, plan === 'owner' ? null : t + intOr(b.days, d.days) * DAY,
        Math.max(0, intOr(b.price, PRICES[plan] || 0)),
      );
      await closeEvents(env, key, ['expired', 'trial_over', 'ai_not_in_trial', 'quota']);
      await addEvent(env, key, 'ok', 'plan_changed', `Now on ${plan}${intOr(b.price, PRICES[plan] || 0) ? ` (${intOr(b.price, PRICES[plan] || 0)} SAR/month)` : ''}`, 'Their key keeps working; nothing to reinstall.');
      break;
    }
    case 'update': {
      const f = b.fields || {};
      const portals = Array.isArray(f.portals) ? f.portals.filter((p) => ALL_PORTALS.includes(p)) : lic.portals;
      if (!portals.length) return fail(400, 'no_portals', 'Choose at least one portal.');
      await run(
        'UPDATE licences SET agency = ?2, contact = ?3, portals = ?4, max_devices = ?5, ai_quota = ?6, notes = ?7, price = ?8 WHERE key = ?1',
        f.agency != null ? cleanText(f.agency, 120) : lic.agency,
        f.contact != null ? cleanText(f.contact, 40) : lic.contact,
        JSON.stringify(portals),
        Math.max(1, intOr(f.max_devices, lic.max_devices)),
        intOr(f.ai_quota, lic.ai_quota),
        f.notes != null ? cleanText(f.notes, 500) : lic.notes,
        f.price != null && f.price !== '' ? Math.max(0, intOr(f.price, priceOf(lic))) : priceOf(lic),
      );
      await addEvent(env, key, 'info', 'details', f.price != null && +f.price !== priceOf(lic) ? `Details changed (price ${priceOf(lic)} → ${intOr(f.price, priceOf(lic))} SAR)` : 'Details changed');
      break;
    }
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
    case 'remove_device':
      await run('DELETE FROM devices WHERE key = ?1 AND device = ?2', cleanText(b.device, 64));
      await closeEvents(env, key, ['device_limit', 'device_removed']);
      await addEvent(env, key, 'info', 'device_removed_by_you', `Computer removed (${cleanText(b.device, 8)})`, 'That computer must enter the key again.');
      break;
    case 'add_ai': {
      const n = intOr(b.amount, 100);
      if (n < 1 || n > 100000) return fail(400, 'bad_amount', 'Amount must be between 1 and 100000.');
      await run('UPDATE licences SET ai_quota = ai_quota + ?2 WHERE key = ?1 AND ai_quota >= 0', n);
      await closeEvents(env, key, ['quota', 'ai_not_in_trial']);
      await addEvent(env, key, 'ok', 'ai_added', `+${n} AI reads`, 'Read with AI works again straight away.');
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
      await closeEvents(env, key, ['device_limit']);
      await addEvent(env, key, 'ok', 'device_slot', `Computers allowed: ${lic.max_devices + 1}`, 'They can now enter the key on one more computer.');
      break;
    default:
      return fail(400, 'bad_action', 'Unknown action.');
  }
  return adminDetail(env, key);
}

// ---------------------------------------------------------------- router

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    try {
      if (!env.DB) return fail(503, 'not_set_up', 'The database (DB) is not connected to this Worker.');

      if (path === '/') return new Response('SafarFill API', { headers: { 'content-type': 'text/plain' } });
      if (path === '/favicon.ico') return new Response(null, { status: 204 });
      if (path === '/v1/ping') return json({ ok: true, version: API_VERSION });
      if (path === '/v1/session' && req.method === 'POST') return await session(env, req);
      if (path === '/v1/parse' && req.method === 'POST') return await parse(env, req);
      if (path === '/v1/ai' && req.method === 'POST') return await aiRead(env, req);

      if (path === '/admin' && req.method === 'GET') {
        return new Response(ADMIN_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', ...ADMIN_HEADERS } });
      }
      if (path === '/admin/app.js' && req.method === 'GET') {
        return new Response(ADMIN_JS, { headers: { 'content-type': 'text/javascript; charset=utf-8', ...ADMIN_HEADERS } });
      }
      if (path.startsWith('/admin/api/')) {
        const denied = await requireAdmin(env, req);
        if (denied) return denied;
        await ensurePriceColumn(env);
        if (path === '/admin/api/licences' && req.method === 'GET') return await adminList(env);
        if (path === '/admin/api/licences' && req.method === 'POST') return await adminCreate(env, req);
        if (path === '/admin/api/licence' && req.method === 'GET') return await adminDetail(env, cleanText(url.searchParams.get('key'), 20).toUpperCase());
        if (path === '/admin/api/action' && req.method === 'POST') return await adminAction(env, req);
      }
      return fail(404, 'not_found', 'Not found.');
    } catch (e) {
      console.error(e && e.stack ? e.stack : e);
      return fail(500, 'server_error', 'Something went wrong on the server. Try again.');
    }
  },
};
