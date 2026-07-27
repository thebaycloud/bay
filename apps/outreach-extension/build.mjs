import { context, build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const watch = process.argv.includes("--watch");
const outdir = "dist";

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

/** @type {import("esbuild").BuildOptions} */
const options = {
  entryPoints: {
    background: "src/background/index.ts",
    content: "src/content/index.ts",
    panel: "src/panel/index.ts",
  },
  bundle: true,
  format: "esm",
  target: "chrome120",
  outdir,
  // Sourcemaps are inline so a single unpacked directory is debuggable in
  // DevTools without a separate map-file dance.
  sourcemap: "inline",
  logLevel: "info",
};

function copyStatic() {
  // The source manifest deliberately lives under src/ rather than the package
  // root: with a manifest.json sitting next to package.json, "Load unpacked"
  // accepts the source directory and then fails on the missing bundle.
  cpSync("src/manifest.json", `${outdir}/manifest.json`);
  cpSync("src/panel/panel.html", `${outdir}/panel.html`);
  cpSync("src/panel/panel.css", `${outdir}/panel.css`);
}

if (watch) {
  const ctx = await context({
    ...options,
    plugins: [{ name: "static", setup: (b) => b.onEnd(copyStatic) }],
  });
  await ctx.watch();
  console.log("watching…  load dist/ as an unpacked extension");
} else {
  await build(options);
  copyStatic();
  console.log(`built ${outdir}/  — load it as an unpacked extension`);
}
