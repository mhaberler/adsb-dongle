import { describe, expect, test } from "bun:test";
import { gnssQuality, gnssValues } from "./gnss";
import { shapeOf } from "./aircraft-shapes";
import type { AircraftMessage } from "./protocol";

const ac = (extra: Partial<AircraftMessage>): AircraftMessage => ({
  hex: "3c6444",
  lat: 48.2,
  lon: 16.4,
  seen: 0,
  messages: 1,
  ...extra,
});

describe("gnssQuality", () => {
  test("ok, degraded and unusable by NIC", () => {
    expect(gnssQuality(ac({ nic: 8 }))).toBe("ok");
    expect(gnssQuality(ac({ nic: 6 }))).toBe("degraded");
    expect(gnssQuality(ac({ nic: 0 }))).toBe("unusable");
  });

  test("NACp counts from ADS-B version 1 only", () => {
    expect(gnssQuality(ac({ nic: 8, version: 2, nac_p: 7 }))).toBe("degraded");
    expect(gnssQuality(ac({ nic: 8, version: 2, nac_p: 0 }))).toBe("unusable");
    expect(gnssQuality(ac({ nic: 8, version: 0, nac_p: 7 }))).toBe("ok");
  });

  test("NACp alone (firmware without nic)", () => {
    expect(gnssQuality(ac({ version: 2, nac_p: 9 }))).toBe("ok");
    expect(gnssQuality(ac({ version: 2, nac_p: 6 }))).toBe("degraded");
  });

  test("unknown without position or without NIC/NACp", () => {
    expect(gnssQuality(ac({ lat: undefined, lon: undefined, nic: 8 }))).toBeNull();
    expect(gnssQuality(ac({}))).toBeNull();
  });

  test("raw values", () => {
    expect(gnssValues(ac({ nic: 8, version: 2, nac_p: 9 }))).toBe("NIC 8 · NACp 9");
    expect(gnssValues(ac({ nic: 5 }))).toBe("NIC 5");
  });
});

describe("shapeOf", () => {
  test("by emitter category", () => {
    expect(shapeOf("A1")).toBe("light");
    expect(shapeOf("A3")).toBe("jet");
    expect(shapeOf("A5")).toBe("heavy");
    expect(shapeOf("A7")).toBe("heli");
    expect(shapeOf("B1")).toBe("glider");
    expect(shapeOf("B2")).toBe("balloon");
    expect(shapeOf("B6")).toBe("drone");
    expect(shapeOf("C2")).toBe("ground");
  });

  test("arrow for no info, unknown and old numeric categories", () => {
    expect(shapeOf("A0")).toBe("arrow");
    expect(shapeOf("B3")).toBe("arrow");
    expect(shapeOf(3)).toBe("arrow");
    expect(shapeOf(undefined)).toBe("arrow");
  });
});
