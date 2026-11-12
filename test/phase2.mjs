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
// v1.10.0: recipes, phone and theme checked like SafarFill 1.3 does
const chk = async (body) => (await post('/admin/api/rules', { action: 'check', body: { schema: 1, airlines: [], messages: {}, portals: {}, ...body } }, A)).j;
const has = (j, s) => !j.ok && j.errors.some((e) => e.includes(s));
ok(has(await chk({ portals: { akbar: { recipe: 2 } } }), 'portals.akbar.recipe'), 'recipe must be 1');
ok(has(await chk({ portals: { akbar: { recipe: 1, controls: { first: 'F Name!' } } } }), 'portals.akbar.controls.first'), 'bad control name refused');
ok(has(await chk({ portals: { akbar: { recipe: 1, controls: 'FName' } } }), 'portals.akbar.controls'), 'group as single value refused (no crash)');
ok(has(await chk({ portals: { akbar: { recipe: 1, dateFormat: 'DD/MM/YY' } } }), 'dateFormat'), 'bad date format refused');
ok(has(await chk({ portals: { alhind: { recipe: 1, fields: { first: 'input<script>' } } } }), 'fields.first'), 'bad selector refused');
ok(has(await chk({ portals: { akbar: { recipe: 1, colour: 'x' } } }), 'portals.akbar.colour'), 'unknown recipe key refused');
ok(has(await chk({ portals: { airsial: { recipe: 1, rows: { ADT: { first: 'F_AdultName{n}{n}' } } } } }), 'rows.ADT.first'), 'bad Air Sial id refused');
ok(has(JSON.parse(JSON.stringify(await (await fetch(B + '/admin/api/rules', { method: 'POST', headers: A, body: '{"action":"check","body":{"schema":1,"portals":{"akbar":{"recipe":1,"__proto__":{"x":"y"}}}}}' })).json())), '__proto__'), '__proto__ key refused');
ok(has(await chk({ phone: { phone: 1, local: [{ country: 'PK', dial: '92', starts: ['03'], length: 30, drop0: true }] } }), 'phone.local.0'), 'bad phone rule refused');
ok(has(await chk({ phone: { phone: 1, local: [] } }), 'phone.local'), 'empty phone list refused');
ok(has(await chk({ phone: { phone: 1, notes: { unknown: 'my_note' } } }), 'no text for "my_note"'), 'phone note needs a message');
ok((await chk({ phone: { phone: 1, notes: { unknown: 'my_note' } }, messages: { my_note: 'Choose the flag.' } })).ok, 'phone note with message ok');
ok(has(await chk({ theme: { theme: 1, colors: { light: { brand: 'red' } } } }), 'theme.colors.light.brand'), 'bad colour refused');
ok(has(await chk({ theme: { theme: 1, logo: 'https://evil.example.com/x.png' } }), 'theme.logo'), 'logo host refused');
ok(has(await chk({ theme: { theme: 1, show: { warnings: false } } }), 'theme.show.warnings'), 'unknown show key refused');
ok(has(await chk({ theme: { theme: 1, labels: { fill: 'x'.repeat(61) } } }), 'theme.labels.fill'), 'long label refused');
ok((await chk({ theme: { theme: 1, textSize: 'large', compact: true, colors: { dark: { brand: '#112233' } }, logo: 'https://sahllabs.com/logo.png' } })).ok, 'good theme ok');
const body2 = { ...full.body, messages: { fill_done: 'Filled. Check the form.' }, portals: { akbar: { recipe: 1, dateFormat: 'DD-MM-YYYY' }, alhind: { recipe: 1 } } };
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
ok((await get('/v1/ping')).j.version === '1.10.0', 'ping');

// --- 6. SafarFill 1.3 starting values, phone + theme in the signed payload, rules_ignored
const v13 = await post('/admin/api/rules', { action: 'load_v13' }, A);
ok(v13.j.ok, 'load 1.3 starting values: ' + JSON.stringify(v13.j.errors || ''));
const d13 = (await get('/admin/api/rules?id=' + v13.j.id, A)).j.rules;
ok(d13.status === 'draft' && d13.body.portals.akbar.recipe === 1 && d13.body.portals.muqeem && d13.body.phone.local.length === 8 && d13.body.theme.theme === 1, 'draft has recipes, phone, theme');
ok(d13.body.messages.phone_unsure && d13.body.messages.one_name_no_airline && d13.body.airlines.length === 34, 'draft keeps airlines, adds texts');
ok((await post('/admin/api/rules', { action: 'test', id: v13.j.id }, A)).j.ok, '1.3 draft passes and goes to testers');
r = await get('/v1/rules', P1);
let pl13 = JSON.parse(r.j.payload);
ok(r.j.version === v13.j.id && pl13.phone && pl13.theme && pl13.portals.alhind.recipe === 1, 'tester payload has phone + theme');
ok(await verify(r.j.payload, r.j.sig), '1.3 payload signature verifies');
ok(JSON.parse((await get('/v1/rules', P2)).j.payload).phone === undefined, 'non-tester still on the old version');
list = (await get('/admin/api/rules', A)).j;
ok(list.versions.find((v) => v.id === v13.j.id).phone === true && list.versions.find((v) => v.id === v13.j.id).theme === true, 'list shows phone + theme');
const fi = await post('/v1/fill', { portal: 'alhind', rules_ignored: ['portals.alhind.fields.first', 'theme.colors.light.brand', '<b>x</b>'] }, P1);
ok(fi.j.ok, 'fill with rules_ignored ok');
d = (await get('/admin/api/licence?key=' + std, A)).j;
const ri = d.actions.find((a) => a.action === 'rules_ignored');
ok(ri && ri.detail.startsWith('rules v' + v13.j.id + ': portals.alhind.fields.first, theme.colors.light.brand') && !ri.detail.includes('<'), 'rules_ignored logged: ' + (ri && ri.detail));
open = (await get('/admin/api/licences', A)).j.open;
ok(open.some((e) => e.code === 'rules_ignored' && e.key === std), 'rules_ignored alert');
ok((await post('/admin/api/rules', { action: 'delete', id: v13.j.id }, A)).s === 400, 'test version not deletable');
ok((await post('/v1/session', { key: std, device: 'dev-rules-0001', version: '1.1.3' })).j.licence.portals.length === 4, 'session licence unchanged');

for (const k of [std, st, ex]) await post('/admin/api/action', { key: k, action: 'delete_licence' }, A);
console.log(`phase2: passed ${pass}, failed ${failN}`);
