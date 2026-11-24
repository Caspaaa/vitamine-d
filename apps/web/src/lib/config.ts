/** Where the published height tiles live: `<url>/dsm/index.json`, `<url>/dsm/17/<x>/<y>.png`. */
export const DATA_URL = process.env.NEXT_PUBLIC_DATA_URL ?? '/data/urbis-2021';

export const MAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

/** Centre of Brussels (Grand-Place area), [lng, lat]. */
export const BRUSSELS_CENTER: [number, number] = [4.3525, 50.8467];
/** The Brussels-Capital Region (with a little room). Height data exists only inside it. */
export const BRUSSELS_BOUNDS: [[number, number], [number, number]] = [[4.24, 50.76], [4.5, 50.92]];
/** How far the map can be panned: the region plus a generous margin. */
export const MAX_BOUNDS: [[number, number], [number, number]] = [[4.1, 50.65], [4.65, 51.02]];

export const DEFAULT_ZOOM = 16;
export const SEARCH_URL = 'https://photon.komoot.io/api/';
