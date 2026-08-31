import { defineConfig } from "vite";

// Capacitor's webview loads the built app from a file:// (Android
// content://) origin, so asset URLs must be relative, not root-absolute.
// fs.allow widens Vite's dev-server file access to ../webapp/src, which
// this app imports the shared decode/map pipeline from directly (no
// duplication - see CLAUDE.md).
export default defineConfig({
  base: "./",
  server: {
    fs: {
      allow: ["..", "."],
    },
  },
});
