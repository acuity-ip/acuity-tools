// Acuity IP tools: the host page. Signs in as the practice, loads the pinned tiles (Timeline, Appeals, Appeal stats) through
// one mothership, and answers their lookups through the ODP proxy. Tiles never touch the network.
import './style.css';
import { TileMothership, Tile } from '@dasl/tile-loader';
import { SITE, PRACTICE, PINS, TILE_LOAD_DOMAIN, TIMES, BRIDGE_LIMITS } from './config.js';
import { isFramed, showOpenInOwnTab } from './frame-guard.js';
import { createAuth, isSignInReturn, SignInStopped, WrongAccount } from './auth.js';
import { createPinnedLoader } from './pinned.js';
import { createProxyClient } from './proxy.js';
import { createBridge, APPEAL_TYPES, STATS_TYPES } from './bridge.js';

const UP = 'tiles-protocol-up-data-payload';
const DOWN = 'tiles-protocol-down-data-payload';
const root = document.getElementById('tools');
const guarded = (f) => { try { return f(); } catch { return null; } };
const signInLib = () => import('@atproto/oauth-client-browser');

function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
}

async function start() {
  if (isFramed()) { showOpenInOwnTab(root, `${SITE.origin}/`); return; }
  const auth = createAuth(signInLib, { storage: guarded(() => globalThis.localStorage) });

  if (isSignInReturn(globalThis.location)) {
    root.replaceChildren(h('p', { class: 'wait' }, 'Finishing signing in…'));
    const r = await auth.start();
    if (r.finishedInWindow) { root.replaceChildren(h('p', { class: 'wait' }, 'Signed in. You can close this window.')); return; }
    if (r.moving) return;
    guarded(() => history.replaceState(null, '', location.pathname));
  }

  // ---------- page ----------
  const account = h('div', { class: 'account' });
  const note = h('p', { class: 'note', 'aria-live': 'polite', hidden: true });
  const docBar = h('div', { class: 'doc-bar', 'aria-live': 'polite', hidden: true });
  const tabs = h('nav', { class: 'tabs', role: 'tablist' });
  const stage = h('main', { class: 'stage' });
  root.replaceChildren(
    h('header', { class: 'band' },
      h('div', { class: 'top' },
        h('div', { class: 'brand' }, h('span', { class: 'wordmark' }, 'acuityIP.'), h('span', { class: 'tools' }, 'uspto data')),
        account),
      tabs),
    note,
    docBar,
    stage,
    h('footer', { class: 'foot' },
      'Published US applications and patents only. Data: USPTO Open Data Portal (applications and PTAB decisions). ',
      'Response windows are estimates; the docketing system controls.'));

  const say = (text) => { note.textContent = text || ''; note.hidden = !text; };

  function drawAccount() {
    account.replaceChildren();
    if (auth.signedIn) {
      account.append(h('span', { class: 'who' }, `@${PRACTICE.handle}`),
        h('button', { type: 'button', class: 'quiet', onclick: () => auth.signOut() }, 'Sign out'));
    } else {
      account.append(
        h('button', { type: 'button', class: 'primary', onclick: onSignIn }, `Sign in as @${PRACTICE.handle}`),
        h('span', { class: 'why' }, 'Asks only to request USPTO lookups from the Acuity proxy. Nothing is posted.'));
    }
  }

  let signingIn = null;
  function onSignIn() {
    if (signingIn) return;
    auth.openWindow();                         // straight from the click (browsers allow windows only then)
    signingIn = new AbortController();
    say('Finish signing in in the small window…');
    auth.signIn({ signal: signingIn.signal })
      .then(() => say(''))
      .catch((err) => say(err instanceof WrongAccount || err instanceof SignInStopped ? err.message : `Sign-in didn't work: ${err.message}`))
      .finally(() => { signingIn = null; });
  }

  // ---------- decision PDFs (kept by the page; tiles can't open windows) ----------
  let docUrl = null;
  function showDoc(pdf, appeal) {
    if (docUrl) URL.revokeObjectURL(docUrl);
    docUrl = URL.createObjectURL(pdf);
    const label = `${appeal.slice(0, 4)}-${appeal.slice(4)}`;
    docBar.replaceChildren(
      h('span', {}, `Decision in appeal ${label} is ready.`),
      h('a', { class: 'button primary', href: docUrl, target: '_blank', rel: 'noopener' }, 'Open'),
      h('a', { class: 'button', href: docUrl, download: `PTAB-${label}.pdf` }, 'Download'),
      h('button', { type: 'button', class: 'quiet', 'aria-label': 'Dismiss', onclick: () => { docBar.hidden = true; } }, '×'));
    docBar.hidden = false;
  }

  // ---------- the tiles: one frame and one bridge each, one shown at a time ----------
  const mothership = new TileMothership({ loadDomain: TILE_LOAD_DOMAIN });
  mothership.addLoader(createPinnedLoader({ Tile, pins: Object.values(PINS).filter(Boolean) }));
  mothership.init();
  const ask = createProxyClient({ getPass: () => auth.getPass() });

  const SLOTS = {
    timeline: { label: 'Timeline', title: 'USPTO timeline', types: ['timeline'], height: 900 },
    appeals: { label: 'Appeals', title: 'PTAB appeal decisions', types: APPEAL_TYPES, height: 1500, doc: true, show: true },
    stats: { label: 'Appeal stats', title: 'PTAB appeal statistics', types: STATS_TYPES, height: 1500 },
  };
  const slots = {};
  for (const [id, spec] of Object.entries(SLOTS)) {
    const slot = { id, spec, frame: null, heard: false, attempt: 0, timers: [], loaded: false };
    slot.status = h('div', { class: 'tile-status', 'aria-live': 'polite' });
    slot.mount = h('div', { class: 'tile-mount' });
    slot.panel = h('section', { class: 'panel', id: `panel-${id}`, role: 'tabpanel', hidden: true }, slot.status, slot.mount);
    slot.tab = h('button', { type: 'button', role: 'tab', class: 'tab', id: `tab-${id}`, 'aria-controls': `panel-${id}`, onclick: () => choose(id, true) }, spec.label);
    slot.bridge = createBridge({
      send: (payload) => slot.frame?.contentWindow?.postMessage({ action: DOWN, payload }, '*'),
      ask,
      signedIn: () => auth.signedIn,
      types: spec.types,
      limits: BRIDGE_LIMITS,
      onDoc: spec.doc ? showDoc : null,
      onShow: spec.show ? (tile, app) => { choose(tile, true, app); } : null,
      onDrop: (why) => console.warn(`[tools] dropped a message from the ${id} tile:`, why),
    });
    tabs.append(slot.tab);
    stage.append(slot.panel);
    slots[id] = slot;
  }

  function setStatus(slot, text, ...actions) {
    slot.status.replaceChildren(...(text ? [h('span', {}, text), ...actions] : []));
    slot.status.hidden = !text;
  }

  async function load(slot) {
    const { id, spec } = slot;
    const pin = PINS[id];
    const name = spec.title.replace(/^USPTO /, '');
    const tryAgain = () => h('button', { type: 'button', class: 'quiet', onclick: () => load(slot) }, 'Try again');
    slot.loaded = true;
    if (!pin) { setStatus(slot, `The ${name} tile isn't pinned yet. Publish it, then run scripts/pin.mjs.`); return; }
    const mine = ++slot.attempt;
    slot.timers.forEach(clearTimeout);
    slot.frame?.remove(); slot.frame = null; slot.heard = false;
    slot.bridge.reset();
    setStatus(slot, `Loading the ${name} tile…`);
    slot.timers = [
      setTimeout(() => { if (mine === slot.attempt && !slot.heard) setStatus(slot, 'Still loading…'); }, TIMES.still),
      setTimeout(() => { if (mine === slot.attempt && !slot.heard) setStatus(slot, 'Still loading…', tryAgain()); }, TIMES.retry),
    ];
    let tile;
    try { tile = await mothership.loadTile(pin.uri); } catch (err) {
      if (mine !== slot.attempt) return;
      slot.timers.forEach(clearTimeout);
      setStatus(slot, `Couldn't load the ${name} tile: ${err.message}`, tryAgain());
      return;
    }
    if (mine !== slot.attempt) return;
    if (!tile) { slot.timers.forEach(clearTimeout); setStatus(slot, `Couldn't load the ${name} tile.`, tryAgain()); return; }
    const frame = tile.renderContent(spec.height);
    frame.className = 'tile-frame';
    frame.removeAttribute('style');
    frame.style.height = `${spec.height}px`;   // CSSOM, allowed by the page policy (style attributes aren't)
    frame.title = spec.title;
    frame.setAttribute('allow', '');           // no camera, microphone, location…
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals allow-downloads');   // as Raku: no popups
    slot.frame = frame;
    slot.mount.replaceChildren(frame);
  }

  let shown = null;
  function choose(id, updateHash = false, appNumber = null) {
    const slot = slots[id];
    if (!slot) return;
    for (const s of Object.values(slots)) {
      const on = s === slot;
      s.panel.hidden = !on;
      s.tab.setAttribute('aria-selected', on ? 'true' : 'false');
      s.tab.tabIndex = on ? 0 : -1;
    }
    shown = id;
    if (!slot.loaded) load(slot);
    if (appNumber) slot.bridge.open(appNumber);
    if (updateHash) {
      const want = appNumber ? `#${appNumber}` : `#${id}`;
      if (location.hash !== want) guarded(() => history.replaceState(null, '', want));
    }
  }

  addEventListener('message', (e) => {
    const slot = Object.values(slots).find((s) => s.frame && e.source === s.frame.contentWindow);
    if (!slot) return;                                        // only our tiles' frames
    const d = e.data;
    if (!d || d.action !== UP) return;                        // only the data channel
    if (!slot.heard) { slot.heard = true; slot.timers.forEach(clearTimeout); setStatus(slot, ''); }
    slot.bridge.handle(d.payload);
  });

  // The page address picks the tab: #appeals, #stats, #timeline, or #18649422 (opens that application).
  function fromHash() {
    const raw = decodeURIComponent(location.hash.slice(1));
    if (slots[raw]) return choose(raw);
    if (raw && slots.timeline.bridge.open(raw)) return choose('timeline');
    if (!shown) choose('timeline');
  }
  addEventListener('hashchange', fromHash);

  auth.onChange(() => {
    drawAccount();
    for (const s of Object.values(slots)) s.bridge.status();
    if (!auth.signedIn && docUrl) { URL.revokeObjectURL(docUrl); docUrl = null; docBar.hidden = true; }
    if (auth.problem instanceof WrongAccount) say(auth.problem.message);
  });
  drawAccount();
  fromHash();
  auth.start();
  globalThis.__tools = { auth, slots };
}
start();
