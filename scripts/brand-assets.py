#!/usr/bin/env python3
"""Generate every raster brand asset from one source of geometry.

    python3 scripts/brand-assets.py

Writes favicons, app icons and the OG banner into apps/landing/public and
apps/web/public. Rasterises with 4x supersampling so the diagonals stay clean
at 16px. Geometry lives in docs/BRAND.md — change it there and here together.

Only dependency is Pillow:  pip install Pillow
"""

from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
TARGETS = [ROOT / "apps/landing/public", ROOT / "apps/web/public"]

PAPER = (245, 244, 239)
INK = (21, 20, 15)
ACCENT = (11, 94, 56)
SS = 4  # supersampling factor


def bars(cap_top, cap_h, width, gap, lean, board):
    """Two parallelograms, optically centred on a square artboard.

    lean is the horizontal run per 12 units of drop (5 = 5:12).
    Returns polygons in artboard units.
    """
    dx = cap_h * lean / 12.0
    total = 2 * width + gap + dx
    left = (board - total) / 2.0
    xt = left + dx  # top-left x of the trailing bar
    bottom = cap_top + cap_h
    out = []
    for i in range(2):
        x = xt + i * (width + gap)
        out.append([
            (x, cap_top),
            (x + width, cap_top),
            (x + width - dx, bottom),
            (x - dx, bottom),
        ])
    return out


# --- the four drawings -------------------------------------------------------
# 24-unit artboards are the in-app glyphs; 32-unit ones are self-contained badges.
GLYPH_REGULAR = bars(cap_top=2, cap_h=20, width=5, gap=2.6, lean=5, board=24)
GLYPH_COMPACT = bars(cap_top=1, cap_h=22, width=6, gap=3, lean=4, board=24)
GLYPH_KNOCKOUT = bars(cap_top=1.5, cap_h=21, width=6.8, gap=2.6, lean=4, board=24)

# Favicon: its own drawing. Bigger glyph-to-box ratio than the chip, because at
# 16px there is no surrounding UI to carry the brand.
BADGE_FAVICON = bars(cap_top=6, cap_h=20, width=5, gap=3, lean=4, board=32)
# 16px gets its own drawing again: a 2.5px bar cannot be crisp, so widen to ~3px
# and open the gap. Below ~20px this is the only thing that reads.
BADGE_FAVICON_16 = bars(cap_top=3, cap_h=10, width=3, gap=1.6, lean=4, board=16)
# App icon: more padding. iOS rounds the corners and Android may mask to a
# circle, so the glyph stays inside the middle ~55%.
BADGE_APP = bars(cap_top=8, cap_h=16, width=4.2, gap=2.6, lean=4, board=32)


def render(polys, board, px, fg, bg=None):
    """Rasterise polygons (in `board` units) to a `px` square image."""
    n = px * SS
    im = Image.new("RGBA", (n, n), (*bg, 255) if bg else (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    k = n / board
    for p in polys:
        d.polygon([(x * k, y * k) for x, y in p], fill=(*fg, 255))
    # Area average, not LANCZOS: at these reductions LANCZOS rings and the
    # diagonals come out furry.
    return im.resize((px, px), Image.BOX)


def svg(polys, board, fg, bg=None, px=None):
    size = px or board
    body = ""
    if bg:
        body += f'<rect width="{board}" height="{board}" fill="rgb{bg}"/>'
    for p in polys:
        pts = " ".join(f"{x:.2f},{y:.2f}" for x, y in p)
        body += f'<polygon points="{pts}" fill="{fg}"/>'
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
        f'viewBox="0 0 {board} {board}">{body}</svg>\n'
    )


MONO_FONTS = [
    "/System/Library/Fonts/SFNSMono.ttf",
    "/System/Library/Fonts/Menlo.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationMono-Bold.ttf",
]


def load_font(size):
    from PIL import ImageFont

    for path in MONO_FONTS:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return None


def og_banner(w=1200, h=630):
    """Paper ground, graph grid, oversized mark, wordmark, tagline."""
    n = 2
    im = Image.new("RGB", (w * n, h * n), PAPER)
    d = ImageDraw.Draw(im)
    step, grid = 40 * n, (227, 225, 215)
    for x in range(0, w * n, step):
        d.line([(x, 0), (x, h * n)], fill=grid, width=n)
    for y in range(0, h * n, step):
        d.line([(0, y), (w * n, y)], fill=grid, width=n)

    board, size = 24, 210 * n
    k = size / board
    ox, oy = (w * n - size) / 2, (h * n) / 2 - size - 8 * n
    for p in GLYPH_REGULAR:
        d.polygon([(ox + x * k, oy + y * k) for x, y in p], fill=ACCENT)

    name = load_font(64 * n)
    tag = load_font(28 * n)
    if name:
        t = "SUPERSONIC"
        tw = d.textlength(t, font=name)
        d.text(((w * n - tw) / 2, (h * n) / 2 + 30 * n), t, font=name, fill=INK)
    if tag:
        t = "Deploy anything in one click"
        tw = d.textlength(t, font=tag)
        d.text(((w * n - tw) / 2, (h * n) / 2 + 118 * n), t, font=tag, fill=(84, 82, 74))

    return im.resize((w, h), Image.LANCZOS)


def main():
    files = {}

    files["favicon.svg"] = svg(BADGE_FAVICON, 32, "#F5F4EF", ACCENT)
    files["mark.svg"] = svg(GLYPH_REGULAR, 24, "#0B5E38", px=240)
    files["mark-white.svg"] = svg(GLYPH_KNOCKOUT, 24, "#FFFFFF", px=240)

    png = {
        "favicon-16.png": render(BADGE_FAVICON_16, 16, 16, PAPER, ACCENT),
        "favicon-32.png": render(BADGE_FAVICON, 32, 32, PAPER, ACCENT),
        "apple-touch-icon.png": render(BADGE_APP, 32, 180, PAPER, ACCENT),
        "icon-192.png": render(BADGE_APP, 32, 192, PAPER, ACCENT),
        "icon-512.png": render(BADGE_APP, 32, 512, PAPER, ACCENT),
        "og.png": og_banner(),
    }

    # Legacy fallback only. Modern browsers take favicon.svg or the explicit
    # 16/32 PNGs declared in metadata, which are drawn at their real sizes.
    ico = render(BADGE_FAVICON, 32, 48, PAPER, ACCENT)

    for out in TARGETS:
        out.mkdir(parents=True, exist_ok=True)
        for name, text in files.items():
            (out / name).write_text(text)
        for name, im in png.items():
            im.save(out / name)
        ico.save(out / "favicon.ico", sizes=[(32, 32), (48, 48)])
        print("wrote", len(files) + len(png) + 1, "files to", out.relative_to(ROOT))


if __name__ == "__main__":
    main()
