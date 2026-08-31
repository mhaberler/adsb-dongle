import type { ByteTransport } from "./transport";

// WebUSB driver for USB CDC-ACM devices (this repo's ESP32-C6 dongle,
// which uses ARDUINO_USB_CDC_ON_BOOT). Android fallback for devices whose
// Android kernel hasn't already claimed the interface via its own
// cdc_acm driver - if it has, claimInterface() below will fail and the
// caller should report that clearly rather than silently doing nothing.

const USB_CLASS_CDC_DATA = 0x0a;
const USB_CLASS_CDC_COMM = 0x02;

const REQ_SET_LINE_CODING = 0x20;
const REQ_SET_CONTROL_LINE_STATE = 0x22;
const CONTROL_LINE_DTR_RTS = 0x0003;

export async function requestCdcAcmTransport(): Promise<ByteTransport> {
  if (!("usb" in navigator)) {
    throw new Error("WebUSB not supported in this browser");
  }
  const device = await navigator.usb.requestDevice({
    filters: [{ classCode: USB_CLASS_CDC_COMM }, { classCode: 0xef /* IAD / composite */ }],
  });
  return new CdcAcmTransport(device);
}

export class CdcAcmTransport implements ByteTransport {
  private dataInterfaceNumber = 0;
  private commInterfaceNumber = 0;
  private inEndpoint = 1;
  private outEndpoint = 1;
  private onDisconnect: (() => void) | null = null;
  private device: USBDevice;

  constructor(device: USBDevice) {
    this.device = device;
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

    const interfaces = this.device.configuration!.interfaces;
    const commIface = interfaces.find(
      (i) => i.alternates[0].interfaceClass === USB_CLASS_CDC_COMM,
    );
    const dataIface = interfaces.find(
      (i) => i.alternates[0].interfaceClass === USB_CLASS_CDC_DATA,
    );
    if (!commIface || !dataIface) {
      throw new Error("Not a CDC-ACM device (comm/data interface not found)");
    }

    this.commInterfaceNumber = commIface.interfaceNumber;
    this.dataInterfaceNumber = dataIface.interfaceNumber;

    for (const ep of dataIface.alternates[0].endpoints) {
      if (ep.direction === "in") this.inEndpoint = ep.endpointNumber;
      else if (ep.direction === "out") this.outEndpoint = ep.endpointNumber;
    }

    await this.device.claimInterface(this.commInterfaceNumber);
    if (this.dataInterfaceNumber !== this.commInterfaceNumber) {
      await this.device.claimInterface(this.dataInterfaceNumber);
    }

    // SET_LINE_CODING: 7 bytes, little-endian baud (u32), stop bits (1
    // byte, 0 = 1 stop bit), parity (1 byte, 0 = none), data bits (1 byte).
    const lineCoding = new Uint8Array(7);
    new DataView(lineCoding.buffer).setUint32(0, baud, true);
    lineCoding[4] = 0; // 1 stop bit
    lineCoding[5] = 0; // no parity
    lineCoding[6] = 8; // 8 data bits

    await this.device.controlTransferOut(
      {
        requestType: "class",
        recipient: "interface",
        request: REQ_SET_LINE_CODING,
        value: 0,
        index: this.commInterfaceNumber,
      },
      lineCoding,
    );

    // Assert DTR+RTS - the ESP32 Arduino CDC stack buffers/discards
    // output until DTR is seen, same as a native serial monitor would.
    await this.device.controlTransferOut({
      requestType: "class",
      recipient: "interface",
      request: REQ_SET_CONTROL_LINE_STATE,
      value: CONTROL_LINE_DTR_RTS,
      index: this.commInterfaceNumber,
    });
  }

  async read(): Promise<Uint8Array | null> {
    const result = await this.device.transferIn(this.inEndpoint, 4096);
    if (result.status !== "ok" || !result.data) return new Uint8Array(0);
    return new Uint8Array(result.data.buffer, result.data.byteOffset, result.data.byteLength);
  }

  async write(data: Uint8Array): Promise<void> {
    await this.device.transferOut(this.outEndpoint, data as unknown as BufferSource);
  }

  async close(): Promise<void> {
    try {
      await this.device.releaseInterface(this.commInterfaceNumber);
    } catch {
      // ignore
    }
    if (this.dataInterfaceNumber !== this.commInterfaceNumber) {
      try {
        await this.device.releaseInterface(this.dataInterfaceNumber);
      } catch {
        // ignore
      }
    }
    try {
      await this.device.close();
    } catch {
      // ignore
    }
  }
}
