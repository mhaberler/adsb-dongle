import type { ByteTransport } from "./transport";

export async function requestWebSerialTransport(): Promise<ByteTransport> {
  if (!("serial" in navigator)) {
    throw new Error("Web Serial API not supported in this browser");
  }
  const port = await navigator.serial.requestPort();
  return new WebSerialTransport(port);
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
    const readable = this.port.readable! as unknown as ReadableStream<Uint8Array>;
    this.reader = readable.getReader();
    this.writer = (this.port.writable! as unknown as WritableStream<Uint8Array>).getWriter();
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
