// Mode-S demodulator for an SDR link at 2.4 Msps: RTL-SDR IQ in, Raw frames
// (`+SS<hex>;`) out. Port of readsb's `demod_2400.c` (wiedehopf/readsb,
// GPL-3.0-or-later; Oliver Jowett / Matthias Wirth / Michael Wolf, dump1090-fa
// lineage): preamble correlation over five sub-sample phases, phase-weighted
// bit slicing, best-scoring phase wins. Scoped like the rest of this repo:
// DF17/DF18 only, CRC check-only (no bit-error or DF repair), so a phase
// "scores" only when its CRC is good. Signal level as readsb measures it
// (mean power over the message, `SS` = 255·√level, the Beast scale).
//
// At 2.4 MHz there are exactly 6 samples per 5 symbols. Positions are kept in
// units of 1/5 sample (= 1/6 symbol); a bit (two symbols) is 12 units.

import { modeSChecksum } from "./modes";

export const DEMOD_2400_RATE_HZ = 2_400_000;

/** readsb PREAMBLE_THRESHOLD_DEFAULT; ref level = noise · threshold / 32. */
const PREAMBLE_THRESHOLD = 58;
const LONG_BITS = 112;
const LONG_BYTES = 14;
/** Samples a candidate at `pa` may touch: preamble 19, phase ≤ 1, 112 bits ≈ 269, slicer look-ahead. */
const SPAN = 300;

/** Magnitude 0..65535 of one offset-binary IQ pair, as readsb's UC8 table. */
const MAG_LUT = (() => {
  const lut = new Uint16Array(256 * 256);
  for (let i = 0; i < 256; i++) {
    for (let q = 0; q < 256; q++) {
      const fi = (i - 127.5) / 127.5, fq = (q - 127.5) / 127.5;
      const magsq = Math.min(1, fi * fi + fq * fq);
      lut[i * 256 + q] = Math.floor(Math.sqrt(magsq) * 65535 + 0.5);
    }
  }
  return lut;
})();

// readsb's correlation functions for a 1-0 symbol pair starting at sub-sample
// phase 0..4 within m[0]: > 0 means a 1 bit.
function slicePhase(m: Uint16Array, i: number, phase: number): number {
  switch (phase) {
    case 0: return 18 * m[i] - 15 * m[i + 1] - 3 * m[i + 2];
    case 1: return 14 * m[i] - 5 * m[i + 1] - 9 * m[i + 2];
    case 2: return 16 * m[i] + 5 * m[i + 1] - 20 * m[i + 2];
    case 3: return 7 * m[i] + 11 * m[i + 1] - 18 * m[i + 2];
    default: return 4 * m[i] + 15 * m[i + 1] - 20 * m[i + 2] + m[i + 3];
  }
}

const hex2 = (b: number) => b.toString(16).toUpperCase().padStart(2, "0");

export class ModeSDemod2400 {
  private carry = new Uint16Array(0);

  /** Feed offset-binary IQ bytes (I,Q,I,Q…) sampled at 2.4 MHz. */
  push(iq: Uint8Array): string[] {
    const nSamp = iq.length >> 1;
    const m = new Uint16Array(this.carry.length + nSamp);
    m.set(this.carry);
    const base = this.carry.length;
    for (let i = 0; i < nSamp; i++) m[base + i] = MAG_LUT[iq[2 * i] * 256 + iq[2 * i + 1]];

    const out: string[] = [];
    const msg = new Uint8Array(LONG_BYTES);
    const best = new Uint8Array(LONG_BYTES);
    const stop = m.length - SPAN;
    let pa = 0;
    for (; pa < stop; pa++) {
      // Cheap pre-check before the full preamble correlation.
      if (!(m[pa + 1] > m[pa + 7] && m[pa + 12] > m[pa + 14] && m[pa + 12] > m[pa + 15])) continue;

      const baseNoise = m[pa + 5] + m[pa + 8] + m[pa + 16] + m[pa + 17] + m[pa + 18];
      const refLevel = (baseNoise * PREAMBLE_THRESHOLD) >> 5;

      const diff23 = m[pa + 2] - m[pa + 3];
      const sum14 = m[pa + 1] + m[pa + 4];
      const diff1011 = m[pa + 10] - m[pa + 11];
      const common = sum14 - diff23 + m[pa + 9] + m[pa + 12];

      let bestPhase = -1;
      const tryPhase = (p: number) => {
        if (bestPhase < 0 && this.slice(m, pa, p, msg)) { best.set(msg); bestPhase = p; }
      };
      // Peaks of the five preamble shapes (readsb's comments, phases 3..7 → try 4..8).
      if (common - diff1011 >= refLevel) { tryPhase(4); tryPhase(5); }
      if (common + diff1011 >= refLevel) { tryPhase(6); tryPhase(7); }
      if (sum14 + 2 * diff23 + diff1011 + m[pa + 12] >= refLevel) tryPhase(8);
      if (bestPhase < 0) continue;

      // Mean power over the message, full scale = 1.
      const signalLen = Math.floor((LONG_BITS * 12) / 5); // integer, as readsb
      let power = 0;
      for (let k = 0; k < signalLen; k++) { const v = m[pa + 19 + k]; power += v * v; }
      const level = power / 65535 / 65535 / signalLen;
      const ss = Math.max(1, Math.min(255, Math.round(255 * Math.sqrt(level))));
      let line = "+" + hex2(ss);
      for (const b of best) line += hex2(b);
      out.push(line + ";");

      // readsb skips only part of the message and lets the preamble test do the rest.
      pa += (LONG_BITS * 8) / 4;
    }
    this.carry = m.slice(Math.min(pa, m.length));
    return out;
  }

  /** Slice 112 bits at preamble `pa` with phase `tryPhase` (4..8); true for a CRC-good DF17/18. */
  private slice(m: Uint16Array, pa: number, tryPhase: number, msg: Uint8Array): boolean {
    const u0 = (pa + 19) * 5 + tryPhase;
    msg.fill(0);
    for (let bit = 0; bit < LONG_BITS; bit++) {
      const u = u0 + 12 * bit;
      if (slicePhase(m, Math.floor(u / 5), u % 5) > 0) msg[bit >> 3] |= 0x80 >> (bit & 7);
      if (bit === 4) {
        const df = msg[0] >> 3;
        if (df !== 17 && df !== 18) return false;
      }
    }
    const crc = (msg[11] << 16) | (msg[12] << 8) | msg[13];
    return modeSChecksum(msg, LONG_BITS) === crc;
  }
}
