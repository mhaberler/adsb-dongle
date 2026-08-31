import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { AircraftMessage } from "./protocol";

const DEFAULT_CENTER: L.LatLngTuple = [0, 0];
const DEFAULT_ZOOM = 3;
const FIRST_AIRCRAFT_ZOOM = 9;

// Inline SVG arrow, no external asset. Points north (track 0) by default;
// rotated in place via CSS transform per-marker.
const PLANE_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <path d="M12 1 L17 14 L12 11 L7 14 Z" fill="#e63946" stroke="#7a1f26" stroke-width="0.5"/>
</svg>`;

function planeIcon(track: number | undefined): L.DivIcon {
  const rotation = track ?? 0;
  return L.divIcon({
    className: "plane-icon",
    html: `<div style="transform: rotate(${rotation}deg);">${PLANE_SVG}</div>`,
    iconSize: [24, 24],
    iconAnchor: [12, 12],
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

  constructor(containerId: string) {
    this.map = L.map(containerId).setView(DEFAULT_CENTER, DEFAULT_ZOOM);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19,
    }).addTo(this.map);
  }

  upsert(ac: AircraftMessage): void {
    if (ac.lat === undefined || ac.lon === undefined) return;

    const latlng: L.LatLngTuple = [ac.lat, ac.lon];
    let marker = this.markers.get(ac.hex);
    if (marker) {
      marker.setLatLng(latlng);
      marker.setIcon(planeIcon(ac.track));
      marker.setPopupContent(popupHtml(ac));
    } else {
      marker = L.marker(latlng, { icon: planeIcon(ac.track) }).addTo(this.map);
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
