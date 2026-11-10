"""Mouse cursors for the composite: drawn as vectors (supersampled), white with a dark outline and a soft
shadow, in a 32-unit box. `sprite(name, px)` returns (RGBA image, hotspot) at the wanted size."""
from functools import lru_cache
from PIL import Image, ImageDraw, ImageFilter, ImageChops

SS = 8  # supersampling
BOX = 32


def _canvas():
    return Image.new('L', (BOX * SS, BOX * SS), 0)


def _poly(mask, pts):
    ImageDraw.Draw(mask).polygon([(x * SS, y * SS) for x, y in pts], fill=255)


def _rrect(mask, x0, y0, x1, y1, r):
    ImageDraw.Draw(mask).rounded_rectangle([x0 * SS, y0 * SS, x1 * SS, y1 * SS], radius=r * SS, fill=255)


def _line(mask, a, b, w):
    d = ImageDraw.Draw(mask)
    d.line([a[0] * SS, a[1] * SS, b[0] * SS, b[1] * SS], fill=255, width=int(w * SS))


def _arrow_head(mask, tip, direction, size=4.2, width=4.6):
    tx, ty = tip
    dx, dy = direction
    px, py = -dy, dx
    _poly(mask, [(tx, ty), (tx - dx * size + px * width / 2, ty - dy * size + py * width / 2), (tx - dx * size - px * width / 2, ty - dy * size - py * width / 2)])


def _shape(name):
    """Returns (fill mask, hotspot, fill colour, outline colour)."""
    m = _canvas()
    white, black = (255, 255, 255), (18, 18, 20)
    if name == 'default':
        # the classic arrow: tip at the hotspot
        _poly(m, [(4, 3), (4, 23.6), (9.1, 18.9), (12.9, 27.2), (16.3, 25.7), (12.6, 17.6), (19.3, 17.6)])
        return m, (4, 3), black, white
    if name in ('pointer', 'grab', 'grabbing'):
        # a hand: index finger up for links and buttons, open for grab, closed for grabbing
        up = {'pointer': [5.0, 12.5, 13.0, 14.0], 'grab': [7.0, 5.5, 6.5, 9.0], 'grabbing': [12.5, 11.5, 12.0, 13.5]}[name]
        xs = [10.2, 14.4, 18.6, 22.6]
        for x, top in zip(xs, up):
            _rrect(m, x, top, x + 4.0, 22, 2.0)
        _rrect(m, 10.2, 15.5, 26.6, 28.5, 5.0)  # palm
        # thumb
        t = _canvas()
        _rrect(t, 4.2, 15.2, 12.5, 19.4, 2.1)
        t = t.rotate(-32, center=(10 * SS, 18 * SS), resample=Image.BICUBIC)
        m = ImageChops.lighter(m, t)
        hot = (12.2, 5.6) if name == 'pointer' else (16, 14)
        return m, hot, white, black
    if name == 'crosshair':
        for a, b in (((16, 4), (16, 13)), ((16, 19), (16, 28)), ((4, 16), (13, 16)), ((19, 16), (28, 16))):
            _line(m, a, b, 1.7)
        return m, (16, 16), white, black
    if name in ('ew-resize', 'col-resize', 'ns-resize', 'row-resize', 'move'):
        horiz = name in ('ew-resize', 'col-resize', 'move')
        vert = name in ('ns-resize', 'row-resize', 'move')
        if horiz:
            _line(m, (8, 16), (24, 16), 2.2)
            _arrow_head(m, (4.5, 16), (-1, 0))
            _arrow_head(m, (27.5, 16), (1, 0))
        if vert:
            _line(m, (16, 8), (16, 24), 2.2)
            _arrow_head(m, (16, 4.5), (0, -1))
            _arrow_head(m, (16, 27.5), (0, 1))
        if name == 'col-resize':
            _line(m, (16, 8.5), (16, 23.5), 2.2)
        return m, (16, 16), black, white
    if name == 'text':
        _line(m, (16, 6), (16, 26), 1.8)
        _line(m, (12.5, 5.5), (19.5, 5.5), 1.8)
        _line(m, (12.5, 26.5), (19.5, 26.5), 1.8)
        return m, (16, 16), black, white
    return _shape('default')


ALIASES = {'auto': 'default', 'alias': 'default', 'copy': 'default', 'not-allowed': 'default', 'zoom-in': 'default', 'all-scroll': 'move', 'nwse-resize': 'move', 'nesw-resize': 'move', 'w-resize': 'ew-resize', 'e-resize': 'ew-resize', 'n-resize': 'ns-resize', 's-resize': 'ns-resize', 'context-menu': 'default', 'help': 'default', 'wait': 'default', 'progress': 'default', 'none': 'default', 'cell': 'crosshair'}


@lru_cache(maxsize=None)
def _master(name):
    name = ALIASES.get(name, name)
    mask, hot, fill, outline = _shape(name)
    big = mask.size[0]
    edge = mask.filter(ImageFilter.MaxFilter(int(1.25 * SS) * 2 + 1))  # outline: the shape grown by 1.25 units
    img = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    # soft drop shadow
    sh = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    sh.paste((0, 0, 0, 120), (int(0.6 * SS), int(1.4 * SS)), edge)
    img = Image.alpha_composite(img, sh.filter(ImageFilter.GaussianBlur(1.3 * SS)))
    o = Image.new('RGBA', (big, big), outline + (255,))
    o.putalpha(edge)
    img = Image.alpha_composite(img, o)
    f = Image.new('RGBA', (big, big), fill + (255,))
    f.putalpha(mask)
    img = Image.alpha_composite(img, f)
    return img, hot


@lru_cache(maxsize=256)
def sprite(name, px):
    """Cursor image `px` pixels across (the 32-unit box) and its hotspot in pixels."""
    img, hot = _master(name)
    px = max(8, int(round(px)))
    out = img.resize((px, px), Image.LANCZOS)
    return out, (hot[0] * px / BOX, hot[1] * px / BOX)


if __name__ == '__main__':
    names = ['default', 'pointer', 'grab', 'grabbing', 'crosshair', 'ew-resize', 'col-resize', 'ns-resize', 'move', 'text']
    sheet = Image.new('RGB', (len(names) * 110, 240), (40, 44, 52))
    for i, n in enumerate(names):
        for j, px in enumerate((96, 44)):
            s, h = sprite(n, px)
            bg = (40, 44, 52) if j == 0 else (200, 200, 205)
            ImageDraw.Draw(sheet).rectangle([i * 110, j * 120, i * 110 + 109, j * 120 + 119], fill=bg)
            sheet.paste(s, (i * 110 + 7, j * 120 + 10), s)
    sheet.save('cursors.png')
    print('ok')
