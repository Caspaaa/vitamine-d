// MapLibre GL 6 runs its tile decoding in a separate ES-module worker (plus a shared chunk). Bundlers do not emit
// these reliably, so they are copied to public/vendor and the app points setWorkerUrl at them.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const dist = dirname(require.resolve('maplibre-gl/package.json')) + '/dist';
const out = resolve(dirname(new URL(import.meta.url).pathname), '../public/vendor');
mkdirSync(out, { recursive: true });
for (const f of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) copyFileSync(`${dist}/${f}`, `${out}/${f}`);
console.log('copied MapLibre worker to public/vendor');
