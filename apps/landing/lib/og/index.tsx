import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { BRAND } from "../brand";
import { DEFAULT_LOCALE, NEEDS_CJK_FONT, type Locale } from "../i18n/locales";

/**
 * Every page's Open Graph card.
 *
 * One renderer rather than six, because a set of social cards that disagree
 * about where the wordmark sits reads as six different products.
 *
 * 1200x630 is the size Slack, Twitter, iMessage, LinkedIn and Discord all crop
 * from. Anything else gets letterboxed by somebody.
 *
 * The lockup and the headline over the photograph, and nothing else. A card is
 * read at thumbnail size in a feed, where a description under the title is
 * unreadable and a footer repeating the domain is already in the link preview
 * the card is attached to.
 *
 * The frame is the hero video's, cropped to the card's 1.90:1 rather than
 * letterboxed from 16:9, so the tower stays at the left edge and the ship stays
 * in shot. Cropped and compressed at 1200x630 on disk rather than at render
 * time: the source PNG is 2.6 MB and satori would base64 the whole thing into
 * every card.
 *
 * The photograph is nearly white, which is the problem it has to solve. Type
 * over it needs either a dark scrim or a dark type colour, and dark type on fog
 * is unreadable at thumbnail size. So: a scrim, weighted to the bottom left
 * where the type sits, and white type over it.
 *
 * CJK is set in a subset of Noto, loaded only on the three locales that need it.
 * Geist is listed first, so satori takes Latin from Geist and only reaches for
 * Noto for a glyph Geist does not have: brand names and commands inside a
 * Chinese headline still set in the site's own face. The subsets come from
 * scripts/subset-og-fonts.mjs; `--check` fails when new copy introduces a glyph
 * they are missing, which would otherwise ship as a blank box.
 *
 * Two satori quirks are load-bearing here, and both fail silently by drawing the
 * bare photograph with unreadable type on it:
 *
 *   1. An absolutely positioned box is sized from its own width and height.
 *      `inset: 0` is not resolved the way a browser resolves it, so a scrim
 *      written that way is zero pixels tall.
 *   2. The `background` shorthand parses a hex colour and drops `rgba()` and
 *      `linear-gradient()`. Scrims have to say `backgroundColor` and
 *      `backgroundImage` explicitly.
 */

const FONTS = join(process.cwd(), "node_modules/geist/dist/fonts/geist-sans");
const HERE = join(process.cwd(), "lib/og");

function face(file: string) {
  return readFileSync(join(FONTS, file));
}

function dataUri(path: string, mime: string) {
  return `data:${mime};base64,${readFileSync(path).toString("base64")}`;
}

const PAPER = "#FAFAFA";
const BRAND_RED = "#E63F2C";

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_CONTENT_TYPE = "image/png";

/** Which Noto subset a locale needs, if any. */
const CJK_FACE: Partial<Record<Locale, string>> = {
  "zh-Hans": "noto-sc.ttf",
  "zh-Hant": "noto-tc.ttf",
  ja: "noto-jp.ttf",
};

export interface OgCard {
  title: string;
  eyebrow?: string;
  /** Decides whether a CJK face is loaded. Defaults to English. */
  locale?: Locale;
}

/**
 * Geist first, then the locale's CJK face if it has one. satori resolves a glyph
 * against this list in order, which is what keeps Latin in Geist on a Chinese
 * card rather than falling wholesale to Noto.
 */
function cjk(locale: Locale) {
  const fonts = [
    { name: "Geist", data: face("Geist-Regular.ttf"), weight: 400 as const, style: "normal" as const },
    { name: "Geist", data: face("Geist-Medium.ttf"), weight: 500 as const, style: "normal" as const },
  ];
  const file = NEEDS_CJK_FONT[locale] ? CJK_FACE[locale] : undefined;
  if (file) {
    fonts.push({
      name: "Noto",
      data: readFileSync(join(HERE, "fonts", file)),
      weight: 400 as const,
      style: "normal" as const,
    });
  }
  return fonts;
}

export function ogCard({ title, eyebrow, locale = DEFAULT_LOCALE }: OgCard) {
  const photo = dataUri(join(HERE, "bridge.jpg"), "image/jpeg");
  const markSvg = dataUri(join(process.cwd(), "public/logo-bay.svg"), "image/svg+xml");

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          position: "relative",
          fontFamily: "Geist",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
        <img
          height={630}
          src={photo}
          style={{ position: "absolute", top: 0, left: 0, objectFit: "cover" }}
          width={1200}
        />

        {/* Two scrims, not one. A flat wash over a photograph this bright either
            leaves the type unreadable or kills the picture. The first darkens
            everything a little so white type has something to sit on at all; the
            second is a diagonal that is heavy at the bottom left, where the
            headline is, and clears by the top right, where the sky and the city
            are worth seeing. */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: 1200,
            height: 630,
            backgroundColor: "rgba(8, 12, 20, 0.46)",
          }}
        />
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: 1200,
            height: 630,
            backgroundImage:
              "linear-gradient(38deg, rgba(4,8,14,0.92) 0%, rgba(4,8,14,0.74) 32%, rgba(4,8,14,0.34) 64%, rgba(4,8,14,0.10) 100%)",
          }}
        />

        {/* The accent rule, as on the flat card. */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: 1200,
            height: 10,
            backgroundColor: BRAND_RED,
          }}
        />

        <div
          style={{
            position: "relative",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            width: "100%",
            padding: "68px 76px 76px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            {/* eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text */}
            <img height={52} src={markSvg} width={52} />
            <span
              style={{
                fontSize: 40,
                fontWeight: 500,
                letterSpacing: "-0.03em",
                color: PAPER,
              }}
            >
              {BRAND}
            </span>
          </div>

          <div style={{ display: "flex", flexDirection: "column" }}>
            {eyebrow ? (
              <span
                style={{
                  fontSize: 24,
                  letterSpacing: "0.14em",
                  textTransform: "uppercase",
                  color: "rgba(250,250,250,0.72)",
                  marginBottom: 24,
                }}
              >
                {eyebrow}
              </span>
            ) : null}

            <span
              style={{
                fontSize: title.length > 46 ? 68 : 82,
                fontWeight: 400,
                lineHeight: 1.06,
                letterSpacing: "-0.03em",
                color: PAPER,
                maxWidth: 900,
              }}
            >
              {title}
            </span>
          </div>
        </div>
      </div>
    ),
    {
      ...OG_SIZE,
      fonts: cjk(locale),
    }
  );
}
