'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import type { Map as MapLibreMap, Marker } from 'maplibre-gl';
import { ShadowLayer, TileSource, type ShadowStatus } from '@vitamine/shadow';
import { DATA_URL, MAP_STYLE_URL, MAX_BOUNDS } from '@/lib/config';
import type { ViewState } from '@/lib/urlState';

export interface MapHandle {
  flyTo(lng: number, lat: number, zoom?: number): void;
  setUserLocation(p: { lng: number; lat: number } | null): void;
  setPin(p: { lng: number; lat: number } | null): void;
}

export interface SunDirection {
  azimuthDeg: number;
  altitudeDeg: number;
}

interface Props {
  initialView: ViewState;
  sun: SunDirection;
  onViewChange: (v: ViewState) => void;
  onShadowStatus: (s: ShadowStatus) => void;
  onFatal: () => void;
  onReady: () => void;
  /** Accessible name of the map. */
  label: string;
  ref?: Ref<MapHandle>;
}

const ATTRIBUTION = ['Heights © <a href="https://datastore.brussels" target="_blank" rel="noopener">UrbIS / Paradigm</a> (CC0), 2021', 'Search © <a href="https://photon.komoot.io" target="_blank" rel="noopener">Photon</a>'];

function readView(map: MapLibreMap): ViewState {
  const c = map.getCenter();
  return { lng: c.lng, lat: c.lat, zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
}

function dot(className: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  return el;
}

export default function MapView({ initialView, sun, onViewChange, onShadowStatus, onFatal, onReady, label, ref }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const layerRef = useRef<ShadowLayer | null>(null);
  const markers = useRef<{ user: Marker | null; pin: Marker | null }>({ user: null, pin: null });
  const mlRef = useRef<typeof import('maplibre-gl') | null>(null);
  const sunRef = useRef(sun);
  const callbacks = useRef({ onViewChange, onShadowStatus, onFatal, onReady });
  callbacks.current = { onViewChange, onShadowStatus, onFatal, onReady };

  useImperativeHandle(ref, () => ({
    flyTo(lng, lat, zoom = 17) {
      const map = mapRef.current;
      if (map) map.flyTo({ center: [lng, lat], zoom: Math.max(zoom, map.getZoom()), essential: true });
    },
    setUserLocation(p) {
      const ml = mlRef.current;
      const map = mapRef.current;
      markers.current.user?.remove();
      markers.current.user = null;
      if (!p || !ml || !map) return;
      markers.current.user = new ml.Marker({ element: dot('h-4 w-4 rounded-full border-[3px] border-white bg-blue-600 shadow-[0_0_0_6px_rgba(37,99,235,0.25)]') }).setLngLat([p.lng, p.lat]).addTo(map);
    },
    setPin(p) {
      const ml = mlRef.current;
      const map = mapRef.current;
      markers.current.pin?.remove();
      markers.current.pin = null;
      if (!p || !ml || !map) return;
      markers.current.pin = new ml.Marker({ color: '#e63946' }).setLngLat([p.lng, p.lat]).addTo(map);
    },
  }));

  useEffect(() => {
    sunRef.current = sun;
    layerRef.current?.update(sun);
  }, [sun]);

  useEffect(() => {
    let disposed = false;
    let map: MapLibreMap | null = null;
    (async () => {
      const ml = await import('maplibre-gl');
      if (disposed || !container.current) return;
      mlRef.current = ml;
      ml.setWorkerUrl('/vendor/maplibre-gl-worker.mjs');
      map = new ml.Map({
        container: container.current,
        style: MAP_STYLE_URL,
        center: [initialView.lng, initialView.lat],
        zoom: initialView.zoom,
        pitch: initialView.pitch,
        bearing: initialView.bearing,
        minZoom: 10,
        maxZoom: 20,
        maxPitch: 70,
        maxBounds: MAX_BOUNDS,
        attributionControl: false,
        canvasContextAttributes: { antialias: false },
      });
      mapRef.current = map;
      map.addControl(new ml.AttributionControl({ compact: true, customAttribution: ATTRIBUTION }), 'bottom-left');
      // The basemap style references a few sprites its sprite sheet lacks; a transparent pixel keeps the console clean.
      const created = map;
      created.on('styleimagemissing', (e) => {
        if (!created.hasImage(e.id)) created.addImage(e.id, { width: 1, height: 1, data: new Uint8Array(4) });
      });
      // Start collapsed behind the (i) button: the credits stay one tap away without covering the map.
      map.once('load', () => container.current?.querySelector('.maplibregl-ctrl-attrib')?.removeAttribute('open'));
      map.addControl(new ml.NavigationControl({ showZoom: false, visualizePitch: true }), 'top-right');
      map.on('moveend', () => callbacks.current.onViewChange(readView(map!)));
      map.on('error', (e) => {
        // A style that never loads is fatal; a single missing tile is not.
        if (!map!.isStyleLoaded() && !map!.loaded() && (e.error as { status?: number })?.status === undefined) callbacks.current.onFatal();
      });
      map.on('load', async () => {
        callbacks.current.onReady();
        try {
          const source = await TileSource.open(DATA_URL);
          if (disposed) return;
          const layer = new ShadowLayer({ source, onStatus: (s) => callbacks.current.onShadowStatus(s) });
          layer.update(sunRef.current);
          // Below the labels, and the 3D buildings drawn opaque: Liberty's default 80 % would let the ground shadow ghost through roofs (spike S1).
          const firstSymbol = map!.getStyle().layers.find((l) => l.type === 'symbol')?.id;
          map!.addLayer(layer, firstSymbol);
          if (map!.getLayer('building-3d')) map!.setPaintProperty('building-3d', 'fill-extrusion-opacity', 1);
          layerRef.current = layer;
          (window as unknown as { __vitamine?: unknown }).__vitamine = { map, layer };
        } catch (e) {
          console.error('shadow layer unavailable', e);
          callbacks.current.onShadowStatus({ state: 'error', resident: 0, pending: 0 });
        }
      });
    })().catch(() => callbacks.current.onFatal());
    return () => {
      disposed = true;
      markers.current.user?.remove();
      markers.current.pin?.remove();
      layerRef.current = null;
      map?.remove();
      mapRef.current = null;
    };
    // The map is created once; later changes arrive through props, refs and the handle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // MapLibre gives its container `position: relative`, so the sizing lives on a wrapper.
  return (
    <div className="absolute inset-0">
      <div ref={container} className="h-full w-full" role="application" aria-label={label} />
    </div>
  );
}
