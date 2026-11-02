// Asking the ODP proxy: a fresh one-use pass from the account's own server for every request, then one
// GET. The proxy's answer is already trimmed; here only its shape and error names are checked.
import { PROXY } from './config.js';

export class SignInNeeded extends Error {}

const REASONS = new Set(['invalid-number', 'bad-type', 'bad-search', 'not-ready', 'unauthorized', 'unpublished', 'not-found', 'rate-limited', 'upstream', 'timeout']);
const MAX_PDF = 30 * 1024 * 1024;

/**
 * @param {() => Promise<string>} getPass   a service-auth token for the proxy (throws SignInNeeded)
 * ask(type, params): params is { app } (application lookups), { search } or { stats } (JSON strings), or { appeal, doc }.
 */
export function createProxyClient({ getPass, fetchImpl = (...a) => globalThis.fetch(...a), proxy = PROXY }) {
  return async function ask(type, params) {
    if (typeof params === 'string') params = { app: params };
    let token;
    try { token = await getPass(); } catch (err) {
      return { error: err instanceof SignInNeeded ? 'signed-out' : 'upstream' };
    }
    const qs = new URLSearchParams({ type, ...params }).toString().replace(/\+/g, '%20');
    let res;
    try {
      res = await fetchImpl(`${proxy.url}/xrpc/${proxy.lxm}?${qs}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(type === 'appealDoc' || type === 'actions' || type === 'actionText' ? proxy.timeoutMs * 2 : proxy.timeoutMs),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
    } catch (err) {
      return { error: err && err.name === 'TimeoutError' ? 'timeout' : 'upstream' };
    }
    if (type === 'appealDoc' && res.ok) {
      if (!/^application\/pdf\b/.test(res.headers.get('content-type') || '')) return { error: 'upstream' };
      let blob;
      try { blob = await res.blob(); } catch { return { error: 'upstream' }; }
      if (blob.size > MAX_PDF) return { error: 'upstream' };
      return { pdf: new Blob([blob], { type: 'application/pdf' }) };
    }
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (res.ok && body && body.type === type && body.data && typeof body.data === 'object') return { data: body.data };
    const reason = body && REASONS.has(body.error) ? body.error : 'upstream';
    if (reason === 'unauthorized') return { error: 'signed-out' };
    const out = { error: reason };
    const detail = reason === 'bad-search' || reason === 'not-ready';
    if (detail && typeof body.message === 'string') out.message = body.message.slice(0, 200);
    if (detail && typeof body.field === 'string' && /^[A-Za-z]{1,20}$/.test(body.field)) out.field = body.field;
    const pr = reason === 'not-ready' && body.status && body.status.progress;
    if (pr && Number.isFinite(pr.done) && Number.isFinite(pr.total)) out.progress = { done: pr.done, total: pr.total };
    return out;
  };
}
