const B = 'http://localhost:8787';
const A = { authorization: 'Bearer test-admin-key-1234567890', 'content-type': 'application/json' };
let pass = 0, failN = 0;
const ok = (c, m) => { if (c) pass++; else { failN++; console.log('FAIL:', m); } };
const post = (p, b, h = {}) => fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: typeof b === 'string' ? b : JSON.stringify(b) }).then(async (r) => ({ s: r.status, j: await r.json() }));
const get = (p, h) => fetch(B + p, { headers: h }).then(async (r) => ({ s: r.status, j: await r.json().catch(() => null), r }));

// admin auth
ok((await get('/admin/api/licences', { authorization: 'Bearer wrong-wrong-wrong-wrong' })).s === 401, 'admin wrong key 401');
const page = await fetch(B + '/admin'); ok(page.status === 200 && (await page.text()).includes('SafarFill Admin'), 'admin page');
ok((await fetch(B + '/admin/app.js')).headers.get('content-type').includes('javascript'), 'admin js');

// create keys
const t = await post('/admin/api/licences', { plan: 'trial', agency: 'Test Travels', contact: '966500000000' }, A);
ok(t.j.ok && /^SF-/.test(t.j.key), 'create trial');
const trialKey = t.j.key;
const s = await post('/admin/api/licences', { plan: 'starter', agency: 'Starter Co', portals: ['alhind'], ai_quota: 2 }, A);
const starterKey = s.j.key;

// session
const bad = await post('/v1/session', { key: 'SF-AAAA-AAAA-AAAA', device: 'dev-12345678' });
ok(bad.s === 403 && bad.j.error === 'unknown_key', 'unknown key');
const s1 = await post('/v1/session', { key: trialKey.toLowerCase(), device: 'dev-pc1-000001', version: '1.1.0' });
ok(s1.j.ok && s1.j.pass && s1.j.licence.plan === 'trial' && s1.j.licence.ai_left === 0, 'trial session ' + JSON.stringify(s1.j));
ok(s1.j.licence.expires_at > Date.now() + 47 * 3600e3, 'trial 2 days started');
const s2 = await post('/v1/session', { key: trialKey, device: 'dev-pc2-000002' });
ok(s2.s === 403 && s2.j.error === 'device_limit', 'second PC blocked');
await post('/v1/session', { key: trialKey, device: 'dev-pc2-000002' });
const ev = (await get('/admin/api/licences', A)).j;
ok(ev.open.filter((e) => e.code === 'device_limit' && e.key === trialKey).length === 1, 'device refusal recorded once');
ok(ev.feed.some((e) => e.code === 'trial_started'), 'trial start in feed');
const slot = await post('/admin/api/action', { key: trialKey, action: 'add_device_slot' }, A);
ok(slot.j.licence.max_devices === 2, '+1 computer');
ok(!(await get('/admin/api/licences', A)).j.open.some((e) => e.code === 'device_limit'), 'device attention closed');
ok((await post('/v1/session', { key: trialKey, device: 'dev-pc2-000002' })).j.ok, 'second PC allowed now');
const s1b = await post('/v1/session', { key: trialKey, device: 'dev-pc1-000001' });
ok(s1b.j.ok, 'same PC again ok');
const P = { authorization: 'Bearer ' + s1.j.pass };

// parse
const L1 = 'P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<';
const L2 = 'L898902C36UTO7408122F1204159ZE184226B<<<<<10';
const pr = await post('/v1/parse', { lines: ['REPUBLIC OF UTOPIA PASSPORT NUMBER', L1, L2] }, { ...P, 'x-read-start': '1' });
ok(pr.j.ok && pr.j.parsed && pr.j.parsed.fields.surname === 'ERIKSSON' && pr.j.parsed.fields.passportNo === 'L898902C3' && pr.j.parsed.checks.passportNumber, 'parse lines ' + JSON.stringify(pr.j).slice(0, 300));
const pp = await post('/v1/parse', { pairs: [[L1, L2], ['junk', 'junk']] }, P);
ok(pp.j.results.length === 2 && pp.j.results[0].fields.givenNames === 'ANNA MARIA' && pp.j.results[1].valid === false, 'parse pairs');
ok((await post('/v1/parse', { lines: [L1, L2] })).s === 401, 'parse needs pass');
ok((await post('/v1/parse', { lines: [L1, L2] }, { authorization: 'Bearer ' + s1.j.pass.slice(0, -3) + 'abc' })).s === 401, 'tampered pass');

// ai: trial has none until you give a test
const noAi = await fetch(B + '/v1/ai', { method: 'POST', headers: { ...P, 'x-image-type': 'image/jpeg' }, body: 'QUJDREVGR0hJSktMTU5PUFFS' }).then(async (r) => ({ s: r.status, j: await r.json() }));
ok(noAi.s === 402 && noAi.j.error === 'ai_not_in_plan' && /not included in the free trial/.test(noAi.j.message), 'trial AI off ' + JSON.stringify(noAi.j));
const lst0 = await get('/admin/api/licences', A);
ok(lst0.j.open.some((e) => e.code === 'ai_not_in_trial' && e.key === trialKey), 'wants-AI shows in attention');
const tst = await post('/admin/api/action', { key: trialKey, action: 'ai_test', amount: 10 }, A);
ok(tst.j.licence.ai_quota === 10, 'ai test 10');
const lst1 = await get('/admin/api/licences', A);
ok(!lst1.j.open.some((e) => e.code === 'ai_not_in_trial'), 'attention closed after AI test');
const ai = await fetch(B + '/v1/ai', { method: 'POST', headers: { ...P, 'content-type': 'text/plain', 'x-image-type': 'image/jpeg' }, body: 'QUJDREVGR0hJSktMTU5PUFFS' }).then((r) => r.json());
ok(ai.ok && ai.fields.surname === 'AHMAD' && ai.fields.model === 'claude-sonnet-5-5' && ai.ai_left === 9, 'ai read ' + JSON.stringify(ai));
const aiBad = await fetch(B + '/v1/ai', { method: 'POST', headers: { ...P, 'x-image-type': 'image/jpeg' }, body: 'not base64 !!' }).then((r) => r.json());
ok(aiBad.error === 'bad_image', 'bad image rejected');
const aiType = await fetch(B + '/v1/ai', { method: 'POST', headers: { ...P, 'x-image-type': 'text/html' }, body: 'QUJDREVGR0hJSktMTU5PUFFS' }).then((r) => r.json());
ok(aiType.error === 'bad_image', 'bad type rejected');

// starter quota (2)
const ss = await post('/v1/session', { key: starterKey, device: 'dev-st-0000001' });
ok(ss.j.licence.portals.join() === 'alhind' && ss.j.licence.ai_left === 2, 'starter portals/quota');
const SP = { authorization: 'Bearer ' + ss.j.pass, 'x-image-type': 'image/jpeg' };
for (let i = 0; i < 2; i++) await fetch(B + '/v1/ai', { method: 'POST', headers: SP, body: 'QUJDREVGR0hJSktMTU5PUFFS' });
const q = await fetch(B + '/v1/ai', { method: 'POST', headers: SP, body: 'QUJDREVGR0hJSktMTU5PUFFS' }).then(async (r) => ({ s: r.status, j: await r.json() }));
ok(q.s === 402 && q.j.error === 'quota', 'quota enforced');

// admin actions
const det = await post('/admin/api/action', { key: starterKey, action: 'add_ai', amount: 100 }, A);
ok(det.j.licence.ai_quota === 102, 'add ai');
const blk = await post('/admin/api/action', { key: starterKey, action: 'block' }, A);
ok(blk.j.licence.status === 'blocked', 'block');
const afterBlock = await post('/v1/parse', { lines: [L1, L2] }, { authorization: 'Bearer ' + ss.j.pass });
ok(afterBlock.s === 403 && afterBlock.j.error === 'blocked', 'blocked pass rejected live');
await post('/admin/api/action', { key: starterKey, action: 'unblock' }, A);
const rm = await post('/admin/api/action', { key: starterKey, action: 'reset_devices' }, A);
ok(rm.j.devices.length === 0, 'reset devices');
const afterRm = await post('/v1/parse', { lines: [L1, L2] }, { authorization: 'Bearer ' + ss.j.pass });
ok(afterRm.j.error === 'device_removed', 'removed device rejected');
const rejoin = await post('/v1/session', { key: starterKey, device: 'dev-st-0000001' });
ok(rejoin.j.ok, 'after "remove all" computers can join again');
const ext = await post('/admin/api/action', { key: starterKey, action: 'extend', days: 10 }, A);
ok(ext.j.licence.expires_at > Date.now() + 39 * 86400e3, 'extend adds onto remaining');
const paid = await post('/admin/api/action', { key: trialKey, action: 'make_paid', plan: 'standard' }, A);
ok(paid.j.licence.plan === 'standard' && paid.j.licence.ai_quota === 800, 'trial -> standard');
const list = await get('/admin/api/licences', A);
ok(list.j.licences.length >= 2 && list.j.totals.ai >= 3 && list.j.prices.standard === 149, 'list + totals ' + JSON.stringify(list.j.totals));
ok(list.j.feed.some((e) => e.code === 'quota') && list.j.feed.some((e) => e.code === 'blocked'), 'refusals in feed');

// owner
const o = await post('/admin/api/licences', { plan: 'owner', agency: 'Smart Flyer (own)' }, A);
const os = await post('/v1/session', { key: o.j.key, device: 'dev-owner-01' });
ok(os.j.licence.ai_left === null && os.j.licence.expires_at === null, 'owner unlimited');

// expired licence
const e = await post('/admin/api/licences', { plan: 'standard', days: 30 }, A);
// cors preflight
const pre = await fetch(B + '/v1/ai', { method: 'OPTIONS' });
ok(pre.status === 204 && pre.headers.get('access-control-allow-headers').includes('X-Image-Type'), 'cors');
// system AI failure + dismiss
const o2 = await post('/admin/api/licences', { plan: 'owner' }, A);
const os2 = await post('/v1/session', { key: o2.j.key, device: 'dev-owner-02' });
await fetch(B + '/v1/ai', { method: 'POST', headers: { authorization: 'Bearer ' + os2.j.pass }, body: 'QUJDREVGR0hJSktMTU5PUFFSbad' });
const sys = (await get('/admin/api/licences', A)).j.open.find((e) => e.code === 'ai_unavailable');
ok(sys, 'AI failure shows in attention');
if (sys) { await post('/admin/api/action', { action: 'dismiss', event_id: sys.id }, A); ok(!(await get('/admin/api/licences', A)).j.open.some((e) => e.code === 'ai_unavailable'), 'dismiss'); }
// fill check, portals, minimum version
const fk = await post('/admin/api/licences', { plan: 'starter', agency: 'Fill Co', portals: ['alhind'] }, A);
const fs = await post('/v1/session', { key: fk.j.key, device: 'dev-fill-0001', version: '1.1.0' });
const FP = { authorization: 'Bearer ' + fs.j.pass };
ok((await post('/v1/fill', { portal: 'alhind' }, FP)).j.ok, 'fill allowed portal');
const notIn = await post('/v1/fill', { portal: 'akbar' }, FP);
ok(notIn.s === 403 && notIn.j.error === 'portal_not_in_plan', 'fill refused for portal not in plan');
let LL = (await get('/admin/api/licences', A)).j;
ok(LL.licences.find((l) => l.key === fk.j.key).fill_count === 1 && LL.totals.fills >= 1, 'forms filled counted');
ok(LL.open.some((e) => e.code === 'portal_not_in_plan'), 'portal refusal in attention');
ok((await post('/admin/api/action', { action: 'set_min_version', version: '1.2.0' }, A)).j.min_version === '1.2.0', 'set min version');
const oldParse = await post('/v1/parse', { lines: [L1, L2] }, FP);
ok(oldParse.s === 426 && oldParse.j.error === 'update_required', 'old version refused');
ok((await post('/v1/session', { key: fk.j.key, device: 'dev-fill-0001', version: '1.1.0' })).s === 426, 'old version session refused');
const newS = await post('/v1/session', { key: fk.j.key, device: 'dev-fill-0001', version: '1.2.0' });
ok(newS.j.ok && (await post('/v1/fill', { portal: 'alhind' }, { authorization: 'Bearer ' + newS.j.pass })).j.ok, 'new version allowed');
ok((await get('/admin/api/licences', A)).j.settings.min_version === '1.2.0', 'setting shown');
await post('/admin/api/action', { action: 'set_min_version', version: '' }, A);
ok((await post('/v1/fill', { portal: 'alhind' }, FP)).j.ok, 'old allowed again after clearing');
ok((await post('/admin/api/action', { action: 'set_support', whatsapp: '12' }, A)).s === 400, 'bad whatsapp refused');
ok((await post('/admin/api/action', { action: 'set_support', whatsapp: '+966 51-234-5678', email: 'help@sahl.test' }, A)).j.support.whatsapp === '966512345678', 'support saved');
const sp = (await get('/v1/support')).j;
ok(sp.whatsapp === '966512345678' && sp.email === 'help@sahl.test', 'support public');
ok((await post('/v1/session', { key: fk.j.key, device: 'dev-fill-0001', version: '1.2.0' })).j.support.whatsapp === '966512345678', 'support in session');
ok((await get('/admin/api/licences', A)).j.settings.support.email === 'help@sahl.test', 'support in dashboard');
// pricing: plan + add-ons − discount
const pk = await post('/admin/api/licences', { plan: 'starter', agency: 'Add-on Co', portals: ['akbar', 'alhind'], max_devices: 2, ai_quota: 400, discount: '10%' }, A);
const pl = () => get('/admin/api/licences', A).then((r) => r.j.licences.find((l) => l.key === pk.j.key));
ok((await pl()).price === 134, 'starter + portal + pc + 100 AI − 10% = 134: ' + (await pl()).price);
const pd = (await get('/admin/api/licence?key=' + pk.j.key, A)).j.quote;
ok(pd.lines.length === 5 && pd.total === 134, 'quote lines');
ok((await post('/admin/api/licences', { plan: 'starter', discount: 'abc' }, A)).s === 400, 'bad discount refused');
await post('/admin/api/action', { key: pk.j.key, action: 'add_device_slot' }, A);
ok((await pl()).price === 157, '+1 computer reprices (79+30+50+15=174 −17 = 157): ' + (await pl()).price);
await post('/admin/api/action', { key: pk.j.key, action: 'update', fields: { discount: '20' } }, A);
ok((await pl()).price === 154, 'SAR discount: ' + (await pl()).price);
await post('/admin/api/action', { key: pk.j.key, action: 'make_paid', plan: 'standard' }, A);
ok((await pl()).price === 149 - 20 + 50, 'standard keeps discount + extra pcs: ' + (await pl()).price);
ok((await post('/admin/api/action', { action: 'set_rates', rates: { portal: 40, pc: 30, ai100: 20 } }, A)).j.rates.pc === 30, 'rates saved');
await post('/admin/api/action', { key: pk.j.key, action: 'add_ai', amount: 100 }, A);
ok((await pl()).price === 149 + 60 + 20 - 20, 'new rates on next change: ' + (await pl()).price);
const tr = await post('/admin/api/licences', { plan: 'trial', max_devices: 3 }, A);
ok((await get('/admin/api/licences', A)).j.licences.find((l) => l.key === tr.j.key).price === 0, 'trial free');
// quotes (rates are 40/30/20 here)
ok((await post('/admin/api/quotes', { plan: 'trial' }, A)).s === 400, 'trial quote refused');
const qq = await post('/admin/api/quotes', { plan: 'starter', agency: 'Quote Co', contact: '966511111111', portals: ['akbar', 'alhind'], max_devices: 2, discount: '10' }, A);
ok(qq.j.ok && qq.j.quote.price === 79 + 40 + 30 - 10 && qq.j.quote.status === 'sent', 'quote saved ' + JSON.stringify(qq.j.quote && qq.j.quote.lines));
await post('/admin/api/action', { action: 'set_rates', rates: { portal: 50, pc: 50, ai100: 50 } }, A);
const qa = await post('/admin/api/action', { action: 'quote_accept', id: qq.j.quote.id }, A);
const ql = (await get('/admin/api/licences', A)).j;
const qlic = ql.licences.find((l) => l.key === qa.j.key);
ok(qa.j.ok && qlic && qlic.price === 139 && qlic.max_devices === 2 && qlic.agency === 'Quote Co', 'accepted quote keeps quoted price after rate change: ' + (qlic && qlic.price));
ok(ql.quotes.find((q) => q.id === qq.j.quote.id).status === 'accepted' && ql.quotes[0].lines.length >= 1 && qq.j.quote.lines.length === 4, 'quote accepted, lines kept');
ok((await post('/admin/api/action', { action: 'quote_accept', id: qq.j.quote.id }, A)).s === 400, 'no double key');
const qd = await post('/admin/api/quotes', { plan: 'standard', agency: 'No Co' }, A);
ok((await post('/admin/api/action', { action: 'quote_status', id: qd.j.quote.id, status: 'declined' }, A)).j.quote.status === 'declined', 'declined');
await post('/admin/api/action', { action: 'set_payment', text: 'STC Pay: 05xxxxxxxx' }, A);
ok((await get('/admin/api/licences', A)).j.settings.payment === 'STC Pay: 05xxxxxxxx', 'payment saved');
// reads count pages (X-Read-Start), not calls
const rk = await post('/admin/api/licences', { plan: 'standard', agency: 'Read Co' }, A);
const rs = await post('/v1/session', { key: rk.j.key, device: 'dev-read-0001', version: '1.1.0' });
const RP = { authorization: 'Bearer ' + rs.j.pass };
await post('/v1/parse', { lines: [L1, L2] }, { ...RP, 'x-read-start': '1' });
await post('/v1/parse', { lines: [L1, L2] }, RP);
await post('/v1/parse', { pairs: [[L1, L2]] }, RP);
const rl = (await get('/admin/api/licences', A)).j.licences.find((l) => l.key === rk.j.key);
ok(rl.parse_count === 1, '3 calls, 1 page = 1 read: ' + rl.parse_count);
const pre2 = await fetch(B + '/v1/parse', { method: 'OPTIONS' });
ok(pre2.headers.get('access-control-allow-headers').includes('X-Read-Start'), 'CORS allows X-Read-Start');
// delete a key
const dk = await post('/admin/api/licences', { plan: 'trial', agency: 'Delete Me' }, A);
const ds = await post('/v1/session', { key: dk.j.key, device: 'dev-del-00001', version: '1.1.0' });
ok((await post('/admin/api/action', { key: dk.j.key, action: 'delete_licence' }, A)).j.deleted === dk.j.key, 'key deleted');
ok(!(await get('/admin/api/licences', A)).j.licences.some((l) => l.key === dk.j.key), 'gone from list');
ok((await post('/v1/parse', { lines: [L1, L2] }, { authorization: 'Bearer ' + ds.j.pass })).s >= 400, 'deleted key stops working');
ok((await post('/v1/session', { key: dk.j.key, device: 'dev-del-00001', version: '1.1.0' })).s === 403, 'deleted key refused');
// AI call log per computer
const ak = await post('/admin/api/licences', { plan: 'standard', agency: 'AI Log Co', max_devices: 2 }, A);
const as1 = await post('/v1/session', { key: ak.j.key, device: 'dev-ailog-0001', version: '1.1.2' });
const as2 = await post('/v1/session', { key: ak.j.key, device: 'dev-ailog-0002', version: '1.1.2' });
const aiPost = (pass) => fetch(B + '/v1/ai', { method: 'POST', headers: { authorization: 'Bearer ' + pass, 'content-type': 'text/plain', 'x-image-type': 'image/jpeg' }, body: 'QUJDREVGR0hJSktMTU5PUFFS' }).then((r) => r.json());
ok((await aiPost(as1.j.pass)).ok, 'ai ok pc1');
await aiPost(as1.j.pass); await aiPost(as2.j.pass);
let ad = (await get('/admin/api/licence?key=' + ak.j.key, A)).j;
const d1 = ad.ai_by_device.find((d) => d.device === 'dev-ailog-0001');
ok(d1 && d1.total === 2 && d1.month === 2 && ad.ai_by_device.length === 2, 'ai per computer ' + JSON.stringify(ad.ai_by_device));
ok(ad.ai_calls.length === 3 && ad.ai_calls[0].result === 'ok' && ad.ai_calls[0].version === '1.1.2' && ad.ai_calls[0].size > 0 && ad.ai_calls[0].ai_left === 797, 'last ai calls ' + JSON.stringify(ad.ai_calls[0]));
ok(!JSON.stringify(ad.ai_calls).includes('QUJD'), 'image not stored');
// burst: >30 calls in an hour from one computer (rate limit answers are logged too)
for (let i = 0; i < 29; i++) await aiPost(as1.j.pass);
let al = (await get('/admin/api/licences', A)).j;
ok(al.open.some((e) => e.code === 'ai_burst' && e.key === ak.j.key), 'ai burst alert');
// refused burst: trial without AI, 6 refused calls
const rk2 = await post('/admin/api/licences', { plan: 'trial', agency: 'Refused Co' }, A);
const rs2 = await post('/v1/session', { key: rk2.j.key, device: 'dev-refuse-001', version: '1.1.2' });
for (let i = 0; i < 6; i++) await aiPost(rs2.j.pass);
al = (await get('/admin/api/licences', A)).j;
ok(al.open.some((e) => e.code === 'ai_refused_burst' && e.key === rk2.j.key), 'refused burst alert');
const rd = (await get('/admin/api/licence?key=' + rk2.j.key, A)).j;
ok(rd.ai_calls.length === 6 && rd.ai_calls.every((c) => c.result === 'ai_not_in_plan') && rd.ai_by_device[0].total === 0, 'refused calls logged, not counted as reads');
await post('/admin/api/action', { key: ak.j.key, action: 'delete_licence' }, A);
// computer names
const nk = await post('/admin/api/licences', { plan: 'owner', agency: 'Name Co' }, A);
await post('/v1/session', { key: nk.j.key, device: 'dev-name-00001', version: '1.1.3' });
let nd = (await post('/admin/api/action', { key: nk.j.key, action: 'name_device', device: 'dev-name-00001', name: 'Front desk' }, A)).j;
ok(nd.devices[0].name === 'Front desk' && nd.names['dev-name-00001'] === 'Front desk', 'computer named');
ok((await post('/admin/api/action', { key: nk.j.key, action: 'name_device', device: 'nope-000000', name: 'X' }, A)).s === 404, 'unknown computer refused');
nd = (await post('/admin/api/action', { key: nk.j.key, action: 'remove_device', device: 'dev-name-00001' }, A)).j;
ok(nd.log.some((e) => e.what.includes('dev-name · Front desk')), 'removal shows name');
ok(nd.removed.length === 1 && nd.removed[0].device === 'dev-name-00001', 'removed computer listed');
// v1.9.3: a removed computer cannot re-join with its saved key
let back = await post('/v1/session', { key: nk.j.key, device: 'dev-name-00001', version: '1.1.3' });
ok(back.s === 403 && back.j.error === 'device_removed', 'removed computer stays out');
back = await post('/v1/session', { key: nk.j.key, device: 'dev-name-00001', version: '1.1.3' });
nd = (await get('/admin/api/licence?key=' + nk.j.key, A)).j;
ok(nd.devices.length === 0 && nd.removed[0].tries === 2 && nd.removed[0].last_try > 0, 'tries counted, not re-added');
ok(nd.log.some((e) => e.code === 'device_removed' && !e.done), 'alert raised');
const fresh = await post('/v1/session', { key: nk.j.key, device: 'dev-name-00002', version: '1.1.3' });
ok(fresh.j.ok, 'a new computer still joins');
nd = (await post('/admin/api/action', { key: nk.j.key, action: 'allow_device', device: 'dev-name-00001' }, A)).j;
ok(nd.removed.length === 0 && nd.log.some((e) => e.code === 'device_allowed'), 'allow again');
await post('/v1/session', { key: nk.j.key, device: 'dev-name-00001', version: '1.1.3' });
nd = (await get('/admin/api/licence?key=' + nk.j.key, A)).j;
const nameDev = () => nd.devices.find((d) => d.device === 'dev-name-00001');
ok(nameDev() && nameDev().name === 'Front desk' && nd.log.some((e) => e.what === 'Computer added (dev-name · Front desk)'), 'name kept when computer returns');
nd = (await post('/admin/api/action', { key: nk.j.key, action: 'name_device', device: 'dev-name-00001', name: '' }, A)).j;
ok(!nameDev().name, 'name cleared');
await post('/admin/api/action', { key: nk.j.key, action: 'delete_licence' }, A);
console.log(`passed ${pass}, failed ${failN}`);
