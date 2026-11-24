import { loadAtlas } from './atlas';
import { DEFAULT_PARAMS, ShadowProgram } from './shadowProgram';
import { sunAt } from './sun';

const TILE = 256;
const ortho = (z: number, x: number, y: number) =>
  'https://geoservices-grid.irisnet.be/geowebcache/service/wmts?layer=Ortho&style=&tilematrixset=EPSG:900913' +
  `&Service=WMTS&Request=GetTile&Version=1.0.0&Format=image/jpeg&TileMatrix=EPSG:900913:${z}&TileCol=${x}&TileRow=${y}`;

async function loadLuminance(size: number): Promise<Float32Array> {
  const meta = await (await fetch('/tiles/meta.json')).json();
  const lum = new Float32Array(size * size);
  const canvas = new OffscreenCanvas(TILE, TILE);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const jobs: [number, number][] = [];
  for (let ty = 0; ty < meta.tiles; ty++) for (let tx = 0; tx < meta.tiles; tx++) jobs.push([tx, ty]);
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const [tx, ty] = jobs[next++];
      const blob = await (await fetch(ortho(meta.zoom, meta.x0 + tx, meta.y0 + ty))).blob();
      const bmp = await createImageBitmap(blob);
      ctx.drawImage(bmp, 0, 0, TILE, TILE);
      bmp.close();
      const d = ctx.getImageData(0, 0, TILE, TILE).data;
      for (let y = 0; y < TILE; y++) {
        for (let x = 0; x < TILE; x++) {
          const i = (y * TILE + x) * 4;
          lum[(ty * TILE + y) * size + tx * TILE + x] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        }
      }
    }
  }
  await Promise.all(Array.from({ length: 12 }, worker));
  return lum;
}

function pearson(a: Float32Array, b: Uint8Array, idx: number[]): number {
  let n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (const i of idx) {
    const x = a[i], y = b[i];
    n++; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
  }
  const cov = sab - (sa * sb) / n;
  const va = saa - (sa * sa) / n, vb = sbb - (sb * sb) / n;
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
}

async function main() {
  const out = document.getElementById('out')!;
  out.textContent = 'loading…';
  const atlas = await loadAtlas('/tiles');
  const lumFull = await loadLuminance(atlas.size);
  const N = 2048; // mask resolution: every second atlas pixel
  const lum = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = 2 * j * atlas.size + 2 * i;
      lum[j * N + i] = (lumFull[a] + lumFull[a + 1] + lumFull[a + atlas.size] + lumFull[a + atlas.size + 1]) / 4;
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = N;
  const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true })!;
  const program = new ShadowProgram(gl, atlas);
  // Shifted by half an atlas pixel so every canvas pixel centre lands on the centre of atlas pixel (2i, 2j), never on a pixel corner.
  const matrix = new Float32Array([2 / atlas.size, 0, 0, 0, 0, -2 / atlas.size, 0, 0, 0, 0, 1, 0, -1 + 1 / atlas.size, 1 - 1 / atlas.size, 0, 1]);
  const raw = new Uint8Array(N * N * 4);
  const mask = new Uint8Array(N * N);

  // Pixels without LiDAR coverage (value 0) must not take part in the comparison.
  const valid = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) valid[j * N + i] = atlas.levels[0][2 * j * atlas.size + 2 * i] > 0 ? 1 : 0;

  const BLOCKS = 4;
  const bs = N / BLOCKS;
  const blockIdx: number[][] = [];
  for (let by = 0; by < BLOCKS; by++) {
    for (let bx = 0; bx < BLOCKS; bx++) {
      const idx: number[] = [];
      for (let y = by * bs; y < (by + 1) * bs; y += 2) for (let x = bx * bs; x < (bx + 1) * bs; x += 2) if (valid[y * N + x]) idx.push(y * N + x);
      blockIdx.push(idx);
    }
  }
  const allIdx: number[] = [];
  for (let i = 0; i < N * N; i += 3) if (valid[i]) allIdx.push(i);

  const [lng, lat] = atlas.centerLngLat;
  const params = new URLSearchParams(location.search);
  const day = params.get('day') ?? '2024-09-20';
  const algo = Number(params.get('algo') ?? 1);
  const from = Number(params.get('from') ?? 6 * 60), to = Number(params.get('to') ?? 16 * 60), stepMin = Number(params.get('step') ?? 10);
  const [Y, M, D] = day.split('-').map(Number);
  const rows: { utc: string; az: number; alt: number; r: number[]; rAll: number; frac: number }[] = [];
  for (let minutes = from; minutes <= to; minutes += stepMin) {
    const date = new Date(Date.UTC(Y, M - 1, D, Math.floor(minutes / 60), minutes % 60));
    const sun = sunAt(date, lat, lng);
    gl.viewport(0, 0, N, N);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    program.draw(matrix, { ...DEFAULT_PARAMS, azimuthDeg: sun.azimuth, altitudeDeg: sun.altitude, algo });
    gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) mask[j * N + i] = raw[((N - 1 - j) * N + i) * 4 + 3] > 64 ? 1 : 0;
    rows.push({
      utc: `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`,
      az: sun.azimuth, alt: sun.altitude,
      r: blockIdx.map((idx) => pearson(lum, mask, idx)),
      rAll: pearson(lum, mask, allIdx),
      frac: allIdx.reduce((a, i) => a + mask[i], 0) / allIdx.length,
    });
  }
  // --- Ground-level agreement at the best time -------------------------------------------------------------
  // "Ground" = pixels within 1 m of the local minimum of the surface model (a 61-px window), i.e. streets,
  // squares and courtyards, which is where terraces are.
  const R = 30;
  const dsm2 = new Uint16Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) dsm2[j * N + i] = atlas.levels[0][2 * j * atlas.size + 2 * i];
  const rowMin = new Uint16Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    let m = 65535;
    for (let k = Math.max(0, i - R); k <= Math.min(N - 1, i + R); k++) m = Math.min(m, dsm2[j * N + k]);
    rowMin[j * N + i] = m;
  }
  const ground = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    let m = 65535;
    for (let k = Math.max(0, j - R); k <= Math.min(N - 1, j + R); k++) m = Math.min(m, rowMin[k * N + i]);
    ground[j * N + i] = valid[j * N + i] && dsm2[j * N + i] <= m + 4 ? 1 : 0;
  }
  const groundIdx: number[] = [];
  for (let i = 0; i < N * N; i++) if (ground[i]) groundIdx.push(i);
  // Otsu threshold on the photo's brightness over ground pixels: dark = in shadow in the photo.
  const hist = new Float64Array(256);
  for (const i of groundIdx) hist[Math.min(255, Math.round(lum[i]))]++;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];
  let wB = 0, sumB = 0, bestVar = -1, otsu = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = groundIdx.length - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const v = wB * wF * (sumB / wB - (sumAll - sumB) / wF) ** 2;
    if (v > bestVar) { bestVar = v; otsu = t; }
  }
  const agreeAt = (utcMinutes: number) => {
    const date = new Date(Date.UTC(Y, M - 1, D, Math.floor(utcMinutes / 60), utcMinutes % 60));
    const sun = sunAt(date, lat, lng);
    gl.viewport(0, 0, N, N);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    program.draw(matrix, { ...DEFAULT_PARAMS, azimuthDeg: sun.azimuth, altitudeDeg: sun.altitude, algo });
    gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const idx of groundIdx) {
      const j = Math.floor(idx / N), i = idx % N;
      const pred = raw[((N - 1 - j) * N + i) * 4 + 3] > 64;
      const obs = lum[idx] < otsu;
      if (pred && obs) tp++; else if (pred) fp++; else if (obs) fn++; else tn++;
    }
    const n = tp + fp + fn + tn;
    return { utc: `${Math.floor(utcMinutes / 60)}:${String(utcMinutes % 60).padStart(2, '0')}`, accuracy: +((tp + tn) / n).toFixed(3), shadowIoU: +(tp / (tp + fp + fn)).toFixed(3), predictedShadow: +((tp + fp) / n).toFixed(3), observedShadow: +((tp + fn) / n).toFixed(3) };
  };
  const best = (sel: (r: (typeof rows)[0]) => number) => rows.reduce((b, r) => (sel(r) < sel(b) ? r : b));
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const bestRowMinutes = () => { const [h, m] = best((r) => r.rAll).utc.split(':').map(Number); return h * 60 + m; };
  const summary = {
    day, algo,
    global: { bestUtc: best((r) => r.rAll).utc, rBest: +best((r) => r.rAll).rAll.toFixed(3), rMedian: +median(rows.map((r) => r.rAll)).toFixed(3) },
    blocks: blockIdx.map((_, b) => {
      const bb = best((r) => r.r[b]);
      return { block: b, bestUtc: bb.utc, az: +bb.az.toFixed(1), alt: +bb.alt.toFixed(1), rBest: +bb.r[b].toFixed(3), rMedian: +median(rows.map((r) => r.r[b])).toFixed(3) };
    }),
    ground: { pixels: groundIdx.length, otsuThreshold: otsu, atBest: agreeAt(Number(bestRowMinutes())), minus1h: agreeAt(Number(bestRowMinutes()) - 60), plus1h: agreeAt(Number(bestRowMinutes()) + 60), plus3h: agreeAt(Number(bestRowMinutes()) + 180), minus3h: agreeAt(Number(bestRowMinutes()) - 180) },
    curve: rows.map((r) => `${r.utc} az${r.az.toFixed(0)} alt${r.alt.toFixed(0)} r=${r.rAll.toFixed(3)} shadowFrac=${r.frac.toFixed(4)}`),
  };
  (window as unknown as { __val: unknown }).__val = summary;
  out.textContent = JSON.stringify(summary, null, 1);
}

main().catch((e) => {
  document.getElementById('out')!.textContent = 'Error: ' + (e as Error).message;
  console.error(e);
});
