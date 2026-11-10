"""Compositor for the demo video: turns captured app frames (capture.cjs) into the final picture.

The capture is the app window only. Here it becomes a video: the window on a backdrop, a camera
that moves in on what is happening, the mouse pointer (logged per frame, drawn here), click
ripples, the files being dragged in, captions, time-lapse stretches and title cards.
"""
import json
import math
import os
import subprocess

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

import cursors

W, H, FPS = 1920, 1080, 60
ACCENT = (79, 179, 255)  # the app icon's blue
INK = (242, 245, 250)
MUTED = (154, 164, 181)
FONT_DIR = '/usr/share/fonts/opentype/inter'

TB = 40  # browser bar above the app, in app (CSS) pixels
WINDOW_W = 1664  # width of the app window in the frame when all of it is in view (margins of 128 px)
S0 = 1.0  # output pixels per app pixel when the whole window is in view (set from the capture: set_stage)
RADIUS = 14  # window corner radius (app pixels)
EDGE_BGR = (64, 56, 50)  # hairline round the window
WIDE = (832.0, 450.0, 1.0)  # camera view of the whole window


CAP = (1664, 900)  # size of the captured page (CSS pixels)


def set_stage(cap_w, cap_h):
    """Fit the camera to the size of the captured page."""
    global S0, WIDE, CAP
    S0 = WINDOW_W / cap_w
    CAP = (cap_w, cap_h)
    WIDE = shown((cap_w / 2.0, cap_h / 2.0, 1.0))
    return WIDE


def shown(view):
    """The view the frame really shows: the window never leaves a gap at an edge it reaches, so a
    view aimed past an edge is held there. Camera moves run between such views (a move between
    aims past the edges would stand still, rush, and stand still again)."""
    cx, cy, z = view
    s = S0 * z
    ww, wh = CAP[0] * s, (CAP[1] + TB) * s
    ox = (W - ww) / 2 if ww <= W else min(0.0, max(W - ww, W / 2 - cx * s))
    oy = (H - wh) / 2 if wh <= H else min(0.0, max(H - wh, H / 2 - (cy + TB) * s))
    return ((W / 2 - ox) / s, (H / 2 - oy) / s - TB, z)


def font(weight='SemiBold', size=32, display=True):
    for name in (f"{FONT_DIR}/Inter{'Display' if display else ''}-{weight}.otf", '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'):
        if os.path.exists(name):
            return ImageFont.truetype(name, size)
    return ImageFont.load_default()


def ease(u):
    """ease-in-out (cubic): camera moves and fades"""
    u = min(1.0, max(0.0, u))
    return 4 * u * u * u if u < 0.5 else 1 - (-2 * u + 2) ** 3 / 2


def ease_out(u):
    u = min(1.0, max(0.0, u))
    return 1 - (1 - u) ** 3


def text_width(f, text, tracking=0.0):
    return f.getlength(text) + tracking * max(0, len(text) - 1)


def draw_text(d, xy, text, f, fill, tracking=0.0):
    """Text with letter spacing (kerning kept)."""
    if not tracking:
        d.text(xy, text, font=f, fill=fill)
        return
    x, y = xy
    for i, ch in enumerate(text):
        d.text((x, y), ch, font=f, fill=fill)
        nxt = text[i + 1] if i + 1 < len(text) else ''
        x += (f.getlength(ch + nxt) - f.getlength(nxt) if nxt else f.getlength(ch)) + tracking


def rgba_to_bgra(img):
    a = np.asarray(img.convert('RGBA'))
    return np.ascontiguousarray(a[:, :, [2, 1, 0, 3]])


def blend(dst, src_bgra, x, y, opacity=1.0):
    """Alpha-blend a BGRA sprite onto a BGR frame at integer (x, y)."""
    h, w = src_bgra.shape[:2]
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(dst.shape[1], x + w), min(dst.shape[0], y + h)
    if x1 <= x0 or y1 <= y0:
        return
    s = src_bgra[y0 - y:y1 - y, x0 - x:x1 - x]
    a = s[:, :, 3:4].astype(np.float32) * (opacity / 255.0)
    roi = dst[y0:y1, x0:x1].astype(np.float32)
    dst[y0:y1, x0:x1] = (roi + (s[:, :, :3].astype(np.float32) - roi) * a + 0.5).astype(np.uint8)


def blend_f(dst, src_bgra, x, y, opacity=1.0):
    """As `blend`, at a sub-pixel position (smooth motion)."""
    xi, yi = math.floor(x), math.floor(y)
    fx, fy = x - xi, y - yi
    if fx > 1e-3 or fy > 1e-3:
        m = np.float32([[1, 0, fx], [0, 1, fy]])
        src_bgra = cv2.warpAffine(src_bgra, m, (src_bgra.shape[1] + 1, src_bgra.shape[0] + 1), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
    blend(dst, src_bgra, xi, yi, opacity)


# ---- captured footage ----------------------------------------------------------------------------


class Capture:
    """One capture directory: frames/ and log.json."""

    def __init__(self, d):
        self.dir = d
        self.log = json.load(open(os.path.join(d, 'log.json')))
        self.frames = self.log['frames']
        m = self.log['meta']
        self.w, self.h, self.dsf, self.fps = m['w'], m['h'], m['dsf'], m['fps']
        self.marks = self.log['marks']
        self.rects = self.log['rects']
        self.events = self.log['events']
        self.scenes = {s['name']: (s['from'], s['to']) for s in self.log['scenes']}
        self._cache = {}
        self._order = []
        set_stage(self.w, self.h)

    def image(self, i):
        """Frame i as the browser window: bar on top of the app, a hairline round it, BGR at capture resolution."""
        f = self.frames[i]['f']
        if f not in self._cache:
            img = cv2.imread(os.path.join(self.dir, 'frames', f), cv2.IMREAD_COLOR)
            img = np.vstack([browser_bar(self.w, self.dsf), img])
            ys, xs, al = self._edge()
            px = img[ys, xs].astype(np.float32)
            img[ys, xs] = (px + (np.float32(EDGE_BGR) - px) * al + 0.5).astype(np.uint8)
            self._cache[f] = img
            self._order.append(f)
            if len(self._order) > 4:
                self._cache.pop(self._order.pop(0), None)
        return self._cache[f]

    def _edge(self):
        """The hairline round the window (it tells the dark window from the dark backdrop): pixels and their opacity."""
        if not hasattr(self, '_edge_px'):
            w, h = self.w * self.dsf, (self.h + TB) * self.dsf
            m = Image.new('L', (w, h), 0)
            ImageDraw.Draw(m).rounded_rectangle([0, 0, w - 1, h - 1], radius=RADIUS * self.dsf, outline=255, width=self.dsf)
            a = np.asarray(m)
            ys, xs = np.nonzero(a)
            self._edge_px = (ys, xs, (a[ys, xs].astype(np.float32) / 255.0 * 0.9)[:, None])
        return self._edge_px

    def alpha(self):
        """The window's shape at capture resolution: opaque but for its rounded corners."""
        if not hasattr(self, '_alpha'):
            w, h = self.w * self.dsf, (self.h + TB) * self.dsf
            m = Image.new('L', (w, h), 0)
            ImageDraw.Draw(m).rounded_rectangle([0, 0, w - 1, h - 1], radius=RADIUS * self.dsf, fill=255)
            self._alpha = np.ascontiguousarray(np.asarray(m))
        return self._alpha

    def lapse_range(self, label, scene=None):
        """First and last frame index of a real-time stretch."""
        idx = [i for i, f in enumerate(self.frames) if f.get('lapse') == label and (scene is None or f['s'] == scene)]
        return idx[0], idx[-1]


_bars = {}


def browser_bar(w, dsf):
    """A plain browser bar with the app's address (the capture is the page only)."""
    key = (w, dsf)
    if key in _bars:
        return _bars[key]
    k = dsf * 2  # draw at 2x, then reduce: smooth edges
    img = Image.new('RGB', (w * k, TB * k), (27, 29, 34))
    d = ImageDraw.Draw(img)
    for i in range(3):
        cx = (20 + i * 19) * k
        d.ellipse([cx - 5.5 * k, TB * k / 2 - 5.5 * k, cx + 5.5 * k, TB * k / 2 + 5.5 * k], fill=(70, 74, 84))
    pw = 520 * k
    x0 = (w * k - pw) // 2
    d.rounded_rectangle([x0, 8 * k, x0 + pw, (TB - 8) * k], radius=12 * k, fill=(42, 45, 52))
    f = font('Medium', int(12.5 * k), display=False)
    url = 'amsaleh1998-spec.github.io/Quick-DICOM-Planning'
    tw = f.getlength(url)
    tx = x0 + (pw - tw) / 2 + 8 * k
    # padlock
    lx, ly = tx - 17 * k, TB * k / 2
    d.rounded_rectangle([lx - 4 * k, ly - 1.5 * k, lx + 4 * k, ly + 5 * k], radius=1.5 * k, fill=(150, 156, 168))
    d.arc([lx - 2.8 * k, ly - 6.5 * k, lx + 2.8 * k, ly + 1.5 * k], 180, 360, fill=(150, 156, 168), width=int(1.4 * k))
    d.text((tx, TB * k / 2), url, font=f, fill=(206, 210, 220), anchor='lm')
    d.line([0, TB * k - 1, w * k, TB * k - 1], fill=(14, 15, 18), width=k)
    img = img.resize((w * dsf, TB * dsf), Image.LANCZOS)
    _bars[key] = np.ascontiguousarray(np.asarray(img)[:, :, ::-1])
    return _bars[key]


# ---- backdrop, window --------------------------------------------------------------------------


def make_backdrop():
    """Deep navy with a soft glow; dithered so the gradient survives video compression."""
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    base = np.zeros((H, W, 3), np.float32)
    top, bot = np.array([23, 15, 11], np.float32), np.array([38, 26, 19], np.float32)  # BGR of #0b0f17 -> #131a26
    t = (yy / H)[..., None]
    base[:] = top + (bot - top) * t
    for cx, cy, r, col, a in ((W * 0.18, H * 0.05, 900, (255, 179, 79), 0.16), (W * 0.92, H * 1.0, 800, (200, 120, 60), 0.12)):
        g = np.exp(-(((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * (r * 0.5) ** 2)))[..., None]
        base += (np.array(col, np.float32) - base) * g * a
    rng = np.random.default_rng(3)
    base += rng.uniform(-0.6, 0.6, base.shape).astype(np.float32)
    return np.clip(base + 0.5, 0, 255).astype(np.uint8)


BACKDROP = None
_shadow = {}


def window_shadow(ww, wh, r):
    key = (int(ww), int(wh), int(r))
    if key not in _shadow:
        _shadow.clear()
        pad = 90
        m = Image.new('L', (int(ww) + 2 * pad, int(wh) + 2 * pad), 0)
        ImageDraw.Draw(m).rounded_rectangle([pad, pad, pad + ww, pad + wh], radius=r, fill=255)
        m = m.filter(ImageFilter.GaussianBlur(34))
        a = (np.asarray(m).astype(np.float32) * 0.62).astype(np.uint8)
        _shadow[key] = (np.dstack([np.zeros_like(a), np.zeros_like(a), np.zeros_like(a), a]), pad)
    return _shadow[key]


class Layout:
    """Where the app window is in the frame for a camera view (cx, cy in app pixels, zoom)."""

    def __init__(self, cap_w, cap_h, view):
        cx, cy, z = view
        self.s = S0 * z
        self.ww, self.wh = cap_w * self.s, (cap_h + TB) * self.s
        ox = W / 2 - cx * self.s
        oy = H / 2 - (cy + TB) * self.s
        self.ox = (W - self.ww) / 2 if self.ww <= W else min(0.0, max(W - self.ww, ox))
        self.oy = (H - self.wh) / 2 if self.wh <= H else min(0.0, max(H - self.wh, oy))

    def pt(self, x, y):
        """App pixel -> frame pixel."""
        return self.ox + x * self.s, self.oy + (y + TB) * self.s


def draw_window(frame, cap, i, lay):
    """The browser window with frame i of the capture, placed by the layout.

    The capture is resampled once, to twice the frame's resolution at its exact (sub-pixel) place,
    and halved: sharp, and steady during slow camera moves (rounding the picture to whole pixels
    first makes it shimmer)."""
    src = cap.image(i)
    hs, ws = src.shape[:2]
    k = lay.s / cap.dsf  # frame pixels per capture pixel
    r = RADIUS * lay.s
    covers = lay.ox <= 0 and lay.oy <= 0 and lay.ox + lay.ww >= W and lay.oy + lay.wh >= H
    # a rounded corner in view?
    corner = (lay.ox + r > 0 or lay.ox + lay.ww - r < W) and (lay.oy + r > 0 or lay.oy + lay.wh - r < H)
    if not covers:
        sh, pad = window_shadow(lay.ww, lay.wh, r)
        blend(frame, sh, int(round(lay.ox)) - pad, int(round(lay.oy)) - pad + 26)
    # the part of the window that is in view (capture pixels, a little more for the filter)
    x0 = max(0, int(math.floor(-lay.ox / k)) - 2)
    y0 = max(0, int(math.floor(-lay.oy / k)) - 2)
    x1 = min(ws, int(math.ceil((W - lay.ox) / k)) + 2)
    y1 = min(hs, int(math.ceil((H - lay.oy) / k)) + 2)
    k2 = 2 * k
    m = np.float32([[k2, 0, 2 * lay.ox + x0 * k2 + 0.5 * k2 - 0.5], [0, k2, 2 * lay.oy + y0 * k2 + 0.5 * k2 - 0.5]])
    # (enlarging the capture, when the camera is close: a sharper filter)
    big = cv2.warpAffine(src[y0:y1, x0:x1], m, (2 * W, 2 * H), flags=cv2.INTER_CUBIC if k2 > 1.5 else cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    img = cv2.resize(big, (W, H), interpolation=cv2.INTER_AREA)
    if covers and not corner:
        frame[:] = img
        return
    a2 = cv2.warpAffine(cap.alpha()[y0:y1, x0:x1], m, (2 * W, 2 * H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    al = cv2.resize(a2, (W, H), interpolation=cv2.INTER_AREA)
    ys, xs = np.nonzero(al)
    if not len(ys):
        return
    # blend only where the window is (its bounding box)
    Y0, Y1, X0, X1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    w8 = al[Y0:Y1, X0:X1].astype(np.float32)[..., None] * (1 / 255.0)
    roi = frame[Y0:Y1, X0:X1].astype(np.float32)
    frame[Y0:Y1, X0:X1] = (roi + (img[Y0:Y1, X0:X1].astype(np.float32) - roi) * w8 + 0.5).astype(np.uint8)


# ---- timeline --------------------------------------------------------------------------------


class Timeline:
    """The edit: which captured frame (or card) every output frame shows."""

    def __init__(self):
        self.out = []  # dict(cap, i, lapse, card, seg, xfade)
        self.seg = 0

    def _add(self, entries, xfade=0):
        self.seg += 1
        for j, e in enumerate(entries):
            e['seg'] = self.seg
            e['xfade'] = (j, xfade) if j < xfade else None
            self.out.append(e)
        return len(self.out)

    def clip(self, cap, a, b, speed=1.0, xfade=0):
        """Frames a..b of a capture. `speed`: a number, or [(from_frame, speed), ...]."""
        steps = sorted(speed, key=lambda fs: fs[0]) if isinstance(speed, list) else [(a, speed)]
        entries = []
        pos = float(a)
        while pos < b:
            i = int(pos)
            entries.append(dict(cap=cap, i=i))
            sp = [s for f, s in steps if f <= i]
            pos += (sp[-1] if sp else steps[0][1]) * cap.fps / FPS
        return self._add(entries, xfade)

    def lapse(self, cap, a, b, dur, xfade=0):
        """A real-time stretch (frames a..b, sampled while the app worked) played in `dur` seconds. Returns its (start, end) in output frames."""
        fr = cap.frames
        t0, t1 = fr[a].get('rt', 0), fr[b].get('rt', 0)
        n = max(2, int(round(dur * FPS)))
        entries = []
        j = a
        for k in range(n):
            target = t0 + (t1 - t0) * k / (n - 1)
            while j < b and abs(fr[j + 1].get('rt', 0) - target) <= abs(fr[j].get('rt', 0) - target):
                j += 1
            entries.append(dict(cap=cap, i=j))
        start = len(self.out)
        self._add(entries, xfade)
        return start, len(self.out)

    def still(self, cap, i, dur, xfade=0):
        return self._add([dict(cap=cap, i=i) for _ in range(int(round(dur * FPS)))], xfade)

    def card(self, fn, dur, xfade=0):
        n = int(round(dur * FPS))
        return self._add([dict(card=fn, k=k, n=n) for k in range(n)], xfade)

    def at(self, cap, i, start=0):
        """Output frame that first shows capture frame >= i (searching from `start`)."""
        for k in range(start, len(self.out)):
            e = self.out[k]
            if e.get('cap') is cap and e['i'] >= i:
                return k
        raise ValueError(f'frame {i} is not in the timeline')

    @property
    def n(self):
        return len(self.out)


class Camera:
    """Camera views over output time. A key (t, view, move): the view is reached at t after `move` frames of travel."""

    def __init__(self, first):
        self.keys = [(0, shown(first), 0)]

    def to(self, t, view, move=42):
        self.keys.append((int(t), shown(view), int(move)))
        self.keys.sort(key=lambda k: k[0])

    def cut(self, t, view):
        self.to(t, view, 0)

    def at(self, k):
        prev = self.keys[0]
        for key in self.keys[1:]:
            t, view, move = key
            if k >= t:
                prev = key
                continue
            start = max(t - move, prev[0])  # a move begins where the one before it ended, at the earliest
            if move and k > start:
                u = ease((k - start) / (t - start))
                a, b = prev[1], view
                return (a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, math.exp(math.log(a[2]) + (math.log(b[2]) - math.log(a[2])) * u))
            break
        return prev[1]


def view_of(rect, fill=0.86, zmax=3.2, zmin=1.0, dy=0.0):
    """Camera view that shows a rectangle (app pixels): centre and zoom."""
    x, y, w, h = rect
    z = min((W * fill) / (w * S0), (H * fill) / (h * S0))
    return (x + w / 2, y + h / 2 + dy, max(zmin, min(zmax, z)))



# ---- overlays --------------------------------------------------------------------------------

_cap_cache = {}
_cursor_cache = {}


def caption_sprite(text, accent=None, size=40):
    """A caption: bold white words on a dark glass pill; `accent` words are in the app's blue."""
    key = (text, accent, size)
    if key in _cap_cache:
        return _cap_cache[key]
    f = font('SemiBold', size)
    track = -size * 0.012
    tw = text_width(f, text, track)
    padx, pady = int(size * 0.85), int(size * 0.52)
    w, h = int(tw + 2 * padx), int(size * 1.22 + 2 * pady)
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=h // 2, fill=(10, 13, 20, 214), outline=(255, 255, 255, 34), width=2)
    x = padx
    y = pady + size * 0.02
    if accent and accent in text:
        a, b = text.split(accent, 1)
        for part, col in ((a, INK), (accent, ACCENT), (b, INK)):
            draw_text(d, (x, y), part, f, col + (255,), track)
            x += text_width(f, part, track) + (track if part else 0)
    else:
        draw_text(d, (x, y), text, f, INK + (255,), track)
    _cap_cache[key] = rgba_to_bgra(img)
    return _cap_cache[key]


def chip_sprite(text, size=20, icon=None):
    """A small label (time-lapse badge, dragged file)."""
    key = ('chip', text, size, icon)
    if key in _cap_cache:
        return _cap_cache[key]
    f = font('Medium', size, display=False)
    tw = f.getlength(text)
    iw = int(size * 1.5) if icon else 0
    padx, pady = int(size * 0.7), int(size * 0.45)
    w, h = int(tw + iw + 2 * padx), int(size * 1.25 + 2 * pady)
    img = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, w - 1, h - 1], radius=h // 2 if icon != 'file' else int(size * 0.5), fill=(18, 22, 31, 232), outline=(255, 255, 255, 46), width=1)
    cx, cy = padx + iw * 0.42, h / 2
    if icon == 'ff':
        u = size * 0.34
        for dx in (-u * 0.85, u * 0.55):
            d.polygon([(cx + dx - u * 0.6, cy - u), (cx + dx + u * 0.6, cy), (cx + dx - u * 0.6, cy + u)], fill=ACCENT + (255,))
    elif icon == 'file':
        u = size * 0.62
        d.rounded_rectangle([cx - u * 0.72, cy - u, cx + u * 0.72, cy + u], radius=size * 0.14, fill=(232, 236, 244, 255))
        d.polygon([(cx + u * 0.16, cy - u), (cx + u * 0.72, cy - u * 0.42), (cx + u * 0.16, cy - u * 0.42)], fill=(160, 170, 188, 255))
        for k in range(3):
            d.line([cx - u * 0.42, cy - u * 0.1 + k * u * 0.36, cx + u * 0.42, cy - u * 0.1 + k * u * 0.36], fill=ACCENT + (255,), width=max(1, int(size * 0.09)))
    d.text((padx + iw, h / 2 - size * 0.04), text, font=f, fill=INK + (255,), anchor='lm')
    _cap_cache[key] = rgba_to_bgra(img)
    return _cap_cache[key]


def draw_ring(frame, x, y, r, alpha, color=(255, 255, 255), width=3):
    """A soft ring (click ripple)."""
    if alpha <= 0.01 or r < 1:
        return
    R = int(r + width + 3)
    x0, y0 = int(round(x)) - R, int(round(y)) - R
    size = 2 * R + 1
    m = np.zeros((size, size), np.uint8)
    cv2.circle(m, (R, R), int(round(r)), 255, width, lineType=cv2.LINE_AA)
    spr = np.zeros((size, size, 4), np.uint8)
    spr[:, :, 0], spr[:, :, 1], spr[:, :, 2] = color[2], color[1], color[0]
    spr[:, :, 3] = m
    blend(frame, spr, x0, y0, alpha)


# ---- render ----------------------------------------------------------------------------------


class Movie:
    def __init__(self, timeline, camera):
        self.tl = timeline
        self.cam = camera
        self.captions = []  # (t0, t1, text, accent)
        self.hide_cursor = []  # (t0, t1)
        self.notes = []  # (t0, t1, fn(frame, k)) extra drawing
        self.badges = []  # (t0, t1): stretches shown faster than they happened

    def badge(self, t0, t1):
        """Label output frames t0..t1 as a time-lapse."""
        self.badges.append((int(t0), int(t1)))

    def caption(self, t0, t1, text, accent=None):
        self.captions.append((int(t0), int(t1), text, accent))

    def _events(self, cap):
        """Per recording: when each press is first on screen (ripples run in video time, whatever the speed of the clip) and the file drags."""
        if not hasattr(cap, '_ev'):
            first = {}
            for k, e in enumerate(self.tl.out):
                if e.get('cap') is cap and e['i'] not in first:
                    first[e['i']] = k
            ripples = []
            for d in (e for e in cap.events if e['type'] == 'down'):
                # shown only if the edit keeps the moment of the press (within a tenth of a second)
                ks = [first[i] for i in range(d['i'], d['i'] + max(2, int(0.1 * cap.fps)) + 1) if i in first]
                if ks:
                    ripples.append((min(ks), d['x'], d['y'], self.tl.out[min(ks)]['seg']))
            drags, start = [], None
            for e in cap.events:
                if e['type'] == 'dragstart':
                    start = e
                elif e['type'] == 'drop' and start is not None:
                    drags.append((start['i'], e['i'], start.get('label', '')))
                    start = None
            cap._ev = {'ripples': ripples, 'drag': drags}
        return cap._ev

    def frame(self, k):
        global BACKDROP
        if BACKDROP is None:
            BACKDROP = make_backdrop()
        e = self.tl.out[k]
        frame = BACKDROP.copy()
        if e.get('card'):
            e['card'](frame, e['k'], e['n'])
        else:
            cap, i = e['cap'], e['i']
            lay = Layout(cap.w, cap.h, self.cam.at(k))
            draw_window(frame, cap, i, lay)
            self._pointer(frame, cap, i, lay, k)
        for t0, t1 in self.badges:
            if t0 <= k < t1:
                spr = chip_sprite('time-lapse', 22, 'ff')
                a = min(ease_out((k - t0 + 1) / 9.0), ease_out((t1 - k) / 9.0))
                blend(frame, spr, W - spr.shape[1] - 40, 36, 0.96 * a)
        for t0, t1, fn in self.notes:
            if t0 <= k < t1:
                fn(frame, k - t0, t1 - t0)
        for t0, t1, text, accent in self.captions:
            if t0 <= k < t1:
                spr = caption_sprite(text, accent)
                a_in = ease_out((k - t0) / 16.0)
                a_out = ease_out((t1 - k) / 12.0)
                a = min(a_in, a_out)
                y = H - 92 - spr.shape[0] + (1 - a_in) * 22
                blend_f(frame, spr, (W - spr.shape[1]) / 2, y, a)
        return frame

    def _pointer(self, frame, cap, i, lay, k):
        fr = cap.frames[i]
        ev = self._events(cap)
        x, y = lay.pt(fr['x'], fr['y'])
        size = 46 * (lay.s / S0) ** 0.55
        # click ripples: a ring that opens where the button went down
        seg = self.tl.out[k]['seg']
        for k0, px, py, seg0 in ev['ripples']:
            age = (k - k0) / FPS
            if 0 <= age < 0.45 and seg == seg0:  # (not across a cut)
                rx, ry = lay.pt(px, py)
                u = age / 0.45
                draw_ring(frame, rx, ry, size * (0.22 + 0.62 * ease_out(u)), 0.75 * (1 - u) ** 1.5, ACCENT, max(2, int(size * 0.07)))
        # files dragged in from the desktop
        for a, b, label in ev['drag']:
            if a <= i <= b + int(0.2 * cap.fps):
                spr = chip_sprite(label, 22, 'file')
                gone = max(0.0, (i - b) / (0.2 * cap.fps))
                blend_f(frame, spr, x + size * 0.42, y + size * 0.5, (1 - gone) * min(1.0, (i - a) / (0.15 * cap.fps) + 0.2))
        if any(t0 <= k < t1 for t0, t1 in self.hide_cursor):
            return
        name = fr['c']
        if fr['d'] and name == 'grab':
            name = 'grabbing'
        px_size = int(round(size * (0.92 if fr['d'] else 1.0)))
        key = (name, px_size)
        if key not in _cursor_cache:
            spr, hot = cursors.sprite(name, px_size)
            _cursor_cache[key] = (rgba_to_bgra(spr), hot)
        spr, hot = _cursor_cache[key]
        # a pointer that moves fast leaves a short trail (it would strobe otherwise)
        prev = self.tl.out[k - 1] if k > 0 else None
        if prev is not None and prev.get('cap') is cap and 0 < i - prev['i'] <= 8:
            pf = cap.frames[prev['i']]
            qx, qy = lay.pt(pf['x'], pf['y'])
            d = math.hypot(x - qx, y - qy)
            if d > 22:
                n = int(min(7, d // 13))
                for j in range(1, n + 1):
                    u = j / (n + 1)
                    blend_f(frame, spr, qx + (x - qx) * u - hot[0], qy + (y - qy) * u - hot[1], 0.07 + 0.2 * u)
        blend_f(frame, spr, x - hot[0], y - hot[1])

    def render(self, path, a=0, b=None, scale=1.0, crf=17, preset='slow', xfade=True, log=True):
        """Encode frames a..b (H.264). `scale` < 1 for quick previews."""
        b = self.tl.n if b is None else b
        ow, oh = int(W * scale) // 2 * 2, int(H * scale) // 2 * 2
        # H.264 high profile, BT.709 (converted with that matrix and tagged as such), with a silent
        # stereo track: some players and upload forms do not take a video without audio
        cmd = ['ffmpeg', '-y', '-loglevel', 'error',
               '-f', 'rawvideo', '-pix_fmt', 'bgr24', '-s', f'{ow}x{oh}', '-r', str(FPS), '-i', '-',
               '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
               '-vf', 'scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int',
               '-c:v', 'libx264', '-preset', preset, '-crf', str(crf), '-pix_fmt', 'yuv420p', '-profile:v', 'high',
               '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
               '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', path]
        p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        prev_seg, prev_last, last = None, None, None
        for k in range(a, b):
            e = self.tl.out[k]
            f = self.frame(k)
            if e['seg'] != prev_seg:
                prev_last, prev_seg = last, e['seg']
            if xfade and e.get('xfade') and prev_last is not None:
                j, n = e['xfade']
                u = ease((j + 1) / (n + 1))
                f = cv2.addWeighted(prev_last, 1 - u, f, u, 0)
            last = f
            out = f if scale == 1.0 else cv2.resize(f, (ow, oh), interpolation=cv2.INTER_AREA)
            p.stdin.write(out.tobytes())
            if log and (k - a) % 120 == 0:
                print(f'  frame {k - a}/{b - a}', flush=True)
        p.stdin.close()
        p.wait()
        return path

    def still(self, k, path, scale=1.0):
        f = self.frame(k)
        if scale != 1.0:
            f = cv2.resize(f, (int(W * scale), int(H * scale)), interpolation=cv2.INTER_AREA)
        cv2.imwrite(path, f)
