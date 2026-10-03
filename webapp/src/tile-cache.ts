import L from "leaflet";
import {
  getStorageLength,
  hasTile,
  saveTile,
  tileLayerOffline,
  truncate,
} from "leaflet.offline";
import type { TileInfo, TileLayerOffline } from "leaflet.offline";

// Offline tile cache: leaflet.offline stores tile blobs in IndexedDB and
// its TileLayerOffline serves from there when a tile is present, network
// otherwise. On top of that this module adds (a) passive caching of every
// tile viewed online and (b) a viewport preload across all visible layers.

export interface LayerDef {
  id: string;
  name: string;
  url: string;
  attribution: string;
  // Highest zoom fetched/stored; Leaflet upscales it beyond (maxNativeZoom).
  nativeMax: number;
  minZoom: number;
  estKb: number; // average tile size, for the preload size estimate only
  overlay: boolean;
}

export const LAYER_DEFS: LayerDef[] = [
  {
    id: "osm",
    name: "OpenStreetMap",
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "&copy; OpenStreetMap contributors",
    nativeMax: 12,
    minZoom: 0,
    estKb: 15,
    overlay: false,
  },
  {
    id: "topo",
    name: "OpenTopoMap",
    url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
    attribution:
      "&copy; OpenStreetMap contributors, SRTM | &copy; OpenTopoMap (CC-BY-SA)",
    nativeMax: 12,
    minZoom: 0,
    estKb: 47,
    overlay: false,
  },
  {
    id: "ofm",
    name: "openflightmaps",
    url: "https://nwy-tiles-api.prod.newaydata.com/tiles/{z}/{x}/{y}.png?path=latest/aero/latest",
    attribution: "&copy; open flightmaps association",
    nativeMax: 11,
    minZoom: 4,
    estKb: 50,
    overlay: true,
  },
];

export const MAX_TILES_PER_LAYER = 5000;
const PARALLEL = 4;
const TILE_SIZE = 256;
const AERO_DATE_KEY = "adsb.aeroPreloadedAt";

export interface CachedLayer {
  def: LayerDef;
  layer: TileLayerOffline;
}

async function fetchTile(url: string, reload: boolean): Promise<Blob> {
  const response = await fetch(url, { cache: reload ? "reload" : "default" });
  if (!response.ok) throw new Error(`tile ${response.status}`);
  return response.blob();
}

// A tile whose src is still an http(s) URL came from the network (cached
// ones are served as blob: URLs), so store it. The refetch is normally
// answered from the browser's HTTP cache.
function storeViewedTile(layer: TileLayerOffline, e: L.TileEvent): void {
  const url = e.tile.src;
  if (!url.startsWith("http")) return;
  const { x, y, z } = e.coords;
  fetchTile(url, false)
    .then((blob) =>
      saveTile(
        {
          key: layer._getStorageKey({ x, y, z }),
          url,
          x,
          y,
          z,
          urlTemplate: layer._url,
          createdAt: Date.now(),
        },
        blob,
      ),
    )
    .catch(() => {});
}

export function makeLayers(): CachedLayer[] {
  return LAYER_DEFS.map((def) => {
    const layer = tileLayerOffline(def.url, {
      attribution: def.attribution,
      maxZoom: 19,
      maxNativeZoom: def.nativeMax,
      minZoom: def.minZoom,
      // Keep the overlay above whichever base layer is switched in later.
      zIndex: def.overlay ? 2 : 1,
    });
    layer.on("tileload", (e) => storeViewedTile(layer, e as L.TileEvent));
    return { def, layer };
  });
}

export interface PreloadItem {
  cl: CachedLayer;
  count: number;
  tiles: TileInfo[]; // empty when count exceeds MAX_TILES_PER_LAYER
}

export interface PreloadPlan {
  items: PreloadItem[];
  estMb: number;
  overCap: boolean;
}

// Tiles for the current viewport, from the current zoom down to each
// layer's nativeMax. Counts first so a zoomed-out view can't allocate
// millions of TileInfo objects before the cap is checked.
export function planPreload(map: L.Map, active: CachedLayer[]): PreloadPlan {
  const bounds = map.getBounds();
  const zoom = Math.round(map.getZoom());
  const items = active.map((cl): PreloadItem => {
    const { nativeMax, minZoom } = cl.def;
    const areas: [number, L.Bounds][] = [];
    let count = 0;
    for (let z = Math.max(Math.min(zoom, nativeMax), minZoom); z <= nativeMax; z++) {
      const area = L.bounds(
        map.project(bounds.getNorthWest(), z),
        map.project(bounds.getSouthEast(), z),
      );
      const min = area.min!.divideBy(TILE_SIZE).floor();
      const max = area.max!.divideBy(TILE_SIZE).floor();
      count += (max.x - min.x + 1) * (max.y - min.y + 1);
      areas.push([z, area]);
    }
    const tiles =
      count > MAX_TILES_PER_LAYER
        ? []
        : areas.flatMap(([z, area]) => cl.layer.getTileUrls(area, z));
    return { cl, count, tiles };
  });
  return {
    items,
    estMb: items.reduce((mb, it) => mb + (it.count * it.cl.def.estKb) / 1024, 0),
    overCap: items.some((it) => it.count > MAX_TILES_PER_LAYER),
  };
}

// Base tiles already stored are skipped; overlay (aero) tiles are always
// refetched since that data goes stale. Returns the number of failures.
export async function runPreload(
  plan: PreloadPlan,
  onProgress: (done: number, total: number) => void,
): Promise<number> {
  const queue = plan.items.flatMap((it) =>
    it.tiles.map((tile) => ({ tile, refetch: it.cl.def.overlay })),
  );
  let next = 0;
  let done = 0;
  let failed = 0;
  const worker = async () => {
    while (next < queue.length) {
      const { tile, refetch } = queue[next++];
      try {
        if (refetch || !(await hasTile(tile.key))) {
          await saveTile(tile, await fetchTile(tile.url, refetch));
        }
      } catch {
        failed++;
      }
      onProgress(++done, queue.length);
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  if (failed === 0 && plan.items.some((it) => it.cl.def.overlay)) {
    try {
      localStorage.setItem(AERO_DATE_KEY, new Date().toISOString().slice(0, 10));
    } catch {
      // storage unavailable: no aero date shown
    }
  }
  return failed;
}

export async function clearAll(): Promise<void> {
  await truncate();
  try {
    localStorage.removeItem(AERO_DATE_KEY);
  } catch {
    // ignore
  }
}

export async function cacheSummary(): Promise<string> {
  const n = await getStorageLength();
  let aero: string | null = null;
  try {
    aero = localStorage.getItem(AERO_DATE_KEY);
  } catch {
    // ignore
  }
  return `cache ${n} tiles` + (aero ? ` · aero ${aero}` : "");
}
