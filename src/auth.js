// Signing in (one account only: the practice's). Adapted from Raku's src/auth.js (Oct 30 2026):
// - @atproto/oauth-client-browser 0.5.8, popup sign-in opened straight from the click;
// - on this computer (127.0.0.1) a loopback sign-in that needs no description file;
// - the only permission asked: passes for the ODP proxy's one method (config.js SCOPE);
// - an account other than the practice's is signed straight back out.
// getLib() -> the library's exports (loaded when needed), so tests can hand in a stand-in.
import { SIGNIN, SCOPE, PRACTICE, PROXY, isLocal } from './config.js';
import { SignInNeeded } from './proxy.js';

export class SignInStopped extends Error {}
export class WrongAccount extends Error {}

export function clientIdFor(loc = globalThis.location) {
  if (!isLocal(loc)) return SIGNIN.clientId;
  const port = loc.port ? `:${loc.port}` : '';
  return `http://localhost?redirect_uri=${encodeURIComponent(`http://127.0.0.1${port}/`)}&scope=${encodeURIComponent(SCOPE)}`;
}

/** Is this page load the end of a sign-in (the account server sent the browser back here)? */
export function isSignInReturn(loc = globalThis.location) {
  const q = `${loc.search || ''}&${String(loc.hash || '').replace(/^#/, '')}`;
  return /(^|[?&])state=/.test(q) && /(^|[?&])(code|error)=/.test(q);
}

const guarded = (f, fallback = null) => { try { return f(); } catch { return fallback; } };

export function createAuth(getLib, { storage, loc = globalThis.location, win = globalThis } = {}) {
  let client = null;
  let session = null;
  let problem = null;
  const listeners = new Set();
  const emit = () => listeners.forEach((fn) => { try { fn(); } catch (err) { console.error('[tools] sign-in listener', err); } });
  const remember = (did) => guarded(() => (did ? storage.setItem(SIGNIN.accountKey, did) : storage.removeItem(SIGNIN.accountKey)));
  const remembered = () => guarded(() => storage.getItem(SIGNIN.accountKey));

  async function adopt(s) {
    if (s.did !== PRACTICE.did) {
      try { await client.revoke(s.did); } catch { /* already gone */ }
      throw new WrongAccount(`Only @${PRACTICE.handle} can use this page.`);
    }
    session = s;
    remember(s.did);
    emit();
  }
  function forget() { session = null; remember(null); emit(); }

  return {
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    get signedIn() { return !!session; },
    get problem() { return problem; },

    // Once per page load. In the small sign-in window this finishes the sign-in: { finishedInWindow: true }.
    async start() {
      let lib = {};
      try {
        lib = await getLib();
        client = await lib.BrowserOAuthClient.load({ clientId: clientIdFor(loc), handleResolver: SIGNIN.handleResolver });
        const r = await client.init();
        client.addEventListener?.('deleted', () => forget());
        if (r && r.session) await adopt(r.session);
        else if (remembered()) {
          try { await adopt(await client.restore(remembered())); } catch { forget(); }
        }
        emit();
        return {};
      } catch (err) {
        if ((lib.LoginContinuedInParentWindowError && err instanceof lib.LoginContinuedInParentWindowError) || err?.code === 'LOGIN_CONTINUED_IN_PARENT_WINDOW') {
          return { finishedInWindow: true };
        }
        if (/Redirecting to loopback/.test(String(err?.message))) return { moving: true };
        if (err instanceof WrongAccount) { problem = err; emit(); return { error: err }; }
        console.error('[tools] sign-in could not start', err);
        problem = err;
        emit();
        return { error: err };
      }
    },

    // Call straight from a click, before anything that waits: browsers only allow a new window then.
    openWindow() {
      try { return win.open('about:blank', SIGNIN.windowName, SIGNIN.windowFeatures) || null; } catch { return null; }
    },

    // As Raku: don't watch whether the window is still open (Bluesky's sign-in pages cut the link); the
    // library's own channel brings the result back; Cancel (signal) or its 5 minutes end the wait.
    async signIn({ signal } = {}) {
      if (!client) throw new Error(problem ? "Signing in isn't working here right now." : 'Still getting ready. Try again in a moment.');
      problem = null;
      try {
        const s = await client.signInPopup(PRACTICE.handle, { popupName: SIGNIN.windowName, popupFeatures: SIGNIN.windowFeatures, signal, scope: SCOPE });
        await adopt(s);
      } catch (err) {
        if (signal?.aborted) throw new SignInStopped('Sign-in cancelled.');
        if (/^Timeout$/.test(String(err?.message))) throw new SignInStopped("Sign-in didn't finish in time. Try again.");
        throw err;
      }
    },

    async signOut() {
      const did = session?.did;
      forget();
      try { if (did) await client?.revoke(did); } catch { /* already gone */ }
    },

    // A pass for the proxy: a short token from the account's own server, addressed to the proxy and its
    // one method, good for a minute and used once (as Raku's getRoomPass).
    async getPass() {
      if (!session) throw new SignInNeeded('signed out');
      const q = new URLSearchParams({ aud: PROXY.audience, lxm: PROXY.lxm, exp: String(Math.floor(Date.now() / 1000) + 60) });
      let res;
      try {
        res = await session.fetchHandler(`/xrpc/com.atproto.server.getServiceAuth?${q}`, { method: 'GET' });
      } catch (err) {
        if (/token|session|refresh|revoked|auth/i.test(String(err && (err.name + ' ' + err.message)))) { forget(); throw new SignInNeeded(String(err.message)); }
        throw err;
      }
      const body = await res.json().catch(() => ({}));
      if (res.status === 401 || res.status === 403) { forget(); throw new SignInNeeded(body.message || 'not allowed'); }
      if (!res.ok || typeof body.token !== 'string') throw new Error(body.message || `The account server answered ${res.status}`);
      return body.token;
    },
  };
}
