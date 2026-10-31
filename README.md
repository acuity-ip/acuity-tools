# tools.acuityip.com

The host page for Acuity IP's USPTO tiles. It signs in as @acuityip.com (only that account), loads the
pinned timeline tile through one mothership (`load.tiles.lexicographer.space`), and answers the tile's
lookups through the ODP proxy (`acuity-odp.fly.dev`) with a fresh one-use pass per lookup.
The tile never touches the network; the page never stores what was looked up.

The sign-in asks for exactly one permission:
`rpc:com.acuityip.odp.query?aud=did:web:acuity-odp.fly.dev%23acuity_odp`, i.e. passes for the proxy.
Nothing can be posted or written with it.

    npm install
    npm test                         unit tests (bridge, proxy client, pinned loader, sign-in rules)
    npm run dev                      http://127.0.0.1:5185  (loopback sign-in; no security policy in dev)
    npm run build && npm run preview http://127.0.0.1:5186  (the built page, with its policy)
    node test/page.browser.mjs       browser check of the built page (needs Playwright)

Open with an application number: `https://tools.acuityip.com/#18649422`.

## First launch

1. **Publish the tile** (from `C:\acuity-ip\tiles`): `npm run publish:dry`, then `npm run publish:tiles`
   with a one-off app password; delete the password afterwards.
2. **Pin it** (from here): `npm run pin`. This writes `src/pins.js` from `..\tiles\published.json`.
3. **Redeploy the proxy** (from `C:\acuity-ip\odp-proxy`): `fly deploy --ha=false`. fly.toml now also
   allows the two local addresses above, so step 4 works before DNS.
4. **Try it locally**: `npm run dev`, open http://127.0.0.1:5185/#18649422, sign in, and the tile should
   show the timeline. `npm run build && npm run preview` for the same with the security policy.
5. **GitHub**: create a repo (e.g. `acuity-tools`), push this folder. Settings → Pages → Source: GitHub
   Actions. The workflow builds, tests, checks the policy and oauth.json, and deploys.
   Settings → Pages → Custom domain: `tools.acuityip.com`, then tick Enforce HTTPS once offered.
6. **DNS (InMotion cPanel → Zone Editor → acuityip.com)**: add one record, change nothing else:
   `tools` CNAME `<your-github-user>.github.io.`
   Recommended: verify the domain in GitHub (Settings → Pages → Verified domains), which adds one
   TXT record `_github-pages-challenge-<user>.acuityip.com`. It stops anyone else claiming the subdomain.
   Leave MX, SPF, DKIM, autodiscover and `_atproto` exactly as they are.

After a tile republish: publish, `npm run pin`, check the diff, push.
