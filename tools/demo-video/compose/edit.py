"""The edit of the demo video: which stretches of the recording are shown and how fast, where the
camera looks, what the captions say.

  python3 edit.py <capture dir> [<capture dir> ...] --out demo.mp4
      [--scale 0.5]        smaller picture (quick previews)
      [--only open,scans]  only these scenes (with the title cards)
      [--stills DIR]       stills instead of a video, one every --every frames

Scenes are looked up in the capture directories in the order given (a later directory replaces a
scene of an earlier one), so a scene can be recorded again on its own.

Times in this file are 60ths of a second of the finished video unless said otherwise.
"""
import argparse
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import cv2
import numpy as np

import cards
import engine
from engine import FPS, H, W, Camera, Capture, Movie, Timeline, blend, ease_out, view_of


class Scene:
    """A scene of a recording: the frame numbers of what happened in it."""

    def __init__(self, cap, name):
        self.cap, self.name = cap, name
        self.a, self.b = cap.scenes[name]
        self.k = cap.fps / 60.0  # recorded frames per 60th of a second
        ev = [e for e in cap.events if self.a <= e['i'] < self.b]
        self.clicks = [e['i'] for e in ev if e['type'] == 'click']
        self.downs = [e['i'] for e in ev if e['type'] == 'down']
        self.ups = [e['i'] for e in ev if e['type'] == 'up']
        self.drops = [e['i'] for e in ev if e['type'] == 'drop']
        self.dragstarts = [e['i'] for e in ev if e['type'] == 'dragstart']
        self.lapses = {e['label']: (e['i'], e['to'] - 1, e['ms']) for e in ev if e['type'] == 'lapse'}

    def m(self, name, d=0):
        """Frame of a mark, `d` 60ths later."""
        return self.cap.marks[f'{self.name}.{name}'] + self.d(d)

    def d(self, n):
        """A duration of n 60ths, in recorded frames."""
        return int(round(n * self.k))

    def before(self, name, kind='click'):
        """Frame of the last click (or 'down': button press) before a mark."""
        m = self.m(name)
        return max(i for i in (self.clicks if kind == 'click' else self.downs) if i < m)

    def after(self, name, kind='click'):
        """Frame of the first click (or button press) after a mark."""
        m = self.m(name)
        return min(i for i in (self.clicks if kind == 'click' else self.downs) if i >= m)

    def r(self, name):
        """A rectangle the recording remembered (of this recording, or of another one given on the command line)."""
        return self.cap.rects[name] if name in self.cap.rects else ALL_RECTS[name]

    def lapse(self, label):
        """(first frame, last frame, real milliseconds) of a wait that was recorded in real time."""
        if label in self.lapses:
            return self.lapses[label]
        a, b = self.cap.lapse_range(label, self.name)  # recordings without wait events
        return a, b, self.cap.frames[b].get('rt', 0)

    def path_box(self, a, b, pad=0):
        """Bounding box of the pointer between two frames."""
        xs = [f['x'] for f in self.cap.frames[a:b + 1]]
        ys = [f['y'] for f in self.cap.frames[a:b + 1]]
        return [min(xs) - pad, min(ys) - pad, max(xs) - min(xs) + 2 * pad, max(ys) - min(ys) + 2 * pad]


ALL_RECTS = {}


def implants_rect(cap, i, within):
    """Where the implants are in the 3D view of frame i (drawn in a green of their own, the selected one in amber): a rectangle in app pixels, or None."""
    k = cap.dsf
    img = cap.image(i)[engine.TB * k:]  # the app without the browser bar
    x, y, w, h = [int(v * k) for v in within]
    hsv = cv2.cvtColor(np.ascontiguousarray(img[y:y + h, x:x + w]), cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, (62, 110, 70), (84, 255, 255)) | cv2.inRange(hsv, (14, 160, 150), (30, 255, 255))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    ys, xs = np.nonzero(mask)
    if len(xs) < 300:
        return None
    x0, x1 = np.percentile(xs, [1, 99])
    y0, y1 = np.percentile(ys, [1, 99])
    return [within[0] + x0 / k, within[1] + y0 / k, (x1 - x0) / k, (y1 - y0) / k]


def within(view, rect, top=False):
    """The view moved (and, when it shows more than the rectangle is wide or high, narrowed) to show nothing outside a rectangle; top: along its upper edge."""
    cx, cy, z = view
    x, y, w, h = rect
    z = max(z, W / (w * engine.S0), H / (h * engine.S0))
    hw, hh = W / (2 * z * engine.S0), H / (2 * z * engine.S0)
    cx = min(max(cx, x + hw), x + w - hw)
    cy = y + hh if top else min(max(cy, y + hh), y + h - hh)
    return (cx, cy, z)


def union(*rects):
    x0, y0 = min(r[0] for r in rects), min(r[1] for r in rects)
    x1, y1 = max(r[0] + r[2] for r in rects), max(r[1] + r[3] for r in rects)
    return [x0, y0, x1 - x0, y1 - y0]


def grow(r, dx=0, dy=0):
    return [r[0] - dx, r[1] - dy, r[2] + 2 * dx, r[3] + 2 * dy]


def build(S, report_pages=None):
    """S: scene name -> Scene. Returns the Movie."""
    tl = Timeline()
    WIDE = engine.WIDE
    CX, CY = WIDE[0], WIDE[1]
    cam = Camera(WIDE)
    mv = Movie(tl, cam)
    X = 12  # frames of cross-fade between scenes

    def at(sc, f, start=0):
        return tl.at(sc.cap, f, start)

    # ---- opening card -----------------------------------------------------------------------------
    tl.card(cards.intro, 2.0)

    # ---- drop in a CBCT ---------------------------------------------------------------------------
    if 'open' in S:
        s = S['open']
        t0 = tl.n
        tl.clip(s.cap, s.a + s.d(16), s.drops[0] + 1, 1.0, xfade=X)
        la, lb, _ = s.lapse('load')
        mv.badge(*tl.lapse(s.cap, la, lb, 0.8))
        tl.clip(s.cap, s.m('loaded'), s.b, 1.35)
        cam.cut(t0, WIDE)
        vp = view_of(s.r('viewport'), fill=1.0, zmax=1.32)
        cam.to(at(s, s.m('auto'), t0) + 36, (vp[0] - 40, vp[1], vp[2]), move=46)
        k = at(s, s.m('loaded'), t0)
        mv.caption(t0 + 16, k + 8, 'Drop in a CBCT', 'CBCT')
        mv.caption(k + 20, tl.n - 4, 'Nothing is uploaded', 'Nothing')

    # ---- automatic segmentation -------------------------------------------------------------------
    if 'ai' in S:
        s = S['ai']
        t0 = tl.n
        c = s.clicks  # 0 Segments, 1 Run…, 2 maxilla only, 3 fast, 4 Start, 5 Run in background
        dlg = s.r('aiDialog')
        tl.clip(s.cap, s.a, c[3] + s.d(22), [(s.a, 1.45), (c[1] + s.d(10), 1.7)], xfade=X)
        # (Start and "Run in background" are cut: the next picture is the scan with the progress at its corner)
        tb = tl.n
        la, lb, _ = s.lapse('ai')
        tl.lapse(s.cap, la, lb, 1.9, xfade=10)
        mv.badge(tb + 6, tl.n)
        t3 = tl.n
        tl.clip(s.cap, s.m('done'), s.b, 1.2)
        tl.still(s.cap, s.b - 1, 0.7)  # the result a little longer
        cam.cut(t0, (CX - 300, CY - 120, 1.4))
        # the upper part of the dialog: what it does, region, jaws, quality and the time it will take
        cam.to(at(s, c[1], t0) + 34, (dlg[0] + dlg[2] / 2, 0, 2.05), move=42)
        # the four views, with the progress the app shows at the lower right corner
        work = (2000, 2000, 1.25)
        cam.cut(tb, work)
        cam.to(t3 + 60, view_of(s.r('viewport'), fill=1.0, zmax=1.32), move=50)
        # (no caption over the dialog while its options are chosen)
        mv.caption(t0 + 16, at(s, c[1], t0) + 8, 'AI segmentation', 'AI')
        mv.caption(tb + 10, t3 - 8, 'AI segmentation', 'AI')
        mv.caption(t3 + 4, tl.n - 4, 'Runs right in your browser', 'in your browser')

    # ---- intraoral scans --------------------------------------------------------------------------
    if 'scans' in S:
        s = S['scans']
        t0 = tl.n
        c = s.clicks  # 0 Continue, 1 CBCT surface, 2 "Upper teeth", 3..8 patches, 9 Match, 10 Accept, 11 copy the alignment, 12 Continue
        la, lb, _ = s.lapse('surface')
        tl.clip(s.cap, s.a + s.d(8), la, 2.0, xfade=X)
        mv.badge(*tl.lapse(s.cap, min(la + 1, lb), lb, 0.6))  # (its first picture is from before the click took effect)
        t1 = tl.n
        tl.clip(s.cap, lb + 1, s.b, [(lb + 1, 2.4), (c[3] - s.d(26), 2.8), (c[9] + s.d(4), 1.0), (c[10] - s.d(20), 2.0), (s.dragstarts[1] - s.d(40), 2.0), (c[12] + s.d(10), 1.3)])
        both = view_of(union(s.r('paneScan'), s.r('paneCbct')), fill=0.99, zmax=1.4, dy=-10)
        dialog = view_of(s.r('placeDialog'), fill=0.62, zmax=1.7)
        views = view_of(s.r('viewport'), fill=1.0, zmax=1.32)
        cam.cut(t0, WIDE)
        cam.to(at(s, c[0], t0) - 4, dialog, move=36)
        cam.to(t1 - 6, both, move=30)
        cam.to(at(s, c[9], t0) + 34, view_of(grow(s.r('paneCbct'), 30, 24), fill=0.96, zmax=1.9, dy=30), move=40)
        cam.to(at(s, c[10], t0) + 40, views, move=34)
        cam.to(at(s, s.dragstarts[1], t0) + 10, WIDE, move=28)
        cam.to(at(s, c[11], t0) - 2, dialog, move=34)
        cam.to(at(s, c[12], t0) + 52, view_of(s.r('mpr3d'), fill=0.92, zmax=2.2), move=50)  # both scans in the jaw
        mv.caption(t0 + 16, at(s, c[9], t0) - 4, 'Match the intraoral scan', 'Match')
        mv.caption(at(s, c[9], t0) + 8, at(s, c[10], t0) + 14, 'Colour-coded fit check', 'fit check')
        mv.caption(at(s, s.dragstarts[1], t0), at(s, c[12], t0) + 30, 'The lower scan copies the alignment', 'copies the alignment')

    # ---- the panoramic curve ----------------------------------------------------------------------
    if 'curve' in S:
        s = S['curve']
        t0 = tl.n
        c = s.clicks  # 0 Plan, 1 maximize the axial view, 2 restore
        down, up = s.downs[2], s.ups[2]  # the stroke along the arch
        tl.clip(s.cap, s.a, s.b, [(s.a, 1.9), (down - s.d(40), 1.25), (up + s.d(8), 1.7), (c[2] + s.d(14), 1.15)], xfade=X)
        cam.cut(t0, WIDE)
        cam.to(at(s, c[1], t0) + 44, view_of(s.r('planArea'), fill=0.98, zmax=1.5), move=40)
        cam.to(at(s, down, t0) + 4, view_of(grow(s.path_box(down, up), 110, 70), fill=0.9, zmax=1.9), move=36)
        cam.to(at(s, c[2], t0) + 48, view_of(grow(s.r('pano'), 16, 20), fill=1.0, zmax=1.7, dy=10), move=46)  # the panoramic that came of it
        mv.caption(t0 + 16, tl.n - 4, 'Draw the arch. Get the panoramic.', 'Draw the arch.')

    # ---- implants ---------------------------------------------------------------------------------
    if 'implants' in S:
        s = S['implants']
        t0 = tl.n
        # the clicks on "+ Upper implant" (24, 26) and on the Implant ▾ list
        add24, brand, add26 = s.clicks[0], s.before('brandList'), s.after('mua24')
        tl.clip(s.cap, s.a, s.b, [
            (s.a, 1.7), (add24 - s.d(14), 1.6), (s.m('placed24'), 2.2), (s.m('zoomed') - s.d(6), 1.2), (s.m('library'), 2.0),
            (s.m('sized24') - s.d(10), 1.5), (s.m('tilted24'), 2.6), (s.m('mua24') - s.d(24), 1.9),
            (s.m('placed26'), 2.8), (s.m('sized26'), 2.5), (s.m('tilted26'), 3.0), (s.m('done') - s.d(20), 1.15), (s.b - s.d(34), 3.0),
        ], xfade=X)
        # the details close up: the implant's settings, the cross-sections, the tangential view and the
        # small 3D view – everything left of the Objects list, along the window's lower edge
        z = W / (s.r('plan3d')[0] + s.r('plan3d')[2])
        detail = ((s.r('plan3d')[0] + s.r('plan3d')[2]) / 2, 2000, z)
        cam.cut(t0, view_of(grow(s.r('pano'), 16, 20), fill=1.0, zmax=1.7, dy=10))
        cam.to(at(s, add24, t0) - 2, WIDE, move=40)  # placing: every view at once
        cam.to(at(s, s.m('zoomed'), t0) - 8, detail, move=44)
        cam.to(at(s, add26, t0) - 2, WIDE, move=36)
        cam.to(at(s, s.m('placed26'), t0) + 44, detail, move=40)
        cam.to(at(s, s.m('done'), t0) + 30, WIDE, move=40)
        k = [at(s, f, t0) for f in (brand, s.m('sized24'), s.m('tilted24'), add26)]
        mv.caption(t0 + 16, k[0] - 10, 'Place the implant', 'Place')
        mv.caption(k[0] - 2, k[1] - 8, 'Real implants: 14 brands, 1,260+ sizes', 'Real implants:')
        mv.caption(k[1], k[2] - 8, 'Set position and angle in the sections', 'position and angle')
        mv.caption(k[2], k[3] - 12, 'Add the multi-unit abutment', 'multi-unit abutment')
        mv.caption(k[3] - 4, tl.n - 4, 'Same steps for the next one', 'next one')

    # ---- 3D ---------------------------------------------------------------------------------------
    if 'hero' in S:
        s = S['hero']
        t0 = tl.n
        c = s.clicks  # 0 maximize the 3D view, 1 the eye of "Upper jaw"
        o1, o2 = s.downs[1], s.downs[3]  # the two turns of the model
        # The shot starts with the 3D view already enlarged and the implant deselected. While the model
        # moves (the turns, the zoom between them) every recorded frame is shown: played at 1.3x it
        # would advance in uneven steps. The pointer's ways in between are shortened.
        tl.clip(s.cap, s.m('ready'), s.b, [(s.a, 1.5), (o1 - s.d(4), 1.0), (s.m('turned'), 1.5), (s.m('zoom') - s.d(2), 1.0), (s.m('zoomed') + s.d(4), 1.5), (o2 - s.d(4), 1.0), (s.m('end'), 1.5)], xfade=X)
        views = within(view_of(union(s.r('hero3d'), s.r('objects')), fill=1.0), union(s.r('hero3d'), s.r('objects')), top=True)  # the 3D view and the Objects list, nothing else
        cam.cut(t0, views)
        focus = implants_rect(s.cap, s.m('end'), s.r('hero3d'))
        if focus:  # closer, onto the implants, while the model turns the second time: the 3D view fills the frame
            cam.to(at(s, o2, t0) + 100, within(view_of(grow(focus, 190, 150), fill=0.9, zmax=1.55), s.r('hero3d'), top=True), move=120)
        mv.caption(t0 + 16, tl.n - 4, 'Check the plan in 3D', '3D')

    # ---- report -----------------------------------------------------------------------------------
    if 'report' in S:
        s = S['report']
        t0 = tl.n
        c = s.clicks  # 0 Export ▾, 1 Planning report (PDF)…
        tl.clip(s.cap, s.a, c[1] + s.d(8), 1.3, xfade=X)
        la, lb, _ = s.lapse('report')
        mv.badge(*tl.lapse(s.cap, la, lb, 0.9))
        t1 = tl.n
        tl.still(s.cap, s.b - 1, 2.5)
        cam.cut(t0, cam.at(t0 - 1) if 'hero' in S else WIDE)
        cam.to(at(s, c[0], t0) + 16, view_of(grow(s.r('exportMenu'), 190, 120), fill=0.8, zmax=1.9), move=30)
        cam.to(at(s, c[1], t0) + 36, WIDE, move=32)  # the whole window while the report is made
        if report_pages:
            mv.notes.append((t1, tl.n, report_fan(report_pages)))
        mv.caption(t0 + 14, tl.n - 4, 'Export the planning report', 'planning report')

    # ---- closing card -----------------------------------------------------------------------------
    tl.card(cards.outro, 3.8, xfade=18)
    return mv


def report_fan(paths):
    """Pages of the report fanned out over the dimmed app: an implant's page in front, the overview and the next implant behind."""
    order = [p for p in (2, 0, 3) if p < len(paths)] or [0]
    pages = []
    for p in order:
        img = cv2.imread(paths[p], cv2.IMREAD_COLOR)
        h = 650
        img = cv2.resize(img, (int(img.shape[1] * h / img.shape[0]), h), interpolation=cv2.INTER_AREA)
        pad = 70
        spr = np.zeros((img.shape[0] + 2 * pad, img.shape[1] + 2 * pad, 4), np.uint8)
        sh = np.zeros(spr.shape[:2], np.uint8)
        cv2.rectangle(sh, (pad, pad + 16), (pad + img.shape[1], pad + img.shape[0] + 16), 170, -1)
        spr[:, :, 3] = cv2.GaussianBlur(sh, (0, 0), 20)
        spr[pad:pad + img.shape[0], pad:pad + img.shape[1], :3] = img
        spr[pad:pad + img.shape[0], pad:pad + img.shape[1], 3] = 255
        pages.append(spr)
    # (delay s, x offset, y offset, rotation °): the front page last, so it is drawn on top
    slots = [(0.0, 0, -4, 0.0), (0.1, -440, 26, -6.0), (0.2, 440, 26, 6.0)][:len(pages)]
    draw_order = list(range(len(pages)))[::-1]

    def draw(frame, k, n):
        t = k / FPS
        dim = 0.6 * ease_out(t / 0.4)
        frame[:] = (frame.astype(np.float32) * (1 - dim)).astype(np.uint8)
        for i in draw_order:
            delay, dx, dy, rot = slots[i]
            u = ease_out((t - delay) / 0.6)
            if u <= 0:
                continue
            spr = pages[i]
            h, w = spr.shape[:2]
            m = cv2.getRotationMatrix2D((w / 2, h / 2), rot * u, 0.9 + 0.1 * u)
            m[0, 2] += W / 2 - w / 2 + dx * u
            m[1, 2] += H / 2 - h / 2 + dy + (1 - u) * 240 - 62
            layer = cv2.warpAffine(spr, m, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
            blend(frame, layer, 0, 0, min(1.0, u * 1.5))

    return draw


def load(dirs, only=None):
    S, report = {}, None
    for d in dirs:
        cap = Capture(d)
        ALL_RECTS.update(cap.rects)
        for name in cap.scenes:
            S[name] = Scene(cap, name)
        if os.path.exists(os.path.join(d, 'report.pdf')):
            report = os.path.join(d, 'report.pdf')
    if only:
        S = {k: v for k, v in S.items() if k in only.split(',')}
    pages = None
    if report and 'report' in S:
        base = os.path.join(os.path.dirname(report), 'report-page')
        subprocess.run(['pdftoppm', '-r', '110', '-png', report, base], check=True)
        pages = sorted(os.path.join(os.path.dirname(report), f) for f in os.listdir(os.path.dirname(report)) if f.startswith('report-page') and f.endswith('.png'))
    return S, pages


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('caps', nargs='+')
    ap.add_argument('--out', default='demo.mp4')
    ap.add_argument('--scale', type=float, default=1.0)
    ap.add_argument('--only', default=None, help='comma-separated scenes')
    ap.add_argument('--stills', default=None, help='write stills into this directory instead of a video')
    ap.add_argument('--every', type=int, default=30)
    ap.add_argument('--times', default=None, help='with --stills: only at these seconds (comma-separated)')
    ap.add_argument('--crf', type=int, default=16)
    ap.add_argument('--preset', default='slow')
    a = ap.parse_args()
    S, pages = load(a.caps, a.only)
    mv = build(S, pages)
    print(f'{mv.tl.n} frames = {mv.tl.n / FPS:.1f} s')
    seg = None
    for k, e in enumerate(mv.tl.out):  # where each part starts
        name = e['cap'].frames[e['i']]['s'] if e.get('cap') else 'card'
        if name != seg:
            print(f'  {k / FPS:6.2f} s  {name}')
            seg = name
    if a.stills:
        os.makedirs(a.stills, exist_ok=True)
        ks = [int(float(t) * FPS) for t in a.times.split(',')] if a.times else range(0, mv.tl.n, a.every)
        for k in ks:
            mv.still(min(k, mv.tl.n - 1), os.path.join(a.stills, f'{k:05d}.jpg'), a.scale)
    else:
        mv.render(a.out, scale=a.scale, crf=a.crf, preset=a.preset)
        print('wrote', a.out)


if __name__ == '__main__':
    main()
