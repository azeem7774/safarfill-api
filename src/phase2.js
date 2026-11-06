// SafarFill licence server, Phase 2 step 1 (v1.9.0):
// - Rules service: versioned rule bundles (airlines, messages, portal recipes), signed with ECDSA P-256.
// - Portal on/off switch (server-enforced in /v1/fill).
// - Announcements to agents (/v1/support).
// - Activity log (security, 90 days) with location alerts.
// Rules and recipes are DATA ONLY. The server never sends code.

import SEED_V1 from './airlines-v1.json';

let h = null; // helpers from index.js (json, fail, now, readPass, ...)
export function setup(helpers) { h = helpers; }

const DAY = 86400000;
const MAX_RECIPE = 200 * 1024;   // bytes per portal recipe
const MAX_BUNDLE = 900 * 1024;   // whole bundle (D1 row stays well under its limit)
const MAX_MSG = 300;
const RIYADH = 3 * 3600000;      // "same day" = a calendar day in Saudi time
export const KEEP_DAYS = 90;

// ---------------------------------------------------------------- schema

export const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS rules (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft', note TEXT NOT NULL DEFAULT '', body TEXT NOT NULL, released_at INTEGER)`,
  'ALTER TABLE licences ADD COLUMN rules_tester INTEGER NOT NULL DEFAULT 0',
  `CREATE TABLE IF NOT EXISTS announcements (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL,
    text TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'info', link TEXT NOT NULL DEFAULT '', until INTEGER,
    target_type TEXT NOT NULL DEFAULT 'all', target TEXT NOT NULL DEFAULT '')`,
  `CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, key TEXT NOT NULL,
    device TEXT NOT NULL DEFAULT '', version TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '', city TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT '', action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '')`,
  'CREATE INDEX IF NOT EXISTS activity_key ON activity (key, at)',
  'CREATE INDEX IF NOT EXISTS activity_at ON activity (at)',
  "ALTER TABLE ai_calls ADD COLUMN ip TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE ai_calls ADD COLUMN city TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE ai_calls ADD COLUMN country TEXT NOT NULL DEFAULT ''",
];

// Version 1 = the airline rules file, released. Only when the table is empty.
export async function seedRules(env) {
  const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM rules').first();
  if (n && n.n > 0) return;
  const body = JSON.stringify({ schema: 1, airlines: SEED_V1.airlines || [], messages: {}, portals: {} });
  const t = h.now();
  await env.DB.prepare("INSERT INTO rules (created_at, status, note, body, released_at) VALUES (?1, 'released', ?2, ?3, ?1)")
    .bind(t, 'Airline name rules v1 (from safarfill-airline-rules-v1.json)', body).run();
}

// ---------------------------------------------------------------- validation

const isStr = (s) => typeof s === 'string';
// Checks a rules bundle. Returns { ok, bundle, errors: [] }.
export function validateBundle(input) {
  const errors = [];
  let b = input;
  if (isStr(b)) {
    try { b = JSON.parse(b); } catch (e) { return { ok: false, errors: [`Not valid JSON: ${e.message}`] }; }
  }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { ok: false, errors: ['The bundle must be a JSON object.'] };
  if (b.schema !== 1) errors.push('"schema" must be 1.');
  const airlines = b.airlines === undefined ? [] : b.airlines;
  if (!Array.isArray(airlines)) errors.push('"airlines" must be a list.');
  else {
    const ids = new Set();
    airlines.forEach((a, i) => {
      const at = `airlines[${i}]${a && isStr(a.id) ? ` (${a.id})` : ''}`;
      if (!a || typeof a !== 'object' || Array.isArray(a)) { errors.push(`${at}: must be an object.`); return; }
      if (!isStr(a.id) || !a.id) errors.push(`${at}: "id" must be text.`);
      else if (ids.has(a.id)) errors.push(`${at}: the id "${a.id}" is used twice.`);
      else ids.add(a.id);
      if (!isStr(a.name) || !a.name) errors.push(`${at}: "name" must be text.`);
      if (!isStr(a.rule) || !a.rule) errors.push(`${at}: "rule" must be text.`);
      if (!Array.isArray(a.names) || !a.names.length || !a.names.every(isStr)) errors.push(`${at}: "names" must be a list of text.`);
      if (!Array.isArray(a.codes) || !a.codes.every(isStr)) errors.push(`${at}: "codes" must be a list of text.`);
    });
  }
  const messages = b.messages === undefined ? {} : b.messages;
  if (!messages || typeof messages !== 'object' || Array.isArray(messages)) errors.push('"messages" must be an object of key: text.');
  else for (const [k, v] of Object.entries(messages)) {
    if (!isStr(v)) errors.push(`messages.${k}: must be text.`);
    else if (v.length > MAX_MSG) errors.push(`messages.${k}: longer than ${MAX_MSG} characters.`);
  }
  const portals = b.portals === undefined ? {} : b.portals;
  if (!portals || typeof portals !== 'object' || Array.isArray(portals)) errors.push('"portals" must be an object of portal: recipe.');
  else for (const [k, v] of Object.entries(portals)) {
    if (!h.ALL_PORTALS.includes(k)) errors.push(`portals.${k}: unknown portal (use ${h.ALL_PORTALS.join(', ')}).`);
    const size = new TextEncoder().encode(JSON.stringify(v)).length;
    if (size > MAX_RECIPE) errors.push(`portals.${k}: ${Math.round(size / 1024)} KB, more than 200 KB.`);
  }
  const clean = { schema: 1, airlines: Array.isArray(airlines) ? airlines : [], messages: messages || {}, portals: portals || {} };
  if (new TextEncoder().encode(JSON.stringify(clean)).length > MAX_BUNDLE) errors.push('The whole bundle is larger than 900 KB.');
  return { ok: errors.length === 0, bundle: clean, errors };
}

// ---------------------------------------------------------------- signing (ECDSA P-256, SHA-256)

let signKey = null;
let signKeySrc = '';
async function rulesKey(env) {
  const src = env.RULES_PRIVATE_KEY || '';
  if (!src) return null;
  if (signKey && signKeySrc === src) return signKey;
  const jwk = JSON.parse(src);
  signKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  signKeySrc = src;
  return signKey;
}
// The public half of RULES_PRIVATE_KEY (for the dashboard), or null.
export function publicJwk(env) {
  try {
    const j = JSON.parse(env.RULES_PRIVATE_KEY || '');
    if (!j || j.kty !== 'EC' || j.crv !== 'P-256' || !j.x || !j.y || !j.d) return null;
    return { kty: 'EC', crv: 'P-256', x: j.x, y: j.y, ext: true, key_ops: ['verify'] };
  } catch (e) { return null; }
}
function b64(bytes) {
  let s = '';
  const u = new Uint8Array(bytes);
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
}
// Signature = base64 of the raw 64-byte r||s (the WebCrypto ECDSA format), over the UTF-8 bytes of payload.
export async function signPayload(env, payload) {
  const key = await rulesKey(env);
  if (!key) return null;
  return b64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(payload)));
}

// ---------------------------------------------------------------- rules for a licence

// The version a licence gets: newest released, or for a rules tester the newest test/released.
export async function rulesRowFor(env, lic) {
  const sql = lic && lic.rules_tester
    ? "SELECT id, body FROM rules WHERE status IN ('released', 'test') ORDER BY id DESC LIMIT 1"
    : "SELECT id, body FROM rules WHERE status = 'released' ORDER BY id DESC LIMIT 1";
  return env.DB.prepare(sql).first();
}
export async function rulesVersionFor(env, lic) {
  const sql = lic && lic.rules_tester
    ? "SELECT id FROM rules WHERE status IN ('released', 'test') ORDER BY id DESC LIMIT 1"
    : "SELECT id FROM rules WHERE status = 'released' ORDER BY id DESC LIMIT 1";
  const r = await env.DB.prepare(sql).first();
  return r ? r.id : null;
}

// GET /v1/rules (Bearer pass). ?have=N returns { unchanged: true } when N is already the newest.
export async function getRules(env, req, g) {
  const url = new URL(req.url);
  const row = await rulesRowFor(env, g.lic);
  const portal_status = await portalStatus(env);
  if (!row) return h.fail(404, 'no_rules', 'No rules have been released yet.', { portal_status });
  const have = parseInt(url.searchParams.get('have') || '', 10);
  if (have === row.id) return h.json({ ok: true, version: row.id, unchanged: true, portal_status });
  let bundle = {};
  try { bundle = JSON.parse(row.body); } catch (e) { bundle = {}; }
  const portals = {};
  for (const p of g.lic.portals) if (bundle.portals && bundle.portals[p] !== undefined) portals[p] = bundle.portals[p];
  const payload = JSON.stringify({
    schema: 1, version: row.id, issued_at: h.now(),
    airlines: bundle.airlines || [], messages: bundle.messages || {}, portals,
  });
  const sig = await signPayload(env, payload);
  if (!sig) return h.fail(503, 'rules_not_ready', 'The rules service is not set up yet. Contact Sahl Labs.', { portal_status });
  return h.json({ ok: true, version: row.id, payload, sig, portal_status });
}

// ---------------------------------------------------------------- portal switch

const PORTAL_NAMES = { akbar: 'Akbar', alhind: 'Alhind', airsial: 'Air Sial', muqeem: 'Muqeem' };
export const defaultPauseMsg = (p) => `${PORTAL_NAMES[p] || p} filling is paused for an update. Fill by hand for now.`;

// { akbar: { on: true }, alhind: { on: false, message } , ... }
export async function portalStatus(env) {
  const rows = (await env.DB.prepare("SELECT name, value FROM settings WHERE name LIKE 'portal_off_%'").all()).results;
  const off = Object.fromEntries(rows.map((r) => [r.name.slice('portal_off_'.length), r.value]));
  const out = {};
  for (const p of h.ALL_PORTALS) out[p] = off[p] !== undefined ? { on: false, message: off[p] || defaultPauseMsg(p) } : { on: true };
  return out;
}
export async function setPortal(env, portal, on, message) {
  if (!h.ALL_PORTALS.includes(portal)) return h.fail(400, 'bad_portal', 'Unknown portal.');
  const msg = h.cleanText(message, MAX_MSG) || defaultPauseMsg(portal);
  if (on) await env.DB.prepare('DELETE FROM settings WHERE name = ?1').bind(`portal_off_${portal}`).run();
  else await env.DB.prepare('INSERT INTO settings (name, value) VALUES (?1, ?2) ON CONFLICT (name) DO UPDATE SET value = ?2').bind(`portal_off_${portal}`, msg).run();
  await h.addEvent(env, 'SYSTEM', on ? 'ok' : 'warn', 'portal_switch', on ? `${PORTAL_NAMES[portal]} filling switched ON` : `${PORTAL_NAMES[portal]} filling PAUSED`, on ? '' : msg);
  return null;
}

// ---------------------------------------------------------------- announcements

const LEVELS = ['info', 'warning', 'urgent'];
export async function addAnnouncement(env, b) {
  const text = String(b.text == null ? '' : b.text).replace(/\s+/g, ' ').trim();
  if (!text) return h.fail(400, 'no_text', 'Write the message.');
  if (text.length > MAX_MSG) return h.fail(400, 'too_long', `The message is longer than ${MAX_MSG} characters.`);
  const level = LEVELS.includes(b.level) ? b.level : 'info';
  let link = h.cleanText(b.link, 500);
  if (link) {
    let u = null;
    try { u = new URL(link); } catch (e) { u = null; }
    if (!u || u.protocol !== 'https:') return h.fail(400, 'bad_link', 'The link must start with https://');
    link = u.toString();
  }
  let until = null;
  if (b.until) {
    // A date (YYYY-MM-DD) means "until the end of that day, Saudi time".
    const m = String(b.until).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return h.fail(400, 'bad_date', 'The end date must be a date.');
    until = Date.UTC(+m[1], +m[2] - 1, +m[3]) + DAY - RIYADH - 1;
    if (until < h.now()) return h.fail(400, 'bad_date', 'The end date is in the past.');
  }
  const type = ['all', 'plan', 'licence'].includes(b.target_type) ? b.target_type : 'all';
  let target = '';
  if (type === 'plan') {
    target = String(b.target || '');
    if (!['trial', 'starter', 'standard', 'owner'].includes(target)) return h.fail(400, 'bad_target', 'Choose a plan.');
  } else if (type === 'licence') {
    target = h.cleanText(b.target, 20).toUpperCase();
    if (!(await h.getLicence(env, target))) return h.fail(400, 'bad_target', 'That licence key does not exist.');
  }
  await env.DB.prepare('INSERT INTO announcements (created_at, text, level, link, until, target_type, target) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(h.now(), text, level, link, until, type, target).run();
  await h.addEvent(env, 'SYSTEM', 'info', 'announcement', `Message to ${type === 'all' ? 'everyone' : type === 'plan' ? `plan ${target}` : target}: ${text.slice(0, 80)}`);
  return null;
}
export async function listAnnouncements(env) {
  return (await env.DB.prepare('SELECT * FROM announcements ORDER BY id DESC LIMIT 100').all()).results;
}
export async function deleteAnnouncement(env, id) {
  await env.DB.prepare('DELETE FROM announcements WHERE id = ?1').bind(h.intOr(id, 0)).run();
}
// For /v1/support: "all" messages, plus the plan's and the licence's when a valid pass is sent.
export async function announcementsFor(env, req) {
  const t = h.now();
  let lic = null;
  const auth = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (auth) {
    const pass = await h.readPass(env, auth);
    if (pass) lic = await h.getLicence(env, pass.k);
  }
  const rows = lic
    ? (await env.DB.prepare(
      `SELECT id, level, text, link, until FROM announcements WHERE (until IS NULL OR until > ?1)
       AND (target_type = 'all' OR (target_type = 'plan' AND target = ?2) OR (target_type = 'licence' AND target = ?3)) ORDER BY id DESC LIMIT 20`
    ).bind(t, lic.plan, lic.key).all()).results
    : (await env.DB.prepare(
      "SELECT id, level, text, link, until FROM announcements WHERE (until IS NULL OR until > ?1) AND target_type = 'all' ORDER BY id DESC LIMIT 20"
    ).bind(t).all()).results;
  return rows.map((r) => ({ id: r.id, level: r.level, text: r.text, link: r.link || null, until: r.until || null }));
}

// ---------------------------------------------------------------- activity log

const dayStart = (t) => Math.floor((t + RIYADH) / DAY) * DAY - RIYADH;
export function where(req) {
  const cf = req.cf || {};
  return {
    ip: (req.headers.get('cf-connecting-ip') || '').slice(0, 64),
    city: String(cf.city || '').slice(0, 60),
    country: String(cf.country || '').slice(0, 2),
  };
}
// One row per action. Never passport details or images.
export async function logActivity(env, req, key, device, version, action, detail = '') {
  try {
    const t = h.now();
    const w = where(req);
    const seen = await env.DB.prepare(
      'SELECT 1 FROM activity WHERE key = ?1 AND device = ?2 AND ip = ?3 AND city = ?4 AND at >= ?5 LIMIT 1'
    ).bind(key, device || '', w.ip, w.city, dayStart(t)).first();
    await env.DB.prepare(
      'INSERT INTO activity (at, key, device, version, ip, city, country, action, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)'
    ).bind(t, key, device || '', String(version || '').slice(0, 20), w.ip, w.city, w.country, action, String(detail || '').slice(0, 60)).run();
    if (!seen) await placeAlerts(env, key, device || '', t);
  } catch (e) {
    console.error('activity log failed', e && e.message);
  }
}
// Called after an AI call was stored, so its place counts for the alerts too.
export async function afterAiCall(env, key, device, t) {
  try { await placeAlerts(env, key, device, t); } catch (e) { console.error('alerts failed', e && e.message); }
}

// Where a key/computer was seen today (Saudi day), from both logs.
async function placeAlerts(env, key, device, t) {
  const from = dayStart(t);
  const places = (await env.DB.prepare(
    `SELECT country, city, ip, device FROM activity WHERE key = ?1 AND at >= ?2
     UNION SELECT country, city, ip, device FROM ai_calls WHERE key = ?1 AND at >= ?2`
  ).bind(key, from).all()).results.filter((r) => r.country || r.city || r.ip);
  const countries = [...new Set(places.map((r) => r.country).filter(Boolean))];
  const cities = [...new Set(places.map((r) => `${r.city}${r.country ? `, ${r.country}` : ''}`).filter((c) => !c.startsWith(',') && c))];
  const ips = new Set(places.filter((r) => r.device === device).map((r) => r.ip).filter(Boolean));
  if (countries.length > 1) {
    await h.addEvent(env, key, 'warn', 'geo_country', `Used from ${countries.length} countries today: ${countries.join(', ')}. The key may be shared.`, '', 1440);
  } else if (cities.length > 1) {
    await h.addEvent(env, key, 'info', 'geo_city', `Used from ${cities.length} cities today: ${cities.slice(0, 5).join(' / ')}. Often just mobile internet.`, '', 1440);
  }
  if (device && ips.size > 5) {
    await h.addEvent(env, key, 'warn', 'ip_many', `Computer ${device.slice(0, 8)} used ${ips.size} different internet addresses today.`, '', 1440);
  }
}

// For the dashboard: each computer's last place, and the last 100 actions (activity + AI calls).
export async function activityFor(env, key) {
  const last = (await env.DB.prepare(
    `SELECT device, ip, city, country, MAX(at) AS at FROM (
       SELECT device, ip, city, country, at FROM activity WHERE key = ?1
       UNION ALL SELECT device, ip, city, country, at FROM ai_calls WHERE key = ?1 AND ip != '')
     GROUP BY device`
  ).bind(key).all()).results;
  const actions = (await env.DB.prepare(
    `SELECT at, device, version, ip, city, country, action, detail FROM activity WHERE key = ?1
     UNION ALL SELECT at, device, version, ip, city, country, 'ai' AS action, result AS detail FROM ai_calls WHERE key = ?1
     ORDER BY at DESC LIMIT 100`
  ).bind(key).all()).results;
  return { places: last, actions };
}

// Daily clean-up (Cron Trigger): keep 90 days of logs.
export async function cleanUp(env) {
  const t = h.now();
  const cut = t - KEEP_DAYS * DAY;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM activity WHERE at < ?1').bind(cut),
    env.DB.prepare('DELETE FROM ai_calls WHERE at < ?1').bind(cut),
    env.DB.prepare('DELETE FROM rate WHERE minute < ?1').bind(Math.floor(t / 60000) - 10),
  ]);
}

// ---------------------------------------------------------------- admin: rules

export async function adminRules(env, url) {
  const id = parseInt(url.searchParams.get('id') || '', 10);
  if (id) {
    const r = await env.DB.prepare('SELECT * FROM rules WHERE id = ?1').bind(id).first();
    if (!r) return h.fail(404, 'not_found', 'No such rules version.');
    let body = {};
    try { body = JSON.parse(r.body); } catch (e) { body = {}; }
    return h.json({ ok: true, rules: { ...r, body } });
  }
  const list = (await env.DB.prepare('SELECT id, created_at, status, note, released_at, LENGTH(body) AS size, body FROM rules ORDER BY id DESC LIMIT 100').all()).results
    .map((r) => {
      let b = {};
      try { b = JSON.parse(r.body); } catch (e) { b = {}; }
      return { id: r.id, created_at: r.created_at, status: r.status, note: r.note, released_at: r.released_at, size: r.size,
        airlines: (b.airlines || []).length, messages: Object.keys(b.messages || {}).length, portals: Object.keys(b.portals || {}) };
    });
  const live = await env.DB.prepare("SELECT id FROM rules WHERE status = 'released' ORDER BY id DESC LIMIT 1").first();
  const test = await env.DB.prepare("SELECT id FROM rules WHERE status IN ('released', 'test') ORDER BY id DESC LIMIT 1").first();
  const testers = (await env.DB.prepare('SELECT key, agency FROM licences WHERE rules_tester = 1').all()).results;
  return h.json({ ok: true, versions: list, live: live ? live.id : null, testers_get: test ? test.id : null, testers,
    public_key: publicJwk(env), key_set: !!env.RULES_PRIVATE_KEY });
}

export async function adminRulesAction(env, req) {
  const b = await req.json().catch(() => ({}));
  const t = h.now();
  const get = async (id) => env.DB.prepare('SELECT * FROM rules WHERE id = ?1').bind(h.intOr(id, 0)).first();
  if (b.action === 'check') {
    const v = validateBundle(b.body);
    return h.json({ ok: v.ok, errors: v.errors });
  }
  if (b.action === 'copy') {
    const src = await get(b.id);
    if (!src) return h.fail(404, 'not_found', 'No such rules version.');
    const r = await env.DB.prepare("INSERT INTO rules (created_at, status, note, body) VALUES (?1, 'draft', ?2, ?3)")
      .bind(t, `Copy of v${src.id}`, src.body).run();
    await h.addEvent(env, 'SYSTEM', 'info', 'rules', `Rules v${r.meta.last_row_id}: new draft from v${src.id}`);
    return h.json({ ok: true, id: r.meta.last_row_id });
  }
  const row = await get(b.id);
  if (!row) return h.fail(404, 'not_found', 'No such rules version.');
  if (b.action === 'save') {
    if (row.status !== 'draft') return h.fail(400, 'not_draft', 'Only a draft can be edited. Make a copy first.');
    const v = validateBundle(b.body);
    if (!v.ok) return h.json({ ok: false, error: 'invalid', message: 'The rules have problems. Fix them first.', errors: v.errors }, 400);
    await env.DB.prepare('UPDATE rules SET body = ?2, note = ?3 WHERE id = ?1').bind(row.id, JSON.stringify(v.bundle), h.cleanText(b.note, 200)).run();
    return h.json({ ok: true, id: row.id });
  }
  if (b.action === 'test' || b.action === 'release') {
    if (!['draft', 'test'].includes(row.status)) return h.fail(400, 'bad_status', `v${row.id} is ${row.status}. Use Roll back to bring back an older version.`);
    const v = validateBundle(row.body);
    if (!v.ok) return h.json({ ok: false, error: 'invalid', message: 'The rules have problems. Fix them first.', errors: v.errors }, 400);
    if (b.action === 'test') {
      // Only one version is in test at a time.
      await env.DB.prepare("UPDATE rules SET status = 'draft' WHERE status = 'test' AND id != ?1").bind(row.id).run();
      await env.DB.prepare("UPDATE rules SET status = 'test' WHERE id = ?1").bind(row.id).run();
      await h.addEvent(env, 'SYSTEM', 'info', 'rules', `Rules v${row.id} sent to testers`);
    } else {
      if (row.id < ((await env.DB.prepare("SELECT MAX(id) AS m FROM rules WHERE status = 'released'").first()) || {}).m) {
        return h.fail(400, 'older', 'A newer version is already released. Make a copy of this one and release the copy.');
      }
      await env.DB.prepare("UPDATE rules SET status = 'retired' WHERE status = 'released'").run();
      await env.DB.prepare("UPDATE rules SET status = 'released', released_at = ?2 WHERE id = ?1").bind(row.id, t).run();
      await h.addEvent(env, 'SYSTEM', 'ok', 'rules', `Rules v${row.id} released to everyone`);
    }
    return h.json({ ok: true, id: row.id });
  }
  if (b.action === 'rollback') {
    // Bring back an older version as a NEW, higher version number (the extension never accepts a lower number).
    const r = await env.DB.prepare("INSERT INTO rules (created_at, status, note, body, released_at) VALUES (?1, 'released', ?2, ?3, ?1)")
      .bind(t, `Roll back to v${row.id}`, row.body).run();
    const id = r.meta.last_row_id;
    await env.DB.prepare("UPDATE rules SET status = 'retired' WHERE status = 'released' AND id != ?1").bind(id).run();
    await env.DB.prepare("UPDATE rules SET status = 'draft' WHERE status = 'test'").run();
    await h.addEvent(env, 'SYSTEM', 'warn', 'rules', `Rolled back: v${id} released with the rules of v${row.id}`);
    return h.json({ ok: true, id });
  }
  if (b.action === 'delete') {
    if (row.status !== 'draft') return h.fail(400, 'not_draft', 'Only a draft can be deleted.');
    await env.DB.prepare('DELETE FROM rules WHERE id = ?1').bind(row.id).run();
    return h.json({ ok: true });
  }
  return h.fail(400, 'bad_action', 'Unknown action.');
}
