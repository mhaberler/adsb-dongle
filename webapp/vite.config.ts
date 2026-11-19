import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { defineConfig, type Plugin } from "vite";

// Relative base: the same build runs from any path - the Hetzner vhost
// root, `bun run preview` on localhost, or a subdirectory.
export default defineConfig({
  base: "./",
  plugins: [serviceWorker()],
});

// Writes dist/sw.js after the build: precaches every file in dist/ so the
// app starts offline after one online visit (PWA). The cache name carries
// a hash over all file contents, so each deploy that changes anything
// yields a byte-different sw.js, which the browser installs as an update.
// Source: src/sw-template.js (plain JS, not bundled - a service worker is
// a separate script with its own global scope).
function serviceWorker(): Plugin {
  let outDir = "dist";
  return {
    name: "adsb-service-worker",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const files = listFiles(outDir)
        .map((f) => relative(outDir, f).split("\\").join("/"))
        .filter((f) => f !== "sw.js" && !f.endsWith(".DS_Store"))
        .sort();
      const template = readFileSync(new URL("./src/sw-template.js", import.meta.url), "utf8");
      const hash = createHash("sha256").update(template);
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)));
      const version = hash.digest("hex").slice(0, 12);
      const sw = template
        .replace('"adsb-__VERSION__"', JSON.stringify(`adsb-${version}`))
        .replace("= __ASSETS__;", `= ${JSON.stringify(["./", ...files.filter((f) => f !== "index.html")])};`);
      writeFileSync(join(outDir, "sw.js"), sw);
    },
  };
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)],
  );
}
