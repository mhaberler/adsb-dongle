package io.github.mhaberler.adsbdongle.rtlsdr;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * Mode-S demodulator for an SDR link at 2.4 Msps: RTL-SDR IQ in, Raw frames ("+SS<hex>;") out. Java twin of
 * webapp/src/modes-demod-2400.ts — keep both in sync; the shared fixture webapp/src/fixtures/adsb-2400.{u8,txt}
 * is checked by both test suites. Port of readsb's demod_2400.c (wiedehopf/readsb, GPL-3.0-or-later, dump1090-fa
 * lineage): preamble correlation over five sub-sample phases, phase-weighted bit slicing. DF17/18 only, CRC
 * check-only; signal level as readsb measures it (SS = 255·√mean power).
 *
 * 6 samples per 5 symbols; positions are in units of 1/5 sample, a bit (two symbols) is 12 units.
 */
public final class ModeSDemod2400 {
    private static final int PREAMBLE_THRESHOLD = 58;
    private static final int LONG_BITS = 112, LONG_BYTES = 14;
    private static final int SPAN = 300;
    private static final int[] MAG_LUT = new int[256 * 256];
    private static final char[] HEX = "0123456789ABCDEF".toCharArray();

    static {
        for (int i = 0; i < 256; i++) {
            for (int q = 0; q < 256; q++) {
                // float like readsb's table (and the TS port, whose Math.sqrt rounds the same at 16 bits)
                double fi = (i - 127.5) / 127.5, fq = (q - 127.5) / 127.5;
                double magsq = Math.min(1, fi * fi + fq * fq);
                MAG_LUT[i * 256 + q] = (int) Math.floor(Math.sqrt(magsq) * 65535 + 0.5);
            }
        }
    }

    /** CRC-24 contribution of each of the first 88 bits (same table as webapp/src/modes.ts). */
    private static final int[] CRC_TABLE = {
        0x3935ea, 0x1c9af5, 0xf1b77e, 0x78dbbf, 0xc397db, 0x9e31e9, 0xb0e2f0, 0x587178,
        0x2c38bc, 0x161c5e, 0x0b0e2f, 0xfa7d13, 0x82c48d, 0xbe9842, 0x5f4c21, 0xd05c14,
        0x682e0a, 0x341705, 0xe5f186, 0x72f8c3, 0xc68665, 0x9cb936, 0x4e5c9b, 0xd8d449,
        0x939020, 0x49c810, 0x24e408, 0x127204, 0x093902, 0x049c81, 0xfdb444, 0x7eda22,
        0x3f6d11, 0xe04c8c, 0x702646, 0x381323, 0xe3f395, 0x8e03ce, 0x4701e7, 0xdc7af7,
        0x91c77f, 0xb719bb, 0xa476d9, 0xadc168, 0x56e0b4, 0x2b705a, 0x15b82d, 0xf52612,
        0x7a9309, 0xc2b380, 0x6159c0, 0x30ace0, 0x185670, 0x0c2b38, 0x06159c, 0x030ace,
        0x018567, 0xff38b7, 0x80665f, 0xbfc92b, 0xa01e91, 0xaff54c, 0x57faa6, 0x2bfd53,
        0xea04ad, 0x8af852, 0x457c29, 0xdd4410, 0x6ea208, 0x375104, 0x1ba882, 0x0dd441,
        0xf91024, 0x7c8812, 0x3e4409, 0xe0d800, 0x706c00, 0x383600, 0x1c1b00, 0x0e0d80,
        0x0706c0, 0x038360, 0x01c1b0, 0x00e0d8, 0x00706c, 0x003836, 0x001c1b, 0xfff409,
    };

    private int[] carry = new int[0];

    /** Feed offset-binary IQ bytes (I,Q,I,Q…) sampled at 2.4 MHz. */
    public List<String> push(byte[] iq, int len) {
        int nSamp = len >> 1;
        int[] m = new int[carry.length + nSamp];
        System.arraycopy(carry, 0, m, 0, carry.length);
        int base = carry.length;
        for (int i = 0; i < nSamp; i++) m[base + i] = MAG_LUT[(iq[2 * i] & 0xff) * 256 + (iq[2 * i + 1] & 0xff)];

        List<String> out = new ArrayList<>();
        int[] msg = new int[LONG_BYTES];
        int stop = m.length - SPAN;
        int pa = 0;
        for (; pa < stop; pa++) {
            if (!(m[pa + 1] > m[pa + 7] && m[pa + 12] > m[pa + 14] && m[pa + 12] > m[pa + 15])) continue;

            int baseNoise = m[pa + 5] + m[pa + 8] + m[pa + 16] + m[pa + 17] + m[pa + 18];
            int refLevel = (baseNoise * PREAMBLE_THRESHOLD) >> 5;
            int diff23 = m[pa + 2] - m[pa + 3];
            int sum14 = m[pa + 1] + m[pa + 4];
            int diff1011 = m[pa + 10] - m[pa + 11];
            int common = sum14 - diff23 + m[pa + 9] + m[pa + 12];

            boolean found = false;
            if (common - diff1011 >= refLevel) found = slice(m, pa, 4, msg) || slice(m, pa, 5, msg);
            if (!found && common + diff1011 >= refLevel) found = slice(m, pa, 6, msg) || slice(m, pa, 7, msg);
            if (!found && sum14 + 2 * diff23 + diff1011 + m[pa + 12] >= refLevel) found = slice(m, pa, 8, msg);
            if (!found) continue;

            int signalLen = LONG_BITS * 12 / 5;
            double power = 0;
            for (int k = 0; k < signalLen; k++) { double v = m[pa + 19 + k]; power += v * v; }
            double level = power / 65535.0 / 65535.0 / signalLen;
            int ss = (int) Math.max(1, Math.min(255, Math.round(255 * Math.sqrt(level))));
            StringBuilder sb = new StringBuilder(31).append('+');
            hex2(sb, ss);
            for (int b : msg) hex2(sb, b);
            out.add(sb.append(';').toString());

            pa += LONG_BITS * 8 / 4; // readsb skips only part of the message
        }
        int from = Math.min(pa, m.length);
        carry = Arrays.copyOfRange(m, from, m.length);
        return out;
    }

    private static void hex2(StringBuilder sb, int b) {
        sb.append(HEX[(b >> 4) & 0xf]).append(HEX[b & 0xf]);
    }

    private static int slicePhase(int[] m, int i, int phase) {
        switch (phase) {
            case 0: return 18 * m[i] - 15 * m[i + 1] - 3 * m[i + 2];
            case 1: return 14 * m[i] - 5 * m[i + 1] - 9 * m[i + 2];
            case 2: return 16 * m[i] + 5 * m[i + 1] - 20 * m[i + 2];
            case 3: return 7 * m[i] + 11 * m[i + 1] - 18 * m[i + 2];
            default: return 4 * m[i] + 15 * m[i + 1] - 20 * m[i + 2] + m[i + 3];
        }
    }

    /** Slice 112 bits at preamble pa with phase tryPhase (4..8); true for a CRC-good DF17/18. */
    private static boolean slice(int[] m, int pa, int tryPhase, int[] msg) {
        int u0 = (pa + 19) * 5 + tryPhase;
        Arrays.fill(msg, 0);
        for (int bit = 0; bit < LONG_BITS; bit++) {
            int u = u0 + 12 * bit;
            if (slicePhase(m, u / 5, u % 5) > 0) msg[bit >> 3] |= 0x80 >> (bit & 7);
            if (bit == 4) {
                int df = msg[0] >> 3;
                if (df != 17 && df != 18) return false;
            }
        }
        int crc = (msg[11] << 16) | (msg[12] << 8) | msg[13];
        return checksum(msg) == crc;
    }

    static int checksum(int[] msg) {
        int crc = 0;
        for (int j = 0; j < 88; j++) if ((msg[j >> 3] & (0x80 >> (j & 7))) != 0) crc ^= CRC_TABLE[j];
        return crc;
    }
}
