import { describe, expect, test } from "bun:test";
import { decodeModeS, modeSChecksum } from "./modes";
import { AircraftStore, computeNic } from "./aircraft-store";

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(14);
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}

// DF17 frame for ICAO 3C6444 with the given 7-byte ME field and a valid CRC.
function df17(me: number[]): Uint8Array {
  const msg = new Uint8Array(14);
  msg.set([0x8d, 0x3c, 0x64, 0x44, ...me]);
  const crc = modeSChecksum(msg, 112);
  msg.set([(crc >> 16) & 0xff, (crc >> 8) & 0xff, crc & 0xff], 11);
  return msg;
}

// ME byte 1 of an identification message: type code (5 bits) + category (3).
const ident = (tc: number, ca: number) => [(tc << 3) | ca, 0x2c, 0xc3, 0x71, 0xc3, 0x2c, 0xe0];

describe("emitter category", () => {
  test("real identification frame (KLM1023, set A, no category info)", () => {
    const mm = decodeModeS(hexToBytes("8D4840D6202CC371C32CE0576098"))!;
    expect(mm.flight).toBe("KLM1023 ");
    expect(mm.metype).toBe(4);
    expect(mm.mesub).toBe(0);
    const store = new AircraftStore();
    const [ev] = store.processFrame(hexToBytes("8D4840D6202CC371C32CE0576098"));
    expect(ev.kind === "update" && ev.data.category).toBe("A0");
  });

  test.each([
    [4, 5, "A5"], // heavy
    [4, 7, "A7"], // rotorcraft
    [3, 1, "B1"], // glider
    [3, 2, "B2"], // lighter-than-air
    [2, 1, "C1"], // emergency vehicle
    [1, 0, "D0"],
  ])("type code %i, category %i -> %s", (tc, ca, expected) => {
    const store = new AircraftStore();
    const [ev] = store.processFrame(df17(ident(tc, ca)));
    expect(ev.kind === "update" && ev.data.category).toBe(expected);
  });
});

describe("NIC supplements", () => {
  test("NIC-B is ME bit 8 of an airborne position", () => {
    // 8D400A6658AB05...: ME byte 1 = 0x58 -> TC 11, bit 8 = 0
    expect(decodeModeS(hexToBytes("8D400A6658AB0540C701D9CA672E"))!.nicB).toBe(0);
    expect(decodeModeS(df17([0x59, 0xab, 0x05, 0x40, 0xc7, 0x01, 0xd9]))!.nicB).toBe(1);
  });

  test("NIC-A is ME bit 44 of operational status (version 2)", () => {
    // ME31 sub 0: version bits 41-43 = 2, NIC-A bit 44 = 1, NACp bits 45-48 = 10
    const me = [0xf8, 0x00, 0x00, 0x00, 0x00, 0x5a, 0x00];
    const mm = decodeModeS(df17(me))!;
    expect(mm.opstatusVersion).toBe(2);
    expect(mm.nicA).toBe(1);
    expect(mm.nacP).toBe(10);
  });
});

describe("computeNic", () => {
  test("type code alone", () => {
    expect([9, 10, 12, 13, 14, 15, 17, 18].map((tc) => computeNic(tc, 2, 0, 0))).toEqual([
      11, 10, 7, 6, 5, 4, 1, 0,
    ]);
  });

  test("TC 11 and 16 depend on the supplements per version", () => {
    expect(computeNic(11, 0, 1, 1)).toBe(8);
    expect(computeNic(11, 1, 1, 0)).toBe(9);
    expect(computeNic(11, 2, 1, 0)).toBe(8);
    expect(computeNic(11, 2, 1, 1)).toBe(9);
    expect(computeNic(16, 1, 1, 0)).toBe(3);
    expect(computeNic(16, 2, 0, 1)).toBe(2);
    expect(computeNic(16, 2, 1, 1)).toBe(3);
  });

  test("published with the position once an even/odd pair is solved", () => {
    const store = new AircraftStore();
    // TC 11 even/odd pair from "The 1090 MHz Riddle" (ICAO 40621D); the
    // odd frame is the newer one, so the book's lat_odd applies
    store.processFrame(hexToBytes("8D40621D58C382D690C8AC2863A7"));
    const [ev] = store.processFrame(hexToBytes("8D40621D58C386435CC412692AD6"));
    expect(ev.kind === "update" && ev.data.lat).toBeCloseTo(52.26578, 4);
    expect(ev.kind === "update" && ev.data.nic).toBe(8);
  });
});
