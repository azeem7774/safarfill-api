import { chromium } from '/home/claude/.npm-global/lib/node_modules/playwright/index.mjs';
const B = 'http://localhost:8787', A = { authorization: 'Bearer test-admin-key-1234567890', 'content-type': 'application/json' };
const post = (u, body, h = { 'content-type': 'application/json' }) => fetch(B + u, { method: 'POST', headers: h, body: JSON.stringify(body) }).then((r) => r.json());
const k = (await post('/admin/api/licences', { plan: 'owner', agency: 'UI Removed Co' }, A)).key;
await post('/v1/session', { key: k, device: 'dev-ui-rm-0001', version: '1.2.1' });
await post('/v1/session', { key: k, device: 'dev-ui-rm-0002', version: '1.2.1' });
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const p = await b.newPage({ viewport: { width: 1360, height: 1000 } });
const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto(B + '/admin');
await p.fill('#adminKey', 'test-admin-key-1234567890'); await p.click('#signin');
await p.waitForSelector('#app:not([hidden])');
await p.click(`#list tr[data-key="${k}"] td:nth-child(2)`); await p.waitForTimeout(600);
const before = await p.isHidden('#dRemovedBox');
await p.click('button[data-dev="dev-ui-rm-0001"]'); await p.click('#cYes'); await p.waitForTimeout(800);
const r1 = await post('/v1/session', { key: k, device: 'dev-ui-rm-0001', version: '1.2.1' });
await p.click('#dCopyKey').catch(() => {}); // stays on panel
await p.evaluate(() => 0);
// reopen to refresh
await p.click(`#list tr[data-key="${k}"] td:nth-child(2)`); await p.waitForTimeout(700);
const shown = await p.isVisible('#dRemovedBox'); const rowText = await p.textContent('#dRemoved');
await p.locator('#dRemovedBox').screenshot({ path: '/tmp/claude-0/removed.png' });
await p.click('button[data-allow="dev-ui-rm-0001"]'); await p.waitForTimeout(800);
const after = await p.isHidden('#dRemovedBox');
const r2 = await post('/v1/session', { key: k, device: 'dev-ui-rm-0001', version: '1.2.1' });
console.log({ before, refused: r1.error, shown, rowText: rowText.replace(/\s+/g, ' '), after, rejoined: r2.ok, r2: r2.error, errs });
await post('/admin/api/action', { key: k, action: 'delete_licence' }, A);
await b.close();
