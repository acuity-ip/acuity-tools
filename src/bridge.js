// The bridge between one tile and the page: checks every message the tile sends up, forwards only
// known kinds, applies limits, and answers. Pure logic (no DOM, no network), so it runs in Node tests.
//
// Envelope: { tool: "acuity-odp", v: 1, kind, ... }
//   up:   hello
//         query { id, type, appNumber }                       (timeline tile: application lookups, incl. "actions")
//         query { id, type: "actionText", appNumber, action } (timeline tile: the text of one office action)
//         query { id, type: "appealSearch", search }          (appeals tile: a search form, as an object)
//         query { id, type: "appealDoc", appeal, doc }        (appeals tile: fetch a decision PDF)
//         query { id, type: "appealStats", stats }            (stats tile: a statistics request, as an object)
//         query { id, type: "examStats", exam }               (exam stats tile: a statistics request, as an object)
//         show  { tile, appNumber }                           (appeals -> timeline; timeline -> exam: open an application there)
//         print { report }                                    (exam stats tile: the page prints a report built from plain data)
//         query { id, type: "epTimeline", appNumber }         (EPO timeline tile: appNumber is an EP application or publication number)
//         query { id, type: "family", of, legal? }            (both timelines: the INPADOC family of a published member, e.g. US20250192292A1; legal: true adds legal status)
//         link  { target, number }                            (both timelines: the page offers a link out; see links.js)
//         wish  { want: { office, record, number } }          (both timelines: open a record in whichever tab grants it; see grants.js)
//   status also carries grants: [{ office, record, label }]   (what this tile may wish for right now)
//   down: status { signedIn } | open { appNumber } | result { id, type, data } | error { id, reason, message?, field?, progress? }
//
// A decision PDF never goes into a tile (tiles have no popups and no network). The page keeps it and shows
// its own "Open" button; the tile is told { ready: true }.

export const TOOL = 'acuity-odp';
export const VERSION = 1;
export const TYPES = ['application', 'timeline', 'continuity', 'documents', 'pta'];
export const APPEAL_TYPES = ['appealSearch', 'appealDoc'];
export const STATS_TYPES = ['appealStats'];
export const OA_TYPES = ['actions', 'actionText'];
export const EXAM_TYPES = ['examStats'];
export const EP_TYPES = ['epTimeline'];
export const FAMILY_TYPES = ['family'];
const ACTION_ID = /^[0-9a-f]{24,64}$/;
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const DOC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_SEARCH_JSON = 4096;

export function normalizeAppNumber(input) {
  const s = String(input ?? '').replace(/[\s\/,]/g, '');
  return /^\d{8}$/.test(s) ? s : null;
}

/**
 * "EP 23 215 480.1", "EP4571955", "EP 4 571 955 A1" -> "EP23215480" / "EP4571955"; anything else null.
 * The page insists on the EP prefix (the tile adds it to what people type), so a bare 8-digit US number can never
 * be taken for an EP application.
 */
export function normalizeEpNumber(input) {
  if (typeof input !== 'string' || input.length > 40) return null;
  const t = input.toUpperCase().replace(/[\s,]/g, '');
  if (!t.startsWith('EP')) return null;
  const s = t.slice(2).replace(/(A[1-9]|B[1-9])$/, '');
  const a = /^(\d{8})(?:\.\d)?$/.exec(s);
  if (a) return `EP${a[1]}`;
  return /^\d{7}$/.test(s) ? `EP${s}` : null;
}

/** The number check for a tile: EP tiles take EP numbers, every other tile US application numbers. */
export const numberCheckFor = (tile) => (String(tile).startsWith('ep') ? normalizeEpNumber : normalizeAppNumber);

/** What a query asks the proxy for, checked; or { reason } if the tile sent something unusable. */
export function queryParams(payload) {
  switch (payload.type) {
    case 'appealSearch': {
      const s = payload.search;
      if (!s || typeof s !== 'object' || Array.isArray(s)) return { reason: 'bad-search' };
      let json;
      try { json = JSON.stringify(s); } catch { return { reason: 'bad-search' }; }
      if (json.length > MAX_SEARCH_JSON) return { reason: 'bad-search' };
      return { params: { search: json } };
    }
    case 'examStats': {
      const s = payload.exam;
      if (!s || typeof s !== 'object' || Array.isArray(s)) return { reason: 'bad-search' };
      let json;
      try { json = JSON.stringify(s); } catch { return { reason: 'bad-search' }; }
      if (json.length > 1024) return { reason: 'bad-search' };
      return { params: { exam: json } };
    }
    case 'appealStats': {
      const s = payload.stats;
      if (!s || typeof s !== 'object' || Array.isArray(s)) return { reason: 'bad-search' };
      let json;
      try { json = JSON.stringify(s); } catch { return { reason: 'bad-search' }; }
      if (json.length > MAX_SEARCH_JSON) return { reason: 'bad-search' };
      return { params: { stats: json } };
    }
    case 'appealDoc': {
      const appeal = String(payload.appeal ?? '');
      const doc = String(payload.doc ?? '');
      if (!/^\d{10}$/.test(appeal) || !DOC_ID.test(doc)) return { reason: 'bad-search' };
      return { params: { appeal, doc } };
    }
    case 'family': {
      const of = typeof payload.of === 'string' && payload.of.length <= 40 ? payload.of.toUpperCase().replace(/[\s,/]/g, '') : '';
      if (!/^[A-Z]{2}[0-9A-Z]{4,15}$/.test(of)) return { reason: 'invalid-number' };
      return { params: payload.legal === true ? { of, legal: '1' } : { of } };
    }
    case 'epTimeline': {
      const ep = normalizeEpNumber(payload.appNumber);
      return ep ? { params: { ep } } : { reason: 'invalid-number' };
    }
    case 'actionText': {
      const app = normalizeAppNumber(payload.appNumber);
      if (!app) return { reason: 'invalid-number' };
      const id = String(payload.action ?? '');
      if (!ACTION_ID.test(id)) return { reason: 'not-found' };
      return { params: { app, id } };
    }
    default: {
      const app = normalizeAppNumber(payload.appNumber);
      return app ? { params: { app } } : { reason: 'invalid-number' };
    }
  }
}

/**
 * @param {object} o
 * @param {(payload: object) => void} o.send                 post a payload down to the tile
 * @param {(type: string, params: object) => Promise<{data?: object, pdf?: Blob, error?: string, message?: string, field?: string}>} o.ask
 * @param {() => boolean} o.signedIn
 * @param {string[]} [o.types]     query types this tile may use
 * @param {(pdf: Blob, appeal: string) => void} [o.onDoc]          the page shows its own Open button
 * @param {(tile: string, appNumber: string) => void} [o.onShow]   only if this tile may ask for it
 * @param {string[]} [o.showTiles]                                the tiles it may ask to show
 * @param {(report: object) => void} [o.onPrint]                  a checked report (see report.js), for the page to print
 * @param {(raw: object) => object|null} [o.checkReport]          turns the tile's report into a safe one, or null
 * @param {{maxMessageBytes:number,inFlight:number,perMinute:number}} o.limits
 * @param {(n: string) => string|null} [o.numberCheck]           this tile's own numbers, for open (US by default; EP for EP tiles)
 * @param {(target: string, number: string) => boolean} [o.onLink] the page checks and offers a link out (true if it did)
 * @param {string[]} [o.linkTargets]                              the link targets this tile may ask for
 * @param {(want: object) => boolean} [o.onWish]                 the page as house: true if it granted the wish
 * @param {() => object[]} [o.offers]                            what this tile may wish for now (sent with status)
 */
export function createBridge({ send, ask, signedIn, types = TYPES, limits, onDoc = null, onShow = null, showTiles = [], onPrint = null, checkReport = null, numberCheck = normalizeAppNumber, onLink = null, linkTargets = [], onWish = null, offers = null, now = () => Date.now(), onDrop = () => {} }) {
  let inFlight = 0;
  let window = { start: 0, n: 0 };
  let pendingOpen = null;
  let greeted = false;
  const down = (kind, fields = {}) => send({ ...fields, tool: TOOL, v: VERSION, kind });
  const statusFields = () => ({ signedIn: !!signedIn(), ...(offers ? { grants: offers() } : {}) });

  function overLimit() {
    const t = now();
    if (t - window.start >= 60000) window = { start: t, n: 0 };
    if (inFlight >= limits.inFlight || window.n >= limits.perMinute) return true;
    window.n++;
    return false;
  }

  async function handle(payload) {
    let size = 0;
    try { size = JSON.stringify(payload).length; } catch { return onDrop('unserializable'); }
    if (size > limits.maxMessageBytes) return onDrop('too-large');
    if (!payload || typeof payload !== 'object' || payload.tool !== TOOL || payload.v !== VERSION) return onDrop('not-ours');

    if (payload.kind === 'hello') {
      greeted = true;
      down('status', statusFields());
      if (pendingOpen) { down('open', { appNumber: pendingOpen }); pendingOpen = null; }
      return;
    }
    if (payload.kind === 'show') {
      if (!onShow || !showTiles.includes(payload.tile)) return onDrop('bad-show');
      const app = numberCheckFor(payload.tile)(payload.appNumber);
      if (!app) return onDrop('bad-show');
      onShow(payload.tile, app);
      return;
    }
    if (payload.kind === 'wish') {
      const w = payload.want;
      if (!onWish || !w || typeof w !== 'object' || Array.isArray(w)) return onDrop('bad-wish');
      const want = { office: String(w.office ?? '').slice(0, 4), record: String(w.record ?? '').slice(0, 20), number: typeof w.number === 'string' ? w.number.slice(0, 40) : '' };
      if (!onWish(want)) return onDrop('bad-wish');
      return;
    }
    if (payload.kind === 'link') {
      if (!onLink || typeof payload.target !== 'string' || !linkTargets.includes(payload.target)) return onDrop('bad-link');
      if (!onLink(payload.target, payload.number)) return onDrop('bad-link');
      return;
    }
    if (payload.kind === 'print') {
      if (!onPrint || !checkReport || !signedIn()) return onDrop('bad-print');
      const report = checkReport(payload.report);
      if (!report) return onDrop('bad-print');
      onPrint(report);
      return;
    }
    if (payload.kind !== 'query') return onDrop('unknown-kind');

    const { id, type } = payload;
    if (typeof id !== 'string' || !ID.test(id)) return onDrop('bad-id');
    if (!types.includes(type)) return down('error', { id, reason: 'bad-type' });
    if (type === 'appealDoc' && !onDoc) return down('error', { id, reason: 'bad-type' });
    const { params, reason } = queryParams(payload);
    if (reason) return down('error', { id, reason });
    if (!signedIn()) return down('error', { id, reason: 'signed-out' });
    if (overLimit()) return down('error', { id, reason: 'rate-limited' });

    inFlight++;
    let out;
    try { out = await ask(type, params); } catch { out = { error: 'upstream' }; } finally { inFlight--; }
    if (type === 'appealDoc' && out && out.pdf) {
      onDoc(out.pdf, params.appeal);
      return down('result', { id, type, data: { ready: true } });
    }
    if (out && out.data) return down('result', { id, type, data: out.data });
    const err = { id, reason: (out && out.error) || 'upstream' };
    if (err.reason === 'bad-search' || err.reason === 'not-ready') {
      if (typeof out.message === 'string') err.message = out.message.slice(0, 200);
      if (typeof out.field === 'string' && /^[A-Za-z]{1,20}$/.test(out.field)) err.field = out.field;
    }
    if (err.reason === 'not-ready' && out.progress && Number.isFinite(out.progress.done) && Number.isFinite(out.progress.total)) {
      err.progress = { done: out.progress.done, total: out.progress.total };
    }
    down('error', err);
  }

  return {
    handle,
    /** Tell the tile whether lookups can work now (call on every sign-in change). */
    status() { if (greeted) down('status', statusFields()); },
    /** Ask the tile to look up a number (e.g. from the page address); waits for its hello if needed. */
    open(appNumber) {
      const app = numberCheck(appNumber);
      if (!app) return false;
      if (greeted) down('open', { appNumber: app }); else pendingOpen = app;
      return true;
    },
    /** A new frame for the same tile (Try again): it will say hello again. */
    reset() { greeted = false; inFlight = 0; },
  };
}
