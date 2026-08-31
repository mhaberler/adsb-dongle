export type LineHandler = (line: string) => void;

const PROBE_BAUD_RATES = [115200, 921600];
const PROBE_WINDOW_MS = 2000;

export class SerialLineReader {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<string> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readLoop: Promise<void> | null = null;

  // Requests a port (user gesture) and probes baud rates in
  // PROBE_BAUD_RATES order: opens at each rate and watches for a line
  // matching `isValidLine` within PROBE_WINDOW_MS. Keeps the first rate
  // that produces a recognizable line; falls back to the first rate in the
  // list if none do (so a silent/idle device still ends up connected).
  async connect(
    isValidLine: (line: string) => boolean,
    onLine: LineHandler,
    onDisconnect: () => void,
  ): Promise<number> {
    if (!("serial" in navigator)) {
      throw new Error("Web Serial API not supported in this browser");
    }

    const port = await navigator.serial.requestPort();
    this.port = port;

    port.addEventListener("disconnect", () => {
      this.cleanup();
      onDisconnect();
    });

    const chosenBaud = await this.probeBaud(port, isValidLine);
    await this.openAt(port, chosenBaud, onLine);
    return chosenBaud;
  }

  private async probeBaud(
    port: SerialPort,
    isValidLine: (line: string) => boolean,
  ): Promise<number> {
    for (const baud of PROBE_BAUD_RATES) {
      const found = await this.tryBaud(port, baud, isValidLine);
      if (found) return baud;
    }
    return PROBE_BAUD_RATES[0];
  }

  private async tryBaud(
    port: SerialPort,
    baud: number,
    isValidLine: (line: string) => boolean,
  ): Promise<boolean> {
    await port.open({ baudRate: baud });

    const textDecoder = new TextDecoderStream();
    const readable = port.readable! as unknown as ReadableStream<Uint8Array>;
    const readableClosed = readable.pipeTo(
      textDecoder.writable as unknown as WritableStream<Uint8Array>,
    );
    const lineStream = textDecoder.readable.pipeThrough(
      new TransformStream(new LineBreakTransformer()),
    );
    const reader = lineStream.getReader();

    let matched = false;
    const deadline = Date.now() + PROBE_WINDOW_MS;
    try {
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        const result = await Promise.race([
          reader.read(),
          new Promise<{ value: undefined; done: false }>((resolve) =>
            setTimeout(() => resolve({ value: undefined, done: false }), remaining),
          ),
        ]);
        if (result.value !== undefined && isValidLine(result.value)) {
          matched = true;
          break;
        }
        if (result.done) break;
      }
    } finally {
      await reader.cancel().catch(() => {});
      await readableClosed.catch(() => {});
      await port.close().catch(() => {});
    }
    return matched;
  }

  private async openAt(port: SerialPort, baud: number, onLine: LineHandler): Promise<void> {
    await port.open({ baudRate: baud });

    const textDecoder = new TextDecoderStream();
    const readable = port.readable! as unknown as ReadableStream<Uint8Array>;
    const readableClosed = readable.pipeTo(
      textDecoder.writable as unknown as WritableStream<Uint8Array>,
    );
    const lineStream = textDecoder.readable.pipeThrough(
      new TransformStream(new LineBreakTransformer()),
    );
    this.reader = lineStream.getReader();
    this.writer = (port.writable! as unknown as WritableStream<Uint8Array>).getWriter();

    this.readLoop = (async () => {
      try {
        while (true) {
          const { value, done } = await this.reader!.read();
          if (done) break;
          if (value !== undefined) onLine(value);
        }
      } catch {
        // Port closed/disconnected mid-read; disconnect handler covers cleanup.
      } finally {
        await readableClosed.catch(() => {});
      }
    })();
  }

  // Writes an ASCII string to the port (e.g. a GNS5892 "#49-03\r" command).
  async write(data: string): Promise<void> {
    if (!this.writer) return;
    await this.writer.write(new TextEncoder().encode(data));
  }

  async disconnect(): Promise<void> {
    await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    if (this.reader) {
      try {
        await this.reader.cancel();
      } catch {
        // ignore
      }
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
    if (this.readLoop) {
      await this.readLoop.catch(() => {});
      this.readLoop = null;
    }
    if (this.port) {
      try {
        await this.port.close();
      } catch {
        // ignore
      }
      this.port = null;
    }
  }
}

class LineBreakTransformer implements Transformer<string, string> {
  private buffer = "";

  transform(chunk: string, controller: TransformStreamDefaultController<string>) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    for (const line of lines) controller.enqueue(line);
  }

  flush(controller: TransformStreamDefaultController<string>) {
    if (this.buffer) controller.enqueue(this.buffer);
  }
}
