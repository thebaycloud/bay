#!/usr/bin/env node
/**
 * Subsets Noto Sans SC/TC/JP down to the CJK this site actually sets.
 *
 *   node scripts/subset-og-fonts.mjs           write the subsets
 *   node scripts/subset-og-fonts.mjs --check   fail if a subset is missing a glyph
 *
 * WHY SUBSET
 *
 * The Open Graph cards are drawn by satori, which needs real font bytes rather
 * than a CSS reference. Geist has no CJK, and satori draws a missing glyph as a
 * blank rectangle, so a Chinese or Japanese card set in Geist alone comes back as
 * a row of tofu. The full faces are 23 MB together, which is not something to
 * commit to a marketing site. Every glyph in the catalogues together is a few
 * hundred, and those weigh a few tens of kilobytes.
 *
 * WHY THE SOURCE IS THE WHOLE CATALOGUE, NOT THE CARD STRINGS
 *
 * Subsetting to exactly the six headlines a card can show would be smaller and
 * would break the first time somebody edits one, silently, in production, as a
 * blank box. Taking every CJK character in the locale's catalogue means any
 * string promoted onto a card later is already covered, and `--check` catches
 * the case where new copy introduces a character the subset does not have.
 *
 * Requires fonttools (`pyftsubset`), which is how it fails loudly if absent.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "apps/landing/lib/og/fonts");
const CATALOGUES = join(ROOT, "apps/landing/lib/i18n/messages");

/** Where the full faces are cached between runs. Not committed. */
const CACHE = join(ROOT, ".cache/noto");

const FACES = [
  { tag: "sc", family: "Noto+Sans+SC", catalogue: "zh-Hans.ts", out: "noto-sc.ttf" },
  { tag: "tc", family: "Noto+Sans+TC", catalogue: "zh-Hant.ts", out: "noto-tc.ttf" },
  { tag: "jp", family: "Noto+Sans+JP", catalogue: "ja.ts", out: "noto-jp.ttf" },
];

/**
 * Every character worth keeping from one catalogue.
 *
 * CJK ideographs, kana, and the punctuation those scripts use. Latin is left out
 * deliberately: it is set in Geist, which comes first in satori's font list, so
 * carrying a second copy of the alphabet in every subset would be waste.
 */
const KEEP =
  /[　-〿぀-ゟ゠-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/u;

function charsFor(catalogue) {
  const text = readFileSync(join(CATALOGUES, catalogue), "utf8");
  const set = new Set();
  for (const ch of text) if (KEEP.test(ch)) set.add(ch);
  return [...set].sort().join("");
}

function ensureFull(face) {
  mkdirSync(CACHE, { recursive: true });
  const full = join(CACHE, `${face.tag}-full.ttf`);
  if (existsSync(full) && statSync(full).size > 1_000_000) return full;

  console.log(`  fetching ${face.family}`);
  const css = execFileSync("curl", [
    "-s", "--max-time", "30",
    "-A", "Mozilla/5.0 (Macintosh)",
    `https://fonts.googleapis.com/css2?family=${face.family}:wght@400`,
  ]).toString();
  const url = css.match(/https:\/\/[^)]*\.ttf/)?.[0];
  if (!url) throw new Error(`no ttf url for ${face.family}`);
  execFileSync("curl", ["-s", "--max-time", "120", url, "-o", full]);
  return full;
}

const check = process.argv.includes("--check");
mkdirSync(OUT, { recursive: true });
let bad = 0;

for (const face of FACES) {
  const chars = charsFor(face.catalogue);
  const target = join(OUT, face.out);

  if (check) {
    if (!existsSync(target)) {
      console.error(`  MISSING  ${face.out}`);
      bad++;
      continue;
    }
    // Ask the subset which codepoints it has, and compare.
    const have = execFileSync("python3", [
      "-c",
      `import sys
from fontTools.ttLib import TTFont
f = TTFont(sys.argv[1])
cps = set()
for t in f['cmap'].tables: cps |= set(t.cmap.keys())
sys.stdout.write(''.join(chr(c) for c in sorted(cps)))`,
      target,
    ]).toString();
    const missing = [...chars].filter((c) => !have.includes(c));
    if (missing.length) {
      console.error(
        `  DRIFTED  ${face.out}: ${missing.length} glyph(s) in ${face.catalogue} are not in the subset -> ${missing.slice(0, 12).join("")}`
      );
      bad++;
    } else {
      console.log(`  ok       ${face.out}  (${chars.length} glyphs)`);
    }
    continue;
  }

  const full = ensureFull(face);
  const list = join(CACHE, `${face.tag}.txt`);
  writeFileSync(list, chars);
  execFileSync("pyftsubset", [
    full,
    `--output-file=${target}`,
    `--text-file=${list}`,
    "--no-hinting",
    "--desubroutinize",
    "--layout-features=",
    "--drop-tables+=GSUB,GPOS,DSIG",
    "--name-IDs=",
    "--notdef-outline",
  ]);
  const kb = Math.round(statSync(target).size / 1024);
  console.log(`  wrote    ${face.out}  ${chars.length} glyphs, ${kb} KB`);
}

if (check && bad) {
  console.error(`\n${bad} subset(s) out of date. Run: node scripts/subset-og-fonts.mjs`);
  process.exit(1);
}
