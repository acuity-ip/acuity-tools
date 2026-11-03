// Acuity IP tools: every address and permission the page names lives here (as Raku's config.js).
// public/CNAME must match SITE.host; the deploy workflow checks that oauth.json agrees.
import { PINS } from './pins.js';

export const SITE = Object.freeze({
  name: 'Acuity IP tools',
  host: 'tools.acuityip.com',
  origin: 'https://tools.acuityip.com',
});

// The firm, as acuityip.com's own footer shows it (Nathan, Nov 2 2026). The disclaimer is word for word.
export const FIRM = Object.freeze({
  home: 'https://acuityip.com/',
  legal: 'Acuity IP, LLC',
  address: '5460 Ward Road, Suite 320, Arvada CO 80002',
  phone: '(720) 277-7283',
  tel: '+17202777283',
  email: 'ncassell@acuityip.com',
  bluesky: 'https://bsky.app/profile/acuityip.com',
  disclaimer: 'This website does not constitute legal advice or create an attorney-client relationship.',
  privacy: 'Lookups are not stored: results are kept in memory only, and logs record no application numbers.',
});

// The only account that may use this page (the proxy enforces the same allowlist).
export const PRACTICE = Object.freeze({ did: 'did:plc:5uyc6bnln26yftnfkqtlwxr3', handle: 'acuityip.com' });

// The ODP proxy on Fly. Passes are addressed to its service entry (#acuity_odp in its did.json).
export const PROXY = Object.freeze({
  url: 'https://acuity-odp.fly.dev',
  audience: 'did:web:acuity-odp.fly.dev#acuity_odp',
  lxm: 'com.acuityip.odp.query',
  timeoutMs: 20000,
});

// What the sign-in asks for: the account, plus passes for the proxy's one method. Nothing else
// (no posting, no records). Raw rpc: scope, so no permission-set lexicon is needed.
export const SCOPE = `atproto rpc:${PROXY.lxm}?aud=${PROXY.audience.replace('#', '%23')}`;

export const SIGNIN = Object.freeze({
  clientId: `${SITE.origin}/oauth.json`,       // changing it signs everyone out
  redirectUri: `${SITE.origin}/`,
  handleResolver: 'https://bsky.social',        // as Raku, the Foundry, Seven-Up and Daisy
  windowName: 'acuity-signin',
  windowFeatures: 'width=600,height=700,menubar=no,toolbar=no',
  accountKey: 'acuity-tools-account',          // localStorage: the signed-in DID (no secrets; the library keeps the session)
});

// Tiles load through the owner's loading server: a fresh random origin per tile, no network inside.
export const TILE_LOAD_DOMAIN = 'load.tiles.lexicographer.space';
export const COLLECTION = 'ing.dasl.masl';
export const TIMES = Object.freeze({ still: 4000, retry: 8000 });

// Pinned tiles (scripts/pin.mjs writes pins.js from the tiles folder's published.json).
export { PINS };

// Limits on what a tile may ask of the page (per tile).
export const BRIDGE_LIMITS = Object.freeze({ maxMessageBytes: 8192, inFlight: 4, perMinute: 30 });

export const isLocal = (loc) => !!loc && ['127.0.0.1', 'localhost', '[::1]'].includes(loc.hostname);

/** The sign-in description file, published at SIGNIN.clientId (written by vite.config.js on build). */
export function oauthMetadata() {
  return {
    client_id: SIGNIN.clientId,
    client_name: SITE.name,
    client_uri: `${SITE.origin}/`,
    redirect_uris: [SIGNIN.redirectUri],
    scope: SCOPE,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'web',
    dpop_bound_access_tokens: true,
  };
}

// The page's security policy, a <meta> tag on the built page (GitHub Pages can't send headers;
// frame-ancestors can't be set this way, so frame-guard.js refuses to run inside a frame instead).
// - scripts and styles only from the site itself;
// - connections over https: the account's server and the sign-in (both vary by account), plc.directory,
//   the tile records and files, and the proxy;
// - frames only from the tile loading server.
export function pageCsp(loadDomain = TILE_LOAD_DOMAIN) {
  const base = loadDomain.replace(/^load\./, '');
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self' https:",
    `frame-src https://${loadDomain} https://*.${base}`,
    "worker-src 'none'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}
