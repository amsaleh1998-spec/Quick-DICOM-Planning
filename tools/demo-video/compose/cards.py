"""Title cards: the opening (name and promise) and the closing (where to open it)."""
import os

from PIL import Image, ImageDraw, ImageFilter

from engine import ACCENT, FPS, H, INK, MUTED, W, blend_f, draw_text, ease_out, font, rgba_to_bgra, text_width

ICON = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', 'public', 'icons', 'icon-512.png')
URL = 'quickdicom.app'
_cache = {}


def _text(text, weight, size, color=INK, tracking=None, display=True):
    key = ('t', text, weight, size, color, tracking, display)
    if key not in _cache:
        f = font(weight, size, display)
        tr = -size * 0.018 if tracking is None else tracking
        w = int(text_width(f, text, tr)) + 8
        img = Image.new('RGBA', (w, int(size * 1.4)), (0, 0, 0, 0))
        draw_text(ImageDraw.Draw(img), (2, size * 0.1), text, f, color + (255,), tr)
        _cache[key] = rgba_to_bgra(img)
    return _cache[key]


def _icon(size):
    key = ('i', size)
    if key not in _cache:
        img = Image.open(ICON).convert('RGBA').resize((size, size), Image.LANCZOS)
        # a soft glow under the tile
        pad = size // 2
        canvas = Image.new('RGBA', (size + 2 * pad, size + 2 * pad), (0, 0, 0, 0))
        glow = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
        ImageDraw.Draw(glow).rounded_rectangle([pad, pad + size * 0.08, pad + size, pad + size * 1.08], radius=size * 0.2, fill=ACCENT + (70,))
        canvas = Image.alpha_composite(canvas, glow.filter(ImageFilter.GaussianBlur(size * 0.16)))
        canvas.alpha_composite(img, (pad, pad))
        _cache[key] = (rgba_to_bgra(canvas), pad)
    return _cache[key]


def _pill(text, size):
    key = ('p', text, size)
    if key not in _cache:
        f = font('Medium', size, display=False)
        tw = f.getlength(text)
        padx, pady = int(size * 1.0), int(size * 0.62)
        w, h = int(tw + 2 * padx), int(size * 1.25 + 2 * pady)
        img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        d.rounded_rectangle([1, 1, w - 2, h - 2], radius=h // 2, fill=(79, 179, 255, 30), outline=ACCENT + (235,), width=2)
        d.text((padx, h / 2 - size * 0.03), text, font=f, fill=INK + (255,), anchor='lm')
        _cache[key] = rgba_to_bgra(img)
    return _cache[key]


def _rise(frame, spr, cx, y, t, start, dur=0.5, dist=26):
    """Place a sprite centred on cx; it fades in and rises into place from `start` seconds."""
    u = ease_out((t - start) / dur)
    if u <= 0:
        return
    blend_f(frame, spr, cx - spr.shape[1] / 2, y + (1 - u) * dist, u)



def intro(frame, k, n):
    """The name from the very first frame (it is the picture players show before the video starts); the promise rises in under it."""
    t = k / FPS
    icon, pad = _icon(176)
    blend_f(frame, icon, W / 2 - icon.shape[1] / 2, 330 - pad, 1.0)
    title = _text('Quick DICOM Planning', 'Bold', 92)
    blend_f(frame, title, W / 2 - title.shape[1] / 2, 548, 1.0)
    _rise(frame, _text('Implant planning, right in your browser.', 'Medium', 40, MUTED, tracking=-0.3), W / 2, 678, t, 0.25)


def outro(frame, k, n):
    t = k / FPS
    icon, pad = _icon(104)
    u = ease_out(t / 0.5)
    blend_f(frame, icon, W / 2 - icon.shape[1] / 2, 196 - pad + (1 - u) * 20, u)
    _rise(frame, _text('Plan your next case in the browser.', 'Bold', 76), W / 2, 356, t, 0.12)
    _rise(frame, _text('No install.  Scans never leave your computer.', 'Medium', 36, MUTED, tracking=-0.2), W / 2, 478, t, 0.3)
    _rise(frame, _pill(URL, 38), W / 2, 604, t, 0.55)
    small = (118, 128, 146)
    _rise(frame, _text('Not a medical device – for demonstration and educational use.', 'Regular', 21, small, tracking=0.1, display=False), W / 2, 946, t, 0.9, dist=10)
    _rise(frame, _text('Automatic segmentation: DentalSegmentator (Dot et al., 2024), CC BY 4.0.', 'Regular', 21, small, tracking=0.1, display=False), W / 2, 982, t, 0.9, dist=10)
