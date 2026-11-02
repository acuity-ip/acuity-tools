// Browser check of the BUILT page (its real security policy), signed out, no network needed:
//   npm run build && node test/page.browser.mjs        (needs Playwright + Chromium)
// Requests that would leave this computer are blocked and recorded; the check only looks at where they go.
// Works whatever is pinned: a pinned tile must start loading from the tile loader, an unpinned one must say so.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { preview } from 'vite';
import { PINS } from '../src/pins.js';
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
const offsite = [];
await page.context().route((url) => !url.href.startsWith(base), (route) => { offsite.push(new URL(route.request().url()).host); return route.abort(); });
const blocked = (t) => /Failed to load resource|ERR_FAILED|ERR_BLOCKED/i.test(t);
// Expected hosts for loading a pinned tile: the tile loader (and its per-tile subdomains), the account's
// DID directory and its PDS. Nothing else.
const TILE_HOSTS = /^(load\.tiles\.lexicographer\.space|[a-z]{20}\.tiles\.lexicographer\.space|plc\.directory|[a-z0-9.-]+\.host\.bsky\.network|bsky\.social)$/;

/** The tab's own status line: "isn't pinned yet" when unpinned; otherwise it starts loading the pinned tile. */
async function checkTile(id, title) {
  const status = page.locator(`#panel-${id} .tile-status`);
  if (!PINS[id]) {
    await status.filter({ hasText: `The ${title} tile isn't pinned yet` }).waitFor();
  } else {
    await status.filter({ hasText: new RegExp(`Loading the ${title} tile|Still loading|Couldn't load the ${title} tile`) }).waitFor();
  }
}

await page.goto(`${base}/#18649422`);
await page.getByRole('button', { name: 'Sign in as @acuityip.com' }).waitFor();
const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
assert.match(csp, /script-src 'self';/);
assert.match(csp, /frame-src https:\/\/load\.tiles\.lexicographer\.space/);
ok('built page carries its policy and shows the sign-in button');
assert.equal(await page.locator('#tab-timeline').getAttribute('aria-selected'), 'true', '#18649422 opens the Timeline tab');
await page.goto(`${base}/#appeals`);
await checkTile('appeals', 'PTAB appeal decisions');
assert.equal(await page.locator('#tab-appeals').getAttribute('aria-selected'), 'true');
assert.equal(await page.locator('#panel-timeline').isHidden(), true);
ok(`tabs follow the address; the Appeals tile ${PINS.appeals ? 'starts loading from its pin' : 'says it isn\'t pinned'}`);
await page.locator('#tab-timeline').click();
assert.equal(await page.locator('#panel-appeals').isHidden(), true);
assert.match(page.url(), /#timeline$/);
ok('clicking a tab switches panels and the address');
await page.goto(`${base}/#stats`);
await checkTile('stats', 'PTAB appeal statistics');
assert.equal(await page.locator('#tab-stats').getAttribute('aria-selected'), 'true');
assert.equal(await page.locator('#tab-stats').textContent(), 'Appeal stats');
ok('Appeal stats tab: #stats selects it');
await page.goto(`${base}/#exam`);
await checkTile('exam', 'examination statistics');
assert.equal(await page.locator('#tab-exam').getAttribute('aria-selected'), 'true');
assert.equal(await page.locator('#tab-exam').textContent(), 'Exam stats');
assert.equal(await page.locator('#print-report').isHidden(), true, 'the print area stays out of sight on screen');
ok('Exam stats tab: #exam selects it');
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
assert.deepEqual(errors.filter((e) => !blocked(e)), [], 'no page errors (blocked off-site requests aside)');
const hosts = [...new Set(offsite)].sort();
assert.deepEqual(hosts.filter((h) => !TILE_HOSTS.test(h)), [], `only tile-loading hosts were asked for (${hosts.join(', ') || 'none'})`);
if (Object.values(PINS).some(Boolean)) assert.ok(hosts.some((h) => h.endsWith('tiles.lexicographer.space') || h === 'plc.directory'), 'a pinned tile was asked for');
ok(`no policy violations, no errors; off-site requests only to: ${hosts.join(', ') || 'none'}`);
await browser.close();
server.httpServer.close();
