import type { ByteTransport } from "./transport";

// Minimal userspace driver for FTDI FT230X/FT232R-family USB-UART chips,
// for use via WebUSB where no OS driver claims the device (notably
// Android Chrome, which has no navigator.serial at all). Desktop keeps
// using Web Serial (transport-webserial.ts); this exists only as the
// Android fallback for a directly-wired GNS5892R/Rextron module.
//
// Protocol reference: Linux ftdi_sio driver / libftdi (baud divisor
// algorithm, vendor request numbers) - no vendor SDK, just the well-known
// open reverse-engineered protocol.

const FTDI_VENDOR_ID = 0x0403;

const REQ_RESET = 0x00;
const REQ_SET_BAUDRATE = 0x03;
const REQ_SET_DATA = 0x04;
const REQ_SET_LATENCY_TIMER = 0x09;

const RESET_PURGE_RX = 1;
const RESET_PURGE_TX = 2;

const FTDI_FRAC_CODE = [0, 3, 2, 4, 1, 5, 6, 7];

// Computes the FTDI baud-rate divisor value/index pair for the 48MHz-base
// FT-X/FT232R family (encode_baudrate algorithm, as used by pyftdi and
// libftdi). Returns { value, index } for the SET_BAUDRATE vendor request.
// Exported for unit testing against known-good values cross-checked
// against FTDI's published AN232B-05 divisor table: 921600 -> value
// 0x8003 index 0; 115200 -> value 0x001A index 0.
export function ftdiBaudDivisor(baud: number): { value: number; index: number } {
  const clock = 48_000_000;
  let divisor = Math.floor((clock * 8) / 16 / baud);
  if ((divisor & 0x7) === 7) divisor += 1; // round up a .875 fractional part

  let hwValue = divisor >> 3;
  if (hwValue === 0) hwValue = 1;
  else if (hwValue === 1) hwValue = 0;

  const frac = FTDI_FRAC_CODE[divisor & 0x7];
  const result = (hwValue & 0xffff) | (frac << 14);

  return { value: result & 0xffff, index: (result >> 16) & 0xffff };
}

// FTDI prepends every USB packet (not every "line") with a 2-byte modem
// status header. At full-speed USB the packet size is 64 bytes, so a
// bulk-IN transfer containing multiple packets has a 2-byte header every
// 64 bytes, not just at the start. Strips them, concatenating the actual
// data payload. Exported for unit testing.
export function stripFtdiStatusBytes(raw: Uint8Array, packetSize = 64): Uint8Array {
  if (raw.length <= 2) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < raw.length; offset += packetSize) {
    const end = Math.min(offset + packetSize, raw.length);
    if (end - offset <= 2) continue; // status-only packet, no payload
    chunks.push(raw.subarray(offset + 2, end));
  }

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

export async function requestFtdiTransport(): Promise<ByteTransport> {
  if (!("usb" in navigator)) {
    throw new Error("WebUSB not supported in this browser");
  }
  const device = await navigator.usb.requestDevice({
    filters: [{ vendorId: FTDI_VENDOR_ID }],
  });
  return new FtdiTransport(device);
}

export class FtdiTransport implements ByteTransport {
  private interfaceNumber = 0;
  private inEndpoint = 1;
  private outEndpoint = 2;
  private onDisconnect: (() => void) | null = null;
  private device: USBDevice;

  constructor(device: USBDevice) {
    this.device = device;
  }

  static matches(device: USBDevice): boolean {
    return device.vendorId === FTDI_VENDOR_ID;
  }

  setOnDisconnect(cb: () => void): void {
    this.onDisconnect = cb;
    navigator.usb.addEventListener("disconnect", (event) => {
      if (event.device === this.device) this.onDisconnect?.();
    });
  }

  async open(baud: number): Promise<void> {
    if (!this.device.opened) {
      await this.device.open();
    }
    if (this.device.configuration === null) {
      await this.device.selectConfiguration(1);
    }

    const iface = this.device.configuration!.interfaces[0];
    this.interfaceNumber = iface.interfaceNumber;
    const altSetting = iface.alternates[0];
    for (const ep of altSetting.endpoints) {
      if (ep.direction === "in") this.inEndpoint = ep.endpointNumber;
      else if (ep.direction === "out") this.outEndpoint = ep.endpointNumber;
    }

    await this.device.claimInterface(this.interfaceNumber);

    const vendorOut = (request: number, value: number, index = 0) =>
      this.device.controlTransferOut({
        requestType: "vendor",
        recipient: "device",
        request,
        value,
        index,
      });

    await vendorOut(REQ_RESET, 0);
    await vendorOut(REQ_RESET, RESET_PURGE_RX);
    await vendorOut(REQ_RESET, RESET_PURGE_TX);
    await vendorOut(REQ_SET_DATA, 0x0008); // 8N1
    await vendorOut(REQ_SET_LATENCY_TIMER, 4); // 4ms, keep read latency low

    const { value, index } = ftdiBaudDivisor(baud);
    await vendorOut(REQ_SET_BAUDRATE, value, index);
  }

  async read(): Promise<Uint8Array | null> {
    const result = await this.device.transferIn(this.inEndpoint, 4096);
    if (result.status !== "ok" || !result.data) return new Uint8Array(0);
    const raw = new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
    return stripFtdiStatusBytes(raw);
  }

  async write(data: Uint8Array): Promise<void> {
    await this.device.transferOut(this.outEndpoint, data as unknown as BufferSource);
  }

  async close(): Promise<void> {
    try {
      await this.device.releaseInterface(this.interfaceNumber);
    } catch {
      // ignore
    }
    try {
      await this.device.close();
    } catch {
      // ignore
    }
  }
}
