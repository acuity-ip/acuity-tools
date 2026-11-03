// Wishes and grants (Nov 2 2026). A tile no longer names another tab: it wishes for a record by office,
// e.g. { office: 'EP', record: 'application', number: 'EP23215480' }. Each tab declares what it grants. The page
// is the house: it allows a wish only if the asking tile may make it, a tab grants it, and the number passes
// that office's check; then it opens the granting tab. Nothing but the checked number moves between tiles.
// Every wish comes from a click in the tile, so there is no separate "ask" step; a refusal is simply dropped.
// Pure functions (no DOM), so they run in the Node tests.
import { normalizeAppNumber, normalizeEpNumber } from './bridge.js';

/** How each office's numbers are checked. An office without a check here can't be wished for. */
export const NUMBER_CHECKS = Object.freeze({ US: normalizeAppNumber, EP: normalizeEpNumber });
export const RECORDS = Object.freeze(['application', 'examStats']);
const keyOf = (w) => `${w.office}/${w.record}`;

/**
 * @param {Record<string, {grants?: {office:string, record:string, label:string}[]}>} slots
 */
export function createRegistry(slots) {
  const grantors = new Map();      // "EP/application" -> { tile, grant }
  for (const [tile, spec] of Object.entries(slots)) {
    for (const g of spec.grants || []) {
      if (!NUMBER_CHECKS[g.office] || !RECORDS.includes(g.record)) throw new Error(`${tile}: can't grant ${keyOf(g)}`);
      if (grantors.has(keyOf(g))) throw new Error(`${keyOf(g)} is granted twice`);
      grantors.set(keyOf(g), { tile, grant: Object.freeze({ office: g.office, record: g.record, label: String(g.label) }) });
    }
  }
  return {
    /** What a tile may currently wish for (sent to it with its status), given its allowlist. */
    offers(allowed = []) {
      return allowed.filter((k) => grantors.has(k)).map((k) => grantors.get(k).grant);
    },
    /** The house's answer to one wish: { tile, number } or { refused: reason }. */
    decide(want, allowed = []) {
      if (!want || typeof want !== 'object' || typeof want.office !== 'string' || typeof want.record !== 'string') return { refused: 'bad-wish' };
      const key = keyOf(want);
      if (!allowed.includes(key)) return { refused: 'not-allowed' };
      const g = grantors.get(key);
      if (!g) return { refused: 'no-grantor' };
      const number = NUMBER_CHECKS[want.office](want.number);
      if (!number) return { refused: 'bad-number' };
      return { tile: g.tile, number };
    },
  };
}
