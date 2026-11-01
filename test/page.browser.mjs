// Browser check of the BUILT page (its real security policy), signed out, no network needed:
//   npm run build && node test/page.browser.mjs        (needs Playwright + Chromium)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { preview } from 'vite';
const { chromium } = createRequire(import.meta.url)('playwright');

const server = await preview({ preview: { port: 5186, strictPort: true, host: '127.0.0.1' } });
const base = 'http://127.0.0.1:5186';
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
const cspViolations = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (/Content Security Policy/i.test(m.text())) cspViolations.push(m.text()); else errors.push(m.text());
});
const ok = (s) => console.log(`ok - ${s}`);

await page.goto(`${base}/#18649422`);
await page.getByRole('button', { name: 'Sign in as @acuityip.com' }).waitFor();
const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
assert.match(csp, /script-src 'self';/);
assert.match(csp, /frame-src https:\/\/load\.tiles\.lexicographer\.space/);
ok('built page carries its policy and shows the sign-in button');
assert.equal(await page.locator('#tab-timeline').getAttribute('aria-selected'), 'true', '#18649422 opens the Timeline tab');
await page.goto(`${base}/#appeals`);
await page.getByText("The PTAB appeal decisions tile isn't pinned yet").waitFor();
assert.equal(await page.locator('#tab-appeals').getAttribute('aria-selected'), 'true');
assert.equal(await page.locator('#panel-timeline').isHidden(), true);
ok('tabs follow the address; an unpinned tile says so and loads nothing');
await page.locator('#tab-timeline').click();
assert.equal(await page.locator('#panel-appeals').isHidden(), true);
assert.match(page.url(), /#timeline$/);
ok('clicking a tab switches panels and the address');
await page.goto(`${base}/#stats`);
await page.getByText("The PTAB appeal statistics tile isn't pinned yet").waitFor();
assert.equal(await page.locator('#tab-stats').getAttribute('aria-selected'), 'true');
assert.equal(await page.locator('#tab-stats').textContent(), 'Appeal stats');
ok('Appeal stats tab: #stats selects it');
assert.match(await page.locator('.foot').textContent(), /estimates; the docketing system controls/);
assert.equal(await page.locator('.why').textContent(), 'Firm access to USPTO data tools via Acuity IP proxy.');
ok('footer and permission note');

const oauth = await (await page.request.get(`${base}/oauth.json`)).json();
assert.equal(oauth.scope, 'atproto rpc:com.acuityip.odp.query?aud=did:web:acuity-odp.fly.dev%23acuity_odp');
assert.equal((await (await page.request.get(`${base}/robots.txt`)).text()).trim(), 'User-agent: *\nDisallow: /');
ok('oauth.json and robots.txt served');

// Inside another page's frame: only a link, no sign-in.
const framed = await browser.newPage();
await framed.setContent(`<iframe src="${base}/" style="width:600px;height:300px"></iframe>`);
const f = framed.frameLocator('iframe');
await f.getByText('only run in their own tab').waitFor();
assert.equal(await f.getByRole('button').count(), 0);
ok('frame guard: no buttons inside a frame');

assert.deepEqual(cspViolations, [], 'no policy violations');
assert.deepEqual(errors, [], 'no page errors');
ok('no policy violations, no errors');
await browser.close();
server.httpServer.close();
