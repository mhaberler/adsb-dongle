import type { AircraftMessage } from "./protocol";

// Small text helpers shared by the map (labels, popup) and the list.

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ESC[c]);

export const altOf = (ac: AircraftMessage) => ac.alt_baro ?? ac.alt_geom;
export const callsign = (ac: AircraftMessage) => ac.flight?.trim() || ac.hex.toUpperCase();
export const flightLevel = (ft: number) =>
  `FL${String(Math.max(0, Math.round(ft / 100))).padStart(3, "0")}`;

// |baro_rate| below this (ft/min) counts as level flight
const CLIMB_MIN_FPM = 128;

export function climbArrow(ac: AircraftMessage): string {
  const r = ac.baro_rate;
  if (r === undefined || Math.abs(r) < CLIMB_MIN_FPM) return "";
  return r > 0 ? "↑" : "↓";
}
