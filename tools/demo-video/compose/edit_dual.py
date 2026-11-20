"""The edit of the dual scan video (see edit.py for the implant demo and for what the pieces are).

  python3 edit_dual.py <capture dir> [...] --out dual.mp4 [--scale 0.5] [--stills DIR --times 3,12.5]
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import cards
import engine
from edit import Scene, grow, load, paced, union, within
from engine import FPS, Camera, Movie, Timeline, view_of


def build(S, pace=None):
    pace = pace or {}
    tl = Timeline()
    WIDE = engine.WIDE
    cam = Camera(WIDE)
    mv = Movie(tl, cam)
    X = 12

    def at(sc, f, start=0):
        return tl.at(sc.cap, f, start)

    mv.starts = {'intro': 0}

    def begin(name):
        mv.starts[name] = tl.n
        tl.slow = pace.get(name, {}).get('slow', 1.0)
        return tl.n

    def pad(sc, name):
        d = pace.get(name, {}).get('pad', 0)
        if d > 0:
            tl.still(sc.cap, sc.b - 1, d)

    tl.card(cards.titled('Dual Scan Protocol'), 2.8 + pace.get('intro', {}).get('pad', 0))
    # ---- a DICOM file is double-clicked; the app opens it --------------------------------------
    t0 = begin('file')
    tl.card(cards.file_window, 3.0 + pace.get('file', {}).get('pad', 0), xfade=X)
    mv.caption(t0 + 14, tl.n - 2, 'Double-click a DICOM file', 'Double-click')
    if 'dopen' in S:
        s = S['dopen']
        t0 = begin('dopen')
        la, lb, _ = s.lapse('load')
        tl.lapse(s.cap, min(la + 2, lb), lb, 1.6, xfade=X)
        tl.clip(s.cap, lb + 1, s.b, 0.8)
        pad(s, 'dopen')
        vp = view_of(s.r('viewport'), fill=1.0, zmax=1.32)
        cam.cut(t0, WIDE)
        cam.to(at(s, s.m('loaded'), t0) + 44, (vp[0] - 40, vp[1], vp[2]), move=44)
        mv.caption(t0 + 10, tl.n - 4, 'The scan opens in the app', 'opens in the app')

    # ---- the panoramic curve ---------------------------------------------------------------------
    if 'dcurve' in S:
        s = S['dcurve']
        t0 = begin('dcurve')
        down, up = s.before('drawn', 'down'), s.m('drawn')
        tl.clip(s.cap, s.a, s.b, [(s.a, 1.3), (s.clicks[0] - s.d(4), 1.0), (s.m('open'), 1.2), (down - s.d(30), 1.0), (s.m('settled'), 0.8)], xfade=X)
        pad(s, 'dcurve')
        cam.cut(t0, WIDE)
        cam.to(at(s, s.m('open'), t0) + 36, view_of(s.r('planArea'), fill=0.98, zmax=1.5), move=34)
        cam.to(at(s, up, t0) - 2, WIDE, move=40)
        cam.to(at(s, min(s.m('settled'), s.b - 1), t0) + 40, view_of(grow(s.r('pano'), 16, 20), fill=1.0, zmax=1.7, dy=10), move=38)
        mv.caption(t0 + 16, tl.n - 4, 'Draw the panoramic curve', 'panoramic curve')

    # ---- the denture's own CBCT; the markers ------------------------------------------------------
    if 'dscan' in S:
        s = S['dscan']
        t0 = begin('dscan')
        c = s.clicks  # 0 Scans, 1 Denture CBCT…, 2 Folder…
        la, lb, _ = s.lapse('denture')
        tl.clip(s.cap, s.a, la, [(s.a, 1.1), (c[1] - s.d(10), 0.85)], xfade=X)
        mv.badge(*tl.lapse(s.cap, min(la + 1, lb), lb, 1.6))
        t1 = tl.n
        hold = pace.get('dscan', {}).get('hold', 0)
        w = min(lb + 1 + s.d(70), s.b - 2)
        tl.clip(s.cap, lb + 1, w, 0.75)
        if hold:  # (with a voiceover: the markers and their result held while they are spoken of)
            tl.still(s.cap, w, hold)
        tl.clip(s.cap, w, s.b, 0.75)
        pad(s, 'dscan')
        side = s.r('dualSide')
        cam.cut(t0, view_of(grow(s.r('pano'), 16, 20), fill=1.0, zmax=1.7, dy=10) if 'dcurve' in S else WIDE)
        cam.to(at(s, c[0], t0) + 30, within(view_of(grow(s.r('sidebar'), 260, 0), fill=0.9, zmax=1.9), [0, -40, 1664, 940], top=True), move=36)
        cam.to(at(s, c[1], t0) + 34, view_of(grow(s.r('sourceDialog'), 60, 90), fill=0.8, zmax=1.9), move=34)
        cam.to(t1 - 20, WIDE, move=30)
        # the markers, close: the two projections with the matched markers and the result line
        cam.to(t1 + 52, view_of([side[0] - 30, side[1] - 70, side[2] + 620, 560], fill=1.0, zmax=2.1), move=44)
        mv.caption(t0 + 14, at(s, c[2], t0) + 16, 'Add the CBCT of the denture alone', 'denture alone')
        mv.caption(at(s, c[2], t0) + 26, t1 + 20, 'Finding the radiopaque markers', 'radiopaque markers')
        mv.caption(t1 + 30, tl.n - 4, 'Markers matched automatically. Nothing to click.', 'automatically.')

    # ---- clean-up ---------------------------------------------------------------------------------
    if 'dclean' in S:
        s = S['dclean']
        t0 = begin('dclean')
        cut, keep, fill, smooth = s.after('below'), s.after('cut'), s.before('holes'), s.after('holes')
        tl.clip(s.cap, s.a, s.b, [(s.a, 1.0), (cut - s.d(6), 0.9), (s.m('cut') - s.d(4), 0.8), (smooth - s.d(6), 1.15), (s.m('smooth'), 1.1)], xfade=X)
        pad(s, 'dclean')
        w3 = s.r('dual3d')
        tools = s.r('dualTools')
        work = view_of(union(w3, tools), fill=1.0, zmax=1.45)  # the 3D view and the tools
        cam.cut(t0, WIDE)
        cam.to(at(s, s.m('below'), t0), work, move=50)
        # the cut, the hole it leaves, closing and smoothing it: close on that place
        box = s.path_box(s.before('cut', 'down'), s.m('cut'), 0)
        spot = within(view_of(grow(box, 250, 190), fill=1.0, zmax=2.0), union(w3, tools))
        cam.to(at(s, cut, t0) + 50, spot, move=46)
        cam.to(at(s, keep, t0) - 20, work, move=34)
        cam.to(at(s, keep, t0) + 70, spot, move=40)
        cam.to(at(s, fill, t0) - 16, work, move=30)
        cam.to(at(s, smooth, t0) + 40, spot, move=40)
        cam.to(at(s, s.m('smooth'), t0) + 30, work, move=40)
        cam.to(at(s, s.b - 1, t0) - 30, work, move=1)
        cam.to(tl.n - 6, WIDE, move=34)
        mv.caption(t0 + 14, at(s, cut, t0) - 6, 'Turn it over: scan residue', 'scan residue')
        mv.caption(at(s, cut, t0), at(s, keep, t0) - 8, 'Cut brush: only where the two touch', 'Cut brush:')
        mv.caption(at(s, keep, t0) - 2, at(s, smooth, t0) - 8, 'Remove the islands. Close the hole.', 'islands.')
        mv.caption(at(s, smooth, t0), at(s, s.m('smooth'), t0) + 10, 'Smooth brush for the finish', 'Smooth brush')

    # ---- placed -----------------------------------------------------------------------------------
    if 'dplace' in S:
        s = S['dplace']
        t0 = begin('dplace')
        # (a take in which the scene went on to the 3D view: up to there)
        end = s.clicks[1] - s.d(20) if len(s.clicks) > 1 else s.b
        tl.clip(s.cap, s.a, end, [(s.a, 1.0), (s.m('placed'), 0.75)], xfade=X)
        pad(s, 'dplace')
        views = view_of(s.r('viewport'), fill=1.0, zmax=1.32)
        cam.cut(t0, WIDE)
        cam.to(at(s, s.m('placed'), t0) + 46, views, move=40)
        mv.caption(at(s, s.m('placed'), t0) + 6, tl.n - 4, "Placed in the patient's CBCT", "patient's CBCT")

    # ---- through the cross-sections ---------------------------------------------------------------
    if 'dslices' in S:
        s = S['dslices']
        t0 = begin('dslices')
        tl.clip(s.cap, s.a, s.b, [(s.a, 1.6), (s.m('start') - s.d(10), 1.0)], xfade=X)
        pad(s, 'dslices')
        views = view_of(s.r('viewport'), fill=1.0, zmax=1.32)
        cam.cut(t0, views)
        mv.caption(t0 + 10, tl.n - 4, 'Scroll the sections: the denture on every slice', 'on every slice')

    # ---- 3D ---------------------------------------------------------------------------------------
    if 'd3d' in S:
        s = S['d3d']
        t0 = begin('d3d')
        o = s.downs[-1]  # the turn of the model
        tl.clip(s.cap, s.a, s.b, [(s.a, 1.2), (o - s.d(4), 1.0), (s.m('turned'), 1.0)], xfade=X)
        pad(s, 'd3d')
        hero = within(view_of(s.r('hero3d'), fill=1.0), s.r('hero3d'), top=True)
        cam.cut(t0, view_of(s.r('viewport'), fill=1.0, zmax=1.32))
        cam.to(at(s, s.m('max'), t0) + 30, hero, move=34)
        mv.caption(at(s, s.clicks[0], t0) + 16, tl.n - 4, 'The denture, exactly in place', 'exactly in place')

    mv.starts['outro'] = tl.n
    tl.slow = 1.0
    tl.card(cards.outro_dual, 3.8 + pace.get('outro', {}).get('pad', 0), xfade=18)
    return mv


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('caps', nargs='+')
    ap.add_argument('--out', default='dual.mp4')
    ap.add_argument('--scale', type=float, default=1.0)
    ap.add_argument('--only', default=None)
    ap.add_argument('--stills', default=None)
    ap.add_argument('--every', type=int, default=30)
    ap.add_argument('--times', default=None)
    ap.add_argument('--crf', type=int, default=16)
    ap.add_argument('--preset', default='slow')
    ap.add_argument('--vo', default=None, help='lines.json of a voiceover (voice.py): the video is paced for it; writes <out>.vo.json')
    a = ap.parse_args()
    S, _ = load(a.caps, a.only)
    if a.vo:
        import json
        vo = json.load(open(a.vo))
        # (the video is unhurried already: slower only where a line needs it; cards and the 3D turn are held, not slowed)
        mv, sch, pace = paced(S, None, vo['lines'], vo.get('holds'), base=1.0, most=1.3, build=lambda S, _, p: build(S, p), fixed=('intro', 'file', 'outro', 'd3d'))
        for n, p in pace.items():
            print(f"  pace {n:8s} x{p['slow']:.2f}  +{p['pad']:.1f} s")
        for l in sch:
            print(f"  {l['start']:6.2f} s (+{l['late']:.1f})  {l['text']}")
        st = {k: v / FPS for k, v in mv.starts.items()}
        json.dump(dict(seconds=mv.tl.n / FPS, starts=st, music=dict(drums=st.get('dopen', 6), tune=st.get('d3d', 0), out=st['outro']), lines=sch), open((a.stills or a.out) + '.vo.json', 'w'), indent=1)
    else:
        mv = build(S)
    print(f'{mv.tl.n} frames = {mv.tl.n / FPS:.1f} s')
    seg = None
    for k, e in enumerate(mv.tl.out):
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
