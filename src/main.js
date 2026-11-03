// Acuity IP tools: the host page. Signs in as the practice, loads the pinned tiles through one mothership, and answers
// their lookups through the proxy. Tiles never touch the network.
// Offices (Nov 2 2026): a USPTO | EPO switcher in the header; each office has its own tabs and tiles.
//   USPTO: Timeline, Appeals, Appeal stats, Exam stats (#timeline, #appeals, #stats, #exam, #18649422)
//   EPO:   Timeline (#ep/timeline, #EP23215480 or #EP4571955)
import './style.css';
import { TileMothership, Tile } from '@dasl/tile-loader';
import { SITE, PRACTICE, PINS, TILE_LOAD_DOMAIN, TIMES, BRIDGE_LIMITS } from './config.js';
import { isFramed, showOpenInOwnTab } from './frame-guard.js';
import { createAuth, isSignInReturn, SignInStopped, WrongAccount } from './auth.js';
import { createPinnedLoader } from './pinned.js';
import { createProxyClient } from './proxy.js';
import { createBridge, APPEAL_TYPES, STATS_TYPES, OA_TYPES, EXAM_TYPES, EP_TYPES, FAMILY_TYPES, normalizeEpNumber, normalizeAppNumber } from './bridge.js';
import { linkFor } from './links.js';
import { createRegistry } from './grants.js';
import { checkReport, renderReport } from './report.js';

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
  const OFFICES = { us: { label: 'USPTO', first: 'timeline' }, ep: { label: 'EPO', first: 'eptimeline' } };
  const offices = h('nav', { class: 'offices', 'aria-label': 'Patent office' });
  const FOOT = {
    us: 'Published US applications and patents only. Data: USPTO Open Data Portal (applications, office actions and PTAB decisions). Response windows are estimates; the docketing system controls.',
    ep: 'Published European applications only. Data: European Patent Office (EP Register, through Open Patent Services). Time limits are estimates; the docketing system controls.',
  };
  const foot = h('footer', { class: 'foot' }, FOOT.us);
  const stage = h('main', { class: 'stage' });
  root.replaceChildren(
    h('header', { class: 'band' },
      h('div', { class: 'top' },
        h('div', { class: 'brand' }, h('span', { class: 'wordmark' }, 'acuityIP.'), h('span', { class: 'tools' }, 'patent data'), offices),
        account),
      tabs),
    note,
    docBar,
    stage,
    foot);

  const say = (text) => { note.textContent = text || ''; note.hidden = !text; };

  function drawAccount() {
    account.replaceChildren();
    if (auth.signedIn) {
      account.append(h('span', { class: 'who' }, `@${PRACTICE.handle}`),
        h('button', { type: 'button', class: 'quiet', onclick: () => auth.signOut() }, 'Sign out'));
    } else {
      account.append(
        h('button', { type: 'button', class: 'primary', onclick: onSignIn }, `Sign in as @${PRACTICE.handle}`),
        h('span', { class: 'why' }, 'Firm access to USPTO and EPO data tools via Acuity IP proxy.'));
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

  // ---------- links out (built by the page from fixed patterns; tiles only name a target and a number) ----------
  function showLink(target, number) {
    const l = linkFor(target, number);
    if (!l) return false;
    docBar.replaceChildren(
      h('span', {}, `${l.label} for ${l.number}:`),
      h('a', { class: 'button primary', href: l.url, target: '_blank', rel: 'noopener noreferrer', referrerpolicy: 'no-referrer' }, 'Open in a new tab'),
      h('span', { class: 'fine' }, 'The site may ask you to confirm you\u2019re human.'),
      h('button', { type: 'button', class: 'quiet', 'aria-label': 'Dismiss', onclick: () => { docBar.hidden = true; } }, '\u00d7'));
    docBar.hidden = false;
    return true;
  }
  const ALL_LINKS = ['epRegister', 'epDocuments', 'espacenet', 'patentscope', 'patentCenter'];

  // ---------- printable reports (built by the page from a tile's plain data; nothing kept) ----------
  const printBox = h('div', { id: 'print-report', class: 'print-report', 'aria-hidden': 'true' });
  document.body.append(printBox);
  let printTitle = null;
  function showReport(report) {
    renderReport(printBox, report, { h, firm: 'acuityIP.' });
    printTitle = report.title;
    docBar.replaceChildren(
      h('span', {}, `Report ready: ${report.title}.`),
      h('button', { type: 'button', class: 'primary', onclick: printReport }, 'Print or save as PDF'),
      h('button', { type: 'button', class: 'quiet', 'aria-label': 'Dismiss', onclick: clearReport }, '×'));
    docBar.hidden = false;
  }
  function printReport() {
    const was = document.title;
    if (printTitle) document.title = `acuityIP ${printTitle}`;       // the browser's suggested PDF name
    addEventListener('afterprint', () => { document.title = was; }, { once: true });
    globalThis.print();
  }
  function clearReport() { printBox.replaceChildren(); printTitle = null; docBar.hidden = true; }

  // ---------- the tiles: one frame and one bridge each, one shown at a time ----------
  const mothership = new TileMothership({ loadDomain: TILE_LOAD_DOMAIN });
  mothership.addLoader(createPinnedLoader({ Tile, pins: Object.values(PINS).filter(Boolean) }));
  mothership.init();
  const ask = createProxyClient({ getPass: () => auth.getPass() });

  // hash: the tab's own address (default: its id). number: the numbers its tile takes (US by default).
  const SLOTS = {
    timeline: { office: 'us', label: 'Timeline', title: 'USPTO timeline', types: ['timeline', ...OA_TYPES, ...FAMILY_TYPES], height: 1200, show: ['exam', 'eptimeline'], links: ALL_LINKS,
      grants: [{ office: 'US', record: 'application', label: 'USPTO timeline' }], wishes: ['US/application', 'EP/application', 'US/examStats'] },
    appeals: { office: 'us', label: 'Appeals', title: 'PTAB appeal decisions', types: APPEAL_TYPES, height: 1500, doc: true, show: ['timeline'] },
    stats: { office: 'us', label: 'Appeal stats', title: 'PTAB appeal statistics', types: STATS_TYPES, height: 1500 },
    exam: { office: 'us', label: 'Exam stats', title: 'USPTO examination statistics', types: EXAM_TYPES, height: 1500, print: true,
      grants: [{ office: 'US', record: 'examStats', label: 'Exam stats' }] },
    eptimeline: { office: 'ep', hash: 'ep/timeline', label: 'Timeline', title: 'EPO timeline', types: [...EP_TYPES, ...FAMILY_TYPES], height: 1500, number: normalizeEpNumber, show: ['timeline'], links: ALL_LINKS,
      grants: [{ office: 'EP', record: 'application', label: 'EPO timeline' }], wishes: ['US/application', 'EP/application'] },
  };
  const hashOf = (id) => SLOTS[id].hash || id;
  // The page as house: each tab grants records by office; tiles wish (show stays for tiles published before wishes).
  const registry = createRegistry(SLOTS);
  const lastTab = { us: null, ep: null };
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
      showTiles: spec.show || [],
      onPrint: spec.print ? showReport : null,
      checkReport,
      numberCheck: spec.number || normalizeAppNumber,
      onLink: spec.links ? showLink : null,
      onWish: spec.wishes ? (want) => {
        const d = registry.decide(want, spec.wishes);
        if (d.refused) return false;
        choose(d.tile, true, d.number);
        return true;
      } : null,
      offers: spec.wishes ? () => registry.offers(spec.wishes) : null,
      linkTargets: spec.links || [],
      onDrop: (why) => console.warn(`[tools] dropped a message from the ${id} tile:`, why),
    });
    tabs.append(slot.tab);
    stage.append(slot.panel);
    slots[id] = slot;
  }
  const officeButtons = {};
  for (const [key, o] of Object.entries(OFFICES)) {
    officeButtons[key] = h('button', { type: 'button', class: 'office', id: `office-${key}`, 'aria-pressed': 'false',
      onclick: () => choose(lastTab[key] || o.first, true) }, o.label);
    offices.append(officeButtons[key]);
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
    const office = slot.spec.office;
    lastTab[office] = id;
    for (const s of Object.values(slots)) s.tab.hidden = s.spec.office !== office;
    for (const [key, b] of Object.entries(officeButtons)) b.setAttribute('aria-pressed', key === office ? 'true' : 'false');
    foot.textContent = FOOT[office];
    if (!slot.loaded) load(slot);
    if (appNumber) slot.bridge.open(appNumber);
    if (updateHash) {
      const want = appNumber && (id === 'timeline' || id === 'eptimeline') ? `#${appNumber}` : `#${hashOf(id)}`;
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

  // The page address picks the tab: #appeals, #stats, #exam, #timeline, #18649422 (opens that application),
  // #ep/timeline (or #ep), #EP23215480 / #EP4571955 (opens that EP application in the EPO timeline).
  function fromHash() {
    let raw = '';
    try { raw = decodeURIComponent(location.hash.slice(1)); } catch { raw = ''; }
    const byHash = Object.keys(slots).find((id) => hashOf(id) === raw);
    if (byHash) return choose(byHash);
    if (raw.toLowerCase() === 'ep') return choose(lastTab.ep || OFFICES.ep.first, true);
    if (/^ep/i.test(raw) && slots.eptimeline.bridge.open(raw)) return choose('eptimeline');
    if (raw && slots.timeline.bridge.open(raw)) return choose('timeline');
    if (!shown) choose('timeline');
  }
  addEventListener('hashchange', fromHash);

  auth.onChange(() => {
    drawAccount();
    for (const s of Object.values(slots)) s.bridge.status();
    if (!auth.signedIn && docUrl) { URL.revokeObjectURL(docUrl); docUrl = null; docBar.hidden = true; }
    if (!auth.signedIn && printTitle) clearReport();
    if (auth.problem instanceof WrongAccount) say(auth.problem.message);
  });
  drawAccount();
  fromHash();
  auth.start();
  globalThis.__tools = { auth, slots };
}
start();
