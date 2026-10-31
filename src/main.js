// Acuity IP tools: the host page. Signs in as the practice, loads the pinned timeline tile through one
// mothership, and answers the tile's lookups through the ODP proxy. The tile never touches the network.
import './style.css';
import { TileMothership, Tile } from '@dasl/tile-loader';
import { SITE, PRACTICE, PINS, TILE_LOAD_DOMAIN, TIMES, BRIDGE_LIMITS } from './config.js';
import { isFramed, showOpenInOwnTab } from './frame-guard.js';
import { createAuth, isSignInReturn, SignInStopped, WrongAccount } from './auth.js';
import { createPinnedLoader } from './pinned.js';
import { createProxyClient } from './proxy.js';
import { createBridge } from './bridge.js';

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
  const status = h('div', { class: 'tile-status', 'aria-live': 'polite' });
  const mount = h('div', { class: 'tile-mount' });
  root.replaceChildren(
    h('header', { class: 'top' },
      h('div', { class: 'brand' }, h('strong', {}, 'Acuity IP'), h('span', {}, ' tools')),
      account),
    note,
    h('main', { class: 'stage' }, status, mount),
    h('footer', { class: 'foot' },
      'Published US applications and patents only. Data: USPTO Open Data Portal. ',
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

  // ---------- the tile ----------
  const mothership = new TileMothership({ loadDomain: TILE_LOAD_DOMAIN });
  mothership.addLoader(createPinnedLoader({ Tile, pins: Object.values(PINS).filter(Boolean) }));
  mothership.init();

  const ask = createProxyClient({ getPass: () => auth.getPass() });
  let frame = null;
  let heard = false;
  let attempt = 0;
  let timers = [];
  const bridge = createBridge({
    send: (payload) => frame?.contentWindow?.postMessage({ action: DOWN, payload }, '*'),
    ask,
    signedIn: () => auth.signedIn,
    types: ['timeline'],
    limits: BRIDGE_LIMITS,
    onDrop: (why) => console.warn('[tools] dropped a tile message:', why),
  });

  function setStatus(text, ...actions) {
    status.replaceChildren(...(text ? [h('span', {}, text), ...actions] : []));
    status.hidden = !text;
  }
  const tryAgain = () => h('button', { type: 'button', class: 'quiet', onclick: loadTimeline }, 'Try again');

  async function loadTimeline() {
    const pin = PINS.timeline;
    if (!pin) { setStatus("The timeline tile isn't pinned yet. Publish it, then run scripts/pin.mjs."); return; }
    const mine = ++attempt;
    timers.forEach(clearTimeout);
    frame?.remove(); frame = null; heard = false;
    bridge.reset();
    setStatus('Loading the timeline tile…');
    timers = [
      setTimeout(() => { if (mine === attempt && !heard) setStatus('Still loading…'); }, TIMES.still),
      setTimeout(() => { if (mine === attempt && !heard) setStatus('Still loading…', tryAgain()); }, TIMES.retry),
    ];
    let tile;
    try { tile = await mothership.loadTile(pin.uri); } catch (err) {
      if (mine !== attempt) return;
      timers.forEach(clearTimeout);
      setStatus(`Couldn't load the timeline tile: ${err.message}`, tryAgain());
      return;
    }
    if (mine !== attempt) return;
    if (!tile) { timers.forEach(clearTimeout); setStatus("Couldn't load the timeline tile.", tryAgain()); return; }
    frame = tile.renderContent(900);
    frame.className = 'tile-frame';
    frame.removeAttribute('style');
    frame.title = 'USPTO timeline';
    frame.setAttribute('allow', '');           // no camera, microphone, location…
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals allow-downloads');   // as Raku: no popups
    mount.replaceChildren(frame);
  }

  addEventListener('message', (e) => {
    if (!frame || e.source !== frame.contentWindow) return;   // only our tile's frame
    const d = e.data;
    if (!d || d.action !== UP) return;                        // only the data channel
    if (!heard) { heard = true; timers.forEach(clearTimeout); setStatus(''); }
    bridge.handle(d.payload);
  });

  // #18649422 in the page address opens that application in the tile.
  const openFromHash = () => { const n = decodeURIComponent(location.hash.slice(1)); if (n) bridge.open(n); };
  addEventListener('hashchange', openFromHash);

  auth.onChange(() => { drawAccount(); bridge.status(); if (auth.problem instanceof WrongAccount) say(auth.problem.message); });
  drawAccount();
  openFromHash();
  loadTimeline();
  auth.start();
  globalThis.__tools = { auth, bridge };
}
start();
