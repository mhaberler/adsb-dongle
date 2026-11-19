import { describe, expect, test } from "bun:test";
import { LineReader, type ByteTransport } from "./transport";
import { isPlausibleLine } from "./protocol";

const enc = new TextEncoder();
const FRAME = "*8DAC4FD8583DA5B6F1904E99577D;\r\n";

// Behaves like an FTDI adapter with a module sending at 921600: right
// after open() it hands over a stale buffer of valid frames (received
// while closed), then valid frames at 921600 or line noise at any other
// rate.
class FakeFtdi implements ByteTransport {
  opens: number[] = [];
  private baud = 0;
  private stale = false;
  private closed = true;
  async open(baud: number) {
    this.baud = baud;
    this.opens.push(baud);
    this.stale = true;
    this.closed = false;
  }
  async close() {
    this.closed = true;
  }
  async read(): Promise<Uint8Array | null> {
    if (this.closed) return null;
    if (this.stale) {
      this.stale = false;
      return enc.encode(FRAME.repeat(12));
    }
    await new Promise((r) => setTimeout(r, 20));
    if (this.closed) return null;
    if (this.baud === 921600) return enc.encode(FRAME);
    return new Uint8Array([0xe0, 0x96, 0x58, 0x2a, 0x4e, 0x0a, 0xfe, 0x7b, 0x0e, 0x0a]);
  }
  async write() {}
  setOnDisconnect() {}
}

describe("LineReader baud probe", () => {
  test("stale FTDI buffer doesn't lock the wrong rate", async () => {
    const t = new FakeFtdi();
    const lines: string[] = [];
    const reader = new LineReader();
    await reader.connect(t, [115200, 921600], isPlausibleLine, (l) => lines.push(l), () => {});
    expect(t.opens).toEqual([115200, 921600]);
    await new Promise((r) => setTimeout(r, 100));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.startsWith("*8DAC"))).toBe(true);
    await reader.disconnect();
  }, 10000);
});
