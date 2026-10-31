// Asking the ODP proxy: a fresh one-use pass from the account's own server for every request, then one
// GET. The proxy's answer is already trimmed; here only its shape and error names are checked.
import { PROXY } from './config.js';

export class SignInNeeded extends Error {}

const REASONS = new Set(['invalid-number', 'bad-type', 'unauthorized', 'unpublished', 'not-found', 'rate-limited', 'upstream', 'timeout']);

/**
 * @param {() => Promise<string>} getPass   a service-auth token for the proxy (throws SignInNeeded)
 */
export function createProxyClient({ getPass, fetchImpl = (...a) => globalThis.fetch(...a), proxy = PROXY }) {
  return async function ask(type, app) {
    let token;
    try { token = await getPass(); } catch (err) {
      return { error: err instanceof SignInNeeded ? 'signed-out' : 'upstream' };
    }
    let res;
    try {
      res = await fetchImpl(`${proxy.url}/xrpc/${proxy.lxm}?type=${encodeURIComponent(type)}&app=${encodeURIComponent(app)}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(proxy.timeoutMs),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
    } catch (err) {
      return { error: err && err.name === 'TimeoutError' ? 'timeout' : 'upstream' };
    }
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (res.ok && body && body.type === type && body.data && typeof body.data === 'object') return { data: body.data };
    const reason = body && REASONS.has(body.error) ? body.error : 'upstream';
    return { error: reason === 'unauthorized' ? 'signed-out' : reason };
  };
}
