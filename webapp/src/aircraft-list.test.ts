import { describe, expect, test } from "bun:test";
import { inBand, matchesQuery, sortRows, type ListRow } from "./aircraft-list";
import type { AircraftMessage } from "./protocol";

const ac = (hex: string, extra: Partial<AircraftMessage> = {}): AircraftMessage => ({
  hex,
  seen: 0,
  messages: 1,
  ...extra,
});
const hexes = (rows: ListRow[]) => rows.map((r) => r.ac.hex);

describe("sortRows", () => {
  const rows = (): ListRow[] => [
    { ac: ac("aaaaaa", { flight: "SWR88   ", alt_baro: 37000 }), distKm: 80 },
    { ac: ac("bbbbbb", { flight: "AUA123  ", alt_baro: 24000 }), distKm: 12 },
    { ac: ac("cccccc", { seen: 5 }) }, // no callsign, altitude or distance
    { ac: ac("dddddd", { flight: "DLH4AB  ", alt_baro: 3000 }), distKm: 30 },
  ];

  test("by distance, nearest first; missing values at the bottom", () => {
    expect(hexes(sortRows(rows(), "dist", 1))).toEqual(["bbbbbb", "dddddd", "aaaaaa", "cccccc"]);
  });

  test("descending keeps missing values at the bottom", () => {
    expect(hexes(sortRows(rows(), "alt", -1))).toEqual(["aaaaaa", "bbbbbb", "dddddd", "cccccc"]);
  });

  test("by callsign, falling back to the ICAO address", () => {
    expect(hexes(sortRows(rows(), "flight", 1))).toEqual(["bbbbbb", "cccccc", "dddddd", "aaaaaa"]);
  });
});

describe("matchesQuery", () => {
  const a = ac("3c6444", { flight: "DLH4AB  " });

  test("callsign or ICAO address, case-insensitive", () => {
    expect(matchesQuery(a, "dlh")).toBe(true);
    expect(matchesQuery(a, "3C64")).toBe(true);
    expect(matchesQuery(a, "AUA")).toBe(false);
  });

  test("ignores spaces and dashes; empty query matches all", () => {
    expect(matchesQuery(a, "dlh 4-ab")).toBe(true);
    expect(matchesQuery(a, "  ")).toBe(true);
  });
});

describe("inBand", () => {
  test("no band: everything, even without altitude", () => {
    expect(inBand(undefined, { min: null, max: null })).toBe(true);
  });

  test("bounds in flight levels, inclusive", () => {
    const band = { min: 100, max: 250 };
    expect(inBand(10000, band)).toBe(true);
    expect(inBand(25000, band)).toBe(true);
    expect(inBand(9900, band)).toBe(false);
    expect(inBand(37000, band)).toBe(false);
    expect(inBand(undefined, band)).toBe(false);
  });

  test("open-ended bands", () => {
    expect(inBand(500, { min: null, max: 50 })).toBe(true);
    expect(inBand(41000, { min: 300, max: null })).toBe(true);
  });
});
