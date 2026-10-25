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
const pr = await post('/v1/parse', { lines: ['REPUBLIC OF UTOPIA PASSPORT NUMBER', L1, L2] }, P);
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
console.log(`passed ${pass}, failed ${failN}`);
