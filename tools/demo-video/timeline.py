# Print the edit's timeline, captions and the fastest camera moves: python3 -I timeline.py <capture dirs...>
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'compose'))
import engine, edit
S, pages = edit.load(sys.argv[1:], None)
mv = edit.build(S, pages)
FPS = engine.FPS
print(f'{mv.tl.n} frames = {mv.tl.n / FPS:.1f} s')
seg, start, rows = None, 0, []
for k, e in enumerate(mv.tl.out):
    name = e['cap'].frames[e['i']]['s'] if e.get('cap') else 'card'
    if name != seg:
        if seg is not None: rows.append((seg, start / FPS, (k - start) / FPS))
        seg, start = name, k
rows.append((seg, start / FPS, (mv.tl.n - start) / FPS))
for n, t, d in rows: print(f'  {t:6.2f} s  {n:9s} {d:5.2f} s')
print('captions:')
for t0, t1, text, accent in sorted(mv.captions): print(f'  {t0 / FPS:6.2f} – {t1 / FPS:6.2f}  ({(t1 - t0) / FPS:4.2f} s)  {text}')
shifts, prev = [], None
for k, e in enumerate(mv.tl.out):
    if e.get('card'):
        prev = None
        continue
    lay = engine.Layout(e['cap'].w, e['cap'].h, mv.cam.at(k))
    cur = (lay.ox, lay.oy, lay.s)
    if prev is not None and not e.get('xfade'):
        shifts.append((max(abs(cur[0] - prev[0]), abs(cur[1] - prev[1])), k))
    prev = cur
shifts.sort(reverse=True)
seen = []
for d, k in shifts:
    if all(abs(k - j) > 40 for j in seen):
        seen.append(k)
        print(f'  camera: {d:5.1f} px/frame at {k / FPS:.2f} s')
    if len(seen) >= 6: break
# pointer speed in the frame (px per frame), top moments
import math
jumps, prevp = [], None
for k, e in enumerate(mv.tl.out):
    if e.get('card'):
        prevp = None
        continue
    lay = engine.Layout(e['cap'].w, e['cap'].h, mv.cam.at(k))
    fr = e['cap'].frames[e['i']]
    p = lay.pt(fr['x'], fr['y'])
    if prevp is not None and not e.get('xfade'): jumps.append((math.hypot(p[0] - prevp[0], p[1] - prevp[1]), k))
    prevp = p
jumps.sort(reverse=True)
seen = []
for d, k in jumps:
    if all(abs(k - j) > 30 for j in seen):
        seen.append(k)
        print(f'  pointer: {d:5.1f} px/frame at {k / FPS:.2f} s')
    if len(seen) >= 6: break
