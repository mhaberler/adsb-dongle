package io.github.mhaberler.adsbdongle.rtlsdr;

import java.util.ArrayList;
import java.util.List;

/**
 * Mode-S demodulator for an SDR link: RTL-SDR IQ at 2 Msps in, Raw frames ("+SS<hex>;") out. Java twin of
 * webapp/src/modes-demod.ts — keep both in sync; the shared fixture webapp/src/fixtures/adsb-2msps.{u8,txt} is
 * checked by both test suites. Demod half of mayhem-mobile's AdsbDecoder (dump1090 lineage, GPL-3.0).
 */
public final class ModeSDemod {
    private static final int PREAMBLE_US = 8, LONG_BITS = 112, FULL_LEN = PREAMBLE_US + LONG_BITS;
    private static final int MAG_SCALE = 360;
    private static final double FULL_SCALE = 128.0 * MAG_SCALE;
    private static final int[] MAG_LUT = new int[256 * 256];
    private static final char[] HEX = "0123456789ABCDEF".toCharArray();

    static {
        for (int i = 0; i < 256; i++) {
            for (int q = 0; q < 256; q++) {
                int a = Math.min(128, Math.abs(i - 128)), b = Math.min(128, Math.abs(q - 128));
                MAG_LUT[i * 256 + q] = (int) Math.round(Math.sqrt(a * a + b * b) * MAG_SCALE);
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

    /** Feed offset-binary IQ bytes (I,Q,I,Q…) as an RTL-SDR delivers them. */
    public List<String> push(byte[] iq, int len) {
        int nSamp = len >> 1;
        int[] m = new int[carry.length + nSamp];
        System.arraycopy(carry, 0, m, 0, carry.length);
        int base = carry.length;
        for (int i = 0; i < nSamp; i++) m[base + i] = MAG_LUT[(iq[2 * i] & 0xff) * 256 + (iq[2 * i + 1] & 0xff)];

        List<String> out = new ArrayList<>();
        int[] msg = new int[LONG_BITS / 8];
        int limit = m.length - FULL_LEN * 2;
        int j = 0;
        while (j < limit) {
            if (!(m[j] > m[j + 1] && m[j + 1] < m[j + 2] && m[j + 2] > m[j + 3] && m[j + 3] < m[j]
                && m[j + 4] < m[j] && m[j + 5] < m[j] && m[j + 6] < m[j]
                && m[j + 7] > m[j + 8] && m[j + 8] < m[j + 9] && m[j + 9] > m[j + 6])) { j++; continue; }
            int high = (m[j] + m[j + 2] + m[j + 7] + m[j + 9]) / 6;
            if (m[j + 4] >= high || m[j + 5] >= high) { j++; continue; }
            if (m[j + 11] >= high || m[j + 12] >= high || m[j + 13] >= high || m[j + 14] >= high) { j++; continue; }
            if (!slice(m, j + PREAMBLE_US * 2, msg)) { j++; continue; }
            int df = msg[0] >> 3;
            if (df != 17 && df != 18) { j++; continue; }
            int crc = (msg[11] << 16) | (msg[12] << 8) | msg[13];
            if (checksum(msg) != crc) { j++; continue; }

            double amp = (m[j] + m[j + 2] + m[j + 7] + m[j + 9]) / 4.0 / FULL_SCALE;
            int ss = (int) Math.max(1, Math.min(255, Math.round(255 * amp)));
            StringBuilder sb = new StringBuilder(31).append('+');
            hex2(sb, ss);
            for (int b : msg) hex2(sb, b);
            out.add(sb.append(';').toString());
            j += FULL_LEN * 2;
        }
        int keep = Math.min(FULL_LEN * 2, m.length);
        carry = new int[keep];
        System.arraycopy(m, m.length - keep, carry, 0, keep);
        return out;
    }

    private static void hex2(StringBuilder sb, int b) {
        sb.append(HEX[(b >> 4) & 0xf]).append(HEX[b & 0xf]);
    }

    /** PPM bit slicing; false on an undecidable bit in the first 56. */
    private static boolean slice(int[] m, int start, int[] msg) {
        java.util.Arrays.fill(msg, 0);
        int prev = 0;
        for (int i = 0; i < LONG_BITS; i++) {
            int low = m[start + 2 * i], hi = m[start + 2 * i + 1];
            int b;
            if (i > 0 && Math.abs(low - hi) < 256) b = prev;
            else if (low == hi) { if (i < 56) return false; b = prev; }
            else b = low > hi ? 1 : 0;
            prev = b;
            if (b != 0) msg[i >> 3] |= 0x80 >> (i & 7);
        }
        return true;
    }

    private static int checksum(int[] msg) {
        int crc = 0;
        for (int j = 0; j < 88; j++) if ((msg[j >> 3] & (0x80 >> (j & 7))) != 0) crc ^= CRC_TABLE[j];
        return crc;
    }
}
