// Web Worker for an SDR link: IQ buffers in, Raw frame batches out, so the
// demodulation never stalls the map. The first message picks the
// demodulator by sample rate (2 Msps or readsb's 2.4 Msps one).
import { ModeSDemod } from "./modes-demod";
import { ModeSDemod2400, DEMOD_2400_RATE_HZ } from "./modes-demod-2400";

let demod: { push(iq: Uint8Array): string[] } | null = null;
self.onmessage = (ev: MessageEvent<ArrayBuffer | { rate: number }>) => {
  if (!(ev.data instanceof ArrayBuffer)) {
    demod = ev.data.rate === DEMOD_2400_RATE_HZ ? new ModeSDemod2400() : new ModeSDemod();
    return;
  }
  const lines = demod?.push(new Uint8Array(ev.data)) ?? [];
  if (lines.length) self.postMessage(lines);
};
