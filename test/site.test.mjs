import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBridge, normalizeAppNumber } from '../src/bridge.js';
import { createProxyClient, SignInNeeded } from '../src/proxy.js';
import { createPinnedLoader, rawCid, TileChanged } from '../src/pinned.js';
import { SCOPE, oauthMetadata, pageCsp, PROXY } from '../src/config.js';
import { createAuth, clientIdFor, WrongAccount } from '../src/auth.js';

const LIMITS = { maxMessageBytes: 8192, inFlight: 4, perMinute: 30 };
const q = (fields) => ({ tool: 'acuity-odp', v: 1, kind: 'query', id: 'q1', type: 'timeline', appNumber: '18649422', ...fields });

function bridgeFor({ signedIn = true, ask = async () => ({ data: { ok: 1 } }), ...o } = {}) {
  const sent = [], dropped = [];
  const b = createBridge({ send: (p) => sent.push(p), ask, signedIn: () => signedIn, types: ['timeline'], limits: LIMITS, onDrop: (w) => dropped.push(w), ...o });
  return { b, sent, dropped };
}

// ---------- config ----------
test('scope, oauth.json and page policy', () => {
  assert.equal(SCOPE, 'atproto rpc:com.acuityip.odp.query?aud=did:web:acuity-odp.fly.dev%23acuity_odp');
  const m = oauthMetadata();
  assert.equal(m.client_id, 'https://tools.acuityip.com/oauth.json');
  assert.deepEqual(m.redirect_uris, ['https://tools.acuityip.com/']);
  assert.equal(m.scope, SCOPE);
  const csp = pageCsp();
  for (const part of ["script-src 'self'", "frame-src https://load.tiles.lexicographer.space https://*.tiles.lexicographer.space", "object-src 'none'", "form-action 'none'", "base-uri 'none'"]) assert.ok(csp.includes(part), part);
  assert.ok(!csp.includes('unsafe'), 'no unsafe-* in the page policy');
  assert.match(clientIdFor({ hostname: '127.0.0.1', port: '5185' }), /^http:\/\/localhost\?redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A5185%2F&scope=atproto%20rpc/);
  assert.equal(clientIdFor({ hostname: 'tools.acuityip.com', port: '' }), 'https://tools.acuityip.com/oauth.json');
});

// ---------- bridge ----------
test('bridge: hello -> status, then pending open', async () => {
  const { b, sent } = bridgeFor();
  assert.equal(b.open('18/649,422'), true);
  assert.equal(sent.length, 0, 'open waits for hello');
  await b.handle({ tool: 'acuity-odp', v: 1, kind: 'hello' });
  assert.deepEqual(sent, [
    { signedIn: true, tool: 'acuity-odp', v: 1, kind: 'status' },
    { appNumber: '18649422', tool: 'acuity-odp', v: 1, kind: 'open' },
  ]);
  b.status();
  assert.equal(sent.at(-1).kind, 'status');
});

test('bridge: query -> result; errors pass through', async () => {
  const { b, sent } = bridgeFor({ ask: async (type, { app }) => (app === '18649422' ? { data: { type, app } } : { error: 'unpublished' }) });
  await b.handle(q());
  assert.deepEqual(sent.at(-1), { id: 'q1', type: 'timeline', data: { type: 'timeline', app: '18649422' }, tool: 'acuity-odp', v: 1, kind: 'result' });
  await b.handle(q({ id: 'q2', appNumber: '99999999' }));
  assert.deepEqual(sent.at(-1), { id: 'q2', reason: 'unpublished', tool: 'acuity-odp', v: 1, kind: 'error' });
});

test('bridge: validation and dropping', async () => {
  const asked = [];
  const { b, sent, dropped } = bridgeFor({ ask: async (t, a) => { asked.push(a); return { data: {} }; } });
  await b.handle(q({ appNumber: '1234' }));
  await b.handle(q({ type: 'documents' }));                      // not allowed for this tile
  await b.handle(q({ id: '<img>' }));
  await b.handle({ tool: 'other', v: 1, kind: 'query' });
  await b.handle({ tool: 'acuity-odp', v: 2, kind: 'hello' });
  await b.handle({ tool: 'acuity-odp', v: 1, kind: 'write-record' });
  await b.handle(q({ pad: 'x'.repeat(9000) }));
  assert.deepEqual(sent.map((p) => p.reason), ['invalid-number', 'bad-type']);
  assert.deepEqual(dropped, ['bad-id', 'not-ours', 'not-ours', 'unknown-kind', 'too-large']);
  assert.equal(asked.length, 0);
});

test('bridge: signed out, rate limits, ask throwing', async () => {
  const out = bridgeFor({ signedIn: false });
  await out.b.handle(q());
  assert.equal(out.sent.at(-1).reason, 'signed-out');

  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = bridgeFor({ ask: async () => { await gate; return { data: {} }; } });
  const runs = [1, 2, 3, 4, 5].map((i) => slow.b.handle(q({ id: `q${i}` })));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(slow.sent.map((p) => p.reason), ['rate-limited'], 'fifth in flight refused');
  release(); await Promise.all(runs);

  let t = 0;
  const perMin = bridgeFor({ now: () => t });
  for (let i = 0; i < 31; i++) await perMin.b.handle(q({ id: `m${i}` }));
  assert.equal(perMin.sent.filter((p) => p.reason === 'rate-limited').length, 1);
  t = 61000;
  await perMin.b.handle(q({ id: 'later' }));
  assert.equal(perMin.sent.at(-1).kind, 'result');

  const boom = bridgeFor({ ask: async () => { throw new Error('x'); } });
  await boom.b.handle(q());
  assert.equal(boom.sent.at(-1).reason, 'upstream');
});

// ---------- appeals ----------
const DOC = '0c3e18b7-ff84-4529-9c5a-b6985ddaa169';
const aq = (fields) => ({ tool: 'acuity-odp', v: 1, kind: 'query', id: 'a1', type: 'appealSearch', search: { grounds: ['101'] }, ...fields });
function appealsBridge(o = {}) {
  return bridgeFor({ types: ['appealSearch', 'appealDoc'], ...o });
}

test('bridge: appeal search passes the form on as JSON; bad-search message and field come back', async () => {
  const asked = [];
  const { b, sent } = appealsBridge({ ask: async (t, p) => { asked.push([t, p]); return p.search.includes('999') ? { error: 'bad-search', message: 'Unknown ground 999.', field: 'grounds' } : { data: { total: 3 } }; } });
  await b.handle(aq());
  assert.deepEqual(asked[0], ['appealSearch', { search: '{"grounds":["101"]}' }]);
  assert.deepEqual(sent.at(-1).data, { total: 3 });
  await b.handle(aq({ id: 'a2', search: { grounds: ['999'] } }));
  assert.deepEqual(sent.at(-1), { id: 'a2', reason: 'bad-search', message: 'Unknown ground 999.', field: 'grounds', tool: 'acuity-odp', v: 1, kind: 'error' });
  for (const search of [null, 'grounds=101', [1], { text: 'x'.repeat(5000) }]) await b.handle(aq({ id: 'a3', search }));
  assert.equal(asked.length, 2, 'malformed searches never reach the proxy');
  await b.handle(q({ id: 't1' }));
  assert.equal(sent.at(-1).reason, 'bad-type', 'the appeals tile cannot do application lookups');
  const tl = bridgeFor();
  await tl.b.handle(aq());
  assert.equal(tl.sent.at(-1).reason, 'bad-type', 'and the timeline tile cannot search appeals');
});

test('bridge: decision PDF stays with the page; the tile only hears ready', async () => {
  const docs = [];
  const pdf = new Blob(['%PDF-1.7'], { type: 'application/pdf' });
  const { b, sent } = appealsBridge({ ask: async () => ({ pdf }), onDoc: (p, a) => docs.push([p, a]) });
  await b.handle(aq({ type: 'appealDoc', search: undefined, appeal: '2026003213', doc: DOC }));
  assert.deepEqual(docs, [[pdf, '2026003213']]);
  assert.deepEqual(sent.at(-1).data, { ready: true });
  await b.handle(aq({ id: 'a2', type: 'appealDoc', appeal: '2026003213', doc: '../x' }));
  assert.equal(sent.at(-1).reason, 'bad-search');
  const noDoc = appealsBridge();
  await noDoc.b.handle(aq({ type: 'appealDoc', appeal: '2026003213', doc: DOC }));
  assert.equal(noDoc.sent.at(-1).reason, 'bad-type', 'no onDoc: refused');
});

test('bridge: show asks the page to open an application in the timeline tab', async () => {
  const shown = [];
  const { b, dropped } = appealsBridge({ onShow: (t, a) => shown.push([t, a]) });
  await b.handle({ tool: 'acuity-odp', v: 1, kind: 'show', tile: 'timeline', appNumber: '18/136,874' });
  await b.handle({ tool: 'acuity-odp', v: 1, kind: 'show', tile: 'appeals', appNumber: '18136874' });
  await b.handle({ tool: 'acuity-odp', v: 1, kind: 'show', tile: 'timeline', appNumber: 'x' });
  assert.deepEqual(shown, [['timeline', '18136874']]);
  assert.deepEqual(dropped, ['bad-show', 'bad-show']);
  const tl = bridgeFor();
  await tl.b.handle({ tool: 'acuity-odp', v: 1, kind: 'show', tile: 'timeline', appNumber: '18136874' });
  assert.deepEqual(tl.dropped, ['bad-show'], 'only tiles given onShow may ask');
});

test('proxy client: appeal search and decision PDF', async () => {
  const urls = [];
  let ask = createProxyClient({ getPass: async () => 'P', fetchImpl: async (url) => { urls.push(url); return new Response(JSON.stringify({ error: 'bad-search', message: 'Unknown ground 999.', field: 'grounds' }), { status: 400 }); } });
  assert.deepEqual(await ask('appealSearch', { search: '{"grounds":["999"]}' }), { error: 'bad-search', message: 'Unknown ground 999.', field: 'grounds' });
  assert.equal(urls[0], `${PROXY.url}/xrpc/${PROXY.lxm}?type=appealSearch&search=%7B%22grounds%22%3A%5B%22999%22%5D%7D`);
  ask = createProxyClient({ getPass: async () => 'P', fetchImpl: async (url) => { urls.push(url); return new Response('%PDF-1.7', { status: 200, headers: { 'content-type': 'application/pdf' } }); } });
  const r = await ask('appealDoc', { appeal: '2026003213', doc: DOC });
  assert.equal(r.pdf.type, 'application/pdf');
  assert.equal(await r.pdf.text(), '%PDF-1.7');
  assert.ok(urls.at(-1).endsWith(`type=appealDoc&appeal=2026003213&doc=${DOC}`));
  ask = createProxyClient({ getPass: async () => 'P', fetchImpl: async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }) });
  assert.deepEqual(await ask('appealDoc', { appeal: '2026003213', doc: DOC }), { error: 'upstream' });
});

test('normalizeAppNumber', () => {
  assert.equal(normalizeAppNumber('18/649,422'), '18649422');
  assert.equal(normalizeAppNumber('PCTUS2020050660'), null);
});

// ---------- proxy client ----------
test('proxy client: pass, URL, answers and error mapping', async () => {
  const seen = [];
  const fake = (status, body) => async (url, init) => { seen.push({ url, auth: init.headers.authorization, credentials: init.credentials }); return new Response(JSON.stringify(body), { status }); };
  let ask = createProxyClient({ getPass: async () => 'PASS', fetchImpl: fake(200, { type: 'timeline', data: { a: 1 } }) });
  assert.deepEqual(await ask('timeline', '18649422'), { data: { a: 1 } });
  assert.deepEqual(seen[0], { url: `${PROXY.url}/xrpc/${PROXY.lxm}?type=timeline&app=18649422`, auth: 'Bearer PASS', credentials: 'omit' });
  ask = createProxyClient({ getPass: async () => 'P', fetchImpl: fake(403, { error: 'unpublished' }) });
  assert.deepEqual(await ask('timeline', '1'), { error: 'unpublished' });
  ask = createProxyClient({ getPass: async () => 'P', fetchImpl: fake(401, { error: 'unauthorized' }) });
  assert.deepEqual(await ask('timeline', '1'), { error: 'signed-out' });
  ask = createProxyClient({ getPass: async () => 'P', fetchImpl: fake(500, { error: '<script>' }) });
  assert.deepEqual(await ask('timeline', '1'), { error: 'upstream' });
  ask = createProxyClient({ getPass: async () => 'P', fetchImpl: fake(200, { type: 'pta', data: {} }) });
  assert.deepEqual(await ask('timeline', '1'), { error: 'upstream' }, 'wrong type in answer');
  ask = createProxyClient({ getPass: async () => { throw new SignInNeeded('x'); }, fetchImpl: fake(200, {}) });
  assert.deepEqual(await ask('timeline', '1'), { error: 'signed-out' });
  ask = createProxyClient({ getPass: async () => 'P', fetchImpl: async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); } });
  assert.deepEqual(await ask('timeline', '1'), { error: 'timeout' });
});

// ---------- pinned loader ----------
test('pinned loader: only the pinned record, only intact files', async () => {
  const DID = 'did:plc:5uyc6bnln26yftnfkqtlwxr3';
  const page = new TextEncoder().encode('<!doctype html><title>t</title>');
  const pageCid = await rawCid(page);
  const record = { cid: 'bafyreigood', value: { tile: { name: 't', resources: { '/': { src: { $type: 'blob', ref: { $link: pageCid } }, 'content-type': 'text/html', 'content-security-policy': "default-src 'self'" } } } } };
  let tamper = false, recordCid = 'bafyreigood';
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.host === 'plc.directory') return new Response(JSON.stringify({ service: [{ id: '#atproto_pds', serviceEndpoint: 'https://pds.example' }] }));
    if (u.pathname.endsWith('getRecord')) return new Response(JSON.stringify({ ...record, cid: recordCid }));
    if (u.pathname.endsWith('getBlob')) return new Response(tamper ? new TextEncoder().encode('evil') : page);
    return new Response('', { status: 404 });
  };
  class Tile { constructor(m, url, manifest, loader) { Object.assign(this, { url, manifest, loader }); } }
  const uri = `at://${DID}/ing.dasl.masl/3abcdefghij`;
  const loader = createPinnedLoader({ Tile, pins: [{ uri, cid: 'bafyreigood' }], fetchImpl });
  assert.equal(await loader.load(`at://${DID}/ing.dasl.masl/other12345`, {}), false, 'unpinned tile not loaded');
  const t = await loader.load(uri, {});
  const r = await t.loader.resolvePath('/');
  assert.equal(r.ok, true);
  assert.equal(r.headers['content-security-policy'], "default-src 'self'");
  assert.equal((await t.loader.resolvePath('/missing.js')).ok, false);
  tamper = true;
  const fresh = createPinnedLoader({ Tile, pins: [{ uri, cid: 'bafyreigood' }], fetchImpl });
  assert.equal((await (await fresh.load(uri, {})).loader.resolvePath('/')).ok, false, 'tampered file refused');
  recordCid = 'bafyreichanged';
  await assert.rejects(fresh.load(uri, {}), TileChanged);
});

// ---------- auth (with a stand-in for the OAuth library) ----------
test('auth: wrong account is revoked; pass request is addressed to the proxy', async () => {
  const calls = [];
  const mkSession = (did) => ({ did, fetchHandler: async (path) => { calls.push(path); return new Response(JSON.stringify({ token: 'T' })); } });
  let next = mkSession('did:plc:someoneelse000000000000');
  const revoked = [];
  const lib = {
    BrowserOAuthClient: { load: async () => ({
      init: async () => null, restore: async () => { throw new Error('none'); },
      signInPopup: async (input, opts) => { calls.push(`signin ${input} ${opts.scope}`); return next; },
      revoke: async (did) => revoked.push(did),
    }) },
  };
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const auth = createAuth(async () => lib, { storage, loc: { hostname: 'tools.acuityip.com', port: '' }, win: {} });
  await auth.start();
  await assert.rejects(auth.signIn(), WrongAccount);
  assert.deepEqual(revoked, ['did:plc:someoneelse000000000000']);
  assert.equal(auth.signedIn, false);
  assert.equal(calls[0], `signin acuityip.com ${SCOPE}`);
  next = mkSession('did:plc:5uyc6bnln26yftnfkqtlwxr3');
  await auth.signIn();
  assert.equal(auth.signedIn, true);
  assert.equal(await auth.getPass(), 'T');
  const u = new URL(calls.at(-1), 'https://x');
  assert.equal(u.pathname, '/xrpc/com.atproto.server.getServiceAuth');
  assert.equal(u.searchParams.get('aud'), 'did:web:acuity-odp.fly.dev#acuity_odp');
  assert.equal(u.searchParams.get('lxm'), 'com.acuityip.odp.query');
  assert.ok(Number(u.searchParams.get('exp')) - Date.now() / 1000 <= 61);
  await auth.signOut();
  assert.equal(auth.signedIn, false);
  await assert.rejects(auth.getPass(), SignInNeeded);
});
