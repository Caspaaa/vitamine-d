// Dev only: serve the height tiles built by spikes/s4-pipeline from /data/urbis-2021 (never committed or built into the app).
//   node scripts/link-data.mjs                  link, fail if there are no tiles
//   node scripts/link-data.mjs --if-available   link when tiles exist, otherwise warn (used by `pnpm dev`)
//   node scripts/link-data.mjs --unlink         remove the link (used by `pnpm build`: the data is hosted separately)
import { existsSync, mkdirSync, symlinkSync, rmSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, '../../../spikes/s4-pipeline/out');
const link = resolve(here, '../public/data/urbis-2021');
const arg = process.argv[2];
const exists = () => {
  try { lstatSync(link); return true; } catch { return false; }
};

if (arg === '--unlink') {
  if (exists()) rmSync(link);
  console.log('data link removed: the build must not contain height tiles');
  process.exit(0);
}

if (!existsSync(resolve(target, 'dsm/index.json'))) {
  const message = `No tiles in ${target}. Build them first (docs/spikes/S4-pipeline-hosting.md, "Reproduce").`;
  if (arg === '--if-available') {
    console.warn(`${message} Shadows stay unavailable until NEXT_PUBLIC_DATA_URL points at hosted tiles.`);
    process.exit(0);
  }
  console.error(message);
  process.exit(1);
}
mkdirSync(dirname(link), { recursive: true });
if (exists()) rmSync(link);
symlinkSync(target, link, 'dir');
console.log(`linked ${link} -> ${target}`);
