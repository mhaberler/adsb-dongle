// SDR link: an RTL-SDR stick over WebUSB, demodulated in a Web Worker into
// Raw frames (`+SS<hex>;`) that go to the same line handler a Serial link
// feeds (ADR 0002).
import { RtlSdr } from "./rtlsdr";

export class SdrLink {
  private radio: RtlSdr | null = null;
  private worker: Worker | null = null;

  get label(): string {
    return this.radio?.label ?? "RTL-SDR";
  }

  async connect(device: USBDevice, onLine: (line: string) => void, onLost: (reason: string) => void): Promise<void> {
    await this.disconnect();
    const worker = new Worker(new URL("./sdr-worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (ev: MessageEvent<string[]>) => {
      for (const line of ev.data) onLine(line);
    };
    // Copy out of the WebUSB buffer and hand the copy over without cloning.
    const radio = new RtlSdr(device, (iq) => {
      const copy = iq.slice();
      worker.postMessage(copy.buffer, [copy.buffer]);
    });
    this.worker = worker;
    this.radio = radio;
    try {
      await radio.start((reason) => {
        this.teardown();
        onLost(reason);
      });
    } catch (err) {
      this.teardown();
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    const radio = this.radio;
    this.radio = null;
    await radio?.stop();
    this.teardown();
  }

  private teardown(): void {
    this.worker?.terminate();
    this.worker = null;
    this.radio = null;
  }
}
