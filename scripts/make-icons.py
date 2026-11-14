"""Makes the app icons and the in-app brand mark (public/icons/*.png) from the logo artwork
(brand/quickdicom-logo.png: the hexagon with the implant, on white). The logo sits on a white
tile – as drawn – so it reads the same on the dark interface, the desktop and the home screen.
Run: python3 scripts/make-icons.py"""
from PIL import Image, ImageDraw, ImageFilter

SRC = 'brand/quickdicom-logo.png'


def logo() -> Image.Image:
    """The artwork cropped to the logo itself (its white margin removed)."""
    im = Image.open(SRC).convert('RGB')
    # anything clearly darker than the white background is the logo
    mask = im.convert('L').point(lambda v: 255 if v < 235 else 0)
    return im.crop(mask.getbbox())


LOGO = logo()


def tile(size: int, fill: float, radius: float | None, ss: int = 4) -> Image.Image:
    """A white tile of `size` px (rounded by `radius` × size, or square) with the logo filling
    `fill` of it, centred. Drawn large and scaled down for clean edges."""
    n = size * ss
    out = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    shape = Image.new('L', (n, n), 0)
    d = ImageDraw.Draw(shape)
    if radius is None:
        d.rectangle([0, 0, n, n], fill=255)
    else:
        d.rounded_rectangle([0, 0, n - 1, n - 1], radius=round(radius * n), fill=255)
    out.paste((255, 255, 255, 255), (0, 0), shape)
    w, h = LOGO.size
    k = fill * n / max(w, h)
    lg = LOGO.resize((round(w * k), round(h * k)), Image.LANCZOS)
    out.paste(lg, ((n - lg.width) // 2, (n - lg.height) // 2))
    out.putalpha(shape)  # nothing outside the tile
    return out.resize((size, size), Image.LANCZOS)


# installed app / browser: a rounded white tile (transparent corners)
for size in (192, 512):
    tile(size, 0.8, 0.22).save(f'public/icons/icon-{size}.png')
tile(32, 0.86, 0.2).save('public/icons/favicon-32.png')
# maskable (Android crops it to its own shape): full square, the logo inside the safe zone
tile(512, 0.66, None).save('public/icons/icon-maskable-512.png')
# iOS rounds the corners itself: a full square
tile(180, 0.76, None).convert('RGB').save('public/icons/apple-touch-icon.png')
# the brand mark in the app (toolbar, start screen)
tile(256, 0.82, 0.22).save('public/icons/mark-256.png')
print('icons written')
