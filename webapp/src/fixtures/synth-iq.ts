// Synthetic 2 Msps IQ for the SDR link demodulator tests. `fixtureIq()` is
// written to `adsb-2msps.u8` (with the expected lines in `adsb-2msps.txt`) and
// read by both the bun test and the Android app's Kotlin parity test.
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

/**
 * Offset-binary IQ at 2 Msps: idle noise, then each frame as preamble + PPM
 * bits with pulse amplitude `amp` on I (Q at rest), ±2 counts of noise.
 */
export function synthIq(frames: { hex: string; amp: number }[], gap = 300): Uint8Array {
  const rnd = rng(42);
  const mags: number[] = [];
  const idle = (n: number) => { for (let i = 0; i < n; i++) mags.push(0); };
  idle(gap);
  for (const { hex, amp } of frames) {
    const pre = new Array(16).fill(0);
    for (const k of [0, 2, 7, 9]) pre[k] = amp;
    mags.push(...pre);
    for (let i = 0; i < hex.length * 4; i++) {
      const bit = (parseInt(hex[i >> 2], 16) >> (3 - (i & 3))) & 1;
      mags.push(bit ? amp : 0, bit ? 0 : amp);
    }
    idle(gap);
  }
  const iq = new Uint8Array(mags.length * 2);
  mags.forEach((a, i) => {
    const n = () => Math.round((rnd() - 0.5) * 4);
    iq[2 * i] = Math.max(0, Math.min(255, 128 + a + n()));
    iq[2 * i + 1] = Math.max(0, Math.min(255, 128 + n()));
  });
  return iq;
}

export const fixtureIq = () => synthIq(FRAMES.map((hex, i) => ({ hex, amp: 30 + 30 * i })));

if (import.meta.main) {
  const { ModeSDemod } = await import("../modes-demod");
  const { writeFileSync } = await import("node:fs");
  const iq = fixtureIq();
  writeFileSync(new URL("./adsb-2msps.u8", import.meta.url), iq);
  writeFileSync(new URL("./adsb-2msps.txt", import.meta.url), new ModeSDemod().push(iq).join("\n") + "\n");
}
