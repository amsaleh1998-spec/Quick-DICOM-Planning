"""Draws the app icons (public/icons/*.png): an implant with a crown on a dark tile.
Run: python3 scripts/make-icons.py"""
from PIL import Image, ImageDraw

def icon(size, maskable=False):
    s = size / 512
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = 0 if maskable else int(24 * s)
    radius = 0 if maskable else int(96 * s)
    d.rounded_rectangle([pad, pad, size - pad, size - pad], radius=radius, fill=(19, 26, 38, 255))
    k = 0.8 if maskable else 1.0  # keep the motif inside the maskable safe zone
    def X(v): return size / 2 + (v - 256) * s * k
    def Y(v): return size / 2 + (v - 256) * s * k
    # crown (tooth) on top
    d.rounded_rectangle([X(156), Y(92), X(356), Y(206)], radius=int(46 * s * k), fill=(232, 236, 244, 255))
    # abutment
    d.polygon([(X(214), Y(206)), (X(298), Y(206)), (X(286), Y(244)), (X(226), Y(244))], fill=(140, 180, 230, 255))
    # implant body (tapered) with threads
    d.polygon([(X(206), Y(244)), (X(306), Y(244)), (X(286), Y(420)), (X(226), Y(420))], fill=(79, 179, 255, 255))
    for i in range(6):
        y = 268 + i * 26
        w = 50 - i * 3.2
        d.line([(X(256 - w - 8), Y(y)), (X(256 + w + 8), Y(y + 10))], fill=(19, 26, 38, 255), width=max(1, int(7 * s * k)))
    return img

for size in (192, 512):
    icon(size).save(f'public/icons/icon-{size}.png')
icon(512, maskable=True).save('public/icons/icon-maskable-512.png')
icon(180).convert('RGB').save('public/icons/apple-touch-icon.png')
print('icons written')
