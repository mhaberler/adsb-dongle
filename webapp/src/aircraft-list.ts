import type { AircraftMessage } from "./protocol";
import { altOf, callsign, climbArrow, esc, flightLevel } from "./format";
import { gnssQuality, gnssValues } from "./gnss";
import { icaoCountry } from "./icao-country";
import { CATEGORY_NAMES } from "./aircraft-shapes";

// Aircraft list: a collapsible panel over the map (top right on wide
// screens, a bottom sheet on narrow ones - see style.css). Sorting, search
// and the altitude filter are pure functions below; the panel only renders
// what AircraftMap hands it once a second.

const LIST_KEY = "adsb.list";

export interface ListRow {
  ac: AircraftMessage;
  distKm?: number; // from my location, if known and the aircraft has a position
}

export type SortKey = "flight" | "alt" | "gs" | "dist" | "gnss";

// Altitude filter in flight levels (100 ft); null = no limit.
export interface AltBand {
  min: number | null;
  max: number | null;
}

interface ListSettings {
  open: boolean;
  sort: SortKey;
  dir: 1 | -1;
  band: AltBand;
}

const DEFAULTS: ListSettings = { open: false, sort: "dist", dir: 1, band: { min: null, max: null } };

const GNSS_RANK = { unusable: 0, degraded: 1, ok: 2 } as const;

const SORT_VALUE: Record<SortKey, (r: ListRow) => string | number | undefined> = {
  flight: (r) => callsign(r.ac),
  alt: (r) => altOf(r.ac),
  gs: (r) => r.ac.gs,
  dist: (r) => r.distKm,
  gnss: (r) => {
    const q = gnssQuality(r.ac);
    return q ? GNSS_RANK[q] : undefined;
  },
};

// Sorts in place by key and direction; rows without a value stay at the
// bottom either way, ties go to the most recently heard aircraft.
export function sortRows(rows: ListRow[], key: SortKey, dir: 1 | -1): ListRow[] {
  const value = SORT_VALUE[key];
  return rows.sort((x, y) => {
    const u = value(x);
    const v = value(y);
    if (u === undefined || v === undefined) {
      return Number(u === undefined) - Number(v === undefined) || x.ac.seen - y.ac.seen;
    }
    const c = typeof u === "string" ? u.localeCompare(String(v)) : u - (v as number);
    return c * dir || x.ac.seen - y.ac.seen;
  });
}

// Search by callsign or ICAO address, ignoring case, spaces and dashes.
const normId = (s: string | undefined) => (s ?? "").replace(/[\s-]/g, "").toUpperCase();
export function matchesQuery(ac: AircraftMessage, query: string): boolean {
  const q = normId(query);
  return !q || [callsign(ac), ac.hex].some((s) => normId(s).includes(q));
}

export const bandActive = (band: AltBand) => band.min !== null || band.max !== null;

// Aircraft without altitude are outside any active band.
export function inBand(altFt: number | undefined, band: AltBand): boolean {
  if (!bandActive(band)) return true;
  if (altFt === undefined) return false;
  const fl = altFt / 100;
  return (band.min === null || fl >= band.min) && (band.max === null || fl <= band.max);
}

const isEmergency = (ac: AircraftMessage) =>
  (ac.emergency !== undefined && ac.emergency !== "none") ||
  ["7500", "7600", "7700"].includes(ac.squawk ?? "");

const COLUMNS: [SortKey, string][] = [
  ["flight", "Flight"],
  ["alt", "Alt"],
  ["gs", "Speed"],
  ["dist", "Dist"],
  ["gnss", "GNSS"],
];

export class AircraftList {
  private settings = loadSettings();
  private query = "";
  private root: HTMLDivElement;
  private head: HTMLButtonElement;
  private body: HTMLTableSectionElement;
  private empty: HTMLDivElement;
  private onSelect: (hex: string) => void;
  private onBandChange: () => void;

  constructor(parent: HTMLElement, onSelect: (hex: string) => void, onBandChange: () => void) {
    this.onSelect = onSelect;
    this.onBandChange = onBandChange;
    this.root = document.createElement("div");
    this.root.className = "ac-list";
    this.root.innerHTML = `
      <button type="button" class="ac-list-head" aria-expanded="false"></button>
      <div class="ac-list-panel">
        <div class="ac-list-filters">
          <input type="search" class="ac-list-search" placeholder="Search callsign / ICAO" />
          <label title="Show only aircraft in this altitude band, on the list and the map">
            FL <input type="number" class="ac-list-fl" data-end="min" min="0" max="600" step="10" />
            – <input type="number" class="ac-list-fl" data-end="max" min="0" max="600" step="10" />
          </label>
        </div>
        <div class="ac-list-scroll">
          <table>
            <thead><tr>${COLUMNS.map(([k, t]) => `<th data-sort="${k}">${t}</th>`).join("")}</tr></thead>
            <tbody></tbody>
          </table>
          <div class="ac-list-empty"></div>
        </div>
      </div>`;
    parent.append(this.root);
    this.head = this.root.querySelector(".ac-list-head")!;
    this.body = this.root.querySelector("tbody")!;
    this.empty = this.root.querySelector(".ac-list-empty")!;

    this.head.addEventListener("click", () => this.setOpen(!this.settings.open));
    this.setOpen(this.settings.open);

    this.root.querySelector<HTMLInputElement>(".ac-list-search")!.addEventListener("input", (e) => {
      this.query = (e.target as HTMLInputElement).value;
      this.refresh?.();
    });

    for (const input of this.root.querySelectorAll<HTMLInputElement>(".ac-list-fl")) {
      const end = input.dataset.end as keyof AltBand;
      const v = this.settings.band[end];
      input.value = v === null ? "" : String(v);
      input.addEventListener("change", () => {
        const n = parseInt(input.value, 10);
        this.settings.band[end] = Number.isFinite(n) ? n : null;
        this.save();
        this.onBandChange();
        this.refresh?.();
      });
    }

    this.root.querySelector("thead")!.addEventListener("click", (e) => {
      const key = (e.target as HTMLElement).closest<HTMLElement>("th")?.dataset.sort as SortKey;
      if (!key) return;
      if (this.settings.sort === key) this.settings.dir = this.settings.dir === 1 ? -1 : 1;
      else {
        this.settings.sort = key;
        this.settings.dir = 1;
      }
      this.save();
      this.refresh?.();
    });

    // Rows are rebuilt every second, so listen on the table body.
    this.body.addEventListener("click", (e) => {
      const hex = (e.target as HTMLElement).closest<HTMLElement>("tr")?.dataset.hex;
      if (!hex) return;
      this.onSelect(hex);
      // On a phone the sheet covers half the map: get it out of the way.
      if (window.matchMedia("(max-width: 600px)").matches) this.setOpen(false);
    });
  }

  // Set by the owner: re-render now (after sorting/searching) instead of on
  // the next tick.
  refresh?: () => void;

  get band(): AltBand {
    return this.settings.band;
  }

  render(rows: ListRow[], follow: string | null): void {
    const banded = rows.filter((r) => inBand(altOf(r.ac), this.settings.band));
    const outside = rows.length - banded.length;
    const shown = sortRows(
      banded.filter((r) => matchesQuery(r.ac, this.query)),
      this.settings.sort,
      this.settings.dir,
    );

    this.head.textContent =
      `✈ ${banded.length} aircraft` + (outside ? ` · ${outside} outside FL filter` : "");

    for (const th of this.root.querySelectorAll<HTMLElement>("th[data-sort]")) {
      const on = th.dataset.sort === this.settings.sort;
      th.classList.toggle("sorted", on);
      th.classList.toggle("desc", on && this.settings.dir < 0);
    }

    this.body.innerHTML = shown.map((r) => rowHtml(r, follow)).join("");
    this.empty.hidden = shown.length > 0;
    this.empty.textContent = banded.length
      ? "No aircraft matches the search."
      : outside
        ? "No aircraft in the FL filter band."
        : "No aircraft received yet.";
  }

  private setOpen(open: boolean): void {
    this.settings.open = open;
    this.root.classList.toggle("open", open);
    this.head.setAttribute("aria-expanded", String(open));
    this.save();
  }

  private save(): void {
    try {
      localStorage.setItem(LIST_KEY, JSON.stringify(this.settings));
    } catch {
      // ignore
    }
  }
}

function rowHtml({ ac, distKm }: ListRow, follow: string | null): string {
  const country = icaoCountry(ac.hex);
  const flag = country?.flag
    ? `<span class="flag" title="${esc(country.name)}">${country.flag}</span>`
    : "";
  const category = typeof ac.category === "string" ? CATEGORY_NAMES[ac.category] : undefined;
  const sub = [ac.hex.toUpperCase(), category, ac.squawk && `sq ${ac.squawk}`]
    .filter(Boolean)
    .join(" · ");

  const alt = altOf(ac);
  const altCell =
    alt === undefined ? "–" : `${flightLevel(alt)} ${climbArrow(ac)}<div class="sub">${alt} ft</div>`;

  const speedCell =
    ac.gs === undefined
      ? "–"
      : `${ac.gs} kt` +
        (ac.track === undefined
          ? ""
          : `<div class="sub"><span class="track-arrow" style="transform: rotate(${ac.track}deg)">↑</span> ${ac.track}°</div>`);

  const distCell =
    distKm !== undefined
      ? `${distKm.toFixed(distKm < 10 ? 1 : 0)} km`
      : ac.lat === undefined
        ? '<span class="sub">no pos</span>'
        : "–";

  const q = gnssQuality(ac);
  const gnssCell = q ? `<span class="gnss-dot gnss-${q}" title="${q} (${gnssValues(ac)})"></span>` : "–";

  const cls = [isEmergency(ac) && "emergency", follow === ac.hex && "following"]
    .filter(Boolean)
    .join(" ");
  const title = follow === ac.hex ? "Click to stop following" : "Click to follow on the map";
  return (
    `<tr data-hex="${esc(ac.hex)}" class="${cls}" title="${title}">` +
    `<td>${flag}<b>${esc(callsign(ac))}</b><div class="sub">${esc(sub)}</div></td>` +
    `<td>${altCell}</td><td>${speedCell}</td><td>${distCell}</td><td>${gnssCell}</td></tr>`
  );
}

function loadSettings(): ListSettings {
  try {
    const saved = localStorage.getItem(LIST_KEY);
    if (saved) {
      const s = JSON.parse(saved);
      return { ...DEFAULTS, ...s, band: { ...DEFAULTS.band, ...s.band } };
    }
  } catch {
    // storage unavailable or corrupt: defaults
  }
  return { ...DEFAULTS, band: { ...DEFAULTS.band } };
}
