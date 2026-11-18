// sw.js must list every file the app loads, or the offline copy breaks. Run: node test/sw_test.js
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'sw.js'), 'utf8');
const files = JSON.parse(src.match(/const FILES = (\[[\s\S]*?\]);/)[1].replace(/'/g, '"').replace(/,\s*\]/, ']'));
let bad = 0;
for (const f of files) if (f !== './' && !existsSync(join(root, f))) { console.error('listed but missing:', f); bad++; }
for (const dir of ['js', 'data', 'i18n']) {
  for (const f of readdirSync(join(root, dir))) if (!files.includes(`${dir}/${f}`)) { console.error('not listed in sw.js:', `${dir}/${f}`); bad++; }
}
for (const f of ['index.html', 'style.css', 'manifest.webmanifest']) if (!files.includes(f)) { console.error('not listed in sw.js:', f); bad++; }
if (bad) process.exit(1);
console.log(`sw.js: ${files.length} files OK`);
