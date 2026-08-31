export type LineHandler = (line: string) => void;

export class SerialLineReader {
  private port: SerialPort | null = null;
  private reader: ReadableStreamDefaultReader<string> | null = null;
  private readLoop: Promise<void> | null = null;

  async connect(onLine: LineHandler, onDisconnect: () => void): Promise<void> {
    if (!("serial" in navigator)) {
      throw new Error("Web Serial API not supported in this browser");
    }

    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: 115200 });
    this.port = port;

    port.addEventListener("disconnect", () => {
      this.cleanup();
      onDisconnect();
    });

    const textDecoder = new TextDecoderStream();
    const readableClosed = (
      port.readable! as unknown as ReadableStream<Uint8Array>
    ).pipeTo(textDecoder.writable as unknown as WritableStream<Uint8Array>);
    const lineStream = textDecoder.readable.pipeThrough(
      new TransformStream(new LineBreakTransformer()),
    );
    this.reader = lineStream.getReader();

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
