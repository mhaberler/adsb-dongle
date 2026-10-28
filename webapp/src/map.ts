import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { AircraftMessage } from "./protocol";
import { getAdsbColor } from "./altitude-color";
import { destPoint, distanceKm } from "./geo";
import { icaoCountry } from "./icao-country";
import flagFontUrl from "./vendor/twemoji-flags/TwemojiCountryFlags.woff2?url";
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
const VIEW_KEY = "adsb.view";

const DEFAULT_CENTER: L.LatLngTuple = [0, 0];
const DEFAULT_ZOOM = 3;
const FIRST_AIRCRAFT_ZOOM = 9;

const TRAIL_MAX_POINTS = 300;
// Trail segments are coloured per altitude band rather than per point, so a
// level flight is one polyline and climbs/descents show as colour steps.
const TRAIL_BAND_FT = 1000;
// Dead reckoning: between position reports the marker moves on along track
// at ground speed, for at most this long (the guess gets poor after that).
const DR_MAX_S = 30;
const DR_TICK_MS = 250;
const RINGS_KM = [50, 100, 200];
const LEAD_CHOICES_MIN = [0, 1, 2, 5, 10];
// |baro_rate| below this (ft/min) counts as level flight in the label
const CLIMB_MIN_FPM = 128;
const KT_TO_KMH = 1.852;

interface ViewSettings {
  trails: boolean;
  labels: boolean;
  rings: boolean;
  leadMin: number; // 0 = no lead vector
}
const VIEW_DEFAULTS: ViewSettings = { trails: true, labels: true, rings: true, leadMin: 0 };

// Flag emoji render as plain letter pairs on Windows; this font carries just
// the regional-indicator range (Twemoji art, CC-BY 4.0 — see
// vendor/twemoji-flags/LICENSE.md), so no other text is affected.
try {
  document.fonts.add(
    new FontFace("Twemoji Country Flags", `url(${flagFontUrl}) format("woff2")`, {
      unicodeRange: "U+1F1E6-1F1FF",
    }),
  );
} catch {
  // FontFace unsupported: system emoji font (or letter pairs) instead
}

// Inline SVG arrow, no external asset. Points north (track 0) by default;
// rotated in place via CSS transform per-marker. Fill is the
// ADSBexchange altitude colour ramp (see altitude-color.ts), set per update.
const PLANE_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <path d="M12 1 L17 14 L12 11 L7 14 Z" stroke="#333" stroke-width="0.5"/>
</svg>`;

// One icon per marker for its whole life: rotation, colour and label are
// patched into its DOM element on each update instead of rebuilding it.
function planeIcon(): L.DivIcon {
  return L.divIcon({
    className: "plane-icon",
    html: `<div class="plane-rot">${PLANE_SVG}</div><span class="plane-label"></span>`,
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

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ESC[c]);

const altOf = (ac: AircraftMessage) => ac.alt_baro ?? ac.alt_geom;
const callsign = (ac: AircraftMessage) => ac.flight?.trim() || ac.hex.toUpperCase();
const flightLevel = (ft: number) => `FL${String(Math.max(0, Math.round(ft / 100))).padStart(3, "0")}`;

function climbArrow(ac: AircraftMessage): string {
  const r = ac.baro_rate;
  if (r === undefined || Math.abs(r) < CLIMB_MIN_FPM) return "";
  return r > 0 ? "↑" : "↓";
}

function labelHtml(ac: AircraftMessage): string {
  const alt = altOf(ac);
  const fl = alt === undefined ? "" : `<br>${flightLevel(alt)} ${climbArrow(ac)}`;
  return `<b>${esc(callsign(ac))}</b>${fl}`;
}

function popupHtml(ac: AircraftMessage, home: L.LatLngTuple | null): string {
  const country = icaoCountry(ac.hex);
  const alt = altOf(ac);
  const dist =
    home && ac.lat !== undefined && ac.lon !== undefined
      ? distanceKm(home, [ac.lat, ac.lon])
      : undefined;
  const rows: [string, string | number | undefined][] = [
    ["flight", ac.flight?.trim()],
    ["alt_baro", ac.alt_baro],
    ["alt_geom", ac.alt_geom],
    ["FL", alt === undefined ? undefined : `${flightLevel(alt)} ${climbArrow(ac)}`],
    ["gs", ac.gs === undefined ? undefined : `${ac.gs} kt (${Math.round(ac.gs * KT_TO_KMH)} km/h)`],
    ["track", ac.track],
    ["baro_rate", ac.baro_rate],
    ["squawk", ac.squawk],
    ["emergency", ac.emergency],
    ["distance", dist === undefined ? undefined : `${dist.toFixed(dist < 10 ? 1 : 0)} km`],
    ["seen", `${ac.seen.toFixed(1)}s`],
  ];
  const lines = rows
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `<div><b>${k}</b>: ${esc(String(v))}</div>`)
    .join("");
  const from = country
    ? `<div><span class="flag">${country.flag}</span>${esc(country.name)}</div>`
    : "";
  return `<div class="ac-popup"><div><b>hex</b>: ${esc(ac.hex)}</div>${from}${lines}</div>`;
}

const bandOf = (alt: number | undefined) =>
  alt === undefined ? null : Math.round(alt / TRAIL_BAND_FT);
const bandColor = (band: number | null) =>
  getAdsbColor(band === null ? undefined : band * TRAIL_BAND_FT);

interface TrailRun {
  line: L.Polyline;
  band: number | null;
}

interface Track {
  ac: AircraftMessage;
  rxMs: number; // performance.now() when ac arrived; ac.seen_pos is relative to it
  marker: L.Marker;
  label: string;
  fix?: L.LatLngTuple; // last reported position
  points: number;
  runs: TrailRun[];
  tail: L.Polyline; // last fix -> dead-reckoned position
  lead: L.Polyline;
}

export class AircraftMap {
  private map: L.Map;
  private tracks = new Map<string, Track>();
  private hasFitFirstAircraft = false;
  private myLocationMarker: L.Marker | null = null;
  private hasFitMyLocation = false;
  private home: L.LatLngTuple | null = null;
  private layers = makeLayers();
  private view = loadView();
  private trailLayer = L.layerGroup();
  private leadLayer = L.layerGroup();
  private ringLayer = L.layerGroup();

  constructor(containerId: string) {
    this.map = L.map(containerId).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
    const layersControl = this.setupLayers();
    this.setupCacheControls();
    this.setupViewControls(layersControl);
    this.trailLayer.addTo(this.map);
    this.leadLayer.addTo(this.map);
    this.applyView();
    void navigator.storage?.persist?.();
    window.setInterval(() => {
      if (!document.hidden) for (const t of this.tracks.values()) this.place(t);
    }, DR_TICK_MS);
  }

  // Base/overlay switcher; selection survives reloads via localStorage.
  private setupLayers(): L.Control.Layers {
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
    const control = L.control.layers(bases, overlays, { position: "topleft" }).addTo(this.map);

    this.map.on("baselayerchange overlayadd overlayremove", () => {
      try {
        const ids = this.activeLayers().map((cl) => cl.def.id);
        localStorage.setItem(LAYERS_KEY, JSON.stringify(ids));
      } catch {
        // ignore
      }
    });
    return control;
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

  // Display options appended to the layer switcher's panel, so they need no
  // extra space on the map; persisted in localStorage like the layers.
  private setupViewControls(layersControl: L.Control.Layers): void {
    const list = layersControl.getContainer()?.querySelector<HTMLElement>(".leaflet-control-layers-list");
    if (!list) return;
    L.DomUtil.create("div", "leaflet-control-layers-separator", list);
    const box = L.DomUtil.create("div", "view-options", list);

    const check = (key: "trails" | "labels" | "rings", text: string) => {
      const label = L.DomUtil.create("label", "", box);
      const input = L.DomUtil.create("input", "leaflet-control-layers-selector", label);
      input.type = "checkbox";
      input.checked = this.view[key];
      label.append(` ${text}`);
      L.DomEvent.on(input, "change", () => {
        this.view[key] = input.checked;
        this.saveView();
      });
    };
    check("trails", "Trails");
    check("labels", "Labels");
    check("rings", `Range rings (${RINGS_KM.join("/")} km)`);

    const row = L.DomUtil.create("div", "lead-choice", box);
    row.append("Lead vector ");
    const buttons = LEAD_CHOICES_MIN.map((min) => {
      const b = L.DomUtil.create("button", "", row);
      b.type = "button";
      b.textContent = min ? String(min) : "off";
      b.title = min ? `Position in ${min} min at current track and speed` : "No lead vector";
      L.DomEvent.on(b, "click", () => {
        this.view.leadMin = min;
        this.saveView();
        mark();
      });
      return b;
    });
    row.append(" min");
    const mark = () =>
      buttons.forEach((b, i) =>
        b.classList.toggle("active", LEAD_CHOICES_MIN[i] === this.view.leadMin),
      );
    mark();
  }

  private saveView(): void {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(this.view));
    } catch {
      // ignore
    }
    this.applyView();
  }

  private applyView(): void {
    const show = (layer: L.Layer, on: boolean) =>
      on ? layer.addTo(this.map) : layer.remove();
    show(this.trailLayer, this.view.trails);
    show(this.ringLayer, this.view.rings);
    this.map.getContainer().classList.toggle("no-labels", !this.view.labels);
    for (const t of this.tracks.values()) this.place(t);
  }

  setMyLocation(lat: number, lon: number): void {
    const latlng: L.LatLngTuple = [lat, lon];
    this.home = latlng;
    if (this.myLocationMarker) {
      this.myLocationMarker.setLatLng(latlng);
    } else {
      this.myLocationMarker = L.marker(latlng, {
        icon: myLocationIcon(),
        zIndexOffset: 1000,
      }).addTo(this.map);
    }
    this.drawRings();

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
    this.home = null;
    this.drawRings();
  }

  // Range rings around my location, labelled at their north point.
  private drawRings(): void {
    this.ringLayer.clearLayers();
    if (!this.home) return;
    for (const km of RINGS_KM) {
      L.circle(this.home, {
        radius: km * 1000,
        color: "#333",
        weight: 1,
        opacity: 0.6,
        fill: false,
        dashArray: "5 5",
        interactive: false,
      }).addTo(this.ringLayer);
      L.marker(destPoint(this.home, 0, km), {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({ className: "ring-label", html: `${km} km`, iconSize: [60, 16] }),
      }).addTo(this.ringLayer);
    }
  }

  upsert(ac: AircraftMessage): void {
    if (ac.lat === undefined || ac.lon === undefined) return;

    const latlng: L.LatLngTuple = [ac.lat, ac.lon];
    let t = this.tracks.get(ac.hex);
    if (t) {
      t.ac = ac;
      t.rxMs = performance.now();
    } else {
      const track: Track = {
        ac,
        rxMs: performance.now(),
        marker: L.marker(latlng, { icon: planeIcon() }).addTo(this.map),
        label: "",
        points: 0,
        runs: [],
        tail: L.polyline([], { weight: 2, opacity: 0.8, interactive: false }).addTo(
          this.trailLayer,
        ),
        lead: L.polyline([], { weight: 1.5, dashArray: "5 4", interactive: false }).addTo(
          this.leadLayer,
        ),
      };
      track.marker.bindPopup(() => popupHtml(track.ac, this.home));
      this.tracks.set(ac.hex, track);
      t = track;
    }

    if (!t.fix || t.fix[0] !== latlng[0] || t.fix[1] !== latlng[1]) {
      this.extendTrail(t, latlng, altOf(ac));
      t.fix = latlng;
    }
    this.styleMarker(t);
    this.place(t);
    if (t.marker.isPopupOpen()) t.marker.getPopup()?.update();

    if (!this.hasFitFirstAircraft) {
      this.hasFitFirstAircraft = true;
      this.map.setView(latlng, FIRST_AIRCRAFT_ZOOM);
    }
  }

  remove(hex: string): void {
    const t = this.tracks.get(hex);
    if (!t) return;
    t.marker.remove();
    for (const run of t.runs) run.line.remove();
    t.tail.remove();
    t.lead.remove();
    this.tracks.delete(hex);
  }

  // Appends to the run of the point's altitude band, or starts a new run at
  // the previous fix; drops points from the front beyond TRAIL_MAX_POINTS.
  private extendTrail(t: Track, latlng: L.LatLngTuple, alt: number | undefined): void {
    if (t.fix) {
      const band = bandOf(alt);
      const last = t.runs[t.runs.length - 1];
      if (last && last.band === band) {
        last.line.addLatLng(latlng);
      } else {
        const line = L.polyline([t.fix, latlng], {
          color: bandColor(band),
          weight: 2,
          opacity: 0.8,
          interactive: false,
        }).addTo(this.trailLayer);
        t.runs.push({ line, band });
      }
    }
    if (++t.points <= TRAIL_MAX_POINTS) return;
    t.points--;
    const first = t.runs[0];
    if (!first) return;
    const ll = first.line.getLatLngs() as L.LatLng[];
    ll.shift();
    if (ll.length < 2) {
      first.line.remove();
      t.runs.shift();
    } else {
      first.line.setLatLngs(ll);
    }
  }

  private styleMarker(t: Track): void {
    const el = t.marker.getElement();
    if (!el) return;
    const color = getAdsbColor(altOf(t.ac));
    el.querySelector<HTMLElement>(".plane-rot")!.style.transform = `rotate(${t.ac.track ?? 0}deg)`;
    el.querySelector("path")!.setAttribute("fill", color);
    const label = labelHtml(t.ac);
    if (label !== t.label) {
      el.querySelector(".plane-label")!.innerHTML = t.label = label;
    }
    t.tail.setStyle({ color });
    t.lead.setStyle({ color });
  }

  // Marker, trail tail and lead vector at the dead-reckoned position.
  private place(t: Track): void {
    const ac = t.ac;
    if (!t.fix) return;
    const moving = ac.gs !== undefined && ac.track !== undefined && ac.seen_pos !== undefined;
    let pos = t.fix;
    if (moving) {
      const age = Math.min(DR_MAX_S, ac.seen_pos! + (performance.now() - t.rxMs) / 1000);
      pos = destPoint(t.fix, ac.track!, (ac.gs! * KT_TO_KMH * age) / 3600);
    }
    t.marker.setLatLng(pos);
    t.tail.setLatLngs(pos === t.fix ? [] : [t.fix, pos]);

    if (moving && this.view.leadMin > 0) {
      const km = (ac.gs! * KT_TO_KMH * this.view.leadMin) / 60;
      const end = destPoint(pos, ac.track!, km);
      t.lead.setLatLngs([
        [pos, end],
        [destPoint(end, ac.track! + 150, km * 0.12), end, destPoint(end, ac.track! - 150, km * 0.12)],
      ]);
    } else {
      t.lead.setLatLngs([]);
    }
  }
}

function loadView(): ViewSettings {
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved) return { ...VIEW_DEFAULTS, ...JSON.parse(saved) };
  } catch {
    // storage unavailable or corrupt: defaults
  }
  return { ...VIEW_DEFAULTS };
}
