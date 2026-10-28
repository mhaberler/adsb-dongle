import { describe, expect, test } from "bun:test";
import { destPoint, distanceKm } from "./geo";

describe("distanceKm", () => {
  test("one degree of latitude is ~111.2 km", () => {
    expect(distanceKm([47, 11], [48, 11])).toBeCloseTo(111.19, 1);
  });

  // 355.3 km on the sphere; the WGS84 ellipsoid gives ~356.6 km (0.4% more)
  test("Vienna (LOWW) to Munich (EDDM) is ~355 km", () => {
    expect(distanceKm([48.1103, 16.5697], [48.3538, 11.7861])).toBeCloseTo(355.3, 0);
  });

  test("zero for the same point", () => {
    expect(distanceKm([51.47, -0.46], [51.47, -0.46])).toBe(0);
  });
});

describe("destPoint", () => {
  test("due north moves only latitude", () => {
    const [lat, lon] = destPoint([47, 11], 0, 111.19);
    expect(lat).toBeCloseTo(48, 3);
    expect(lon).toBeCloseTo(11, 6);
  });

  test("round-trips with distanceKm in any direction", () => {
    for (const deg of [0, 45, 90, 135, 200, 315]) {
      const p = destPoint([48.2, 16.4], deg, 100);
      expect(distanceKm([48.2, 16.4], p)).toBeCloseTo(100, 6);
    }
  });

  test("wraps longitude across the antimeridian", () => {
    const [, lon] = destPoint([0, 179.9], 90, 50);
    expect(lon).toBeLessThan(-179);
  });
});
