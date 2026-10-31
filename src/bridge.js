// The bridge between one tile and the page: checks every message the tile sends up, forwards only
// known kinds, applies limits, and answers. Pure logic (no DOM, no network), so it runs in Node tests.
//
// Envelope: { tool: "acuity-odp", v: 1, kind, ... }
//   up:   hello
//         query { id, type, appNumber }                       (timeline tile: application lookups)
//         query { id, type: "appealSearch", search }          (appeals tile: a search form, as an object)
//         query { id, type: "appealDoc", appeal, doc }        (appeals tile: fetch a decision PDF)
//         show  { tile: "timeline", appNumber }               (appeals tile: open an application in the timeline)
//   down: status { signedIn } | open { appNumber } | result { id, type, data } | error { id, reason, message?, field? }
//
// A decision PDF never goes into a tile (tiles have no popups and no network). The page keeps it and shows
// its own "Open" button; the tile is told { ready: true }.

export const TOOL = 'acuity-odp';
export const VERSION = 1;
export const TYPES = ['application', 'timeline', 'continuity', 'documents', 'pta'];
export const APPEAL_TYPES = ['appealSearch', 'appealDoc'];
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const DOC_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_SEARCH_JSON = 4096;
const SHOW_TILES = ['timeline'];

export function normalizeAppNumber(input) {
  const s = String(input ?? '').replace(/[\s\/,]/g, '');
  return /^\d{8}$/.test(s) ? s : null;
}

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
    case 'appealDoc': {
      const appeal = String(payload.appeal ?? '');
      const doc = String(payload.doc ?? '');
      if (!/^\d{10}$/.test(appeal) || !DOC_ID.test(doc)) return { reason: 'bad-search' };
      return { params: { appeal, doc } };
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
 * @param {{maxMessageBytes:number,inFlight:number,perMinute:number}} o.limits
 */
export function createBridge({ send, ask, signedIn, types = TYPES, limits, onDoc = null, onShow = null, now = () => Date.now(), onDrop = () => {} }) {
  let inFlight = 0;
  let window = { start: 0, n: 0 };
  let pendingOpen = null;
  let greeted = false;
  const down = (kind, fields = {}) => send({ ...fields, tool: TOOL, v: VERSION, kind });

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
      down('status', { signedIn: !!signedIn() });
      if (pendingOpen) { down('open', { appNumber: pendingOpen }); pendingOpen = null; }
      return;
    }
    if (payload.kind === 'show') {
      if (!onShow || !SHOW_TILES.includes(payload.tile)) return onDrop('bad-show');
      const app = normalizeAppNumber(payload.appNumber);
      if (!app) return onDrop('bad-show');
      onShow(payload.tile, app);
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
    if (err.reason === 'bad-search') {
      if (typeof out.message === 'string') err.message = out.message.slice(0, 200);
      if (typeof out.field === 'string' && /^[A-Za-z]{1,20}$/.test(out.field)) err.field = out.field;
    }
    down('error', err);
  }

  return {
    handle,
    /** Tell the tile whether lookups can work now (call on every sign-in change). */
    status() { if (greeted) down('status', { signedIn: !!signedIn() }); },
    /** Ask the tile to look up a number (e.g. from the page address); waits for its hello if needed. */
    open(appNumber) {
      const app = normalizeAppNumber(appNumber);
      if (!app) return false;
      if (greeted) down('open', { appNumber: app }); else pendingOpen = app;
      return true;
    },
    /** A new frame for the same tile (Try again): it will say hello again. */
    reset() { greeted = false; inFlight = 0; },
  };
}
