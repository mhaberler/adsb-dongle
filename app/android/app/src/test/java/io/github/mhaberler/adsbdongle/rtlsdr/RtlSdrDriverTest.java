package io.github.mhaberler.adsbdongle.rtlsdr;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Tuner arithmetic, same expectations as webapp/src/rtlsdr.test.ts. */
public class RtlSdrDriverTest {
    @Test
    public void tunerMathMatchesTypeScript() {
        long lo = RtlSdrDriver.ADSB_FREQ_HZ + 3_570_000L;
        long[] p = RtlSdrDriver.pllPlan(lo, 28_800_000L, 2, 2);
        assertEquals(1, p[4]);
        double f = 2.0 * 28_800_000L * (p[2] + p[3] / 65536.0) / p[0];
        assertTrue(Math.abs(f - lo) < 1000);
        assertArrayEquals(new int[] {15, 14, 496}, RtlSdrDriver.gainSteps(RtlSdrDriver.GAIN_TENTH_DB));
        assertEquals(20, RtlSdrDriver.firBytes().length);
    }
}
