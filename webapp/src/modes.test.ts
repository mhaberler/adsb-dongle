import { describe, expect, test } from "bun:test";
import { decodeModeS } from "./modes";
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
