/**
 * The cutting room, as one file.
 *
 * The bench has to be a published artifact — that is where the film gets
 * looked at and argued about — and an artifact is one HTML page with a strict
 * CSP that will not fetch three.js from anywhere. So this bundles the film,
 * its driver and the whole of three into the page, which is large and is
 * nobody's problem: it is not shipped to a user, it is shipped to a reviewer.
 *
 *   node scripts/build-film-studio.mjs [outfile]
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] || resolve(here, "..", ".film-studio.html");

const res = await build({
  entryPoints: [resolve(here, "film-studio", "studio.js")],
  bundle: true, format: "iife", target: "es2020", minify: true,
  write: false, legalComments: "none",
});
const js = res.outputFiles[0].text;
/* An empty entry point bundles to a valid, silent, four-hundred-byte nothing,
   and the page it lands in renders a film-shaped hole with no error in the
   console. Ask out loud instead. */
if (js.length < 200_000) throw new Error(`bundle is only ${js.length} bytes — is the entry empty?`);
const shell = readFileSync(resolve(here, "film-studio", "shell.html"), "utf8");
if (!shell.includes("/*BUNDLE*/")) throw new Error("shell.html has no /*BUNDLE*/ slot");
writeFileSync(out, shell.replace("/*BUNDLE*/", () => js));
console.log(`${out}  ${(js.length / 1e6).toFixed(2)} MB of script`);
