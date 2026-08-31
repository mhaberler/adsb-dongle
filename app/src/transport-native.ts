import { UsbSerial } from "@leeskies/capacitor-usb-serial";
import type { PluginListenerHandle } from "@capacitor/core";
import type { ByteTransport } from "../../webapp/src/transport";

// ByteTransport over @leeskies/capacitor-usb-serial, which wraps
// mik3y/usb-serial-for-android (the same library the native "Serial USB
// Terminal" app uses) - the reliable path for FTDI-adapted modules on
// Android, where neither Web Serial nor WebUSB works for this hardware.

// Picks a device to connect to: the first attached device with no
// disambiguation UI (this app expects exactly one adapter plugged in at a
// time - either the FTDI-wired module or the ESP32 dongle's CDC-ACM
// port). Throws a clear error if none is attached.
export async function pickDevice(): Promise<{ deviceId: string }> {
  const { devices } = await UsbSerial.listDevices();
  if (devices.length === 0) {
    throw new Error("No USB serial device attached");
  }
  return { deviceId: devices[0].deviceId };
}

export async function requestNativeTransport(): Promise<ByteTransport> {
  const { deviceId } = await pickDevice();
  const { granted } = await UsbSerial.requestPermission({ deviceId });
  if (!granted) {
    throw new Error("USB permission denied");
  }
  return new NativeSerialTransport(deviceId);
}

class NativeSerialTransport implements ByteTransport {
  private deviceId: string;
  private portId: string | null = null;
  private onDisconnect: (() => void) | null = null;
  private dataListener: PluginListenerHandle | null = null;
  private detachedListener: PluginListenerHandle | null = null;

  // Async pull queue: the plugin pushes base64 chunks via the 'data'
  // event; read() pulls from here, awaiting the next push when empty.
  private queue: (Uint8Array | null)[] = [];
  private waiters: ((chunk: Uint8Array | null) => void)[] = [];

  constructor(deviceId: string) {
    this.deviceId = deviceId;
  }

  setOnDisconnect(cb: () => void): void {
    this.onDisconnect = cb;
  }

  async open(baud: number): Promise<void> {
    const { portId } = await UsbSerial.open({ deviceId: this.deviceId });
    this.portId = portId;

    await UsbSerial.setParameters({
      portId,
      baudRate: baud,
      dataBits: 8,
      stopBits: 1,
      parity: "none",
    });

    // ESP32 Arduino CDC buffers/discards output until DTR is asserted,
    // same as a native serial monitor would; harmless no-op for FTDI.
    await UsbSerial.setDTR({ portId, value: true });
    await UsbSerial.setRTS({ portId, value: true });

    this.dataListener = await UsbSerial.addListener("data", (event) => {
      if (event.portId !== portId) return;
      this.push(base64ToBytes(event.data));
    });
    this.detachedListener = await UsbSerial.addListener("detached", (event) => {
      if (event.deviceId !== this.deviceId) return;
      this.onDisconnect?.();
    });

    await UsbSerial.startReading({ portId });
  }

  async read(): Promise<Uint8Array | null> {
    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private push(chunk: Uint8Array | null): void {
    if (this.waiters.length > 0) {
      this.waiters.shift()!(chunk);
    } else {
      this.queue.push(chunk);
    }
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.portId) return;
    await UsbSerial.write({ portId: this.portId, data: bytesToBase64(data) });
  }

  async close(): Promise<void> {
    await this.dataListener?.remove().catch(() => {});
    this.dataListener = null;
    await this.detachedListener?.remove().catch(() => {});
    this.detachedListener = null;

    if (this.portId) {
      const portId = this.portId;
      this.portId = null;
      await UsbSerial.stopReading({ portId }).catch(() => {});
      await UsbSerial.close({ portId }).catch(() => {});
    }

    this.push(null);
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
