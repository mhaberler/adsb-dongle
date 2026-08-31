// Transport-agnostic line reader: baud auto-probe + NDJSON/raw-frame line
// framing, shared across Web Serial (desktop) and WebUSB (Android
// fallback, since navigator.serial doesn't exist on Android Chrome)
// transports.

export type LineHandler = (line: string) => void;

export interface ByteTransport {
  open(baud: number): Promise<void>;
  close(): Promise<void>;
  // Resolves to a chunk of bytes, or null on EOF/close.
  read(): Promise<Uint8Array | null>;
  write(data: Uint8Array): Promise<void>;
  setOnDisconnect(cb: () => void): void;
}

const PROBE_WINDOW_MS = 2000;

export class LineReader {
  private transport: ByteTransport | null = null;
  private readLoop: Promise<void> | null = null;
  private decoder = new TextDecoder();
  private lineBuffer = "";

  // Probes baud rates in `probeOrder`: opens at each rate and watches for
  // a line matching `isValidLine` within PROBE_WINDOW_MS. Keeps the first
  // rate that produces a recognizable line; falls back to the first rate
  // in the list if none do (so a silent/idle device still ends up
  // connected).
  async connect(
    transport: ByteTransport,
    probeOrder: number[],
    isValidLine: (line: string) => boolean,
    onLine: LineHandler,
    onDisconnect: () => void,
  ): Promise<number> {
    this.transport = transport;
    transport.setOnDisconnect(() => {
      this.cleanup();
      onDisconnect();
    });

    const chosenBaud = await this.probeBaud(transport, probeOrder, isValidLine);
    await this.openAt(transport, chosenBaud, onLine);
    return chosenBaud;
  }

  private async probeBaud(
    transport: ByteTransport,
    probeOrder: number[],
    isValidLine: (line: string) => boolean,
  ): Promise<number> {
    for (const baud of probeOrder) {
      const found = await this.tryBaud(transport, baud, isValidLine);
      if (found) return baud;
    }
    return probeOrder[0];
  }

  private async tryBaud(
    transport: ByteTransport,
    baud: number,
    isValidLine: (line: string) => boolean,
  ): Promise<boolean> {
    await transport.open(baud);

    const decoder = new TextDecoder();
    let buffer = "";
    let matched = false;
    const deadline = Date.now() + PROBE_WINDOW_MS;

    try {
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        const chunk = await Promise.race([
          transport.read(),
          new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), remaining)),
        ]);
        if (chunk === undefined) break; // timed out this iteration
        if (chunk === null) break; // EOF

        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        if (lines.some((line) => isValidLine(line))) {
          matched = true;
          break;
        }
      }
    } finally {
      await transport.close().catch(() => {});
    }
    return matched;
  }

  private async openAt(transport: ByteTransport, baud: number, onLine: LineHandler): Promise<void> {
    await transport.open(baud);
    this.decoder = new TextDecoder();
    this.lineBuffer = "";

    this.readLoop = (async () => {
      try {
        while (true) {
          const chunk = await transport.read();
          if (chunk === null) break;
          this.lineBuffer += this.decoder.decode(chunk, { stream: true });
          const lines = this.lineBuffer.split("\n");
          this.lineBuffer = lines.pop() ?? "";
          for (const line of lines) onLine(line);
        }
      } catch {
        // Transport closed/disconnected mid-read; disconnect handler covers cleanup.
      }
    })();
  }

  async write(data: string): Promise<void> {
    if (!this.transport) return;
    await this.transport.write(new TextEncoder().encode(data));
  }

  async disconnect(): Promise<void> {
    await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    if (this.readLoop) {
      await this.readLoop.catch(() => {});
      this.readLoop = null;
    }
    if (this.transport) {
      await this.transport.close().catch(() => {});
      this.transport = null;
    }
  }
}
