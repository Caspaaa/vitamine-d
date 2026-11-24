import { loadAtlas } from './atlas';
import { DEFAULT_PARAMS, ShadowProgram } from './shadowProgram';

// Compares, at the same points and sun positions, three answers to "is this pixel in shadow?":
//   gpu     the real renderer (ray-traced mask, read back from the GPU)
//   exact   a CPU ray test with a small constant step (exported by spikes/s2-horizon)
//   horizon the precomputed 144-bin horizon profile (exported by spikes/s2-horizon)
// This is a measurement harness: it reads pixels back, so run it in Chrome/Chromium (Brave would add noise).
interface Data {
  points: [number, number][];
  suns: { az: number; alt: number; label: string }[];
  horizonLit: string[];
  exactLit: string[];
}

async function main() {
  const out = document.getElementById('out')!;
  out.textContent = 'loading…';
  const q = new URLSearchParams(location.search);
  const data: Data = await (await fetch(`/s2/${q.get('file') ?? 'agreement.json'}`)).json();
  // ?bias=0 switches off the renderer's near-field noise tolerance (default 2 = 0.5 m fading over 6 m).
  const bias = Number(q.get('bias') ?? DEFAULT_PARAMS.bias);
  // ?range=1e9 makes the tolerance constant along the whole ray: an observer height instead of a noise filter.
  const biasRangeM = Number(q.get('range') ?? DEFAULT_PARAMS.biasRangeM);
  const atlas = await loadAtlas('/tiles');
  const SIZE = atlas.size;

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true })!;
  const program = new ShadowProgram(gl, atlas);
  // Atlas pixel (i, j) -> canvas pixel (i, j); rows are flipped by readPixels.
  const matrix = new Float32Array([2 / SIZE, 0, 0, 0, 0, -2 / SIZE, 0, 0, 0, 0, 1, 0, -1, 1, 0, 1]);
  const raw = new Uint8Array(SIZE * SIZE * 4);

  const n = data.points.length;
  const rows: { label: string; alt: number; gpuLitPct: number; gpuVsExact: number; gpuVsHorizon: number; exactVsHorizon: number }[] = [];
  const tot = { gpuExact: 0, gpuHor: 0, exactHor: 0, all: 0, gpuLitHorShade: 0, gpuShadeHorLit: 0 };
  for (let s = 0; s < data.suns.length; s++) {
    const sun = data.suns[s];
    gl.viewport(0, 0, SIZE, SIZE);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    program.draw(matrix, { ...DEFAULT_PARAMS, azimuthDeg: sun.az, altitudeDeg: sun.alt, algo: 1, maskOnly: 1, bias, biasRangeM });
    gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    let ge = 0, gh = 0, eh = 0, gpuLit = 0;
    for (let i = 0; i < n; i++) {
      const [x, y] = data.points[i];
      const ix = Math.floor(x), iy = Math.floor(y);
      const gpu = raw[((SIZE - 1 - iy) * SIZE + ix) * 4] > 127 ? 0 : 1; // mask 1 = shadow
      const exact = data.exactLit[s][i] === '1' ? 1 : 0;
      const hor = data.horizonLit[s][i] === '1' ? 1 : 0;
      gpuLit += gpu;
      if (gpu !== exact) ge++;
      if (gpu !== hor) {
        gh++;
        if (gpu && !hor) tot.gpuLitHorShade++; else tot.gpuShadeHorLit++;
      }
      if (exact !== hor) eh++;
    }
    tot.gpuExact += ge; tot.gpuHor += gh; tot.exactHor += eh; tot.all += n;
    rows.push({ label: sun.label, alt: sun.alt, gpuLitPct: (gpuLit / n) * 100, gpuVsExact: (ge / n) * 100, gpuVsHorizon: (gh / n) * 100, exactVsHorizon: (eh / n) * 100 });
  }
  const result = {
    points: n, suns: data.suns.length, tests: tot.all,
    gpuVsExactPct: (tot.gpuExact / tot.all) * 100,
    gpuVsHorizonPct: (tot.gpuHor / tot.all) * 100,
    exactVsHorizonPct: (tot.exactHor / tot.all) * 100,
    gpuLitHorizonShadePct: (tot.gpuLitHorShade / tot.all) * 100,
    gpuShadeHorizonLitPct: (tot.gpuShadeHorLit / tot.all) * 100,
    rows,
  };
  (window as unknown as { __agreement: unknown }).__agreement = result;
  out.textContent = JSON.stringify(result, null, 1);
}

main().catch((e) => {
  document.getElementById('out')!.textContent = 'Error: ' + (e as Error).message;
  console.error(e);
});
