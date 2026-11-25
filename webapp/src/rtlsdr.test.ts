import { describe, expect, test } from "bun:test";
import { ADSB_FREQ_HZ, GAIN_TENTH_DB, firBytes, gainSteps, pllFreq, pllPlan } from "./rtlsdr";

const LO = ADSB_FREQ_HZ + 3_570_000;

describe("rtlsdr tuner math", () => {
  test("PLL lands on the 1090 MHz LO (R820T, 28.8 MHz ref)", () => {
    const p = pllPlan(LO, 28_800_000, 2, 2);
    expect(p.ok).toBe(true);
    expect(Math.abs(pllFreq(p, 28_800_000) - LO)).toBeLessThan(1000);
  });

  test("PLL lands on the 1090 MHz LO (R828D, 16 MHz ref)", () => {
    const p = pllPlan(LO, 16_000_000, 1, 1);
    expect(p.ok).toBe(true);
    expect(Math.abs(pllFreq(p, 16_000_000) - LO)).toBeLessThan(1000);
  });

  test("fixed gain reaches the top of the R82xx steps", () => {
    expect(gainSteps(GAIN_TENTH_DB)).toMatchObject({ lna: 15, mix: 14 });
  });

  test("FIR packs into 20 bytes", () => {
    const fir = firBytes();
    expect(fir).toHaveLength(20);
    expect(fir.every((b) => b >= 0 && b <= 255)).toBe(true);
  });
});
