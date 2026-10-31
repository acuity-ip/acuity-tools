// The pinned loader: loads only the exact tile versions listed in pins.js. Adapted COPY of Raku's
// src/tables/pinned.js (Oct 30 2026): refuses a tile whose record isn't the pinned one, and checks every
// file against its content address before handing it to the loader. Only did:plc accounts.
import { COLLECTION } from './config.js';

const NOT_FOUND = { ok: false, status: 404, statusText: 'Not found' };
const MASL_HEADERS = ['content-disposition', 'content-encoding', 'content-language', 'content-security-policy', 'content-type',
  'link', 'permissions-policy', 'referrer-policy', 'service-worker-allowed', 'sourcemap', 'speculation-rules',
  'supports-loading-mode', 'x-content-type-options'];
const LIMITS = { recordBytes: 256 * 1024, fileBytes: 5 * 1024 * 1024, ms: 15000 };

function maslResponse(entry, body) {
  const headers = {};
  for (const k of MASL_HEADERS) if (typeof entry[k] !== 'undefined') headers[k] = entry[k];
  return { ok: true, status: 200, statusText: 'Ok', headers, body };
}

// A file's raw-codec CIDv1 ("bafkrei…"), as a PDS gives a blob.
export async function rawCid(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const all = new Uint8Array(4 + digest.length);
  all.set([0x01, 0x55, 0x12, 0x20], 0);
  all.set(digest, 4);
  const A = 'abcdefghijklmnopqrstuvwxyz234567';
  let out = 'b', buffer = 0, bits = 0;
  for (const byte of all) {
    buffer = (buffer << 8) | byte; bits += 8;
    while (bits >= 5) { out += A[(buffer >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += A[(buffer << (5 - bits)) & 31];
  return out;
}

export class TileChanged extends Error {}

async function fetchBytes(fetchImpl, url, max) {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(LIMITS.ms), credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!res.ok) return null;
  const buf = new Uint8Array(await res.arrayBuffer());
  return buf.byteLength > max ? null : buf;
}

/** The account's server (PDS), from plc.directory. did:plc only. */
export async function pdsFor(did, fetchImpl = globalThis.fetch) {
  if (!/^did:plc:[a-z2-7]{24}$/.test(did)) throw new Error('Only did:plc tile authors.');
  const bytes = await fetchBytes(fetchImpl, `https://plc.directory/${did}`, 64 * 1024);
  const doc = bytes && JSON.parse(new TextDecoder().decode(bytes));
  const svc = doc && (doc.service || []).find((s) => s.id === '#atproto_pds' || String(s.id).endsWith('#atproto_pds'));
  if (!svc || !/^https:\/\//.test(svc.serviceEndpoint)) throw new Error('No account server found.');
  return String(svc.serviceEndpoint).replace(/\/+$/, '');
}

// Tile: @dasl/tile-loader's Tile class, passed in (so this file runs in Node for the tests).
export function createPinnedLoader({ Tile, pins, fetchImpl = (...a) => globalThis.fetch(...a), onRefused = () => {} }) {
  const files = new Map();                     // cid -> Promise<Uint8Array | null>
  async function blob(pds, did, cid) {
    if (!files.has(cid)) {
      files.set(cid, (async () => {
        const bytes = await fetchBytes(fetchImpl, `${pds}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`, LIMITS.fileBytes);
        if (!bytes) return null;
        return (await rawCid(bytes)) === cid ? bytes : null;     // not the pinned bytes: refuse
      })().catch(() => null));
    }
    const bytes = await files.get(cid);
    if (!bytes) { files.delete(cid); return null; }
    return bytes.slice().buffer;               // a fresh copy each time (the loader may hand it on)
  }

  return {
    async load(url, mothership) {
      const pin = pins.find((p) => p && p.uri === url);
      if (!pin) return false;
      const [did, collection, rkey] = url.replace(/^at:\/\//, '').split('/');
      if (collection !== COLLECTION) return false;
      const pds = await pdsFor(did, fetchImpl);
      const bytes = await fetchBytes(fetchImpl, `${pds}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=${COLLECTION}&rkey=${encodeURIComponent(rkey)}`, LIMITS.recordBytes);
      const body = bytes && JSON.parse(new TextDecoder().decode(bytes));
      if (!body || body.cid !== pin.cid || !body.value || !body.value.tile) {
        onRefused(url, body && body.cid);
        throw new TileChanged(`${url} isn't the pinned version (record ${body && body.cid}, expected ${pin.cid}).`);
      }
      const manifest = body.value.tile;
      return new Tile(mothership, url, manifest, {
        async resolvePath(path) {
          const entry = manifest.resources && manifest.resources[path];
          const src = entry && entry.src;
          const cid = src && (src.$link || (src.ref && src.ref.$link));
          if (!cid) return NOT_FOUND;
          const data = await blob(pds, did, cid);
          return data ? maslResponse(entry, data) : NOT_FOUND;
        },
      });
    },
  };
}
