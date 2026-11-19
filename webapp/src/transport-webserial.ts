import type { ByteTransport } from "./transport";

export async function requestWebSerialTransport(): Promise<ByteTransport> {
  if (!("serial" in navigator)) {
    throw new Error("Web Serial API not supported in this browser");
  }
  const port = await navigator.serial.requestPort();
  return new WebSerialTransport(port);
}

// A port the user already granted on an earlier visit, if one is plugged
// in now - no picker, so it can run without a click (auto-connect).
export async function grantedWebSerialTransport(): Promise<ByteTransport | null> {
  if (!("serial" in navigator)) return null;
  const [port] = await navigator.serial.getPorts();
  return port ? new WebSerialTransport(port) : null;
}

class WebSerialTransport implements ByteTransport {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private onDisconnect: (() => void) | null = null;
  private disconnectListenerAdded = false;
  private port: SerialPort;

  constructor(port: SerialPort) {
    this.port = port;
  }

  setOnDisconnect(cb: () => void): void {
    this.onDisconnect = cb;
    if (!this.disconnectListenerAdded) {
      this.disconnectListenerAdded = true;
      this.port.addEventListener("disconnect", () => this.onDisconnect?.());
    }
  }

  async open(baud: number): Promise<void> {
    await this.port.open({ baudRate: baud });
    await this.resetIntoFirmware();
    const readable = this.port.readable! as unknown as ReadableStream<Uint8Array>;
    this.reader = readable.getReader();
    this.writer = (this.port.writable! as unknown as WritableStream<Uint8Array>).getWriter();
  }

  // Chrome asserts DTR and RTS on open(). On the ESP32-C6's USB-Serial/JTAG
  // port those lines drive reset and boot mode (RTS=1 with DTR=0 resets;
  // DTR=1 when reset releases boots ROM download mode), and the Windows
  // driver appears to set them one after the other - the dongle then sits
  // silent in download mode. So force a clean reset into the firmware,
  // same sequence esptool uses for USB-JTAG chips. On an FTDI-wired
  // module DTR/RTS aren't connected, so this is a no-op there.
  private async resetIntoFirmware(): Promise<void> {
    try {
      await this.port.setSignals({ dataTerminalReady: false, requestToSend: true });
      await new Promise((r) => setTimeout(r, 100));
      await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });
    } catch {
      // Port without modem-control lines - nothing to reset.
    }
  }

  async read(): Promise<Uint8Array | null> {
    if (!this.reader) return null;
    const { value, done } = await this.reader.read();
    if (done) return null;
    return value ?? new Uint8Array(0);
  }

  async write(data: Uint8Array): Promise<void> {
    if (!this.writer) return;
    await this.writer.write(data);
  }

  async close(): Promise<void> {
    if (this.reader) {
      await this.reader.cancel().catch(() => {});
      this.reader = null;
    }
    if (this.writer) {
      try {
        this.writer.releaseLock();
      } catch {
        // ignore
      }
      this.writer = null;
    }
    try {
      await this.port.close();
    } catch {
      // ignore
    }
  }
}
