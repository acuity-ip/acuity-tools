// Links out to the offices' own public pages. A tile only names a target and a number; the page checks the
// number and builds the address from the fixed patterns below, so a tile can never choose where a link goes.
// Checked by Nathan on Nov 2 2026, signed out: EP Register, Espacenet and PATENTSCOPE open the right case and
// their documents download without an account (each site asks the visitor to confirm they're human first);
// Patent Center needs a USPTO.gov sign-in, so its label says so.
import { normalizeAppNumber, normalizeEpNumber } from './bridge.js';

const clean = (n) => (typeof n === 'string' && n.length <= 40 ? n.toUpperCase().replace(/[\s,/]/g, '') : '');
const epApplication = (n) => { const e = normalizeEpNumber(n); return e && e.length === 10 ? e : null; };   // EP + 8 digits
const publication = (n) => { const s = clean(n); return /^[A-Z]{2}[0-9A-Z]{4,15}$/.test(s) ? s : null; };
const wo = (n) => { const m = /^(WO\d{10})(?:A\d)?$/.exec(clean(n)); return m ? m[1] : null; };

export const LINKS = Object.freeze({
  epRegister: { label: 'EP Register', check: epApplication, url: (n) => `https://register.epo.org/application?number=${n}&lng=en` },
  epDocuments: { label: 'EP Register: all documents', check: epApplication, url: (n) => `https://register.epo.org/application?number=${n}&lng=en&tab=doclist` },
  espacenet: { label: 'Espacenet', check: publication, url: (n) => `https://worldwide.espacenet.com/patent/search?q=pn%3D${n}` },
  patentscope: { label: 'PATENTSCOPE', check: wo, url: (n) => `https://patentscope.wipo.int/search/en/detail.jsf?docId=${n}` },
  patentCenter: { label: 'Patent Center (USPTO sign-in)', check: (n) => normalizeAppNumber(n), url: (n) => `https://patentcenter.uspto.gov/applications/${n}` },
});

/** { target, number, label, url } for a tile's link request, or null if anything is off. */
export function linkFor(target, number) {
  const t = Object.prototype.hasOwnProperty.call(LINKS, target) ? LINKS[target] : null;
  if (!t) return null;
  const n = t.check(number);
  return n ? { target, number: n, label: t.label, url: t.url(n) } : null;
}
