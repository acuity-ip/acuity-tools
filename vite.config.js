import { defineConfig } from 'vite';
import { pageCsp, oauthMetadata } from './src/config.js';

// As Raku's vite.config.js: the security policy goes into the built page only (GitHub Pages can't send
// headers; Vite's dev server injects scripts the policy would block). `npm run build` then
// `npm run preview` shows the page with it.
const policy = () => ({
  name: 'tools-page-policy',
  apply: 'build',
  transformIndexHtml(html) {
    return html.replace('<meta name="referrer"', `<meta http-equiv="Content-Security-Policy" content="${pageCsp()}">\n  <meta name="referrer"`);
  },
});

// The sign-in description file, written from config.js on build. On this computer (127.0.0.1) the
// sign-in is a "loopback" one that needs no file (auth.js).
const signInFile = () => ({
  name: 'tools-oauth-json',
  apply: 'build',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'oauth.json', source: `${JSON.stringify(oauthMetadata(), null, 2)}\n` });
  },
});

export default defineConfig({
  plugins: [policy(), signInFile()],
  // 127.0.0.1, not localhost: the loopback sign-in comes back to 127.0.0.1. 5185/5186 so Raku (5180) and the Foundry (5173) can run alongside.
  server: { host: '127.0.0.1', port: 5185, strictPort: true },
  preview: { host: '127.0.0.1', port: 5186, strictPort: true },
  build: { target: 'es2022', sourcemap: false, modulePreload: { polyfill: false } },
});
