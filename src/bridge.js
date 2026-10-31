// The bridge between one tile and the page: checks every message the tile sends up, forwards only
// known kinds, applies limits, and answers. Pure logic (no DOM, no network), so it runs in Node tests.
//
// Envelope: { tool: "acuity-odp", v: 1, kind, ... }
//   up:   hello | query { id, type, appNumber }
//   down: status { signedIn } | open { appNumber } | result { id, type, data } | error { id, reason }

export const TOOL = 'acuity-odp';
export const VERSION = 1;
export const TYPES = ['application', 'timeline', 'continuity', 'documents', 'pta'];
const ID = /^[A-Za-z0-9_-]{1,40}$/;

export function normalizeAppNumber(input) {
  const s = String(input ?? '').replace(/[\s\/,]/g, '');
  return /^\d{8}$/.test(s) ? s : null;
}

/**
 * @param {object} o
 * @param {(payload: object) => void} o.send                 post a payload down to the tile
 * @param {(type: string, app: string) => Promise<{data?: object, error?: string}>} o.ask   ask the proxy
 * @param {() => boolean} o.signedIn
 * @param {string[]} [o.types]     query types this tile may use
 * @param {{maxMessageBytes:number,inFlight:number,perMinute:number}} o.limits
 */
export function createBridge({ send, ask, signedIn, types = TYPES, limits, now = () => Date.now(), onDrop = () => {} }) {
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
    if (payload.kind !== 'query') return onDrop('unknown-kind');

    const { id, type } = payload;
    if (typeof id !== 'string' || !ID.test(id)) return onDrop('bad-id');
    if (!types.includes(type)) return down('error', { id, reason: 'bad-type' });
    const app = normalizeAppNumber(payload.appNumber);
    if (!app) return down('error', { id, reason: 'invalid-number' });
    if (!signedIn()) return down('error', { id, reason: 'signed-out' });
    if (overLimit()) return down('error', { id, reason: 'rate-limited' });

    inFlight++;
    let out;
    try { out = await ask(type, app); } catch { out = { error: 'upstream' }; } finally { inFlight--; }
    if (out && out.data) down('result', { id, type, data: out.data });
    else down('error', { id, reason: (out && out.error) || 'upstream' });
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
