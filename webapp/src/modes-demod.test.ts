import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ModeSDemod } from "./modes-demod";
import { parseRawFrame, parseRawSignal } from "./protocol";
import { FRAMES, fixtureIq, rng, synthIq } from "./fixtures/synth-iq";

const hexOf = (line: string) => line.slice(3, -1);

describe("ModeSDemod", () => {
  test("decodes synthetic frames into +SS raw frames", () => {
    const iq = synthIq(FRAMES.map((hex) => ({ hex, amp: 60 })));
    const lines = new ModeSDemod().push(iq);
    expect(lines.map(hexOf)).toEqual(FRAMES);
    for (const l of lines) {
      expect(parseRawFrame(l)).not.toBeNull();
      expect(parseRawSignal(l)).toBeGreaterThan(0);
    }
  });

  test("frame split across buffers", () => {
    const iq = synthIq(FRAMES.map((hex) => ({ hex, amp: 60 })));
    for (const cut of [400, 650, 1001, 1500]) {
      const d = new ModeSDemod();
      const lines = [...d.push(iq.subarray(0, cut * 2)), ...d.push(iq.subarray(cut * 2)), ...d.push(new Uint8Array(1000))];
      expect(lines.map(hexOf)).toEqual(FRAMES);
    }
  });

  test("back-to-back frames", () => {
    const iq = synthIq(FRAMES.map((hex) => ({ hex, amp: 60 })), 20);
    const lines = new ModeSDemod().push(iq);
    expect(lines.map(hexOf)).toEqual(FRAMES);
  });

  test("signal level grows with amplitude", () => {
    const ss = [20, 60, 120].map((amp) => parseInt(new ModeSDemod().push(synthIq([{ hex: FRAMES[0], amp }]))[0].slice(1, 3), 16));
    expect(ss[0]).toBeLessThan(ss[1]);
    expect(ss[1]).toBeLessThan(ss[2]);
  });

  test("corrupted frame is dropped (CRC)", () => {
    const bad = FRAMES[0].slice(0, 10) + "F" + FRAMES[0].slice(11);
    expect(new ModeSDemod().push(synthIq([{ hex: bad, amp: 60 }]))).toEqual([]);
  });

  test("pure noise yields nothing", () => {
    const rnd = rng(7);
    const iq = new Uint8Array(200_000).map(() => 128 + Math.round((rnd() - 0.5) * 30));
    expect(new ModeSDemod().push(iq)).toEqual([]);
  });

  test("shared fixture (Kotlin parity) is the synthetic stream", () => {
    const fixture = new Uint8Array(readFileSync(new URL("./fixtures/adsb-2msps.u8", import.meta.url)));
    expect(fixture).toEqual(fixtureIq());
    const expected = readFileSync(new URL("./fixtures/adsb-2msps.txt", import.meta.url), "utf8").trim().split("\n");
    expect(new ModeSDemod().push(fixture)).toEqual(expected);
  });
});
