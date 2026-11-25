// Synthetic 2.4 Msps IQ for the SDR link demodulator tests. `fixtureIq2400()`
// is written to `adsb-2400.u8` (with the expected lines in `adsb-2400.txt`)
// and read by both the bun test and the Android app's JUnit parity test.
// Regenerate: bun src/fixtures/synth-iq.ts

/** CRC-valid DF17 frames from modes.test.ts. */
export const FRAMES = [
  "8D4B1621994420C18804887668F9",
  "8D400A6658AB0540C701D9CA672E",
  "8D4CA27A608145305B0B09EAD8B5",
];

/** Deterministic LCG so the fixture is reproducible. */
export function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/** 2.4 Msps fixture: one weak frame (amp 8) and frames at three sub-sample phases. */
export const fixtureIq2400 = () =>
  synthIq2400([...FRAMES.map((hex, i) => ({ hex, amp: 30 + 30 * i })), { hex: FRAMES[0], amp: 8 }], 400, 3);

if (import.meta.main) {
  const { ModeSDemod2400 } = await import("../modes-demod-2400");
  const { writeFileSync } = await import("node:fs");
  // trailing idle so the last frame clears the demodulator's look-ahead in one push
  const iq24 = new Uint8Array([...fixtureIq2400(), ...new Uint8Array(1000).fill(128)]);
  writeFileSync(new URL("./adsb-2400.u8", import.meta.url), iq24);
  writeFileSync(new URL("./adsb-2400.txt", import.meta.url), new ModeSDemod2400().push(iq24).join("\n") + "\n");
}

/**
 * Offset-binary IQ at 2.4 Msps. The waveform is built on a 12 MHz grid
 * (symbol = 6 units, 2.4 MHz sample = 5 units) and each sample is the mean
 * over its 5 units, so frames land at any sub-sample phase: `offset` shifts
 * every frame by that many 1/12 µs units. ±2 counts of noise.
 */
export function synthIq2400(frames: { hex: string; amp: number }[], gap = 400, offset = 0, seed = 42): Uint8Array {
  const rnd = rng(seed);
  const units: number[] = [];
  const idle = (n: number) => { for (let i = 0; i < n * 5; i++) units.push(0); };
  idle(gap);
  for (let i = 0; i < offset; i++) units.push(0);
  for (const { hex, amp } of frames) {
    const pre = new Array(96).fill(0);
    for (const s of [0, 12, 42, 54]) for (let k = 0; k < 6; k++) pre[s + k] = amp;
    units.push(...pre);
    for (let i = 0; i < hex.length * 4; i++) {
      const bit = (parseInt(hex[i >> 2], 16) >> (3 - (i & 3))) & 1;
      for (let k = 0; k < 6; k++) units.push(bit ? amp : 0);
      for (let k = 0; k < 6; k++) units.push(bit ? 0 : amp);
    }
    idle(gap);
  }
  while (units.length % 5) units.push(0);
  const n = units.length / 5;
  const iq = new Uint8Array(n * 2);
  for (let s = 0; s < n; s++) {
    let a = 0;
    for (let k = 0; k < 5; k++) a += units[5 * s + k];
    a /= 5;
    const noise = () => Math.round((rnd() - 0.5) * 4);
    iq[2 * s] = Math.max(0, Math.min(255, Math.round(128 + a) + noise()));
    iq[2 * s + 1] = Math.max(0, Math.min(255, 128 + noise()));
  }
  return iq;
}
