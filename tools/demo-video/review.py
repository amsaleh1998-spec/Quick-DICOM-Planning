"""Look at a recording: a contact sheet of its frames (pointer marked) and what happened in it.

  python3 review.py <recording dir> [cols rows [from to]]     -> <recording dir>/sheet.png
"""
import json
import os
import sys

from PIL import Image, ImageDraw

cap = sys.argv[1]
cols, rows = (int(sys.argv[2]), int(sys.argv[3])) if len(sys.argv) > 3 else (4, 3)
log = json.load(open(os.path.join(cap, 'log.json')))
fr = log['frames']
a = int(sys.argv[4]) if len(sys.argv) > 5 else 0
b = int(sys.argv[5]) if len(sys.argv) > 5 else len(fr) - 1

# ---- what happened ------------------------------------------------------------------------------
fps = log['meta']['fps']
print('recording', log['meta'], '-', len(fr), 'frames')
events = []
for s in log['scenes']:
    events.append((s['from'], f"== scene {s['name']}  [{s['from']}..{s['to']})  {(s['to'] - s['from']) / fps:.1f} s"))
for k, v in log['marks'].items():
    events.append((v, f'   mark {k}'))
for e in log['events']:
    if e['type'] in ('click', 'dragstart', 'drop', 'key'):
        events.append((e['i'], f"   {e['type']} {e.get('label') or e.get('key') or ''} @ {round(e.get('x', 0))},{round(e.get('y', 0))}"))
    elif e['type'] == 'lapse':
        events.append((e['i'], f"   wait '{e['label']}': {e['ms'] / 1000:.1f} s in real time, frames {e['i']}..{e['to'] - 1}"))
for i, text in sorted(events, key=lambda e: e[0]):
    print(f'{i:6d} {text}')

# ---- contact sheet ------------------------------------------------------------------------------
n = cols * rows
idx = [round(a + (b - a) * k / max(1, n - 1)) for k in range(n)]
W = 1664 // cols if cols <= 4 else 416
sc = W / log['meta']['w']
H = round(log['meta']['h'] * sc)
sheet = Image.new('RGB', (W * cols, H * rows))
for k, i in enumerate(idx):
    im = Image.open(os.path.join(cap, 'frames', fr[i]['f'])).convert('RGB').resize((W, H), Image.LANCZOS)
    d = ImageDraw.Draw(im)
    x, y = fr[i]['x'] * sc, fr[i]['y'] * sc
    d.ellipse([x - 5, y - 5, x + 5, y + 5], outline=(255, 60, 60), width=2)
    if fr[i]['d']:
        d.ellipse([x - 2, y - 2, x + 2, y + 2], fill=(255, 60, 60))
    d.text((4, H - 12), f"{i} {fr[i]['s']} {fr[i]['c']}{' (real time)' if fr[i].get('lapse') else ''}", fill=(255, 255, 0))
    sheet.paste(im, ((k % cols) * W, (k // cols) * H))
out = os.path.join(cap, 'sheet.png')
sheet.save(out)
print('wrote', out, sheet.size)
