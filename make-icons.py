"""Generates the PWA icons from the same dartboard mark the header uses.

The header emblem is a CSS conic-gradient, so there's no image file to reuse -
this redraws the same thing (alternating cream wedges with red/green segments
and a bullseye) as real PNGs, using the app's own palette so the taskbar icon
matches the app it opens.
"""
from PIL import Image, ImageDraw

FELT = (15, 61, 46)
CREAM = (239, 230, 210)
INK = (27, 26, 20)
RED = (183, 48, 42)
GREEN = (47, 122, 77)

# Drawn oversized then downsampled - PIL has no antialiasing on pieslice, so
# supersampling is what keeps the wedge edges from looking ragged.
SS = 4


def draw_board(size, padding_ratio):
    """padding_ratio leaves empty space around the board.

    Maskable icons get more, because Android crops them to whatever shape the
    launcher uses; a board drawn edge-to-edge would lose its rim.
    """
    s = size * SS
    img = Image.new("RGBA", (s, s), FELT + (255,))
    d = ImageDraw.Draw(img)

    cx = cy = s / 2
    r = (s / 2) * (1 - padding_ratio)

    # Dark rim so the board reads as an object rather than a flat circle.
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=INK + (255,))

    board_r = r * 0.93
    # 20 wedges. Cream alternates with red/green so it reads as a dartboard
    # at 32px, rather than as a generic colour wheel.
    for i in range(20):
        start = -90 + i * 18
        end = start + 18
        if i % 2 == 0:
            fill = CREAM
        else:
            fill = RED if (i // 2) % 2 == 0 else GREEN
        d.pieslice(
            [cx - board_r, cy - board_r, cx + board_r, cy + board_r],
            start, end, fill=fill + (255,)
        )

    # Triple ring: a band of the opposite colour, which is what makes it
    # recognisable as a dartboard rather than a pinwheel.
    tr_out = board_r * 0.66
    tr_in = board_r * 0.56
    for i in range(20):
        start = -90 + i * 18
        end = start + 18
        fill = GREEN if i % 2 == 0 else RED
        d.pieslice([cx - tr_out, cy - tr_out, cx + tr_out, cy + tr_out],
                   start, end, fill=fill + (255,))
    for i in range(20):
        start = -90 + i * 18
        end = start + 18
        if i % 2 == 0:
            fill = CREAM
        else:
            fill = RED if (i // 2) % 2 == 0 else GREEN
        d.pieslice([cx - tr_in, cy - tr_in, cx + tr_in, cy + tr_in],
                   start, end, fill=fill + (255,))

    # Bullseye.
    bull = board_r * 0.20
    d.ellipse([cx - bull, cy - bull, cx + bull, cy + bull], fill=GREEN + (255,))
    dbull = board_r * 0.10
    d.ellipse([cx - dbull, cy - dbull, cx + dbull, cy + dbull], fill=RED + (255,))

    return img.resize((size, size), Image.LANCZOS)


for size in (192, 512):
    draw_board(size, 0.04).save(f"icon-{size}.png")

# Maskable: extra padding so launcher cropping can't clip the board.
draw_board(512, 0.20).save("icon-maskable-512.png")

# Apple touch icon - iOS ignores the manifest and looks for this.
draw_board(180, 0.04).save("apple-touch-icon.png")

# Favicon, multi-resolution.
draw_board(64, 0.04).save("favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])

print("icons generated")
