// Pins the published tiles: reads the tiles folder's published.json and writes src/pins.js.
//   node scripts/pin.mjs [path\to\published.json]     (default: ..\tiles\published.json)
// After a republish, run it again, check the diff, build, and push: the page then loads only the new version.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = resolve(process.argv[2] || join(ROOT, '..', 'tiles', 'published.json'));
const published = JSON.parse(readFileSync(file, 'utf8'));
const PRACTICE = 'did:plc:5uyc6bnln26yftnfkqtlwxr3';

const pins = {};
for (const id of ['timeline', 'appeals', 'stats', 'exam', 'eptimeline']) {
  const p = published[id];
  if (!p) { pins[id] = null; continue; }
  if (!new RegExp(`^at://${PRACTICE}/ing\\.dasl\\.masl/[a-z0-9]{10,20}$`).test(p.uri)) throw new Error(`${id}: unexpected uri ${p.uri}`);
  if (!/^bafyrei[a-z2-7]{52}$/.test(p.cid)) throw new Error(`${id}: unexpected record cid ${p.cid}`);
  pins[id] = { uri: p.uri, cid: p.cid };
}

const body = Object.entries(pins).map(([k, v]) => `  ${k}: ${v ? `Object.freeze({ uri: '${v.uri}', cid: '${v.cid}' })` : 'null'},`).join('\n');
writeFileSync(join(ROOT, 'src', 'pins.js'),
  `// Written by scripts/pin.mjs from ${file.replace(/\\/g, '\\\\')} (${new Date().toISOString().slice(0, 10)}). Don't edit by hand.\n` +
  `// A tile not listed here (or listed as null) can't be loaded by this page.\nexport const PINS = Object.freeze({\n${body}\n});\n`);
console.log('Pinned:', JSON.stringify(pins, null, 2));
