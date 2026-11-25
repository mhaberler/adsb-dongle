// RTL-SDR over WebUSB for an SDR link: an RTL2832U with a Rafael Micro
// R820T/R820T2, R828D (RTL-SDR Blog V4) or R828S (Blog V4L) tuner, brought up
// fixed on 1090 MHz at 2 Msps with fixed gain, streaming raw offset-binary IQ.
//
// Trimmed port of mayhem-mobile's `web/src/rtlsdr.ts` (GPL-3.0), itself a port
// of librtlsdr's `librtlsdr.c` and `tuner_r82xx.c` (GPL-2.0-or-later). Cut:
// HF (direct sampling, upconverter), live retune / rate change / reopen, AGC,
// PPM, bias tee. Kept: the hard-won details below.
//
//  - Control transfers are vendor request 0 both ways; the register block
//    goes in `index`, the address in `value`, and two-byte writes go out
//    big-endian although reads come back little-endian.
//  - Every demodulator write is followed by a dummy read of page 0x0a
//    register 0x01, or the part works for a while and then quietly stops.
//  - The R82xx returns register reads bit-reversed.
//  - The RTL2832U's I2C master carries eight bytes a transaction (one is the
//    register address), so the 27-byte tuner init block goes in sevens; sent
//    whole it is truncated with no error and nothing downconverts.
//  - The R828D sits at another I2C address and may run its PLL from a 16 MHz
//    crystal or the RTL's 28.8 MHz (measured by which one locks); its aerial
//    is on the cable-in above ~345 MHz.
//
// Mirrored in the Android app's `RtlSdrDriver.kt`.

export const RTLSDR_FILTERS: USBDeviceFilter[] = [
  { vendorId: 0x0bda, productId: 0x2832 }, // Realtek RTL2832U, generic
  { vendorId: 0x0bda, productId: 0x2838 }, // RTL2838, what almost every stick reports
  { vendorId: 0x0ccd, productId: 0x00a9 }, { vendorId: 0x0ccd, productId: 0x00b3 }, // Terratec
  { vendorId: 0x1554, productId: 0x5020 }, // PixelView
  { vendorId: 0x185b, productId: 0x0620 }, { vendorId: 0x185b, productId: 0x0650 }, // Compro
  { vendorId: 0x1f4d, productId: 0xb803 }, { vendorId: 0x1f4d, productId: 0xc803 }, // GTek / Lifeview
];

export function isRtlSdr(d: USBDevice): boolean {
  return RTLSDR_FILTERS.some((f) => f.vendorId === d.vendorId && f.productId === d.productId);
}

export const ADSB_FREQ_HZ = 1_090_000_000;
/** Default sample rate; the 2.4 Msps demodulator asks for 2_400_000. */
export const SAMPLE_RATE_HZ = 2_000_000;
/** Tuner gain in tenths of a dB: the most the R82xx stages add up to. */
export const GAIN_TENTH_DB = 488;

// Register blocks, as libusb addresses them through `index`.
const DEMODB = 0, USBB = 1, SYSB = 2, IICB = 6;
const USB_SYSCTL = 0x2000, USB_EPA_CTL = 0x2148, USB_EPA_MAXPKT = 0x2158;
const DEMOD_CTL = 0x3000, DEMOD_CTL_1 = 0x300b;
const GPO = 0x3001, GPOE = 0x3003, GPD = 0x3004;

const RTL_XTAL = 28_800_000;
/** Where the tuner puts the wanted signal (low-side injection). */
const R82XX_IF_HZ = 3_570_000;

const R820T_ADDR = 0x34;
const R828D_ADDR = 0x74;
const R828D_XTAL = 16_000_000;
const R82XX_CHECK_VAL = 0x69;
/** USB strings of the RTL-SDR Blog V4 / V4L (their tuners can't be told apart on the bus). */
const BLOG_MAKER = "RTLSDRBlog", BLOG_V4L = "Blog V4L", BLOG_V4 = "Blog V4";
const usbString = (s: string | null | undefined): string => (s ?? "").replace(/\0/g, "").trim();

/** R820T gain stages, step by step, in tenths of a dB (librtlsdr). */
const LNA_STEPS = [0, 9, 13, 40, 38, 13, 31, 22, 26, 31, 26, 14, 19, 5, 35, 13];
const MIX_STEPS = [0, 5, 10, 10, 19, 9, 10, 25, 17, 10, 8, 16, 13, 6, 3, -8];

/** Channel filter, as librtlsdr programs it. */
const FIR_DEFAULT = [-54, -36, -41, -40, -32, -14, 14, 53, 101, 156, 215, 273, 327, 372, 404, 421];

const REV4 = [0x0, 0x8, 0x4, 0xc, 0x2, 0xa, 0x6, 0xe, 0x1, 0x9, 0x5, 0xd, 0x3, 0xb, 0x7, 0xf];
const bitrev = (b: number) => (REV4[b & 0xf] << 4) | REV4[(b >> 4) & 0xf];

/** Tracking filter / mixer settings by LO band in MHz (librtlsdr). */
const FREQ_RANGES = [
  { freq: 0, openD: 0x08, rfMux: 0x02, tfC: 0xdf, cap0p: 0x00 },
  { freq: 50, openD: 0x08, rfMux: 0x02, tfC: 0xbe, cap0p: 0x00 },
  { freq: 55, openD: 0x08, rfMux: 0x02, tfC: 0x8b, cap0p: 0x00 },
  { freq: 60, openD: 0x08, rfMux: 0x02, tfC: 0x7b, cap0p: 0x00 },
  { freq: 65, openD: 0x08, rfMux: 0x02, tfC: 0x69, cap0p: 0x00 },
  { freq: 70, openD: 0x08, rfMux: 0x02, tfC: 0x58, cap0p: 0x00 },
  { freq: 75, openD: 0x00, rfMux: 0x02, tfC: 0x44, cap0p: 0x00 },
  { freq: 80, openD: 0x00, rfMux: 0x02, tfC: 0x44, cap0p: 0x00 },
  { freq: 90, openD: 0x00, rfMux: 0x02, tfC: 0x34, cap0p: 0x00 },
  { freq: 100, openD: 0x00, rfMux: 0x02, tfC: 0x34, cap0p: 0x00 },
  { freq: 110, openD: 0x00, rfMux: 0x02, tfC: 0x24, cap0p: 0x00 },
  { freq: 120, openD: 0x00, rfMux: 0x02, tfC: 0x24, cap0p: 0x00 },
  { freq: 140, openD: 0x00, rfMux: 0x02, tfC: 0x14, cap0p: 0x00 },
  { freq: 180, openD: 0x00, rfMux: 0x02, tfC: 0x13, cap0p: 0x00 },
  { freq: 220, openD: 0x00, rfMux: 0x02, tfC: 0x13, cap0p: 0x00 },
  { freq: 250, openD: 0x00, rfMux: 0x02, tfC: 0x11, cap0p: 0x00 },
  { freq: 280, openD: 0x00, rfMux: 0x02, tfC: 0x00, cap0p: 0x00 },
  { freq: 310, openD: 0x00, rfMux: 0x41, tfC: 0x00, cap0p: 0x00 },
  { freq: 450, openD: 0x00, rfMux: 0x41, tfC: 0x00, cap0p: 0x00 },
  { freq: 588, openD: 0x00, rfMux: 0x40, tfC: 0x00, cap0p: 0x00 },
  { freq: 650, openD: 0x00, rfMux: 0x40, tfC: 0x00, cap0p: 0x00 },
];

/** Tuner power-on registers 0x05..0x1f. */
const R82XX_INIT = [
  0x80, 0x13, 0x70, 0xc0, 0x40, 0xdb, 0x6b, 0xeb, 0x53, 0x75, 0x68, 0x6c, 0xbb, 0x80,
  0x31, 0x0f, 0x00, 0xc0, 0x30, 0x48, 0xec, 0x60, 0x00, 0x24, 0xdd, 0x0e, 0x40,
];

/** FIR coefficients as the demodulator wants them: 8 signed bytes, then 8 twelve-bit values packed in threes. */
export function firBytes(): number[] {
  const fir = new Array<number>(20).fill(0);
  for (let i = 0; i < 8; i++) fir[i] = FIR_DEFAULT[i] & 0xff;
  for (let i = 0; i < 8; i += 2) {
    const v0 = FIR_DEFAULT[8 + i], v1 = FIR_DEFAULT[8 + i + 1];
    const at = 8 + ((i * 3) >> 1);
    fir[at] = (v0 >> 4) & 0xff;
    fir[at + 1] = ((v0 << 4) | ((v1 >> 8) & 0x0f)) & 0xff;
    fir[at + 2] = v1 & 0xff;
  }
  return fir;
}

/**
 * Synthesizer settings for one LO frequency: a divider bringing the VCO into
 * 1.77–3.54 GHz, then fractional-N (integer + 16-bit fraction). `vcoPowerRef`
 * is 2 on an R820T, 1 on an R828D/R828S and bounds the integer part.
 */
export function pllPlan(freqHz: number, pllRef: number, fine: number, vcoPowerRef = 2): {
  mixDiv: number; divNum: number; nint: number; sdm: number; ok: boolean;
} {
  const VCO_MIN_KHZ = 1_770_000, VCO_MAX_KHZ = VCO_MIN_KHZ * 2;
  const freqKhz = Math.trunc((freqHz + 500) / 1000);
  let mixDiv = 2, divNum = 0;
  while (mixDiv <= 64) {
    if (freqKhz * mixDiv >= VCO_MIN_KHZ && freqKhz * mixDiv < VCO_MAX_KHZ) {
      let db = mixDiv;
      while (db > 2) { db >>= 1; divNum++; }
      break;
    }
    mixDiv <<= 1;
  }
  if (fine > vcoPowerRef) divNum -= 1; else if (fine < vcoPowerRef) divNum += 1;
  const vcoFreq = freqHz * mixDiv;
  const vcoDiv = Math.trunc((pllRef + 65536 * vcoFreq) / (2 * pllRef));
  const nint = Math.trunc(vcoDiv / 65536);
  const sdm = vcoDiv % 65536;
  return { mixDiv, divNum, nint, sdm, ok: nint <= 128 / vcoPowerRef - 1 };
}

/** The frequency a PLL plan actually produces. */
export function pllFreq(p: { mixDiv: number; nint: number; sdm: number }, pllRef: number): number {
  return (2 * pllRef * (p.nint + p.sdm / 65536)) / p.mixDiv;
}

/** LNA and mixer steps reaching a gain, walked alternately as librtlsdr does. */
export function gainSteps(tenthDb: number): { lna: number; mix: number; total: number } {
  let total = 0, lna = 0, mix = 0;
  for (let i = 0; i < 15; i++) {
    if (total >= tenthDb) break;
    total += LNA_STEPS[++lna];
    if (total >= tenthDb) break;
    total += MIX_STEPS[++mix];
  }
  return { lna, mix, total };
}

export class RtlSdr {
  label = "RTL-SDR";
  private epIn = 1;
  private stopFlag = false;
  private loop: Promise<void> | null = null;
  /** Shadow of tuner registers 0x05..0x1f (the part can't be read back per register). */
  private readonly tunerRegs = new Uint8Array(32);
  private tunerAddr = R820T_ADDR;
  private tunerXtal = RTL_XTAL;
  private vcoPowerRef = 2;
  private tuner = "";
  private ctlFails = 0;

  private readonly dev: USBDevice;
  private readonly onIq: (buf: Uint8Array) => void;
  private readonly log: (line: string) => void;

  private readonly rate: number;

  constructor(
    dev: USBDevice,
    onIq: (buf: Uint8Array) => void,
    log: (line: string) => void = (l) => console.info(l),
    rate = SAMPLE_RATE_HZ,
  ) {
    this.rate = rate;
    this.dev = dev;
    this.onIq = onIq;
    this.log = log;
  }

  /** Open, bring up on 1090 MHz and start streaming; resolves once streaming. */
  async start(onStopped: (reason: string) => void): Promise<void> {
    await this.dev.open();
    if (this.dev.configuration === null) await this.dev.selectConfiguration(1);
    await this.dev.claimInterface(0);
    const ep = this.dev.configuration?.interfaces[0]?.alternate.endpoints
      .find((e) => e.type === "bulk" && e.direction === "in");
    if (!ep) throw new Error("RTL-SDR: no bulk-IN endpoint");
    this.epIn = ep.endpointNumber;
    try {
      await this.bringUp();
    } catch (e) {
      await this.release();
      throw e;
    }
    this.stopFlag = false;
    this.loop = this.stream()
      .then((reason) => reason, (e: Error) => e.message)
      .then(async (reason) => {
        await this.release();
        if (!this.stopFlag) onStopped(reason);
      });
  }

  async stop(): Promise<void> {
    this.stopFlag = true;
    await this.loop;
  }

  private async release(): Promise<void> {
    try { await this.dev.releaseInterface(0); } catch { /* gone */ }
    try { await this.dev.close(); } catch { /* gone */ }
  }

  private async bringUp(): Promise<void> {
    // A stick left running by another program halts its endpoint.
    try { await this.dev.clearHalt("in", this.epIn); } catch { /* nothing stalled */ }
    await this.initBaseband();
    await this.initTuner();
    await this.setSampleRate(this.rate);
    await this.setI2cRepeater(true);
    await this.r82xxSetFreq(ADSB_FREQ_HZ);
    await this.applyGain(GAIN_TENTH_DB);
    await this.setI2cRepeater(false);
    await this.resetBuffer();
    if (this.ctlFails) this.log(`RTL-SDR: ${this.ctlFails} control transfers refused during bring-up`);
    this.log(`${this.label}: streaming 1090 MHz @ ${this.rate / 1e6} Msps`);
  }

  /** Eight 64 KB reads in flight so the stick never waits on us. Resolves with why it stopped. */
  private async stream(): Promise<string> {
    const N = 8, SIZE = 65536;
    let lastError = "";
    const read = (): Promise<USBInTransferResult> =>
      this.dev.transferIn(this.epIn, SIZE).catch((e: Error) => {
        lastError = e.message;
        return { status: "babble", data: undefined } as unknown as USBInTransferResult;
      });
    const inflight: Promise<USBInTransferResult>[] = [];
    for (let i = 0; i < N; i++) inflight.push(read());
    let bad = 0;
    let reason = "stopped";
    while (!this.stopFlag) {
      const res = await inflight.shift()!;
      if (!this.stopFlag) inflight.push(read());
      if (res.status !== "ok" || !res.data) {
        // A run of failures means the stick is gone, not one unlucky buffer.
        if (++bad > N * 2) { reason = `RTL-SDR lost: ${lastError || res.status}`; break; }
        if (res.status === "stall") { try { await this.dev.clearHalt("in", this.epIn); } catch { /* gone */ } }
        continue;
      }
      bad = 0;
      const dv = res.data;
      this.onIq(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
    }
    await Promise.allSettled(inflight);
    return reason;
  }

  // ---- RTL2832U registers --------------------------------------------------

  private async writeReg(block: number, addr: number, val: number, len: number): Promise<void> {
    const data = len === 1 ? new Uint8Array([val & 0xff]) : new Uint8Array([(val >> 8) & 0xff, val & 0xff]);
    await this.ctlOut({ requestType: "vendor", recipient: "device", request: 0, value: addr, index: (block << 8) | 0x10 }, data);
  }

  /** A refused write resolves with status 'stall' rather than throwing; count it. */
  private async ctlOut(setup: USBControlTransferParameters, data: Uint8Array<ArrayBuffer>): Promise<void> {
    const r = await this.dev.controlTransferOut(setup, data);
    if (r.status !== "ok") this.ctlFails++;
  }

  private async readReg(block: number, addr: number): Promise<number> {
    const r = await this.dev.controlTransferIn(
      { requestType: "vendor", recipient: "device", request: 0, value: addr, index: block << 8 }, 1);
    return r.status === "ok" && r.data && r.data.byteLength ? r.data.getUint8(0) : 0;
  }

  private async setGpio(pin: number, on: boolean): Promise<void> {
    const bit = 1 << pin;
    await this.writeReg(SYSB, GPD, (await this.readReg(SYSB, GPD)) & ~bit, 1);
    await this.writeReg(SYSB, GPOE, (await this.readReg(SYSB, GPOE)) | bit, 1);
    const v = await this.readReg(SYSB, GPO);
    await this.writeReg(SYSB, GPO, on ? v | bit : v & ~bit, 1);
  }

  private async demodWrite(page: number, addr: number, val: number, len: number): Promise<void> {
    const data = len === 1 ? new Uint8Array([val & 0xff]) : new Uint8Array([(val >> 8) & 0xff, val & 0xff]);
    await this.ctlOut({ requestType: "vendor", recipient: "device", request: 0, value: (addr << 8) | 0x20, index: 0x10 | page }, data);
    await this.demodRead(0x0a, 0x01, 1); // required after every demod write
  }

  private async demodRead(page: number, addr: number, len: number): Promise<number> {
    const r = await this.dev.controlTransferIn(
      { requestType: "vendor", recipient: "device", request: 0, value: (addr << 8) | 0x20, index: page }, len);
    if (r.status !== "ok" || !r.data || r.data.byteLength !== len) { this.ctlFails++; return 0; }
    return len === 1 ? r.data.getUint8(0) : (r.data.getUint8(1) << 8) | r.data.getUint8(0);
  }

  private async initBaseband(): Promise<void> {
    await this.writeReg(USBB, USB_SYSCTL, 0x09, 1);
    await this.writeReg(USBB, USB_EPA_MAXPKT, 0x0002, 2);
    await this.writeReg(USBB, USB_EPA_CTL, 0x1002, 2);
    await this.writeReg(SYSB, DEMOD_CTL_1, 0x22, 1);
    await this.writeReg(SYSB, DEMOD_CTL, 0xe8, 1);
    await this.demodWrite(1, 0x01, 0x14, 1); await this.demodWrite(1, 0x01, 0x10, 1); // soft reset
    await this.demodWrite(1, 0x15, 0x00, 1); await this.demodWrite(1, 0x16, 0x0000, 2);
    for (let i = 0; i < 6; i++) await this.demodWrite(1, 0x16 + i, 0x00, 1); // DDC shift and IF
    const fir = firBytes();
    for (let j = 0; j < 20; j++) await this.demodWrite(1, 0x1c + j, fir[j], 1);
    await this.demodWrite(0, 0x19, 0x05, 1); // SDR mode, digital AGC off
    await this.demodWrite(1, 0x93, 0xf0, 1); await this.demodWrite(1, 0x94, 0x0f, 1);
    await this.demodWrite(1, 0x11, 0x00, 1); // AGC off
    await this.demodWrite(1, 0x04, 0x00, 1); // RF and IF AGC loops off
    await this.demodWrite(DEMODB, 0x61, 0x60, 1); // no PID filter
    await this.demodWrite(DEMODB, 0x06, 0x80, 1); // plain ADC I/Q datapath
    await this.demodWrite(1, 0xb1, 0x1b, 1); // zero-IF, DC cancellation, IQ compensation
    await this.demodWrite(DEMODB, 0x0d, 0x83, 1); // no clock on TP_CK0
  }

  private async setIfFreq(freqHz: number): Promise<void> {
    const ifFreq = -Math.trunc((freqHz * 0x400000) / RTL_XTAL);
    await this.demodWrite(1, 0x19, (ifFreq >> 16) & 0x3f, 1);
    await this.demodWrite(1, 0x1a, (ifFreq >> 8) & 0xff, 1);
    await this.demodWrite(1, 0x1b, ifFreq & 0xff, 1);
  }

  private async setSampleRate(rate: number): Promise<void> {
    const rsamp = Math.trunc((RTL_XTAL * 0x400000) / rate) & 0x0ffffffc;
    await this.demodWrite(1, 0x9f, (rsamp >> 16) & 0xffff, 2);
    await this.demodWrite(1, 0xa1, rsamp & 0xffff, 2);
    await this.demodWrite(1, 0x3f, 0, 1); // no crystal correction
    await this.demodWrite(1, 0x3e, 0, 1);
    await this.demodWrite(1, 0x01, 0x14, 1); await this.demodWrite(1, 0x01, 0x10, 1);
  }

  private setI2cRepeater(on: boolean): Promise<void> {
    return this.demodWrite(1, 0x01, on ? 0x18 : 0x10, 1);
  }

  private async resetBuffer(): Promise<void> {
    await this.writeReg(USBB, USB_EPA_CTL, 0x1002, 2);
    await this.writeReg(USBB, USB_EPA_CTL, 0x0000, 2);
  }

  // ---- I2C to the tuner ----------------------------------------------------

  private async i2cWrite(bytes: Uint8Array<ArrayBuffer>): Promise<void> {
    await this.ctlOut({ requestType: "vendor", recipient: "device", request: 0, value: this.tunerAddr, index: (IICB << 8) | 0x10 }, bytes);
  }

  private async r82xxRead(len: number): Promise<number[]> {
    const out = new Array<number>(len).fill(0);
    const raw = await this.i2cReadRaw(len);
    for (let i = 0; i < len && i < raw.length; i++) out[i] = bitrev(raw[i]);
    return out;
  }

  /** Raw read; an address with no tuner stalls (throws) — that is an answer, not a failure. */
  private async i2cReadRaw(len: number): Promise<number[]> {
    try {
      const r = await this.dev.controlTransferIn(
        { requestType: "vendor", recipient: "device", request: 0, value: this.tunerAddr, index: IICB << 8 }, len);
      if (r.status !== "ok" || !r.data) return [];
      const out: number[] = [];
      for (let i = 0; i < len && i < r.data.byteLength; i++) out.push(r.data.getUint8(i));
      return out;
    } catch {
      return [];
    }
  }

  /** Consecutive tuner registers, seven data bytes per I2C transaction. */
  private async tunerWrite(startReg: number, vals: number[]): Promise<void> {
    for (let pos = 0; pos < vals.length;) {
      const size = Math.min(7, vals.length - pos);
      const b = new Uint8Array(size + 1);
      b[0] = (startReg + pos) & 0xff;
      for (let i = 0; i < size; i++) {
        b[i + 1] = vals[pos + i] & 0xff;
        const reg = startReg + pos + i;
        if (reg >= 5 && reg < 32) this.tunerRegs[reg] = vals[pos + i] & 0xff;
      }
      await this.i2cWrite(b);
      pos += size;
    }
  }

  private tunerWriteReg(reg: number, v: number): Promise<void> { return this.tunerWrite(reg, [v & 0xff]); }

  private tunerWriteMask(reg: number, v: number, mask: number): Promise<void> {
    return this.tunerWriteReg(reg, (this.tunerRegs[reg] & ~mask) | (v & mask));
  }

  // ---- R820T / R820T2 / R828D / R828S --------------------------------------

  private async initTuner(): Promise<void> {
    // Demodulator side for an R82xx: no zero-IF, in-phase ADC only, 3.57 MHz IF, spectrum inverted back.
    await this.demodWrite(1, 0xb1, 0x1a, 1);
    await this.demodWrite(DEMODB, 0x08, 0x4d, 1);
    await this.setIfFreq(R82XX_IF_HZ);
    await this.demodWrite(1, 0x15, 0x01, 1);

    await this.setI2cRepeater(true);
    let found = false;
    for (const [addr, xtal, ref, name] of [
      [R820T_ADDR, RTL_XTAL, 2, "R820T/R820T2"],
      [R828D_ADDR, R828D_XTAL, 1, "R828D"],
    ] as const) {
      this.tunerAddr = addr;
      const probe = await this.i2cReadRaw(1);
      if (probe.length && probe[0] === R82XX_CHECK_VAL) {
        this.tunerXtal = xtal; this.vcoPowerRef = ref; this.tuner = name; found = true;
        break;
      }
    }
    if (!found) {
      await this.setI2cRepeater(false);
      throw new Error("RTL-SDR: no R820T/R828D tuner answered (E4000/FC0012 sticks are not supported)");
    }
    const maker = usbString(this.dev.manufacturerName), product = usbString(this.dev.productName);
    // A V4L's R828S passes for an R820T on the bus; only its USB strings give it away.
    if (this.tuner === "R820T/R820T2" && maker === BLOG_MAKER && product === BLOG_V4L) {
      this.tuner = "R828S"; this.vcoPowerRef = 1;
    }
    const blog = maker === BLOG_MAKER && (product === BLOG_V4 || product === BLOG_V4L);
    this.label = this.tuner === "R828S" ? "RTL-SDR Blog V4L"
      : blog && this.tuner === "R828D" ? "RTL-SDR Blog V4" : `RTL-SDR ${this.tuner}`;
    this.log(`${this.label}: tuner ${this.tuner} at I2C 0x${this.tunerAddr.toString(16)}`);

    for (let i = 0; i < R82XX_INIT.length; i++) this.tunerRegs[5 + i] = R82XX_INIT[i];
    await this.tunerWrite(0x05, R82XX_INIT);
    if (this.tuner === "R828D") await this.pickR828dReference();
    await this.setTvStandard();
    await this.sysFreqSel();
    await this.setI2cRepeater(false);
    // Blog V4/V4L: GPIO5 high = direct aerial path (low = HF upconverter).
    if (blog) await this.setGpio(5, true);
  }

  /** Which clock this R828D's synthesizer runs from, found by which one locks. */
  private async pickR828dReference(): Promise<void> {
    for (const cand of [R828D_XTAL, RTL_XTAL]) {
      this.tunerXtal = cand;
      if (await this.r82xxSetPll(100_000_000)) return;
    }
    this.tunerXtal = R828D_XTAL;
    this.log("RTL-SDR: R828D would not lock against either reference");
  }

  /** Calibrate the channel filter, twice if the first attempt lands on a reserved value. */
  private async setTvStandard(): Promise<void> {
    const filtQ = 0x10;
    let filCal = 0;
    for (let i = 0; i < 2; i++) {
      await this.tunerWriteMask(0x0f, 0x04, 0x04); // calibration clock on
      await this.r82xxSetPll(56_000_000);
      await this.tunerWriteMask(0x0b, 0x10, 0x10); // trigger
      await this.tunerWriteMask(0x0b, 0x00, 0x10);
      await this.tunerWriteMask(0x0f, 0x00, 0x04); // calibration clock off
      filCal = (await this.r82xxRead(5))[4] & 0x0f;
      if (filCal !== 0 && filCal !== 0x0f) break;
    }
    if (filCal === 0x0f) filCal = 0;
    await this.tunerWriteMask(0x0a, filtQ | filCal, 0x1f);
  }

  private async sysFreqSel(): Promise<void> {
    await this.tunerWriteMask(0x05, 0x00, 0x60);
    await this.tunerWriteMask(0x06, 0x00, 0x08);
    await this.tunerWriteMask(0x1d, 0x00, 0x38);
    await this.tunerWriteMask(0x06, 0x00, 0x40);
    await this.tunerWriteMask(0x1a, 0x30, 0x30);
    await this.tunerWriteMask(0x1d, 0x18, 0x38);
    await this.tunerWriteMask(0x1a, 0x20, 0x30);
  }

  private async setMux(loFreqHz: number): Promise<void> {
    const mhz = Math.trunc(loFreqHz / 1_000_000);
    let r = FREQ_RANGES[0];
    for (const fr of FREQ_RANGES) { if (mhz >= fr.freq) r = fr; else break; }
    await this.tunerWriteMask(0x17, r.openD, 0x08);
    await this.tunerWriteMask(0x1a, r.rfMux, 0xc3);
    await this.tunerWriteReg(0x1b, r.tfC);
    await this.tunerWriteMask(0x10, r.cap0p, 0x0b);
    await this.tunerWriteMask(0x08, 0x00, 0x3f);
    await this.tunerWriteMask(0x09, 0x00, 0x3f);
  }

  /** Fractional-N synthesizer; false when it won't lock. */
  private async r82xxSetPll(freqHz: number): Promise<boolean> {
    const VCO_CURR_MIN = 0x80, VCO_CURR_MAX = 0x60;
    await this.tunerWriteMask(0x10, 0x00, 0x10); // reference divider of one
    await this.tunerWriteMask(0x1a, 0x00, 0x0c); // autotune 128 kHz while settling
    await this.tunerWriteMask(0x12, VCO_CURR_MIN, 0xe0);
    const fine = ((await this.r82xxRead(5))[4] & 0x30) >> 4;
    const plan = pllPlan(freqHz, this.tunerXtal, fine, this.vcoPowerRef);
    await this.tunerWriteMask(0x10, plan.divNum << 5, 0xe0);
    if (!plan.ok) return false;
    const { nint, sdm } = plan;
    const ni = Math.trunc((nint - 13) / 4);
    const si = nint - 4 * ni - 13;
    await this.tunerWriteReg(0x14, ni + (si << 6));
    await this.tunerWriteMask(0x12, sdm === 0 ? 0x08 : 0x00, 0x18);
    await this.tunerWriteReg(0x16, sdm >> 8);
    await this.tunerWriteReg(0x15, sdm & 0xff);
    for (let i = 0; i < 2; i++) {
      const saw = await this.r82xxRead(3);
      if ((saw[2] & 0x40) !== 0) {
        await this.tunerWriteMask(0x1a, 0x08, 0x08); // 8 kHz autotune once locked
        return true;
      }
      if (i === 0) await this.tunerWriteMask(0x12, VCO_CURR_MAX, 0xe0); // more current, retry
    }
    return false;
  }

  private async r82xxSetFreq(rfHz: number): Promise<void> {
    const lo = rfHz + R82XX_IF_HZ;
    await this.setMux(lo);
    // R828D: aerial on cable-in above ~345 MHz (reg 0x05 bits 6:5 = 0); R828S: air-in.
    if (this.tuner === "R828D" || this.tuner === "R828S") await this.tunerWriteMask(0x05, 0x00, 0x60);
    if (!(await this.r82xxSetPll(lo))) this.log(`RTL-SDR: PLL did not lock at ${(rfHz / 1e6).toFixed(1)} MHz`);
  }

  private async applyGain(tenthDb: number): Promise<void> {
    const { lna, mix } = gainSteps(tenthDb);
    await this.tunerWriteMask(0x05, 0x10, 0x10); // LNA manual
    await this.tunerWriteMask(0x07, 0x00, 0x10); // mixer manual
    await this.tunerWriteMask(0x05, lna, 0x0f);
    await this.tunerWriteMask(0x07, mix, 0x0f);
    await this.tunerWriteMask(0x0c, 0x08, 0x9f); // output stage ~13.5 dB
  }
}
