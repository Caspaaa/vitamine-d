import { Map as MapLibreMap, NavigationControl, setWorkerUrl } from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { loadAtlas } from './atlas';
import { ShadowLayer } from './shadowLayer';
import { localDate, sunAt, todayString } from './sun';

// Vite's dependency pre-bundling moves maplibre-gl, so its worker must be pointed at explicitly.
setWorkerUrl(workerUrl);

const q = new URLSearchParams(location.search);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const ORTHO =
  'https://geoservices-grid.irisnet.be/geowebcache/service/wmts?layer=Ortho&style=&tilematrixset=EPSG:900913' +
  '&Service=WMTS&Request=GetTile&Version=1.0.0&Format=image/jpeg&TileMatrix=EPSG:900913:{z}&TileCol={x}&TileRow={y}';

async function main() {
  const status = $('status');
  status.textContent = 'Loading height tiles…';
  const atlas = await loadAtlas('/tiles', 16, q.get('decode') === 'canvas' ? 'canvas' : 'png');
  const [lng, lat] = atlas.centerLngLat;
  status.textContent =
    `atlas ${atlas.size}px @ ${atlas.metersPerPx.toFixed(3)} m/px · ` +
    `fetch ${atlas.loadMs.fetch.toFixed(0)} ms, decode ${atlas.loadMs.decode.toFixed(0)} ms, mips ${atlas.loadMs.mips.toFixed(0)} ms (per worker)`;

  const map = new MapLibreMap({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: [Number(q.get('lng') ?? 4.3525), Number(q.get('lat') ?? 50.8467)],
    zoom: Number(q.get('z') ?? 16),
    pitch: Number(q.get('pitch') ?? 0),
    maxZoom: 20,
    pixelRatio: q.get('pr') ? Number(q.get('pr')) : undefined,
    canvasContextAttributes: { antialias: false },
  });
  map.addControl(new NavigationControl({ visualizePitch: true }), 'top-right');
  const layer = new ShadowLayer(atlas);

  await new Promise<void>((resolve) => map.on('load', () => resolve()));
  map.addSource('ortho', { type: 'raster', tiles: [ORTHO], tileSize: 256, maxzoom: 21, attribution: 'Ortho © Paradigm / UrbIS (CC0)' });
  const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  map.addLayer({ id: 'ortho', type: 'raster', source: 'ortho', layout: { visibility: 'none' } }, firstSymbol);
  map.addLayer(layer, firstSymbol);
  // The shadow layer sits below the buildings. Liberty draws them 80% opaque, so the ground shadow would ghost
  // through roofs and walls; opaque buildings hide it correctly.
  map.setPaintProperty('building-3d', 'fill-extrusion-opacity', q.get('opaque') === '0' ? 0.8 : 1);

  const day = $<HTMLInputElement>('day');
  const time = $<HTMLInputElement>('time');
  const label = $('timeLabel');
  const sunInfo = $('sun');
  const perf = $('perf');

  if (q.get('t')) {
    const [d, t] = q.get('t')!.split('T');
    day.value = d;
    const [h, m] = t.split(':').map(Number);
    time.value = String(h * 60 + m);
  } else {
    day.value = todayString();
    const n = new Date();
    time.value = String(n.getHours() * 60 + n.getMinutes());
  }

  function apply() {
    const minutes = Number(time.value);
    const date = localDate(day.value, minutes);
    label.textContent = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    const sun = sunAt(date, lat, lng);
    sunInfo.textContent = `sun azimuth ${sun.azimuth.toFixed(1)}° · altitude ${sun.altitude.toFixed(1)}°`;
    layer.update({ azimuthDeg: sun.azimuth, altitudeDeg: sun.altitude });
  }
  day.addEventListener('input', apply);
  time.addEventListener('input', apply);
  $('now').addEventListener('click', () => {
    const n = new Date();
    day.value = todayString();
    time.value = String(n.getHours() * 60 + n.getMinutes());
    apply();
  });

  let playing = false;
  $('play').addEventListener('click', () => {
    playing = !playing;
    $('play').textContent = playing ? 'Pause' : 'Play';
    const tick = () => {
      if (!playing) return;
      time.value = String((Number(time.value) + 4) % 1440);
      apply();
      requestAnimationFrame(tick);
    };
    tick();
  });

  const bind = (id: string, key: 'lodScale' | 'bias' | 'alpha') => {
    const el = $<HTMLInputElement>(id);
    const out = $(id + 'Val');
    const set = () => {
      out.textContent = el.value;
      layer.update({ [key]: Number(el.value) });
    };
    el.addEventListener('input', set);
    set();
  };
  bind('lod', 'lodScale');
  bind('bias', 'bias');
  bind('alpha', 'alpha');

  $<HTMLInputElement>('smooth').addEventListener('change', (e) => layer.setOptions({ smooth: (e.target as HTMLInputElement).checked }));
  $<HTMLInputElement>('useMask').addEventListener('change', (e) => {
    layer.useMask = (e.target as HTMLInputElement).checked;
    layer.update({});
  });
  const edge = $<HTMLInputElement>('edge');
  const setEdge = () => {
    const c = Number(edge.value);
    $('edgeVal').textContent = c.toFixed(2);
    layer.setOptions({ edge: [c - 0.15, c + 0.15] });
  };
  edge.addEventListener('input', setEdge);
  setEdge();
  if (q.get('stress')) layer.stress = Math.max(1, Number(q.get('stress')));
  if (q.get('iter')) layer.update({ maxIter: Number(q.get('iter')) });
  if (q.get('mode')) layer.update({ mode: Number(q.get('mode')), alpha: Number(q.get('mode')) ? 1 : 0.5 });
  if (q.get('smooth') === '0') { $<HTMLInputElement>('smooth').checked = false; layer.setOptions({ smooth: false }); }
  if (q.get('mask') === '0') { $<HTMLInputElement>('useMask').checked = false; layer.useMask = false; }

  $<HTMLInputElement>('showShadows').addEventListener('change', (e) =>
    map.setLayoutProperty(layer.id, 'visibility', (e.target as HTMLInputElement).checked ? 'visible' : 'none'),
  );
  $<HTMLInputElement>('showOrtho').addEventListener('change', (e) =>
    map.setLayoutProperty('ortho', 'visibility', (e.target as HTMLInputElement).checked ? 'visible' : 'none'),
  );
  $<HTMLInputElement>('debugHeight').addEventListener('change', (e) =>
    layer.update({ mode: (e.target as HTMLInputElement).checked ? 1 : 0, alpha: (e.target as HTMLInputElement).checked ? 1 : 0.5 }),
  );

  // Frame-time / GPU-time readout.
  let last = performance.now();
  const frames: number[] = [];
  map.on('render', () => {
    const now = performance.now();
    frames.push(now - last);
    last = now;
    if (frames.length > 30) frames.shift();
  });
  setInterval(() => {
    const avg = frames.reduce((a, b) => a + b, 0) / Math.max(frames.length, 1);
    const gpu = layer.gpuMs;
    perf.textContent = `frame ${avg.toFixed(1)} ms · shadow GPU ${gpu === null ? 'n/a' : gpu.toFixed(2) + ' ms'} · ${map.getCanvas().width}×${map.getCanvas().height}px · ${layer.info}`;
  }, 500);

  async function benchmark(n = 300, benchDay = '2026-06-21') {
    const frameTimes: number[] = [];
    const gpuTimes: number[] = [];
    const startDay = day.value;
    day.value = benchDay;
    let prev = performance.now();
    for (let i = 0; i < n; i++) {
      time.value = String(Math.round(450 + (i / n) * 780)); // 07:30 → 20:30
      apply();
      await new Promise((r) => requestAnimationFrame(r));
      const now = performance.now();
      frameTimes.push(now - prev);
      prev = now;
      if (layer.gpuMs !== null) gpuTimes.push(layer.gpuMs);
    }
    day.value = startDay;
    apply();
    const sorted = [...frameTimes].sort((a, b) => a - b);
    const result = {
      frames: n,
      meanMs: frameTimes.reduce((a, b) => a + b, 0) / n,
      p95Ms: sorted[Math.floor(n * 0.95)],
      maxMs: sorted[n - 1],
      gpuMeanMs: gpuTimes.length ? gpuTimes.reduce((a, b) => a + b, 0) / gpuTimes.length : null,
      canvas: [map.getCanvas().width, map.getCanvas().height],
      zoom: map.getZoom(),
    };
    (window as unknown as { __bench: unknown }).__bench = result;
    const fps = 1000 / result.meanMs;
    $('benchResult').textContent =
      `BENCHMARK  mean ${result.meanMs.toFixed(1)} ms (${fps.toFixed(0)} fps) · p95 ${result.p95Ms.toFixed(1)} ms · worst ${result.maxMs.toFixed(0)} ms · shadow GPU ${result.gpuMeanMs?.toFixed(2) ?? 'n/a'} ms · canvas ${result.canvas[0]}×${result.canvas[1]}`;
    return result;
  }
  $('bench').addEventListener('click', () => {
    $('benchResult').textContent = 'running… (about 6 s, do not touch the screen)';
    benchmark();
  });
  (window as unknown as { benchmark: typeof benchmark; map: typeof map; layer: typeof layer }).benchmark = benchmark;
  (window as unknown as { map: typeof map }).map = map;
  (window as unknown as { layer: typeof layer }).layer = layer;

  apply();
  (window as unknown as { __ready: boolean }).__ready = true;
}

main().catch((e) => {
  $('status').textContent = 'Error: ' + (e as Error).message;
  console.error(e);
});
