package io.github.mhaberler.adsbdongle.rtlsdr;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbDeviceConnection;
import android.hardware.usb.UsbManager;
import android.os.Build;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.List;

/**
 * SDR link on Android (ADR 0002): the WebView has no WebUSB and IQ at 2 Msps is too much for the bridge, so the
 * RTL-SDR is driven and demodulated here and only Raw frames reach JS.
 *
 * Methods: list() → {devices: [{deviceId, name}]}; start() → {label} once streaming (asks for USB permission
 * if needed); stop(). Events: "frames" {lines: string[]} per USB buffer with frames, "stopped" {reason} when
 * the stick goes away on its own, "attached" / "detached" for RTL-SDR sticks.
 */
@CapacitorPlugin(name = "RtlSdr")
public class RtlSdrPlugin extends Plugin {
    private static final String ACTION_PERMISSION = "io.github.mhaberler.adsbdongle.RTLSDR_PERMISSION";

    private UsbManager usb;
    private PluginCall pendingStart;
    private volatile RtlSdrDriver driver;
    private Thread worker;

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context ctx, Intent intent) {
            UsbDevice d = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
            if (d == null || !RtlSdrDriver.isRtlSdr(d)) return;
            String action = intent.getAction();
            if (ACTION_PERMISSION.equals(action)) {
                PluginCall call = pendingStart;
                pendingStart = null;
                if (call == null) return;
                if (intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)) launch(call, d);
                else call.reject("USB permission denied");
            } else if (UsbManager.ACTION_USB_DEVICE_ATTACHED.equals(action)) {
                notifyListeners("attached", new JSObject());
            } else if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(action)) {
                notifyListeners("detached", new JSObject());
            }
        }
    };

    @Override
    public void load() {
        usb = (UsbManager) getContext().getSystemService(Context.USB_SERVICE);
        IntentFilter f = new IntentFilter(ACTION_PERMISSION);
        f.addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED);
        f.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        ContextCompat.registerReceiver(getContext(), receiver, f, ContextCompat.RECEIVER_NOT_EXPORTED);
    }

    @Override
    protected void handleOnDestroy() {
        halt();
        try { getContext().unregisterReceiver(receiver); } catch (Exception ignored) { }
    }

    private UsbDevice firstStick() {
        for (UsbDevice d : usb.getDeviceList().values()) if (RtlSdrDriver.isRtlSdr(d)) return d;
        return null;
    }

    @PluginMethod
    public void list(PluginCall call) {
        JSArray devices = new JSArray();
        for (UsbDevice d : usb.getDeviceList().values()) {
            if (!RtlSdrDriver.isRtlSdr(d)) continue;
            JSObject o = new JSObject();
            o.put("deviceId", d.getDeviceId());
            o.put("name", d.getProductName());
            devices.put(o);
        }
        JSObject ret = new JSObject();
        ret.put("devices", devices);
        call.resolve(ret);
    }

    @PluginMethod
    public void start(PluginCall call) {
        UsbDevice d = firstStick();
        if (d == null) { call.reject("No RTL-SDR attached"); return; }
        if (usb.hasPermission(d)) { launch(call, d); return; }
        pendingStart = call;
        Intent intent = new Intent(ACTION_PERMISSION).setPackage(getContext().getPackageName());
        int flags = Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0;
        usb.requestPermission(d, PendingIntent.getBroadcast(getContext(), 0, intent, flags));
    }

    @PluginMethod
    public void stop(PluginCall call) {
        halt();
        call.resolve();
    }

    private void halt() {
        RtlSdrDriver drv = driver;
        driver = null;
        if (drv != null) drv.stop();
        Thread t = worker;
        worker = null;
        if (t != null) {
            try { t.join(2000); } catch (InterruptedException ignored) { }
        }
    }

    private void launch(PluginCall call, UsbDevice d) {
        halt();
        Thread t = new Thread(() -> {
            UsbDeviceConnection conn = usb.openDevice(d);
            if (conn == null) { call.reject("Cannot open RTL-SDR"); return; }
            RtlSdrDriver drv = new RtlSdrDriver(d, conn);
            try {
                drv.open();
            } catch (Exception e) {
                conn.close();
                call.reject(e.getMessage());
                return;
            }
            driver = drv;
            JSObject ok = new JSObject();
            ok.put("label", drv.label());
            call.resolve(ok);

            ModeSDemod demod = new ModeSDemod();
            String reason = drv.stream((buf, len) -> {
                List<String> lines = demod.push(buf, len);
                if (lines.isEmpty()) return;
                JSObject ev = new JSObject();
                ev.put("lines", new JSArray(lines));
                notifyListeners("frames", ev);
            });
            conn.close();
            if (driver == drv) { // ended on its own, not by stop()
                driver = null;
                JSObject ev = new JSObject();
                ev.put("reason", reason);
                notifyListeners("stopped", ev);
            }
        }, "rtlsdr-rx");
        t.setPriority(Thread.MAX_PRIORITY);
        worker = t;
        t.start();
    }
}
