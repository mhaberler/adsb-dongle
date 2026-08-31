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

    const chosenBaud = await this.probeAndOpen(transport, probeOrder, isValidLine, onLine);
    return chosenBaud;
  }

  // Opens directly at a fixed baud, no probing. Use when the caller
  // already knows the rate (e.g. a native-only transport wired to one
  // known device type) and wants to skip the probe-window latency
  // entirely rather than pass a single-element probeOrder to connect().
  async connectAt(
    transport: ByteTransport,
    baud: number,
    onLine: LineHandler,
    onDisconnect: () => void,
  ): Promise<void> {
    this.transport = transport;
    transport.setOnDisconnect(() => {
      this.cleanup();
      onDisconnect();
    });

    await transport.open(baud);
    this.startReadLoop(transport, onLine, "");
  }

  // Probes baud rates in `probeOrder`. On a match (or after the last rate,
  // as a fallback), keeps the already-open port at that rate and starts
  // the real read loop directly - no close+reopen at the same baud. Some
  // native transports (e.g. Android USB-serial) need time to tear down a
  // closed connection before it can be reopened, and an immediate reopen
  // at the same rate is both unnecessary and racy there. Only closes
  // between attempts when moving on to a *different* rate to try next.
  private async probeAndOpen(
    transport: ByteTransport,
    probeOrder: number[],
    isValidLine: (line: string) => boolean,
    onLine: LineHandler,
  ): Promise<number> {
    for (let i = 0; i < probeOrder.length; i++) {
      const baud = probeOrder[i];
      const isLast = i === probeOrder.length - 1;
      const result = await this.tryBaud(transport, baud, isValidLine);
      if (result.matched || isLast) {
        this.startReadLoop(transport, onLine, result.carryOverBuffer);
        return baud;
      }
      await transport.close().catch(() => {});
    }
    // Unreachable: probeOrder is always non-empty, so the isLast branch
    // above always returns.
    return probeOrder[0];
  }

  // Opens at `baud` and watches for a line matching `isValidLine` within
  // PROBE_WINDOW_MS. Does not start the read loop or touch the port
  // otherwise - the caller decides whether to keep this connection
  // (start the read loop on it) or close it and try the next rate.
  private async tryBaud(
    transport: ByteTransport,
    baud: number,
    isValidLine: (line: string) => boolean,
  ): Promise<{ matched: boolean; carryOverBuffer: string }> {
    await transport.open(baud);

    const decoder = new TextDecoder();
    let buffer = "";
    let matched = false;
    const deadline = Date.now() + PROBE_WINDOW_MS;

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

    return { matched, carryOverBuffer: buffer };
  }

  private startReadLoop(transport: ByteTransport, onLine: LineHandler, carryOverBuffer: string): void {
    this.decoder = new TextDecoder();
    this.lineBuffer = carryOverBuffer;

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
