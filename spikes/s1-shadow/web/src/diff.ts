import { loadAtlas } from './atlas';
import { DEFAULT_PARAMS, ShadowProgram } from './shadowProgram';

// Debug view: where does the shadow mask change between two sun azimuths?
async function main() {
  const q = new URLSearchParams(location.search);
  const azA = Number(q.get('a') ?? 179.5), azB = Number(q.get('b') ?? 180.5), alt = Number(q.get('alt') ?? 40);
  const algo = Number(q.get('algo') ?? 1);
  const iterA = Number(q.get('iterA') ?? 192), iterB = Number(q.get('iterB') ?? 192);
  const atlas = await loadAtlas('/tiles');
  const N = 2048;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = N;
  const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true })!;
  const program = new ShadowProgram(gl, atlas);
  // Shifted by half an atlas pixel so every canvas pixel centre lands on the centre of atlas pixel (2i, 2j), never on a pixel corner.
  const matrix = new Float32Array([2 / atlas.size, 0, 0, 0, 0, -2 / atlas.size, 0, 0, 0, 0, 1, 0, -1 + 1 / atlas.size, 1 - 1 / atlas.size, 0, 1]);
  const raw = new Uint8Array(N * N * 4);
  const maskAt = (az: number, maxIter: number) => {
    gl.viewport(0, 0, N, N);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    program.draw(matrix, { ...DEFAULT_PARAMS, azimuthDeg: az, altitudeDeg: alt, algo, maxIter });
    gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    const m = new Uint8Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) m[j * N + i] = raw[((N - 1 - j) * N + i) * 4 + 3] > 64 ? 1 : 0;
    return m;
  };
  const A = maskAt(azA, iterA), B = maskAt(azB, iterB);
  const S = 1024;
  // Optional zoomed crop in mask pixels: crop=x0,y0,size
  const crop = (q.get('crop') ?? `0,0,${N}`).split(',').map(Number);
  const [cx0, cy0, csz] = crop;
  const out = document.createElement('canvas');
  out.width = out.height = S;
  const ctx = out.getContext('2d')!;
  const img = ctx.createImageData(S, S);
  let onlyA = 0, onlyB = 0, both = 0, nodata = 0;
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const mi = cx0 + Math.floor((i * csz) / S), mj = cy0 + Math.floor((j * csz) / S);
      const k = mj * N + mi;
      const a = A[k], b = B[k];
      const valid = atlas.levels[0][2 * mj * atlas.size + 2 * mi] > 0;
      let c: [number, number, number] = [235, 235, 235];
      if (!valid) { c = [255, 255, 160]; nodata++; }
      else if (a && b) { c = [60, 60, 60]; both++; }
      else if (a) { c = [0, 90, 255]; onlyA++; }
      else if (b) { c = [255, 40, 40]; onlyB++; }
      const o = (j * S + i) * 4;
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  document.body.style.margin = '0';
  document.body.appendChild(out);
  (window as unknown as { __diff: unknown }).__diff = { azA, azB, alt, onlyA, onlyB, both, nodata, total: S * S };
}
main();
