package io.github.mhaberler.adsbdongle.rtlsdr;

import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbEndpoint;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbRequest;
import android.os.Build;
import android.util.Log;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeoutException;

/**
 * RTL-SDR for an SDR link: RTL2832U + R820T/R820T2, R828D (Blog V4) or R828S (Blog V4L), fixed on 1090 MHz at
 * 2 Msps with fixed gain, streaming raw offset-binary IQ. Java twin of webapp/src/rtlsdr.ts — keep both in sync.
 *
 * Trimmed port of mayhem-mobile's usb/RtlSdr.kt (GPL-3.0), itself from librtlsdr (librtlsdr.c, tuner_r82xx.c,
 * GPL-2.0-or-later). The details that each cost someone a day: vendor request 0 both ways, block in index,
 * address in value, two-byte writes big-endian; a dummy read of page 0x0a reg 0x01 after every demod write; the
 * R82xx reads back bit-reversed; the I2C master carries 8 bytes a transaction, so the tuner init block goes in
 * sevens; the R828D sits at another address and may run its PLL from 16 or 28.8 MHz (measured by which locks).
 */
public final class RtlSdrDriver {
    public interface Sink {
        void onIq(byte[] buf, int len);
    }

    private static final String TAG = "RtlSdr";

    public static final int[][] IDS = {
        {0x0bda, 0x2832}, {0x0bda, 0x2838}, {0x0ccd, 0x00a9}, {0x0ccd, 0x00b3}, {0x1554, 0x5020},
        {0x185b, 0x0620}, {0x185b, 0x0650}, {0x1f4d, 0xb803}, {0x1f4d, 0xc803},
    };

    public static boolean isRtlSdr(UsbDevice d) {
        for (int[] id : IDS) if (d.getVendorId() == id[0] && d.getProductId() == id[1]) return true;
        return false;
    }

    static final long ADSB_FREQ_HZ = 1_090_000_000L;
    static final int SAMPLE_RATE_HZ = 2_000_000;
    static final int GAIN_TENTH_DB = 488;

    private static final int DEMODB = 0, USBB = 1, SYSB = 2, IICB = 6;
    private static final int USB_SYSCTL = 0x2000, USB_EPA_CTL = 0x2148, USB_EPA_MAXPKT = 0x2158;
    private static final int DEMOD_CTL = 0x3000, DEMOD_CTL_1 = 0x300b;
    private static final int GPO = 0x3001, GPOE = 0x3003, GPD = 0x3004;
    private static final long RTL_XTAL = 28_800_000L;
    private static final long R82XX_IF_HZ = 3_570_000L;
    private static final int R820T_ADDR = 0x34, R828D_ADDR = 0x74;
    private static final long R828D_XTAL = 16_000_000L;
    private static final int R82XX_CHECK_VAL = 0x69;
    private static final int TIMEOUT = 300;
    private static final long STALL_MS = 2000;

    private static final int[] LNA_STEPS = {0, 9, 13, 40, 38, 13, 31, 22, 26, 31, 26, 14, 19, 5, 35, 13};
    private static final int[] MIX_STEPS = {0, 5, 10, 10, 19, 9, 10, 25, 17, 10, 8, 16, 13, 6, 3, -8};
    private static final int[] FIR_DEFAULT = {-54, -36, -41, -40, -32, -14, 14, 53, 101, 156, 215, 273, 327, 372, 404, 421};
    private static final int[] REV4 = {0x0, 0x8, 0x4, 0xc, 0x2, 0xa, 0x6, 0xe, 0x1, 0x9, 0x5, 0xd, 0x3, 0xb, 0x7, 0xf};
    /** {MHz, openD, rfMux, tfC, cap0p} by LO band (librtlsdr). */
    private static final int[][] FREQ_RANGES = {
        {0, 0x08, 0x02, 0xdf, 0}, {50, 0x08, 0x02, 0xbe, 0}, {55, 0x08, 0x02, 0x8b, 0}, {60, 0x08, 0x02, 0x7b, 0},
        {65, 0x08, 0x02, 0x69, 0}, {70, 0x08, 0x02, 0x58, 0}, {75, 0, 0x02, 0x44, 0}, {80, 0, 0x02, 0x44, 0},
        {90, 0, 0x02, 0x34, 0}, {100, 0, 0x02, 0x34, 0}, {110, 0, 0x02, 0x24, 0}, {120, 0, 0x02, 0x24, 0},
        {140, 0, 0x02, 0x14, 0}, {180, 0, 0x02, 0x13, 0}, {220, 0, 0x02, 0x13, 0}, {250, 0, 0x02, 0x11, 0},
        {280, 0, 0x02, 0x00, 0}, {310, 0, 0x41, 0x00, 0}, {450, 0, 0x41, 0x00, 0}, {588, 0, 0x40, 0x00, 0},
        {650, 0, 0x40, 0x00, 0},
    };
    private static final int[] R82XX_INIT = {
        0x80, 0x13, 0x70, 0xc0, 0x40, 0xdb, 0x6b, 0xeb, 0x53, 0x75, 0x68, 0x6c, 0xbb, 0x80,
        0x31, 0x0f, 0x00, 0xc0, 0x30, 0x48, 0xec, 0x60, 0x00, 0x24, 0xdd, 0x0e, 0x40,
    };

    private final UsbDevice device;
    private final UsbDeviceConnection conn;
    private UsbEndpoint epIn;
    private final int[] tunerRegs = new int[32];
    private int tunerAddr = R820T_ADDR;
    private long tunerXtal = RTL_XTAL;
    private int vcoPowerRef = 2;
    private String tuner = "";
    private String label = "RTL-SDR";
    private int ctlFails = 0;
    private volatile boolean stop = false;

    public RtlSdrDriver(UsbDevice device, UsbDeviceConnection conn) {
        this.device = device;
        this.conn = conn;
    }

    public String label() { return label; }

    public void stop() { stop = true; }

    /** Claim the interface and bring the stick up on 1090 MHz. */
    public void open() {
        UsbInterface intf = device.getInterface(0);
        if (!conn.claimInterface(intf, true)) throw new IllegalStateException("RTL-SDR: cannot claim interface");
        for (int i = 0; i < intf.getEndpointCount(); i++) {
            UsbEndpoint ep = intf.getEndpoint(i);
            if (ep.getType() == UsbConstants.USB_ENDPOINT_XFER_BULK && ep.getDirection() == UsbConstants.USB_DIR_IN) epIn = ep;
        }
        if (epIn == null) throw new IllegalStateException("RTL-SDR: no bulk-IN endpoint");
        clearHalt();
        initBaseband();
        initTuner();
        setSampleRate(SAMPLE_RATE_HZ);
        setI2cRepeater(true);
        r82xxSetFreq(ADSB_FREQ_HZ);
        applyGain(GAIN_TENTH_DB);
        setI2cRepeater(false);
        resetBuffer();
        if (ctlFails > 0) Log.w(TAG, ctlFails + " control transfers refused during bring-up");
        Log.i(TAG, label + ": streaming 1090 MHz @ 2 Msps");
    }

    /** Stream until stop() or the stick is gone; returns why it ended. Reads kept in flight via UsbRequest. */
    public String stream(Sink sink) {
        boolean big = Build.VERSION.SDK_INT >= 28;
        int nbuf = big ? 8 : 12, bufSz = big ? 65536 : 16384;
        ByteBuffer[] buffers = new ByteBuffer[nbuf];
        List<UsbRequest> reqs = new ArrayList<>();
        for (int i = 0; i < nbuf; i++) {
            buffers[i] = ByteBuffer.allocateDirect(bufSz);
            UsbRequest r = new UsbRequest();
            if (!r.initialize(conn, epIn)) break;
            r.setClientData(i);
            if (!r.queue(buffers[i])) { r.close(); break; }
            reqs.add(r);
        }
        if (reqs.isEmpty()) return "RTL-SDR: cannot queue USB reads";
        byte[] scratch = new byte[bufSz];
        long lastData = System.currentTimeMillis();
        int fails = 0;
        String reason = "stopped";
        try {
            while (!stop) {
                if (System.currentTimeMillis() - lastData > STALL_MS) { reason = "RTL-SDR: no samples for 2 s"; break; }
                UsbRequest req;
                try {
                    req = Build.VERSION.SDK_INT >= 26 ? conn.requestWait(100) : conn.requestWait();
                } catch (TimeoutException e) {
                    continue;
                }
                if (req == null) {
                    if (++fails >= 200) { reason = "RTL-SDR lost"; break; }
                    try { Thread.sleep(2); } catch (InterruptedException e) { break; }
                    continue;
                }
                Object cd = req.getClientData();
                if (!(cd instanceof Integer)) continue;
                int idx = (Integer) cd;
                ByteBuffer b = buffers[idx];
                int n = b.position();
                if (n > 0) {
                    lastData = System.currentTimeMillis();
                    b.rewind();
                    b.get(scratch, 0, n);
                    sink.onIq(scratch, n);
                }
                b.clear();
                if (!req.queue(b)) {
                    if (++fails >= 200) { reason = "RTL-SDR lost"; break; }
                } else {
                    fails = 0;
                }
            }
        } finally {
            for (UsbRequest r : reqs) {
                try { r.cancel(); } catch (Exception ignored) { }
            }
            for (UsbRequest r : reqs) {
                try { r.close(); } catch (Exception ignored) { }
            }
            try { conn.releaseInterface(device.getInterface(0)); } catch (Exception ignored) { }
        }
        return reason;
    }

    // ---- RTL2832U registers -------------------------------------------------

    private void clearHalt() {
        conn.controlTransfer(0x02, 0x01, 0x00, epIn.getAddress(), null, 0, 500);
    }

    private static byte[] be(int v, int len) {
        return len == 1 ? new byte[] {(byte) v} : new byte[] {(byte) (v >> 8), (byte) v};
    }

    private void out(int value, int index, byte[] data) {
        if (conn.controlTransfer(0x40, 0, value, index, data, data.length, TIMEOUT) < 0) ctlFails++;
    }

    private void writeReg(int block, int addr, int v, int len) { out(addr, (block << 8) | 0x10, be(v, len)); }

    private int readReg(int block, int addr) {
        byte[] b = new byte[1];
        return conn.controlTransfer(0xC0, 0, addr, block << 8, b, 1, TIMEOUT) == 1 ? b[0] & 0xff : 0;
    }

    private void setGpio(int pin, boolean on) {
        int bit = 1 << pin;
        writeReg(SYSB, GPD, readReg(SYSB, GPD) & ~bit, 1);
        writeReg(SYSB, GPOE, readReg(SYSB, GPOE) | bit, 1);
        int v = readReg(SYSB, GPO);
        writeReg(SYSB, GPO, on ? v | bit : v & ~bit, 1);
    }

    private void demodWrite(int page, int addr, int v, int len) {
        out((addr << 8) | 0x20, 0x10 | page, be(v, len));
        demodRead(0x0a, 0x01, 1); // required after every demod write
    }

    private int demodRead(int page, int addr, int len) {
        byte[] b = new byte[len];
        if (conn.controlTransfer(0xC0, 0, (addr << 8) | 0x20, page, b, len, TIMEOUT) != len) { ctlFails++; return 0; }
        return len == 1 ? b[0] & 0xff : ((b[1] & 0xff) << 8) | (b[0] & 0xff);
    }

    static int[] firBytes() {
        int[] fir = new int[20];
        for (int i = 0; i < 8; i++) fir[i] = FIR_DEFAULT[i] & 0xff;
        for (int i = 0; i < 8; i += 2) {
            int v0 = FIR_DEFAULT[8 + i], v1 = FIR_DEFAULT[8 + i + 1];
            int at = 8 + ((i * 3) >> 1);
            fir[at] = (v0 >> 4) & 0xff;
            fir[at + 1] = ((v0 << 4) | ((v1 >> 8) & 0x0f)) & 0xff;
            fir[at + 2] = v1 & 0xff;
        }
        return fir;
    }

    private void initBaseband() {
        writeReg(USBB, USB_SYSCTL, 0x09, 1);
        writeReg(USBB, USB_EPA_MAXPKT, 0x0002, 2);
        writeReg(USBB, USB_EPA_CTL, 0x1002, 2);
        writeReg(SYSB, DEMOD_CTL_1, 0x22, 1);
        writeReg(SYSB, DEMOD_CTL, 0xe8, 1);
        demodWrite(1, 0x01, 0x14, 1); demodWrite(1, 0x01, 0x10, 1); // soft reset
        demodWrite(1, 0x15, 0x00, 1); demodWrite(1, 0x16, 0x0000, 2);
        for (int i = 0; i < 6; i++) demodWrite(1, 0x16 + i, 0x00, 1);
        int[] fir = firBytes();
        for (int j = 0; j < 20; j++) demodWrite(1, 0x1c + j, fir[j], 1);
        demodWrite(0, 0x19, 0x05, 1); // SDR mode, digital AGC off
        demodWrite(1, 0x93, 0xf0, 1); demodWrite(1, 0x94, 0x0f, 1);
        demodWrite(1, 0x11, 0x00, 1); // AGC off
        demodWrite(1, 0x04, 0x00, 1); // RF and IF AGC loops off
        demodWrite(DEMODB, 0x61, 0x60, 1); // no PID filter
        demodWrite(DEMODB, 0x06, 0x80, 1); // plain ADC I/Q datapath
        demodWrite(1, 0xb1, 0x1b, 1); // zero-IF, DC cancellation, IQ compensation
        demodWrite(DEMODB, 0x0d, 0x83, 1); // no clock on TP_CK0
    }

    private void setIfFreq(long freqHz) {
        int ifFreq = (int) -((freqHz * 0x400000L) / RTL_XTAL);
        demodWrite(1, 0x19, (ifFreq >> 16) & 0x3f, 1);
        demodWrite(1, 0x1a, (ifFreq >> 8) & 0xff, 1);
        demodWrite(1, 0x1b, ifFreq & 0xff, 1);
    }

    private void setSampleRate(int rate) {
        int rsamp = (int) ((RTL_XTAL * 0x400000L) / rate) & 0x0ffffffc;
        demodWrite(1, 0x9f, (rsamp >> 16) & 0xffff, 2);
        demodWrite(1, 0xa1, rsamp & 0xffff, 2);
        demodWrite(1, 0x3f, 0, 1); // no crystal correction
        demodWrite(1, 0x3e, 0, 1);
        demodWrite(1, 0x01, 0x14, 1); demodWrite(1, 0x01, 0x10, 1);
    }

    private void setI2cRepeater(boolean on) { demodWrite(1, 0x01, on ? 0x18 : 0x10, 1); }

    private void resetBuffer() {
        writeReg(USBB, USB_EPA_CTL, 0x1002, 2);
        writeReg(USBB, USB_EPA_CTL, 0x0000, 2);
    }

    // ---- I2C to the tuner ---------------------------------------------------

    private int[] i2cReadRaw(int len) {
        byte[] b = new byte[len];
        int r = conn.controlTransfer(0xC0, 0, tunerAddr, IICB << 8, b, len, TIMEOUT);
        if (r <= 0) return new int[0];
        int[] outv = new int[Math.min(r, len)];
        for (int i = 0; i < outv.length; i++) outv[i] = b[i] & 0xff;
        return outv;
    }

    private int[] r82xxRead(int len) {
        int[] raw = i2cReadRaw(len);
        int[] outv = new int[len];
        for (int i = 0; i < len && i < raw.length; i++) {
            int v = raw[i];
            outv[i] = (REV4[v & 0xf] << 4) | REV4[(v >> 4) & 0xf];
        }
        return outv;
    }

    private void tunerWrite(int startReg, int[] vals) {
        for (int pos = 0; pos < vals.length; ) {
            int size = Math.min(7, vals.length - pos);
            byte[] b = new byte[size + 1];
            b[0] = (byte) (startReg + pos);
            for (int i = 0; i < size; i++) {
                b[i + 1] = (byte) vals[pos + i];
                int reg = startReg + pos + i;
                if (reg >= 5 && reg < 32) tunerRegs[reg] = vals[pos + i] & 0xff;
            }
            out(tunerAddr, (IICB << 8) | 0x10, b);
            pos += size;
        }
    }

    private void tunerWriteReg(int reg, int v) { tunerWrite(reg, new int[] {v & 0xff}); }

    private void tunerWriteMask(int reg, int v, int mask) { tunerWriteReg(reg, (tunerRegs[reg] & ~mask) | (v & mask)); }

    // ---- R820T / R820T2 / R828D / R828S -------------------------------------

    private static String usbString(String s) { return s == null ? "" : s.replace("\0", "").trim(); }

    private void initTuner() {
        demodWrite(1, 0xb1, 0x1a, 1);
        demodWrite(DEMODB, 0x08, 0x4d, 1);
        setIfFreq(R82XX_IF_HZ);
        demodWrite(1, 0x15, 0x01, 1);

        setI2cRepeater(true);
        boolean found = false;
        Object[][] cands = {{R820T_ADDR, RTL_XTAL, 2, "R820T/R820T2"}, {R828D_ADDR, R828D_XTAL, 1, "R828D"}};
        for (Object[] c : cands) {
            tunerAddr = (Integer) c[0];
            int[] probe = i2cReadRaw(1);
            if (probe.length > 0 && probe[0] == R82XX_CHECK_VAL) {
                tunerXtal = (Long) c[1]; vcoPowerRef = (Integer) c[2]; tuner = (String) c[3]; found = true;
                break;
            }
        }
        if (!found) {
            setI2cRepeater(false);
            throw new IllegalStateException("RTL-SDR: no R820T/R828D tuner answered (E4000/FC0012 sticks are not supported)");
        }
        String maker = usbString(device.getManufacturerName()), product = usbString(device.getProductName());
        if (tuner.equals("R820T/R820T2") && maker.equals("RTLSDRBlog") && product.equals("Blog V4L")) {
            tuner = "R828S"; vcoPowerRef = 1;
        }
        boolean blog = maker.equals("RTLSDRBlog") && (product.equals("Blog V4") || product.equals("Blog V4L"));
        label = tuner.equals("R828S") ? "RTL-SDR Blog V4L"
            : blog && tuner.equals("R828D") ? "RTL-SDR Blog V4" : "RTL-SDR " + tuner;
        Log.i(TAG, label + ": tuner " + tuner + " at I2C 0x" + Integer.toHexString(tunerAddr));

        System.arraycopy(R82XX_INIT, 0, tunerRegs, 5, R82XX_INIT.length);
        tunerWrite(0x05, R82XX_INIT);
        if (tuner.equals("R828D")) pickR828dReference();
        setTvStandard();
        sysFreqSel();
        setI2cRepeater(false);
        if (blog) setGpio(5, true); // direct aerial path, not the HF upconverter
    }

    private void pickR828dReference() {
        for (long cand : new long[] {R828D_XTAL, RTL_XTAL}) {
            tunerXtal = cand;
            if (r82xxSetPll(100_000_000L)) return;
        }
        tunerXtal = R828D_XTAL;
        Log.w(TAG, "R828D would not lock against either reference");
    }

    private void setTvStandard() {
        int filCal = 0;
        for (int i = 0; i < 2; i++) {
            tunerWriteMask(0x0f, 0x04, 0x04);
            r82xxSetPll(56_000_000L);
            tunerWriteMask(0x0b, 0x10, 0x10);
            tunerWriteMask(0x0b, 0x00, 0x10);
            tunerWriteMask(0x0f, 0x00, 0x04);
            filCal = r82xxRead(5)[4] & 0x0f;
            if (filCal != 0 && filCal != 0x0f) break;
        }
        if (filCal == 0x0f) filCal = 0;
        tunerWriteMask(0x0a, 0x10 | filCal, 0x1f);
    }

    private void sysFreqSel() {
        tunerWriteMask(0x05, 0x00, 0x60);
        tunerWriteMask(0x06, 0x00, 0x08);
        tunerWriteMask(0x1d, 0x00, 0x38);
        tunerWriteMask(0x06, 0x00, 0x40);
        tunerWriteMask(0x1a, 0x30, 0x30);
        tunerWriteMask(0x1d, 0x18, 0x38);
        tunerWriteMask(0x1a, 0x20, 0x30);
    }

    private void setMux(long loFreqHz) {
        long mhz = loFreqHz / 1_000_000L;
        int[] r = FREQ_RANGES[0];
        for (int[] fr : FREQ_RANGES) { if (mhz >= fr[0]) r = fr; else break; }
        tunerWriteMask(0x17, r[1], 0x08);
        tunerWriteMask(0x1a, r[2], 0xc3);
        tunerWriteReg(0x1b, r[3]);
        tunerWriteMask(0x10, r[4], 0x0b);
        tunerWriteMask(0x08, 0x00, 0x3f);
        tunerWriteMask(0x09, 0x00, 0x3f);
    }

    /** {mixDiv, divNum, nint, sdm, ok} — same arithmetic as rtlsdr.ts pllPlan(). */
    static long[] pllPlan(long freqHz, long pllRef, int fine, int vcoPowerRef) {
        final long vcoMinKhz = 1_770_000L, vcoMaxKhz = vcoMinKhz * 2;
        long freqKhz = (freqHz + 500) / 1000;
        int mixDiv = 2, divNum = 0;
        while (mixDiv <= 64) {
            if (freqKhz * mixDiv >= vcoMinKhz && freqKhz * mixDiv < vcoMaxKhz) {
                int db = mixDiv;
                while (db > 2) { db >>= 1; divNum++; }
                break;
            }
            mixDiv <<= 1;
        }
        if (fine > vcoPowerRef) divNum -= 1; else if (fine < vcoPowerRef) divNum += 1;
        long vcoFreq = freqHz * mixDiv;
        long vcoDiv = (pllRef + 65536L * vcoFreq) / (2 * pllRef);
        long nint = vcoDiv / 65536, sdm = vcoDiv % 65536;
        return new long[] {mixDiv, divNum, nint, sdm, nint <= 128 / vcoPowerRef - 1 ? 1 : 0};
    }

    private boolean r82xxSetPll(long freqHz) {
        tunerWriteMask(0x10, 0x00, 0x10);
        tunerWriteMask(0x1a, 0x00, 0x0c);
        tunerWriteMask(0x12, 0x80, 0xe0);
        int fine = (r82xxRead(5)[4] & 0x30) >> 4;
        long[] p = pllPlan(freqHz, tunerXtal, fine, vcoPowerRef);
        tunerWriteMask(0x10, (int) p[1] << 5, 0xe0);
        if (p[4] == 0) return false;
        int nint = (int) p[2], sdm = (int) p[3];
        int ni = (nint - 13) / 4;
        int si = nint - 4 * ni - 13;
        tunerWriteReg(0x14, ni + (si << 6));
        tunerWriteMask(0x12, sdm == 0 ? 0x08 : 0x00, 0x18);
        tunerWriteReg(0x16, sdm >> 8);
        tunerWriteReg(0x15, sdm & 0xff);
        for (int i = 0; i < 2; i++) {
            if ((r82xxRead(3)[2] & 0x40) != 0) {
                tunerWriteMask(0x1a, 0x08, 0x08);
                return true;
            }
            if (i == 0) tunerWriteMask(0x12, 0x60, 0xe0);
        }
        return false;
    }

    private void r82xxSetFreq(long rfHz) {
        long lo = rfHz + R82XX_IF_HZ;
        setMux(lo);
        if (tuner.equals("R828D") || tuner.equals("R828S")) tunerWriteMask(0x05, 0x00, 0x60);
        if (!r82xxSetPll(lo)) Log.w(TAG, "PLL did not lock at " + rfHz / 1_000_000 + " MHz");
    }

    /** {lna, mix, total} walked alternately as librtlsdr does. */
    static int[] gainSteps(int tenthDb) {
        int total = 0, lna = 0, mix = 0;
        for (int i = 0; i < 15; i++) {
            if (total >= tenthDb) break;
            total += LNA_STEPS[++lna];
            if (total >= tenthDb) break;
            total += MIX_STEPS[++mix];
        }
        return new int[] {lna, mix, total};
    }

    private void applyGain(int tenthDb) {
        int[] g = gainSteps(tenthDb);
        tunerWriteMask(0x05, 0x10, 0x10);
        tunerWriteMask(0x07, 0x00, 0x10);
        tunerWriteMask(0x05, g[0], 0x0f);
        tunerWriteMask(0x07, g[1], 0x0f);
        tunerWriteMask(0x0c, 0x08, 0x9f);
    }
}
