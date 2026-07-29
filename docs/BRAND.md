# The mark

Supersonic's mark is **two leaning bars** — the slash out of `supersonic.cv`, and
the comment marker our users type all day. It leans forward, so it reads as pace
without illustrating anything.

## The one rule

**An icon is not one drawing at many sizes. It's several drawings, each cut for
where it lands.** Everything below follows from that.

Two things break a mark that is merely scaled down:

- **Thin features collapse.** At 16px a bar 5/24 of the height is 3.3 device
  pixels, and the gap between the bars is 1.7. Both turn to grey mush.
- **Light-on-dark loses weight.** A white glyph on green reads thinner than the
  same glyph in green on paper, because antialiasing bleeds the background
  inward. Knockouts need extra mass to look like the same weight.

## Geometry

All drawings are two parallelograms, optically centred. `lean` is the horizontal
run per 12 units of drop, so 5 means 5:12.

| Drawing | Board | Cap | Bar | Gap | Lean | Used for |
|---|---|---|---|---|---|---|
| `regular` | 24 | 20 | 5 | 2.6 | 5:12 | positive, ≥ 24px |
| `compact` | 24 | 22 | 6 | 3 | 4:12 | positive, < 24px |
| `knockout` | 24 | 21 | 6.8 | 2.6 | 4:12 | light on dark, any size |
| `favicon` | 32 | 20 | 5 | 3 | 4:12 | favicon.svg, 32px png |
| `favicon-16` | 16 | 10 | 3 | 1.6 | 4:12 | 16px png only |
| `app icon` | 32 | 16 | 4.2 | 2.6 | 4:12 | apple-touch, PWA, maskable |

`scripts/brand-assets.py` is the source of truth for the raster assets and
carries the same numbers. Change them in both places together.

## Two kinds of artboard

**Glyph** (24-unit, transparent, `currentColor`) — the mark alone. The container
supplies colour and padding. This is what `<Mark />` renders, and it's what goes
inline in a nav, a button or a line of text.

**Badge** (32-unit, own background, opaque) — the mark *and* its field, padding
baked in. Used wherever we don't control the surroundings: favicon, app icons,
OG image, social avatars.

Using one artboard for both is the usual mistake. A glyph with baked-in padding
can't be optically aligned in a nav; a bare glyph handed to iOS gets cropped or
floats in the middle of a rounded square.

## Using it in the apps

```tsx
import { Mark } from "@/components/Mark";

<Mark size={15} onDark />   // inside the accent chip
<Mark size={28} />          // on paper
```

`size` picks the drawing — it is not just a scale factor. `onDark` selects the
knockout. Don't pass `variant` unless you're doing something unusual.

The mark inherits `currentColor`, so it takes the colour of whatever it sits in.
Never hardcode a fill on the glyph.

### Proportions

- **In the accent chip:** glyph ≈ **64%** of the chip. A 22px chip takes a 14px
  glyph, 24px takes 15px, 26px takes 16px. Below ~59% it reads as a dot in a box.
- **Clear space:** one bar width (≈20% of the mark's height) on all four sides.
  It's derived from the mark, so it scales with it.
- **In a lockup:** align the mark's cap height to the wordmark's cap height, not
  to its em box. Gap between them ≈ 0.6× the mark height.

### Minimum sizes

- Glyph: **16px**. Below that use the favicon badge.
- Lockup with wordmark: **100px** wide. Below that, drop the wordmark.

## Never

- Outline it, or add a stroke.
- Change the lean, or add a third bar.
- Rotate it.
- Put the bare glyph on a photo or a busy background — use the badge.
- Recolour to anything but the accent, ink, or paper.

## Assets

Regenerate everything with:

```bash
python3 scripts/brand-assets.py     # needs Pillow
```

It writes into `apps/landing/public` and `apps/web/public`:

| File | Size | Notes |
|---|---|---|
| `favicon.svg` | 32 | Preferred by modern browsers, sharp at any zoom |
| `favicon-32.png` `favicon-16.png` | 32, 16 | Each drawn at its real size |
| `favicon.ico` | 32, 48 | Legacy fallback only |
| `apple-touch-icon.png` | 180 | Opaque, no transparency — iOS rounds it itself |
| `icon-192.png` `icon-512.png` | 192, 512 | PWA; glyph inside the middle 55% so maskable crops are safe |
| `og.png` | 1200×630 | Social preview |
| `mark.svg` `mark-white.svg` | — | For decks, README, anywhere outside the apps |

## Where the mark lives

Three consumers, three formats, no shared package (there's no npm workspace):

| Consumer | File |
|---|---|
| Landing | `apps/landing/components/Mark.tsx` |
| Cockpit | `apps/web/components/Mark.tsx` |
| Badge injected into every customer app | `MARK()` in `services/proxy/src/inject.ts` |

These are deliberate copies. If you change the geometry, change all three plus
`scripts/brand-assets.py`.
