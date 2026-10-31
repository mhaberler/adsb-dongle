import { describe, expect, test } from "bun:test";
import { classifyLine, parseRawFrame, parseRawSignal } from "./protocol";

// Live sensorpod ihex line (RTL-SDR, signal byte 0x10).
const PLUS = "+108F4BA890EA4A5864017C087FCF72;";
const STAR = "*8F4BA890EA4A5864017C087FCF72;";

describe("+SS raw frames", () => {
  test("classified as raw frames", () => {
    expect(classifyLine(PLUS)).toBe("rawframe");
    expect(classifyLine(STAR)).toBe("rawframe");
  });

  test("same bytes as the * form", () => {
    expect(parseRawFrame(PLUS)).toEqual(parseRawFrame(STAR)!);
  });

  test("signal level on the Beast scale", () => {
    expect(parseRawSignal(PLUS)).toBeCloseTo((16 / 255) ** 2, 12);
    expect(parseRawSignal("+FF8F4BA890EA4A5864017C087FCF72;")).toBe(1);
    expect(parseRawSignal(STAR)).toBeUndefined();
  });

  test("malformed + lines rejected", () => {
    expect(parseRawFrame("+;")).toBeNull();
    expect(parseRawFrame("+1;")).toBeNull();
    expect(parseRawFrame("+G08F4BA890EA4A5864017C087FCF72;")).toBeNull();
    expect(parseRawSignal("+G08F4BA890;")).toBeUndefined();
  });
});
