import { describe, expect, test } from "bun:test";
import { ftdiBaudDivisor, stripFtdiStatusBytes } from "./transport-ftdi";

describe("ftdiBaudDivisor", () => {
  // Cross-checked against FTDI's published AN232B-05 divisor table -
  // these are the only two rates this app actually uses.
  test("921600 baud -> value 0x8003, index 0", () => {
    expect(ftdiBaudDivisor(921600)).toEqual({ value: 0x8003, index: 0 });
  });

  test("115200 baud -> value 0x001A, index 0", () => {
    expect(ftdiBaudDivisor(115200)).toEqual({ value: 0x001a, index: 0 });
  });
});

describe("stripFtdiStatusBytes", () => {
  test("strips the 2-byte header from a single sub-packet payload", () => {
    const raw = new Uint8Array([0x01, 0x60, 0x41, 0x42, 0x43]); // status + "ABC"
    expect(stripFtdiStatusBytes(raw)).toEqual(new Uint8Array([0x41, 0x42, 0x43]));
  });

  test("strips a 2-byte header from every 64-byte packet stride", () => {
    const packet1 = new Uint8Array(64);
    packet1[0] = 0x01;
    packet1[1] = 0x60;
    for (let i = 2; i < 64; i++) packet1[i] = i; // 62 bytes payload

    const packet2 = new Uint8Array(10);
    packet2[0] = 0x01;
    packet2[1] = 0x60;
    packet2[2] = 0xaa;
    packet2[3] = 0xbb;

    const raw = new Uint8Array(packet1.length + packet2.length);
    raw.set(packet1, 0);
    raw.set(packet2, packet1.length);

    const result = stripFtdiStatusBytes(raw);
    expect(result.length).toBe(62 + 8); // packet1: 64-2, packet2: 10-2
    expect(result[0]).toBe(2); // first payload byte of packet1
    expect(result[62]).toBe(0xaa);
    expect(result[63]).toBe(0xbb);
  });

  test("status-only packet (no payload) contributes nothing", () => {
    const raw = new Uint8Array([0x01, 0x60]);
    expect(stripFtdiStatusBytes(raw).length).toBe(0);
  });
});
