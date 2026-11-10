"""Draws the app icons (public/icons/*.png): an implant with its crown, in titanium on a graphite
tile (the brand mark of index.html, #qdp-mark).
Run: python3 scripts/make-icons.py"""
from PIL import Image, ImageDraw

SS = 4  # supersampling


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3)) + (255,)


def gradient(size, stops, horizontal=False):
    """stops: [(position 0..1, (r, g, b))]"""
    img = Image.new('RGBA', (size, size))
    d = ImageDraw.Draw(img)
    for i in range(size):
        t = i / (size - 1)
        for (p0, c0), (p1, c1) in zip(stops, stops[1:]):
            if p0 <= t <= p1:
                col = lerp(c0, c1, (t - p0) / max(1e-6, p1 - p0))
                break
        if horizontal:
            d.line([(i, 0), (i, size)], fill=col)
        else:
            d.line([(0, i), (size, i)], fill=col)
    return img


def icon(size, maskable=False):
    n = size * SS
    s = n / 64
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    tile = Image.new('L', (n, n), 0)
    pad = 0 if maskable else round(3 * s)
    ImageDraw.Draw(tile).rounded_rectangle([pad, pad, n - pad, n - pad], radius=0 if maskable else round(13 * s), fill=255)
    img.paste(gradient(n, [(0, (59, 59, 65)), (1, (29, 29, 32))]), (0, 0), tile)
    k = 0.78 if maskable else 0.94  # the motif stays inside the maskable safe zone

    def P(x, y):
        return (n / 2 + (x - 32) * s * k, n / 2 + (y - 33) * s * k)

    def shape(draw_fn, fill_img):
        m = Image.new('L', (n, n), 0)
        draw_fn(ImageDraw.Draw(m))
        img.paste(fill_img, (0, 0), m)

    # crown
    shape(lambda d: d.rounded_rectangle([*P(19.5, 11), *P(44.5, 26)], radius=round(6 * s * k), fill=255), gradient(n, [(0, (255, 255, 255)), (0.15, (255, 255, 255)), (0.45, (220, 220, 226)), (1, (220, 220, 226))]))
    # abutment
    shape(lambda d: d.polygon([P(26.5, 26), P(37.5, 26), P(36.1, 31), P(27.9, 31)], fill=255), Image.new('RGBA', (n, n), (180, 180, 188, 255)))
    # implant body: brushed titanium, lit from the middle
    x0, x1 = P(25.8, 0)[0] / n, P(38.2, 0)[0] / n
    metal = gradient(n, [(0, (140, 140, 149)), (x0, (140, 140, 149)), (x0 + (x1 - x0) * 0.45, (241, 241, 244)), (x1, (150, 150, 159)), (1, (150, 150, 159))], horizontal=True)
    shape(lambda d: d.polygon([P(25.8, 31), P(38.2, 31), P(35.4, 54.2), P(34.2, 55), P(29.8, 55), P(28.6, 54.2)], fill=255), metal)
    d = ImageDraw.Draw(img)
    for i in range(4):
        y = 35.6 + i * 4.6
        d.line([P(26.3 + i * 0.5, y), P(37.8 - i * 0.5, y - 1.6)], fill=(29, 29, 32, 200), width=max(1, round(1.5 * s * k)))
    return img.resize((size, size), Image.LANCZOS)


for size in (192, 512):
    icon(size).save(f'public/icons/icon-{size}.png')
icon(512, maskable=True).save('public/icons/icon-maskable-512.png')
bg = Image.new('RGB', (180, 180), (24, 24, 26))
ic = icon(180, maskable=True)
bg.paste(ic, (0, 0), ic)
bg.save('public/icons/apple-touch-icon.png')
print('icons written')
