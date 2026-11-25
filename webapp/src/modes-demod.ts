// Mode-S demodulator for an SDR link: RTL-SDR IQ at 2 Msps in, Raw frames
// (`+SS<hex>;`) out. Port of the demod half of mayhem-mobile's
// `web/src/dsp/adsb.ts` (dump1090 lineage, GPL-3.0): preamble test, PPM bit
// slicing with no bit errors allowed, DF17/DF18 only, CRC check-only. Mirrored
// in the Android app's `ModeSDemod.kt` — keep both in sync (shared fixture
// `fixtures/adsb-2msps.u8`).

import { modeSChecksum } from "./modes";

/** Sample rate the demodulator is built for: one sample per half-bit. */
export const DEMOD_RATE_HZ = 2_000_000;

const PREAMBLE_US = 8;
const LONG_BITS = 112;
const FULL_LEN = PREAMBLE_US + LONG_BITS;
/** Magnitude LUT scale: sqrt(i²+q²)·360 keeps integer precision. */
const MAG_SCALE = 360;
/** Amplitude of a full-scale single component (|sample − 128| = 128). */
const FULL_SCALE = 128 * MAG_SCALE;

/** Magnitude of one offset-binary IQ pair, indexed by `i * 256 + q`. */
const MAG_LUT = (() => {
  const lut = new Int32Array(256 * 256);
  for (let i = 0; i < 256; i++) {
    for (let q = 0; q < 256; q++) {
      const a = Math.min(128, Math.abs(i - 128));
      const b = Math.min(128, Math.abs(q - 128));
      lut[i * 256 + q] = Math.round(Math.sqrt(a * a + b * b) * MAG_SCALE);
    }
  }
  return lut;
})();

const hex2 = (b: number) => b.toString(16).toUpperCase().padStart(2, "0");

export class ModeSDemod {
  /** Magnitudes kept from the previous buffer so a frame may straddle two. */
  private carry = new Int32Array(0);

  /** Feed offset-binary IQ bytes (I,Q,I,Q…) as an RTL-SDR delivers them. */
  push(iq: Uint8Array): string[] {
    const nSamp = iq.length >> 1;
    const m = new Int32Array(this.carry.length + nSamp);
    m.set(this.carry);
    const base = this.carry.length;
    for (let i = 0; i < nSamp; i++) m[base + i] = MAG_LUT[iq[2 * i] * 256 + iq[2 * i + 1]];

    const out: string[] = [];
    const msg = new Uint8Array(LONG_BITS / 8);
    const limit = m.length - FULL_LEN * 2;
    let j = 0;
    while (j < limit) {
      // Pulses at 0, 1, 3.5 and 4.5 µs (samples 0, 2, 7, 9), quiet in between.
      if (!(m[j] > m[j + 1] && m[j + 1] < m[j + 2] && m[j + 2] > m[j + 3] && m[j + 3] < m[j] &&
        m[j + 4] < m[j] && m[j + 5] < m[j] && m[j + 6] < m[j] &&
        m[j + 7] > m[j + 8] && m[j + 8] < m[j + 9] && m[j + 9] > m[j + 6])) { j++; continue; }
      const high = ((m[j] + m[j + 2] + m[j + 7] + m[j + 9]) / 6) | 0;
      if (m[j + 4] >= high || m[j + 5] >= high) { j++; continue; }
      if (m[j + 11] >= high || m[j + 12] >= high || m[j + 13] >= high || m[j + 14] >= high) { j++; continue; }

      if (!this.slice(m, j + PREAMBLE_US * 2, msg)) { j++; continue; }
      const df = msg[0] >> 3;
      if (df !== 17 && df !== 18) { j++; continue; }
      const crc = (msg[11] << 16) | (msg[12] << 8) | msg[13];
      if (modeSChecksum(msg, LONG_BITS) !== crc) { j++; continue; }

      const amp = (m[j] + m[j + 2] + m[j + 7] + m[j + 9]) / 4 / FULL_SCALE;
      const ss = Math.max(1, Math.min(255, Math.round(255 * amp)));
      let line = "+" + hex2(ss);
      for (const b of msg) line += hex2(b);
      out.push(line + ";");
      j += FULL_LEN * 2;
    }
    const keep = Math.min(FULL_LEN * 2, m.length);
    this.carry = m.slice(m.length - keep);
    return out;
  }

  /** PPM bit slicing; false on an undecidable bit in the first 56. */
  private slice(m: Int32Array, start: number, msg: Uint8Array): boolean {
    msg.fill(0);
    let prev = 0;
    for (let i = 0; i < LONG_BITS; i++) {
      const low = m[start + 2 * i], hi = m[start + 2 * i + 1];
      let b: number;
      if (i > 0 && Math.abs(low - hi) < 256) b = prev;
      else if (low === hi) { if (i < 56) return false; b = prev; }
      else b = low > hi ? 1 : 0;
      prev = b;
      if (b) msg[i >> 3] |= 0x80 >> (i & 7);
    }
    return true;
  }
}
