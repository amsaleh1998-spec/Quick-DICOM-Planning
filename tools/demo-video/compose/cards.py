"""Title cards: the opening (name and promise) and the closing (where to open it)."""
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from engine import ACCENT, FPS, H, INK, MUTED, W, blend, blend_f, draw_text, ease_out, font, rgba_to_bgra, text_width

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


# ---- the dual scan video -----------------------------------------------------------------------

def titled(sub):
    """An opening card with the name, a headline under it and the promise."""
    def card(frame, k, n):
        t = k / FPS
        icon, pad = _icon(132)
        blend_f(frame, icon, W / 2 - icon.shape[1] / 2, 250 - pad, 1.0)
        name = _text('Quick DICOM Planning', 'Medium', 40, MUTED, tracking=-0.3)
        blend_f(frame, name, W / 2 - name.shape[1] / 2, 420, 1.0)
        title = _text(sub, 'Bold', 104)
        blend_f(frame, title, W / 2 - title.shape[1] / 2, 500, 1.0)
        _rise(frame, _text('The denture, placed in the CBCT by its markers.', 'Medium', 40, MUTED, tracking=-0.3), W / 2, 668, t, 0.25)
    return card


def _folder_window(rows, title):
    """A plain file window (an illustration, not a screenshot of any system)."""
    key = ('fw', tuple(rows), title)
    if key not in _cache:
        w, h, r = 1040, 596, 18
        pad = 60
        img = Image.new('RGBA', (w + 2 * pad, h + 2 * pad), (0, 0, 0, 0))
        sh = Image.new('RGBA', img.size, (0, 0, 0, 0))
        ImageDraw.Draw(sh).rounded_rectangle([pad, pad + 18, pad + w, pad + h + 18], radius=r, fill=(0, 0, 0, 150))
        img = Image.alpha_composite(img, sh.filter(ImageFilter.GaussianBlur(26)))
        d = ImageDraw.Draw(img)
        d.rounded_rectangle([pad, pad, pad + w, pad + h], radius=r, fill=(30, 31, 36, 255), outline=(70, 72, 80, 255), width=1)
        d.rounded_rectangle([pad, pad, pad + w, pad + 62], radius=r, fill=(40, 41, 47, 255))
        d.rectangle([pad, pad + 40, pad + w, pad + 62], fill=(40, 41, 47, 255))
        d.line([pad, pad + 62, pad + w, pad + 62], fill=(70, 72, 80, 255))
        # a folder glyph and the path
        fx, fy = pad + 26, pad + 20
        d.rounded_rectangle([fx, fy + 4, fx + 30, fy + 24], radius=4, fill=(236, 190, 86, 255))
        d.rounded_rectangle([fx, fy, fx + 14, fy + 8], radius=3, fill=(236, 190, 86, 255))
        d.text((fx + 46, fy + 12), title, font=font('Medium', 24, False), fill=INK + (255,), anchor='lm')
        d.text((pad + 78, pad + 92), 'Name', font=font('Regular', 19, False), fill=MUTED + (255,), anchor='lm')
        d.text((pad + 700, pad + 92), 'Type', font=font('Regular', 19, False), fill=MUTED + (255,), anchor='lm')
        d.line([pad + 24, pad + 112, pad + w - 24, pad + 112], fill=(58, 60, 68, 255))
        for i, name in enumerate(rows):
            y = pad + 144 + i * 54
            d.rounded_rectangle([pad + 34, y - 15, pad + 56, y + 15], radius=3, fill=(214, 220, 232, 255))
            d.polygon([(pad + 48, y - 15), (pad + 56, y - 7), (pad + 48, y - 7)], fill=(150, 158, 176, 255))
            d.text((pad + 78, y), name, font=font('Regular', 23, False), fill=INK + (255,), anchor='lm')
            d.text((pad + 700, y), 'DICOM image', font=font('Regular', 21, False), fill=MUTED + (255,), anchor='lm')
        _cache[key] = (rgba_to_bgra(img), pad, w, h)
    return _cache[key]


def file_window(frame, k, n):
    """A folder of DICOM files; one of them is double-clicked."""
    import cursors
    from engine import draw_ring, ease
    t = k / FPS
    rows = [f'an_{i:03d}.dcm' for i in range(1, 9)]
    win, pad, w, h = _folder_window(rows, 'Dual Scan Example  ›  patient with denture')
    u = ease_out(t / 0.4)
    x0, y0 = W / 2 - w / 2 - pad, 150 - pad + (1 - u) * 24
    click = 1.25  # s: the first click of the double-click
    row_y = y0 + pad + 144
    if t >= click:  # the row is selected
        sel = np.zeros((48, w - 36, 4), np.uint8)
        sel[:, :, :3] = (255, 150, 60)
        sel[:, :, 3] = 70
        base = frame.copy()
        blend_f(base, win, x0, y0, u)
        blend(base, sel, int(x0 + pad + 18), int(row_y - 24), 1.0)
        frame[:] = base
    else:
        blend_f(frame, win, x0, y0, u)
    # the pointer comes in from the lower right and double-clicks the first file
    tx, ty = x0 + pad + 250, row_y + 4
    m = ease(min(1.0, max(0.0, (t - 0.25) / 0.9)))
    px, py = tx + (1 - m) * 520, ty + (1 - m) * 300
    for c in (click, click + 0.22):
        a = (t - c) / 0.45
        if 0 <= a <= 1:
            draw_ring(frame, px, py, 10 + 34 * ease_out(a), (1 - a) * 0.9, color=(255, 255, 255))
    spr, hot = cursors.sprite('default', 44)
    blend_f(frame, rgba_to_bgra(spr), px - hot[0], py - hot[1], 1.0)


def outro_dual(frame, k, n):
    t = k / FPS
    icon, pad = _icon(104)
    u = ease_out(t / 0.5)
    blend_f(frame, icon, W / 2 - icon.shape[1] / 2, 196 - pad + (1 - u) * 20, u)
    _rise(frame, _text('Dual scan, in your browser.', 'Bold', 76), W / 2, 356, t, 0.12)
    _rise(frame, _text('Markers matched for you.  Scans never leave your computer.', 'Medium', 36, MUTED, tracking=-0.2), W / 2, 478, t, 0.3)
    _rise(frame, _pill(URL, 38), W / 2, 604, t, 0.55)
    small = (118, 128, 146)
    _rise(frame, _text('Not a medical device – for demonstration and educational use.', 'Regular', 21, small, tracking=0.1, display=False), W / 2, 964, t, 0.9, dist=10)
