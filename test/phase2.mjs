// Tests for v1.9.0: rules service, portal switch, announcements, activity log, clean-up.
import { readFileSync } from 'node:fs';
const B = 'http://localhost:8787';
const A = { authorization: 'Bearer test-admin-key-1234567890', 'content-type': 'application/json' };
let pass = 0, failN = 0;
const ok = (c, m) => { if (c) pass++; else { failN++; console.log('FAIL:', m); } };
const post = (p, b, h = {}) => fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(b) }).then(async (r) => ({ s: r.status, j: await r.json() }));
const get = (p, h = {}) => fetch(B + p, { headers: h }).then(async (r) => ({ s: r.status, j: await r.json() }));
const CF = (ip) => ({ 'cf-connecting-ip': ip });

const pubJwk = JSON.parse(readFileSync(new URL('./rules-test-public.json', import.meta.url)));
const pub = await crypto.subtle.importKey('jwk', pubJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
const verify = async (payload, sig) => crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub,
  Uint8Array.from(atob(sig), (c) => c.charCodeAt(0)), new TextEncoder().encode(payload));

// licences
const std = (await post('/admin/api/licences', { plan: 'standard', agency: 'Rules Co' }, A)).j.key;
const st = (await post('/admin/api/licences', { plan: 'starter', agency: 'Starter Rules', portals: ['akbar'] }, A)).j.key;
const s1 = await post('/v1/session', { key: std, device: 'dev-rules-0001', version: '1.1.3' }, CF('1.1.1.1'));
const s2 = await post('/v1/session', { key: st, device: 'dev-rules-0002', version: '1.1.3' }, CF('2.2.2.2'));
const P1 = { authorization: 'Bearer ' + s1.j.pass }, P2 = { authorization: 'Bearer ' + s2.j.pass };

// --- 1. rules
ok(s1.j.ok && s1.j.rules_version >= 1, 'session has rules_version ' + s1.j.rules_version);
ok(s1.j.portal_status && s1.j.portal_status.akbar.on === true, 'session has portal_status');
let r = await get('/v1/rules', P1);
ok(r.j.ok && r.j.version === s1.j.rules_version && typeof r.j.payload === 'string' && r.j.sig, 'rules answer');
ok(await verify(r.j.payload, r.j.sig), 'signature verifies with the public key');
ok(!(await verify(r.j.payload.replace('PIA', 'PIX'), r.j.sig)), 'changed payload does not verify');
const pl = JSON.parse(r.j.payload);
ok(pl.schema === 1 && pl.version === r.j.version && pl.airlines.length === 34 && pl.airlines[0].id === 'pia' && pl.issued_at > 0, 'seed v1 airlines');
ok((await get('/v1/rules?have=' + r.j.version, P1)).j.unchanged === true, 'have=N unchanged');
ok((await get('/v1/rules')).s === 401, 'rules need a pass');

// admin: copy, edit, validate, test, release
const v1 = r.j.version;
let list = (await get('/admin/api/rules', A)).j;
ok(list.key_set && list.public_key && list.public_key.x === pubJwk.x && !list.public_key.d, 'admin shows public key only');
const draft = (await post('/admin/api/rules', { action: 'copy', id: v1 }, A)).j.id;
const full = (await get('/admin/api/rules?id=' + draft, A)).j.rules;
ok(full.status === 'draft' && full.body.airlines.length === 34, 'copy is a draft');
const bad = await post('/admin/api/rules', { action: 'save', id: draft, body: { schema: 1, airlines: [{ id: 'x' }], messages: { a: 5 }, portals: { nope: {} } } }, A);
ok(bad.s === 400 && bad.j.errors.length >= 3, 'invalid bundle refused: ' + JSON.stringify(bad.j.errors));
const big = 'x'.repeat(210 * 1024);
ok((await post('/admin/api/rules', { action: 'check', body: { schema: 1, airlines: [], messages: {}, portals: { akbar: { big } } } }, A)).j.errors.some((e) => e.includes('200 KB')), 'recipe over 200 KB refused');
const body2 = { ...full.body, messages: { fill_done: 'Filled. Check the form.' }, portals: { akbar: { steps: [1, 2] }, alhind: { steps: [3] } } };
ok((await post('/admin/api/rules', { action: 'save', id: draft, body: body2, note: 'akbar + alhind recipes' }, A)).j.ok, 'draft saved');
ok((await post('/admin/api/rules', { action: 'test', id: draft }, A)).j.ok, 'sent to testers');
ok((await get('/v1/rules', P1)).j.version === v1, 'normal licence still gets released version');
await post('/admin/api/action', { key: std, action: 'set_rules_tester', on: true }, A);
r = await get('/v1/rules', P1);
ok(r.j.version === draft && JSON.parse(r.j.payload).portals.akbar, 'tester gets test version');
ok((await post('/v1/session', { key: std, device: 'dev-rules-0001', version: '1.1.3' }, CF('1.1.1.1'))).j.rules_version === draft, 'tester session rules_version');
ok((await post('/admin/api/rules', { action: 'save', id: draft, body: body2 }, A)).s === 400, 'test version cannot be edited');
ok((await post('/admin/api/rules', { action: 'release', id: draft }, A)).j.ok, 'released');
r = await get('/v1/rules', P2);
const p2l = JSON.parse(r.j.payload);
ok(r.j.version === draft && p2l.portals.akbar && !p2l.portals.alhind && p2l.messages.fill_done, 'starter gets only its portal');
ok(await verify(r.j.payload, r.j.sig), 'released signature verifies');
// rollback = new higher version with old body
const rb = (await post('/admin/api/rules', { action: 'rollback', id: v1 }, A)).j.id;
r = await get('/v1/rules', P2);
ok(rb > draft && r.j.version === rb && !Object.keys(JSON.parse(r.j.payload).portals).length, 'rollback is a new higher version');
list = (await get('/admin/api/rules', A)).j;
ok(list.live === rb && list.versions.find((v) => v.id === draft).status === 'retired', 'old release retired');
ok((await post('/admin/api/rules', { action: 'release', id: draft }, A)).s === 400, 'retired cannot be released again');

// --- 2. portal switch
let f = await post('/v1/fill', { portal: 'akbar' }, P1);
ok(f.j.ok, 'fill works when on');
await post('/admin/api/action', { action: 'set_portal', portal: 'akbar', on: false, message: '' }, A);
f = await post('/v1/fill', { portal: 'akbar' }, P1);
ok(f.s === 423 && f.j.error === 'portal_paused' && f.j.message === 'Akbar filling is paused for an update. Fill by hand for now.', 'paused portal refused 423');
ok((await post('/v1/fill', { portal: 'alhind' }, P1)).j.ok, 'other portal still works');
r = await get('/v1/rules?have=999', P1);
ok(r.j.portal_status.akbar.on === false && r.j.portal_status.akbar.message, 'rules show portal_status');
const sx = await post('/v1/session', { key: std, device: 'dev-rules-0001', version: '1.1.3' }, CF('1.1.1.1'));
ok(sx.j.portal_status.akbar.on === false, 'session shows paused');
await post('/admin/api/action', { action: 'set_portal', portal: 'akbar', on: false, message: 'Akbar changed its page. Fixing.' }, A);
ok((await post('/v1/fill', { portal: 'akbar' }, P1)).j.message === 'Akbar changed its page. Fixing.', 'custom pause message');
await post('/admin/api/action', { action: 'set_portal', portal: 'akbar', on: true }, A);
ok((await post('/v1/fill', { portal: 'akbar' }, P1)).j.ok, 'switched on again');

// --- 3. announcements
ok((await post('/admin/api/action', { action: 'add_announcement', text: 'x'.repeat(301) }, A)).s === 400, 'too long refused');
ok((await post('/admin/api/action', { action: 'add_announcement', text: 'hi', link: 'http://a.com' }, A)).s === 400, 'http link refused');
await post('/admin/api/action', { action: 'add_announcement', text: 'Server maintenance tonight <b>11 PM</b>', level: 'warning', link: 'https://sahllabs.com/news' }, A);
await post('/admin/api/action', { action: 'add_announcement', text: 'Starter: new portal available', target_type: 'plan', target: 'starter' }, A);
await post('/admin/api/action', { action: 'add_announcement', text: 'Your payment is due', level: 'urgent', target_type: 'licence', target: std }, A);
await post('/admin/api/action', { action: 'add_announcement', text: 'Old one', until: '2020-01-01' }, A).then((x) => ok(x.s === 400, 'past date refused'));
let sp = (await get('/v1/support')).j;
ok(sp.website === 'https://sahllabs.com' && 'whatsapp' in sp && sp.announcements.length === 1 && sp.announcements[0].text.includes('<b>'), 'public: only all, text unchanged');
sp = (await get('/v1/support', P2)).j;
ok(sp.announcements.length === 2 && sp.announcements.some((a) => a.text.startsWith('Starter')), 'starter pass: all + plan');
sp = (await get('/v1/support', P1)).j;
ok(sp.announcements.length === 2 && sp.announcements.some((a) => a.level === 'urgent'), 'standard pass: all + licence');
const ann = (await get('/admin/api/licences', A)).j.announcements;
await post('/admin/api/action', { action: 'delete_announcement', id: ann[0].id }, A);
ok((await get('/v1/support', P1)).j.announcements.length === 1, 'deleted');

// --- 4. activity log
const LL = 'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<', L2 = 'L898902C36UTO7408122F1204159ZE184226B<<<<<10';
await post('/v1/parse', { lines: [LL, L2] }, { ...P1, 'x-read-start': '1', ...CF('1.1.1.1') });
await post('/v1/parse', { lines: [LL, L2] }, { ...P1, ...CF('1.1.1.1') }); // not a page start: not logged
let d = (await get('/admin/api/licence?key=' + std, A)).j;
const acts = d.actions.map((a) => a.action + (a.detail ? ':' + a.detail : ''));
ok(acts.includes('parse page') && acts.includes('session') && acts.includes('fill:akbar') && acts.includes('refused:fill akbar: portal_paused'), 'actions logged ' + JSON.stringify(acts.slice(0, 12)));
ok(acts.filter((a) => a === 'parse page').length === 1, 'only page starts logged');
ok(d.places.length === 1 && d.places[0].ip === '1.1.1.1', 'computer last ip');
ok(!JSON.stringify(d.actions).includes('ERIKSSON'), 'no passport data in log');
// ai calls merged into actions
await fetch(B + '/v1/ai', { method: 'POST', headers: { ...P1, ...CF('1.1.1.1'), 'content-type': 'text/plain', 'x-image-type': 'image/jpeg' }, body: 'QUJDREVGR0hJSktMTU5PUFFS' });
d = (await get('/admin/api/licence?key=' + std, A)).j;
ok(d.actions[0].action === 'ai' && d.actions[0].detail === 'ok' && d.actions[0].ip === '1.1.1.1', 'ai call in actions with ip');
// more than 5 IPs for one computer in a day -> attention
for (let i = 0; i < 6; i++) await post('/v1/fill', { portal: 'alhind' }, { ...P1, ...CF('9.9.9.' + i) });
let open = (await get('/admin/api/licences', A)).j.open;
ok(open.some((e) => e.code === 'ip_many' && e.key === std), 'many IPs alert');
// refused session logged for an expired licence
const ex = (await post('/admin/api/licences', { plan: 'starter', agency: 'Expired Co', days: 1 }, A)).j.key;
await post('/v1/session', { key: ex, device: 'dev-exp-00001', version: '1.1.3' });

// --- 5. clean-up (Cron): rows older than 90 days removed
const cron = await fetch(B + '/__scheduled?cron=0+2+*+*+*');
ok(cron.status === 200, 'scheduled handler runs');
d = (await get('/admin/api/licence?key=' + std, A)).j;
ok(d.actions.length > 5, 'recent rows kept after clean-up');

// --- compatibility: old endpoints unchanged
ok((await get('/v1/ping')).j.version === '1.9.0', 'ping');
ok((await post('/v1/session', { key: std, device: 'dev-rules-0001', version: '1.1.3' })).j.licence.portals.length === 4, 'session licence unchanged');

for (const k of [std, st, ex]) await post('/admin/api/action', { key: k, action: 'delete_licence' }, A);
console.log(`phase2: passed ${pass}, failed ${failN}`);
