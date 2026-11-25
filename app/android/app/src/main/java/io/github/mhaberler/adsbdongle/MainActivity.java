package io.github.mhaberler.adsbdongle;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import io.github.mhaberler.adsbdongle.rtlsdr.RtlSdrPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RtlSdrPlugin.class); // local plugin: SDR link (RTL-SDR), see ADR 0002
        super.onCreate(savedInstanceState);
    }
}
