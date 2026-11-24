// Writes public/sw.js from sw/sw.template.js with a build id (so every deploy gets its own app-shell cache) and the height-data URL.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let id = Date.now().toString(36);
try {
  id = execSync('git rev-parse --short HEAD', { cwd: here, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() + '-' + id;
} catch { /* not a git checkout */ }
const dataUrl = process.env.NEXT_PUBLIC_DATA_URL ?? '/data/urbis-2021'; // same default as src/lib/config.ts
const source = readFileSync(resolve(here, '../sw/sw.template.js'), 'utf8').replaceAll('__BUILD_ID__', id).replaceAll('__DATA_URL__', dataUrl);
writeFileSync(resolve(here, '../public/sw.js'), source);
console.log('service worker stamped', id, dataUrl);
