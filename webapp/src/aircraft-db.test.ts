import { describe, expect, test } from "bun:test";
import { chunkKey, parseLine, toInfo } from "./aircraft-db";
import { shapeOf } from "./aircraft-shapes";
import { matchesQuery } from "./aircraft-list";

describe("parseLine", () => {
  test("ICAO;reg;type;flags;model;year;owner", () => {
    expect(parseLine("3C6444;D-AIBD;A319;00;Airbus A319-112;2009;Lufthansa;")).toEqual([
      "3c6444",
      ["D-AIBD", "A319", "Airbus A319-112", 0],
    ]);
  });

  test("military flag is the first flags character", () => {
    expect(parseLine("3F4A1C;;EUFI;10;Eurofighter Typhoon;;;")![1][3]).toBe(1);
  });

  test("skips empty entries, Miscode placeholders and junk", () => {
    expect(parseLine("000011;;;00;;;;")).toBeNull();
    expect(parseLine("000011;;;10;;;Miscode - VARIOUS;")).toBeNull();
    expect(parseLine("")).toBeNull();
    expect(parseLine("XYZ;D-ABCD;A320;00;;;;")).toBeNull();
  });
});

describe("toInfo", () => {
  const types = { A319: { desc: "L2J", wtc: "M" } };

  test("adds type description and wake category", () => {
    expect(toInfo(["D-AIBD", "A319", "Airbus A319-112", 0], types)).toEqual({
      reg: "D-AIBD",
      type: "A319",
      model: "Airbus A319-112",
      kind: "L2J",
      wtc: "M",
    });
  });

  test("drops empty and '-' fields, keeps military", () => {
    expect(toInfo(["-", "", "", 1], types)).toEqual({ mil: true });
  });
});

test("chunkKey: first three hex digits, lower case", () => {
  expect(chunkKey("3C6444")).toBe("3c6");
});

describe("shapeOf with database info", () => {
  test("type description where the category says nothing", () => {
    expect(shapeOf("A0", { kind: "H2T" })).toBe("heli");
    expect(shapeOf(undefined, { kind: "L2J", wtc: "M" })).toBe("jet");
    expect(shapeOf(undefined, { kind: "L1P", wtc: "L" })).toBe("light");
    expect(shapeOf(undefined, { type: "GLID" })).toBe("glider");
    expect(shapeOf(undefined, { type: "BALL" })).toBe("balloon");
  });

  test("wake category H/J refines a generic jet category", () => {
    expect(shapeOf("A3", { kind: "L2J", wtc: "H" })).toBe("heavy");
  });

  test("specific categories win over the database", () => {
    expect(shapeOf("B2", { kind: "L2J", wtc: "M" })).toBe("balloon");
    expect(shapeOf("A7", { kind: "L2J", wtc: "M" })).toBe("heli");
  });
});

test("search finds registrations without dash", () => {
  expect(matchesQuery({ hex: "3c6444", seen: 0, messages: 1 }, "daibd", "D-AIBD")).toBe(true);
});
