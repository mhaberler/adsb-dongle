import { describe, expect, test } from "bun:test";
import { ModeSDemod2400 } from "./modes-demod-2400";
import { parseRawFrame, parseRawSignal } from "./protocol";
import { readFileSync } from "node:fs";
import { FRAMES, fixtureIq2400, rng, synthIq2400 } from "./fixtures/synth-iq";

const hexOf = (line: string) => line.slice(3, -1);
const flush = new Uint8Array(1000).fill(128);

function run(iq: Uint8Array, cuts: number[] = []): string[] {
  const d = new ModeSDemod2400();
  const out: string[] = [];
  let at = 0;
  for (const c of [...cuts, iq.length / 2]) { out.push(...d.push(iq.subarray(at * 2, c * 2))); at = c; }
  out.push(...d.push(flush));
  return out;
}

describe("ModeSDemod2400", () => {
  test("decodes frames at every sub-sample phase", () => {
    for (let offset = 0; offset < 12; offset++) {
      const lines = run(synthIq2400(FRAMES.map((hex) => ({ hex, amp: 60 })), 400, offset));
      expect(lines.map(hexOf)).toEqual(FRAMES);
      for (const l of lines) {
        expect(parseRawFrame(l)).not.toBeNull();
        expect(parseRawSignal(l)).toBeGreaterThan(0);
      }
    }
  });

  test("frame split across buffers", () => {
    const iq = synthIq2400(FRAMES.map((hex) => ({ hex, amp: 60 })), 400, 3);
    for (const cut of [450, 700, 1001, 1700]) expect(run(iq, [cut]).map(hexOf)).toEqual(FRAMES);
  });

  test("back-to-back frames", () => {
    expect(run(synthIq2400(FRAMES.map((hex) => ({ hex, amp: 60 })), 30, 2)).map(hexOf)).toEqual(FRAMES);
  });

  test("weak frames near the noise", () => {
    // amplitude 8 counts over ±2 noise
    expect(run(synthIq2400(FRAMES.map((hex) => ({ hex, amp: 8 })), 400, 1)).map(hexOf)).toEqual(FRAMES);
  });

  test("signal level grows with amplitude", () => {
    const ss = [20, 60, 120].map((amp) => parseInt(run(synthIq2400([{ hex: FRAMES[0], amp }]))[0].slice(1, 3), 16));
    expect(ss[0]).toBeLessThan(ss[1]);
    expect(ss[1]).toBeLessThan(ss[2]);
  });

  test("corrupted frame is dropped (CRC)", () => {
    const bad = FRAMES[0].slice(0, 10) + "F" + FRAMES[0].slice(11);
    expect(run(synthIq2400([{ hex: bad, amp: 60 }]))).toEqual([]);
  });

  test("pure noise yields nothing", () => {
    const r = rng(7);
    expect(run(new Uint8Array(240_000).map(() => 128 + Math.round((r() - 0.5) * 30)))).toEqual([]);
  });

  test("shared fixture (Java parity) is the synthetic stream", () => {
    const fixture = new Uint8Array(readFileSync(new URL("./fixtures/adsb-2400.u8", import.meta.url)));
    expect(fixture).toEqual(new Uint8Array([...fixtureIq2400(), ...new Uint8Array(1000).fill(128)]));
    const expected = readFileSync(new URL("./fixtures/adsb-2400.txt", import.meta.url), "utf8").trim().split("\n");
    expect(expected.map(hexOf)).toEqual([...FRAMES, FRAMES[0]]);
    expect(new ModeSDemod2400().push(fixture)).toEqual(expected);
  });
});
