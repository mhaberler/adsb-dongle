import { describe, expect, test } from "bun:test";
import { classifyLine, isPlausibleLine, parseRawFrame, parseRawSignal } from "./protocol";

// Live sensorpod ihex line (RTL-SDR, signal byte 0x10).
const PLUS = "+108F4BA890EA4A5864017C087FCF72;";
const STAR = "*8F4BA890EA4A5864017C087FCF72;";

describe("isPlausibleLine (baud probe)", () => {
  test.each([
    "*8DAC4FD8583DA5B6F1904E99577D;",
    "*8DAC4FD8583DA5B6F1904E99577D;\r",
    "*02E19910589F31;", // 56-bit short frame
    "+108F4BA890EA4A5864017C087FCF72;", // sensorpod +SS form
    '{"hex":"40621d","seen":0.2,"messages":184}',
    '{"frames_seen":15234,"crc_fail":312}',
    "#49-03",
  ])("accepts %p", (line) => expect(isPlausibleLine(line)).toBe(true));

  test.each([
    "", // empty
    "*", // bare marker
    "*8DAC4FD8", // truncated frame
    "*8DAC4FD8583DA5B6F1904E99577D", // no terminator
    "*8DAC4FD8583DA5B6F1904E99577Z;", // non-hex
    "+8DAC4FD8583DA5B6F1904E99577D;", // + without signal byte
    "{\u0096X\u0092N^", // looks like JSON, isn't
    "{garbage",
    "#à\u0096", // non-printable after '#'
    "#",
  ])("rejects %p", (line) => expect(isPlausibleLine(line)).toBe(false));

  test("no false match in noise: 921600 stream read at 115200", () => {
    // Deterministic pseudo-random bytes, biased like the real capture
    // (lots of 0xfe/0x0e/'*'/'#'/'{' candidates), split into lines.
    let x = 12345;
    const rnd = () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) >> 8) & 0xff;
    const alphabet = [0x2a, 0x23, 0x7b, 0x0a, 0x0d, 0x3b, 0x38, 0x44];
    let s = "";
    for (let i = 0; i < 200000; i++) {
      const r = rnd();
      s += String.fromCharCode(r < 64 ? alphabet[r & 7] : rnd());
    }
    const lines = s.split("\n");
    expect(lines.filter(isPlausibleLine)).toEqual([]);
  });
});

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
