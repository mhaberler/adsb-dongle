import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "io.github.mhaberler.adsbdongle",
  appName: "ADS-B Dongle",
  webDir: "dist",
  // Broker feeds are plain ws:// on the LAN; an https WebView origin would
  // block them as mixed content.
  server: { androidScheme: "http", cleartext: true },
  ios: {
    // @leeskies/capacitor-usb-serial is Android-only, and its Package.swift
    // product name doesn't match what cap sync expects, breaking SPM
    // resolution - keep it out of the iOS build.
    includePlugins: [
      "@capacitor/app",
      "@capacitor/geolocation",
      "@mhaberler/capacitor-zeroconf-nsd",
    ],
  },
};

export default config;
