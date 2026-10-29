// Aircraft database (registration, type, model, military) from Mictronics
// via wiedehopf/tar1090-db. Not bundled and not hosted by us: the user
// downloads it on demand, straight from GitHub (raw.githubusercontent.com
// allows cross-origin fetches), and it is kept in IndexedDB for offline use.
// Stored in chunks keyed by the first three hex digits of the ICAO
// address (about 1000 in use, median 4 kB), so saving is quick and a
// lookup reads one small chunk. Some 570,000 aircraft, ~25 MB stored.

const AIRCRAFT_URL = "https://raw.githubusercontent.com/wiedehopf/tar1090-db/csv/aircraft.csv.gz";
const TYPES_URL =
  "https://raw.githubusercontent.com/wiedehopf/tar1090-db/master/db/icao_aircraft_types.js";

const DB_NAME = "adsb.aircraftdb";
const CHUNKS = "chunks";
const META = "meta";

export interface AircraftInfo {
  reg?: string; // registration, e.g. "D-AIBC"
  type?: string; // ICAO type designator, e.g. "A320"
  model?: string; // e.g. "Airbus A320-214"
  kind?: string; // ICAO type description, e.g. "L2J" (land, 2 engines, jet)
  wtc?: string; // wake turbulence category L/M/H/J
  mil?: boolean;
}

// [reg, type, model, military] per ICAO address, empty strings for unknown
type Entry = [string, string, string, number];
type Chunk = Record<string, Entry>; // key: full lower-case hex address
type TypeTable = Record<string, { desc?: string; wtc?: string }>;

export interface DbMeta {
  downloadedAt: number; // ms since epoch
  count: number;
  types: TypeTable;
}

export const chunkKey = (hex: string) => hex.slice(0, 3).toLowerCase();

// One CSV line: ICAO;registration;type;flags (1st char "1" = military);
// model;year;owner;... Skips entries without any useful field and the
// "Miscode" placeholders for known bogus addresses.
export function parseLine(line: string): [string, Entry] | null {
  const p = line.split(";");
  if (p.length < 7 || !/^[0-9a-fA-F]{6}$/.test(p[0])) return null;
  const mil = p[3].startsWith("1");
  if (!(p[1] || p[2] || mil) || p[6].startsWith("Miscode")) return null;
  return [p[0].toLowerCase(), [p[1], p[2], p[4], mil ? 1 : 0]];
}

export function toInfo(entry: Entry, types: TypeTable): AircraftInfo {
  const [reg, type, model, mil] = entry;
  const t = types[type] ?? {};
  const info: AircraftInfo = {};
  if (reg && reg !== "-") info.reg = reg;
  if (type && type !== "-") info.type = type;
  if (model && model !== "-") info.model = model;
  if (t.desc) info.kind = t.desc;
  if (t.wtc) info.wtc = t.wtc;
  if (mil) info.mil = true;
  return info;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(CHUNKS);
      req.result.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function get<T>(db: IDBDatabase, store: string, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

// Fetches a gzipped file, reporting received compressed bytes.
async function fetchGunzipped(
  url: string,
  onBytes?: (done: number, total: number) => void,
): Promise<ReadableStream<string>> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  let done = 0;
  // typed BufferSource on both outputs: what the decoder streams accept
  const counter = new TransformStream<Uint8Array<ArrayBuffer>, BufferSource>({
    transform(chunk, ctl) {
      done += chunk.byteLength;
      onBytes?.(done, total);
      ctl.enqueue(chunk);
    },
  });
  const bytes: ReadableStream<BufferSource> = res.body
    .pipeThrough(counter)
    .pipeThrough(new DecompressionStream("gzip"));
  return bytes.pipeThrough(new TextDecoderStream());
}

async function readAll(stream: ReadableStream<string>): Promise<string> {
  let text = "";
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += value;
  }
}

export class AircraftDb {
  private db: Promise<IDBDatabase> | null = null;
  private meta: DbMeta | null = null;
  private chunks = new Map<string, Chunk | null>(); // null: loading or absent
  // Resolves once the stored meta (if any) has been read at startup.
  readonly ready: Promise<void>;

  constructor() {
    this.ready = this.open()
      .then((db) => get<DbMeta>(db, META, "meta"))
      .then((meta) => {
        this.meta = meta ?? null;
      })
      .catch(() => {
        this.meta = null; // IndexedDB unavailable: no database
      });
  }

  private open(): Promise<IDBDatabase> {
    this.db ??= openDb();
    return this.db;
  }

  get status(): DbMeta | null {
    return this.meta;
  }

  // Synchronous lookup: undefined while the address's chunk is not loaded
  // yet (it is then fetched in the background) or when unknown.
  info(hex: string): AircraftInfo | undefined {
    if (!this.meta || !hex || hex.startsWith("~")) return undefined;
    const key = chunkKey(hex);
    if (!this.chunks.has(key)) {
      this.chunks.set(key, null);
      void this.open()
        .then((db) => get<Chunk>(db, CHUNKS, key))
        .then((chunk) => this.chunks.set(key, chunk ?? {}))
        .catch(() => this.chunks.delete(key));
      return undefined;
    }
    const entry = this.chunks.get(key)?.[hex.toLowerCase()];
    return entry ? toInfo(entry, this.meta.types) : undefined;
  }

  // Downloads both files from tar1090-db, replaces the stored database.
  async download(onProgress: (text: string) => void): Promise<DbMeta> {
    const typesText = await readAll(await fetchGunzipped(TYPES_URL));
    const types: TypeTable = JSON.parse(typesText);

    const lines = await fetchGunzipped(AIRCRAFT_URL, (done, total) =>
      onProgress(total ? `downloading ${Math.round((100 * done) / total)}%` : "downloading"),
    );
    const chunks = new Map<string, Chunk>();
    let count = 0;
    let rest = "";
    const reader = lines.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      const text = rest + (value ?? "");
      const parts = text.split("\n");
      rest = done ? "" : parts.pop()!;
      for (const line of parts) {
        const parsed = parseLine(line);
        if (!parsed) continue;
        const [hex, entry] = parsed;
        const key = chunkKey(hex);
        let chunk = chunks.get(key);
        if (!chunk) chunks.set(key, (chunk = {}));
        chunk[hex] = entry;
        count++;
      }
      if (done) break;
    }

    onProgress("saving");
    const meta: DbMeta = { downloadedAt: Date.now(), count, types };
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([CHUNKS, META], "readwrite");
      const store = tx.objectStore(CHUNKS);
      store.clear();
      for (const [key, chunk] of chunks) store.put(chunk, key);
      tx.objectStore(META).put(meta, "meta");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    this.meta = meta;
    this.chunks.clear();
    return meta;
  }
}
