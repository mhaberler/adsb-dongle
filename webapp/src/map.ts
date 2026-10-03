import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { AircraftMessage } from "./protocol";
import { getAdsbColor } from "./altitude-color";
import {
  MAX_TILES_PER_LAYER,
  cacheSummary,
  clearAll,
  makeLayers,
  planPreload,
  runPreload,
} from "./tile-cache";
import type { CachedLayer } from "./tile-cache";

const LAYERS_KEY = "adsb.layers";

const DEFAULT_CENTER: L.LatLngTuple = [0, 0];
const DEFAULT_ZOOM = 3;
const FIRST_AIRCRAFT_ZOOM = 9;

// Inline SVG arrow, no external asset. Points north (track 0) by default;
// rotated in place via CSS transform per-marker. Fill is the
// ADSBexchange altitude colour ramp (see altitude-color.ts).
function planeSvg(color: string): string {
  return `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <path d="M12 1 L17 14 L12 11 L7 14 Z" fill="${color}" stroke="#333" stroke-width="0.5"/>
</svg>`;
}

function planeIcon(ac: AircraftMessage): L.DivIcon {
  const rotation = ac.track ?? 0;
  const color = getAdsbColor(ac.alt_baro ?? ac.alt_geom);
  return L.divIcon({
    className: "plane-icon",
    html: `<div style="transform: rotate(${rotation}deg);">${planeSvg(color)}</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

function myLocationIcon(): L.DivIcon {
  return L.divIcon({
    className: "my-location-icon",
    html: `<div class="my-location-dot"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

function popupHtml(ac: AircraftMessage): string {
  const rows: [string, string | number | undefined][] = [
    ["flight", ac.flight?.trim()],
    ["alt_baro", ac.alt_baro],
    ["alt_geom", ac.alt_geom],
    ["gs", ac.gs],
    ["track", ac.track],
    ["squawk", ac.squawk],
    ["emergency", ac.emergency],
    ["seen", `${ac.seen.toFixed(1)}s`],
  ];
  const lines = rows
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `<div><b>${k}</b>: ${v}</div>`)
    .join("");
  return `<div class="ac-popup"><div><b>hex</b>: ${ac.hex}</div>${lines}</div>`;
}

export class AircraftMap {
  private map: L.Map;
  private markers = new Map<string, L.Marker>();
  private hasFitFirstAircraft = false;
  private myLocationMarker: L.Marker | null = null;
  private hasFitMyLocation = false;
  private layers = makeLayers();

  constructor(containerId: string) {
    this.map = L.map(containerId).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
    this.setupLayers();
    this.setupCacheControls();
    void navigator.storage?.persist?.();
  }

  // Base/overlay switcher; selection survives reloads via localStorage.
  private setupLayers(): void {
    let selected: string[] = ["osm"];
    try {
      const saved = localStorage.getItem(LAYERS_KEY);
      if (saved) selected = JSON.parse(saved);
    } catch {
      // storage unavailable or corrupt: default layer
    }
    if (!this.layers.some((cl) => !cl.def.overlay && selected.includes(cl.def.id))) {
      selected.push("osm");
    }

    const bases: Record<string, L.Layer> = {};
    const overlays: Record<string, L.Layer> = {};
    for (const cl of this.layers) {
      (cl.def.overlay ? overlays : bases)[cl.def.name] = cl.layer;
      if (selected.includes(cl.def.id)) cl.layer.addTo(this.map);
    }
    L.control.layers(bases, overlays, { position: "topleft" }).addTo(this.map);

    this.map.on("baselayerchange overlayadd overlayremove", () => {
      try {
        const ids = this.activeLayers().map((cl) => cl.def.id);
        localStorage.setItem(LAYERS_KEY, JSON.stringify(ids));
      } catch {
        // ignore
      }
    });
  }

  private activeLayers(): CachedLayer[] {
    return this.layers.filter((cl) => this.map.hasLayer(cl.layer));
  }

  // Preload/clear buttons plus a one-line cache status, as Leaflet controls.
  private setupCacheControls(): void {
    const status = L.DomUtil.create("div", "tile-status");
    const statusControl = new L.Control({ position: "bottomleft" });
    statusControl.onAdd = () => status;
    statusControl.addTo(this.map);
    const showSummary = (suffix = "") =>
      cacheSummary()
        .then((s) => (status.textContent = s + suffix))
        .catch(() => (status.textContent = "cache unavailable"));
    void showSummary();

    let busy = false;
    const preload = async () => {
      if (busy) return;
      const plan = planPreload(this.map, this.activeLayers());
      const counts = plan.items
        .map((it) => `${it.cl.def.id} ${it.count}`)
        .join(" + ");
      if (plan.overCap) {
        alert(`Too many tiles (${counts}; max ${MAX_TILES_PER_LAYER} per layer). Zoom in.`);
        return;
      }
      if (!confirm(`Preload ${counts} tiles (~${Math.ceil(plan.estMb)} MB)?`)) return;
      busy = true;
      const failed = await runPreload(plan, (done, total) => {
        status.textContent = `tiles ${done}/${total}`;
      });
      busy = false;
      void showSummary(failed ? ` · ${failed} failed` : "");
    };
    const clear = async () => {
      if (busy || !confirm("Delete all cached map tiles?")) return;
      await clearAll();
      void showSummary();
    };

    const bar = L.DomUtil.create("div", "leaflet-bar");
    const button = (text: string, title: string, onClick: () => void) => {
      const a = L.DomUtil.create("a", "", bar);
      a.href = "#";
      a.textContent = text;
      a.title = title;
      a.setAttribute("role", "button");
      L.DomEvent.on(a, "click", (e) => {
        L.DomEvent.preventDefault(e);
        onClick();
      });
    };
    button("⤓", "Preload visible area for offline use", () => void preload());
    button("✕", "Delete cached map tiles", () => void clear());
    L.DomEvent.disableClickPropagation(bar);
    const barControl = new L.Control({ position: "topleft" });
    barControl.onAdd = () => bar;
    barControl.addTo(this.map);
  }

  setMyLocation(lat: number, lon: number): void {
    const latlng: L.LatLngTuple = [lat, lon];
    if (this.myLocationMarker) {
      this.myLocationMarker.setLatLng(latlng);
    } else {
      this.myLocationMarker = L.marker(latlng, {
        icon: myLocationIcon(),
        zIndexOffset: 1000,
      }).addTo(this.map);
    }

    // Only auto-fit to "my location" if no aircraft has claimed the initial
    // view yet (aircraft take priority once any appear).
    if (!this.hasFitMyLocation && !this.hasFitFirstAircraft) {
      this.hasFitMyLocation = true;
      this.map.setView(latlng, FIRST_AIRCRAFT_ZOOM);
    }
  }

  clearMyLocation(): void {
    this.myLocationMarker?.remove();
    this.myLocationMarker = null;
    this.hasFitMyLocation = false;
  }

  upsert(ac: AircraftMessage): void {
    if (ac.lat === undefined || ac.lon === undefined) return;

    const latlng: L.LatLngTuple = [ac.lat, ac.lon];
    let marker = this.markers.get(ac.hex);
    if (marker) {
      marker.setLatLng(latlng);
      marker.setIcon(planeIcon(ac));
      marker.setPopupContent(popupHtml(ac));
    } else {
      marker = L.marker(latlng, { icon: planeIcon(ac) }).addTo(this.map);
      marker.bindPopup(popupHtml(ac));
      this.markers.set(ac.hex, marker);
    }

    if (!this.hasFitFirstAircraft) {
      this.hasFitFirstAircraft = true;
      this.map.setView(latlng, FIRST_AIRCRAFT_ZOOM);
    }
  }

  remove(hex: string): void {
    const marker = this.markers.get(hex);
    if (!marker) return;
    marker.remove();
    this.markers.delete(hex);
  }
}
