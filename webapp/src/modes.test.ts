import { describe, expect, test } from "bun:test";
import { decodeId13Field, decodeModeS, modeAToModeC, modeSChecksum } from "./modes";
import { AircraftStore } from "./aircraft-store";
import { decodeCPRairborne } from "./cpr";

// Known-good DF17 example frames from the GNS5892 command-interface doc
// V1.0 ("ADS-B data reception example"). Expected field values below were
// cross-checked against lib/libmodes's original C decode
// (mode_s_decode()) compiled and run directly on these same frames.
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(14);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

describe("decodeModeS", () => {
  test("decodes a DF17 frame with valid CRC and ICAO", () => {
    const mm = decodeModeS(hexToBytes("8D4B1621994420C18804887668F9"));
    expect(mm).not.toBeNull();
    expect(mm!.msgtype).toBe(17);
    expect(mm!.icao).toBe(0x4b1621);
    // metype 19 (velocity) in this frame -> exercise velocity/heading fields.
    expect(mm!.metype).toBe(19);
    expect(mm!.velocity).toBeGreaterThanOrEqual(0);
  });

  test("decodes a second DF17 frame with valid CRC and ICAO", () => {
    const mm = decodeModeS(hexToBytes("8D400A6658AB0540C701D9CA672E"));
    expect(mm).not.toBeNull();
    expect(mm!.msgtype).toBe(17);
    expect(mm!.icao).toBe(0x400a66);
    // metype 11 (airborne position) in this frame.
    expect(mm!.metype).toBe(11);
    expect(mm!.rawLatitude).toBeDefined();
    expect(mm!.rawLongitude).toBeDefined();
  });

  test("decodes a DF17 airborne position (ME9-18) frame and rejects bad CRC", () => {
    const mm = decodeModeS(hexToBytes("8D4CA27A608145305B0B09EAD8B5"));
    expect(mm).not.toBeNull();
    expect(mm!.icao).toBe(0x4ca27a);
    expect(mm!.metype).toBeGreaterThanOrEqual(9);
    expect(mm!.metype).toBeLessThanOrEqual(18);
    expect(mm!.rawLatitude).toBeDefined();
    expect(mm!.rawLongitude).toBeDefined();

    // Flip a data bit -> CRC must fail.
    const corrupted = hexToBytes("8D4CA27A608145305B0B09EAD8B5");
    corrupted[5] ^= 0x01;
    expect(decodeModeS(corrupted)).toBeNull();
  });

  test("rejects DF11 (all-call) as out of scope (DF17/18 only)", () => {
    const mm = decodeModeS(hexToBytes("5D3C5961BAAB6C00000000000000"));
    expect(mm).toBeNull();
  });

  test("rejects a short (56-bit, zero-padded) frame", () => {
    // Non-DF17/18 short frames from the doc example, zero-padded to 14
    // bytes by the module - the msgtype filter should reject these.
    const mm = decodeModeS(hexToBytes("02E1991058EF3100000000000000"));
    expect(mm).toBeNull();
  });
});

describe("decodeCPRairborne", () => {
  test("solves a plausible position from a synthetic even/odd pair", () => {
    // Values within valid 17-bit CPR range; primarily exercises that the
    // solver runs and returns lat/lon within Earth bounds, not a specific
    // known fix (the doc's example frames aren't a matched even/odd pair).
    const evenLat = 74158;
    const evenLon = 50194;
    const oddLat = 74110;
    const oddLon = 50194;

    const result = decodeCPRairborne(evenLat, evenLon, oddLat, oddLon, false);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.lat).toBeGreaterThanOrEqual(-90);
      expect(result.lat).toBeLessThanOrEqual(90);
      expect(result.lon).toBeGreaterThanOrEqual(-180);
      expect(result.lon).toBeLessThanOrEqual(180);
    }
  });
});

// --- Field decoding fixes (Gillham altitude, ME19 scaling, squawk) ---

// DF17 frame for ICAO A36F68 with a valid CRC; `fields` sets ME bits
// (1-based, readsb numbering) as [firstBit, lastBit, value].
function df17Fields(fields: [number, number, number][]): Uint8Array {
  const msg = new Uint8Array(14);
  msg.set([0x8d, 0xa3, 0x6f, 0x68]);
  for (const [first, last, value] of fields) {
    for (let b = first; b <= last; b++) {
      if ((value >> (last - b)) & 1) {
        const i = b - 1;
        msg[4 + (i >> 3)] |= 1 << (7 - (i & 7));
      }
    }
  }
  const crc = modeSChecksum(msg, 112);
  msg.set([(crc >> 16) & 0xff, (crc >> 8) & 0xff, crc & 0xff], 11);
  return msg;
}

const gray = (n: number) => n ^ (n >> 1);

// Independent Gillham encoder, written from the code's definition (as in
// pyModeS' gray2alt, inverted) rather than from the decoder: 500 ft steps
// Gray-coded over D2 D4 A1 A2 A4 B1 B2 B4, 100 ft steps over C1 C2 C4 with
// 5 coded as 7 and reversed in odd 500 ft steps. Returns the 13-bit field
// in transmission order C1 A1 C2 A2 C4 A4 M B1 D1 B2 D2 B4 D4.
function gillhamId13(altFt: number): number {
  const n = altFt / 100 + 13;
  const fh = Math.floor((n - 1) / 5);
  let oh = n - fh * 5; // 1..5
  if (fh & 1) oh = 6 - oh;
  const g100 = gray(oh === 5 ? 7 : oh);
  const g500 = gray(fh);
  const bit = (v: number, i: number) => (v >> i) & 1;
  const [c1, c2, c4] = [bit(g100, 2), bit(g100, 1), bit(g100, 0)];
  const [d2, d4, a1, a2, a4, b1, b2, b4] = [7, 6, 5, 4, 3, 2, 1, 0].map((i) => bit(g500, i));
  const order = [c1, a1, c2, a2, c4, a4, 0, b1, 0, b2, d2, b4, d4];
  return order.reduce((acc, b) => (acc << 1) | b, 0);
}

// 13-bit (with M) -> 12-bit AC field (M removed), Q (bit 4) stays 0.
const ac12FromId13 = (id13: number) => ((id13 >> 1) & 0xfc0) | (id13 & 0x3f);

describe("altitude", () => {
  test("Q=1 (25 ft): textbook frame decodes to 38000 ft", () => {
    // "The 1090 MHz Riddle", airborne position example.
    expect(decodeModeS(hexToBytes("8D40621D58C382D690C8AC2863A7"))!.altitude).toBe(38000);
  });

  test("Q=0 (Gillham, 100 ft) round-trips over the whole range", () => {
    for (let alt = -1200; alt <= 126700; alt += 100) {
      const mm = decodeModeS(df17Fields([[1, 5, 11], [9, 20, ac12FromId13(gillhamId13(alt))]]))!;
      if (mm.altitude !== alt) throw new Error(`alt ${alt}: got ${mm.altitude}`);
    }
  });

  test("Q=0 4400 ft (the C172 that showed FL000)", () => {
    const mm = decodeModeS(df17Fields([[1, 5, 11], [9, 20, ac12FromId13(gillhamId13(4400))]]))!;
    expect(mm.altitude).toBe(4400);
  });

  test("empty AC field is no altitude, not 0 ft", () => {
    expect(decodeModeS(df17Fields([[1, 5, 11]]))!.altitude).toBeUndefined();
    const store = new AircraftStore();
    const [ev] = store.processFrame(df17Fields([[1, 5, 11]]));
    expect(ev.kind === "update" && ev.data.alt_baro).toBeUndefined();
  });

  test("modeAToModeC rejects illegal codes", () => {
    expect(modeAToModeC(0x0000)).toBeUndefined(); // C bits all zero
    expect(modeAToModeC(0x0011)).toBeUndefined(); // D1 set
    expect(modeAToModeC(0x0070)).toBeUndefined(); // C1 C2 C4 = 7 -> 6 (invalid)
  });
});

describe("airborne velocity", () => {
  test("textbook frame: 159 kt, 182.88°, -832 ft/min", () => {
    // "The 1090 MHz Riddle", ground speed example (GNSS vertical rate).
    const mm = decodeModeS(hexToBytes("8D485020994409940838175B284F"))!;
    expect(mm.velocity!).toBeCloseTo(159.2, 1);
    expect(mm.heading!).toBeCloseTo(182.88, 2);
    expect(mm.vertRate).toBe(-832);
    expect(mm.vertRateBaro).toBe(false);
    expect(mm.geoMinusBaro).toBe(550);
  });

  // ME19 sub 1: ew dir 14, ew 15-24, ns dir 25, ns 26-35, vr source 36,
  // vr sign 37, vr 38-46, delta sign 49, delta 50-56.
  const vel = (sub: number, extra: [number, number, number][]) =>
    decodeModeS(df17Fields([[1, 5, 19], [6, 8, sub], ...extra]))!;

  test("raw values are offset by one", () => {
    const mm = vel(1, [
      [15, 24, 1 + 3],
      [26, 35, 1 + 4],
      [36, 36, 1],
      [37, 37, 1],
      [38, 46, 1 + 2],
      [49, 49, 0],
      [50, 56, 1 + 1],
    ]);
    expect(mm.velocity).toBe(5);
    expect(mm.vertRate).toBe(-128);
    expect(mm.vertRateBaro).toBe(true);
    expect(mm.geoMinusBaro).toBe(25);
  });

  test("subtype 2 (supersonic) counts in 4 kt", () => {
    expect(vel(2, [[15, 24, 1 + 3], [26, 35, 1 + 4]]).velocity).toBe(20);
  });

  test("raw 0 means no information", () => {
    const mm = vel(1, [[15, 24, 0], [26, 35, 5]]);
    expect(mm.velocity).toBeUndefined();
    expect(mm.heading).toBeUndefined();
    expect(mm.vertRate).toBeUndefined();
    expect(mm.geoMinusBaro).toBeUndefined();
  });

  test("store: GNSS rate goes to geom_rate, baro rate to baro_rate", () => {
    const store = new AircraftStore();
    const [geo] = store.processFrame(df17Fields([[1, 5, 19], [6, 8, 1], [38, 46, 1 + 10]]));
    expect(geo.kind === "update" && geo.data.geom_rate).toBe(640);
    expect(geo.kind === "update" && geo.data.baro_rate).toBeUndefined();
    const [baro] = store.processFrame(df17Fields([[1, 5, 19], [6, 8, 1], [36, 36, 1], [38, 46, 1 + 10]]));
    expect(baro.kind === "update" && baro.data.baro_rate).toBe(640);
  });
});

describe("squawk (ME28 sub 1)", () => {
  // ID13 in transmission order C1 A1 C2 A2 C4 A4 X B1 D1 B2 D2 B4 D4.
  function id13(code: string): number {
    const [a, b, c, d] = [...code].map(Number);
    const bit = (v: number, i: number) => (v >> i) & 1;
    const order = [bit(c, 0), bit(a, 0), bit(c, 1), bit(a, 1), bit(c, 2), bit(a, 2), 0,
      bit(b, 0), bit(d, 0), bit(b, 1), bit(d, 1), bit(b, 2), bit(d, 2)];
    return order.reduce((acc, x) => (acc << 1) | x, 0);
  }

  test.each(["1200", "7700", "7000", "0415", "2000"])("%s", (code) => {
    const frame = df17Fields([[1, 5, 28], [6, 8, 1], [12, 24, id13(code)]]);
    expect(decodeModeS(frame)!.esSquawk).toBe(parseInt(code, 16));
    const [ev] = new AircraftStore().processFrame(frame);
    expect(ev.kind === "update" && ev.data.squawk).toBe(code);
  });

  test("decodeId13Field maps to hex Gillham", () => {
    expect(decodeId13Field(id13("7700"))).toBe(0x7700);
  });
});
