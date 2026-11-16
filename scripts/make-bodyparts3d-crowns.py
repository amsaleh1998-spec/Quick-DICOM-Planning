#!/usr/bin/env python3
"""
Tooth crowns for the waxup library from BodyParts3D (the 28 permanent teeth of the BodyParts3D /
Anatomography database, (c) The Database Center for Life Science, CC BY-SA 2.1 Japan): cut off the
roots, close the cut, add wisdom teeth derived from the second molars, and write the two STL files
scripts/make-tooth-library.py takes (+z superior, +y anterior, patient left = -x).

    python3 scripts/make-bodyparts3d-crowns.py <BodyParts3D_data dir> out-dir/
    python3 scripts/make-tooth-library.py out-dir/upper_teeth.stl out-dir/lower_teeth.stl \
        public/library/teeth-bodyparts3d.json BodyParts3D

<BodyParts3D_data dir> holds parts_list_e.txt and stl/FMA*.stl (e.g. assets/BodyParts3D_data of
https://github.com/Kevin-Mattheus-Moerman/BodyParts3D, a copy of the BodyParts3D model files).

Changes made to the BodyParts3D teeth (as the licence asks to indicate): each tooth is cut across its
long axis at the average crown height from the incisal edge / cusp tips and the cut is closed flat
(the root removed); the wisdom teeth 18, 28, 38, 48 - not in BodyParts3D - are the second molars at
92 %, set behind them; the teeth keep their BodyParts3D positions, turned into the CAD orientation.
The result is shared under the same licence (CC BY-SA 2.1 Japan).
"""
import os
import re
import struct
import sys

import numpy as np

TEETH_FMA = {
    'FMA55681': 11, 'FMA55680': 12, 'FMA55798': 13, 'FMA55689': 14, 'FMA55688': 15, 'FMA55698': 16, 'FMA55697': 17,
    'FMA55682': 21, 'FMA55683': 22, 'FMA55799': 23, 'FMA55690': 24, 'FMA55691': 25, 'FMA55699': 26, 'FMA55700': 27,
    'FMA57143': 31, 'FMA57141': 32, 'FMA55687': 33, 'FMA55693': 34, 'FMA55692': 35, 'FMA55704': 36, 'FMA55703': 37,
    'FMA57142': 41, 'FMA57140': 42, 'FMA55686': 43, 'FMA55694': 44, 'FMA55695': 45, 'FMA55705': 46, 'FMA55706': 47,
}


def load_stl(path):
    b = open(path, 'rb').read()
    if b[:5] == b'solid' and b'facet' in b[:300]:
        return np.array([list(map(float, m.split())) for m in re.findall(rb'vertex\s+([^\n]+)', b)]).reshape(-1, 3, 3)
    n = struct.unpack('<I', b[80:84])[0]
    return np.frombuffer(b[84:84 + 50 * n], dtype=np.dtype([('n', '<f4', 3), ('v', '<f4', (3, 3)), ('a', '<u2')]))['v'].astype(float)


def teeth(src):
    """FDI -> (FMA id, name, triangles) of the BodyParts3D teeth."""
    names = dict(l.rstrip('\n').split('\t')[:2] for l in open(os.path.join(src, 'parts_list_e.txt'), encoding='utf-8') if l.startswith('FMA'))
    return {f: (fma, names.get(fma, ''), load_stl(os.path.join(src, 'stl', f'{fma}.stl'))) for fma, f in TEETH_FMA.items()}


# average crown heights (mm) by tooth kind - where to look for the neck
CL = {True: {1: 10.5, 2: 9.0, 3: 10.0, 4: 8.5, 5: 8.5, 6: 7.5, 7: 7.0}, False: {1: 9.0, 2: 9.5, 3: 11.0, 4: 8.5, 5: 8.0, 6: 7.5, 7: 7.0}}


def weld(tri):
    v = tri.reshape(-1, 3)
    q = np.round(v * 1e4).astype(np.int64)
    uq, first, inv = np.unique(q, axis=0, return_index=True, return_inverse=True)
    return v[first], inv.reshape(-1, 3)


def long_axis(pos, upper):
    c = pos.mean(0)
    w, V = np.linalg.eigh(np.cov((pos - c).T))
    a = V[:, -1]
    occl = np.array([0, 0, -1.0]) if upper else np.array([0, 0, 1.0])
    return a if a @ occl > 0 else -a  # pointing to the occlusal end


def section_area(pos, idx, p0, a):
    """Perimeter of the cut of the mesh with the plane (p0, a)."""
    d = (pos - p0) @ a
    e1 = np.cross(a, [1, 0, 0] if abs(a[0]) < 0.9 else [0, 1, 0])
    e1 /= np.linalg.norm(e1)
    e2 = np.cross(a, e1)
    segs = []
    for t in idx:
        s = d[t]
        if (s > 0).all() or (s <= 0).all():
            continue
        pts = []
        for i, j in ((0, 1), (1, 2), (2, 0)):
            if (s[i] > 0) != (s[j] > 0):
                u = s[i] / (s[i] - s[j])
                pts.append(pos[t[i]] + u * (pos[t[j]] - pos[t[i]]))
        if len(pts) == 2:
            segs.append(pts)
    if not segs:
        return 0.0
    # the perimeter of the section (independent of the triangles' orientation) - smallest at the neck
    return float(sum(np.linalg.norm(q - p) for p, q in segs))


def cut_crown(pos, idx, p0, a):
    """Keep the part on the +a side of the plane; close the cut with a flat cap. Watertight."""
    d = (pos - p0) @ a
    newpos = list(pos)
    emid = {}

    def mid(i, j):
        k = (min(i, j), max(i, j))
        if k not in emid:
            u = d[i] / (d[i] - d[j])
            newpos.append(pos[i] + u * (pos[j] - pos[i]))
            emid[k] = len(newpos) - 1
        return emid[k]

    out = []
    for t in idx:
        up = d[t] >= 0
        n = up.sum()
        if n == 3:
            out.append(t)
        elif n == 0:
            continue
        else:
            # rotate so the odd vertex is first, keeping the winding
            k = int(np.where(up != (n == 2))[0][0]) if n in (1, 2) else 0
            if n == 1:
                k = int(np.where(up)[0][0])
            else:
                k = int(np.where(~up)[0][0])
            i0, i1, i2 = t[k], t[(k + 1) % 3], t[(k + 2) % 3]
            m1, m2 = mid(i0, i1), mid(i0, i2)
            if n == 1:  # i0 above
                out.append([i0, m1, m2])
            else:  # i0 below, i1 and i2 above
                out += [[m1, i1, i2], [m1, i2, m2]]
    out = np.array(out)
    P = np.array(newpos)
    # boundary edges (used once) -> loops -> fan caps
    e = np.concatenate([out[:, [0, 1]], out[:, [1, 2]], out[:, [2, 0]]])
    key = np.sort(e, 1)
    _, inv, cnt = np.unique(key, axis=0, return_inverse=True, return_counts=True)
    bnd = e[cnt[inv] == 1]
    nxt = {int(b): int(c) for b, c in bnd[:, [1, 0]]}  # cap runs opposite to the boundary direction
    caps, seen = [], set()
    for s in list(nxt):
        if s in seen:
            continue
        loop, v = [], s
        while v not in seen and v in nxt:
            seen.add(v)
            loop.append(v)
            v = nxt[v]
        if len(loop) < 3:
            continue
        c = P[loop].mean(0)
        P = np.vstack([P, c])
        ci = len(P) - 1
        for i in range(len(loop)):
            caps.append([ci, loop[i], loop[(i + 1) % len(loop)]])
    tris = np.vstack([out, np.array(caps)]) if caps else out
    # drop unused vertices
    used = np.unique(tris)
    remap = -np.ones(len(P), dtype=np.int64)
    remap[used] = np.arange(len(used))
    return P[used], remap[tris]


def crown_of(f, tri):
    upper = f < 30
    kind = f % 10
    pos, idx = weld(tri)
    a = long_axis(pos, upper)
    tip = (pos @ a).max()
    # the cervical line: the average crown height from the incisal edge / cusp tips, along the long axis
    h = CL[upper][kind]
    p0 = pos[np.argmax(pos @ a)] - a * h
    A = section_area(pos, idx, p0, a)
    cp, ci = cut_crown(pos, idx, p0, a)
    return cp, ci, h, A


def watertight(idx):
    e = np.sort(np.concatenate([idx[:, [0, 1]], idx[:, [1, 2]], idx[:, [2, 0]]]), 1)
    _, cnt = np.unique(e, axis=0, return_counts=True)
    return int((cnt != 2).sum())


def to_cad(p):
    """BodyParts3D (x patient left, y posterior, z superior) -> CAD files (patient left -x, +y anterior)."""
    return np.stack([-p[:, 0], -p[:, 1], p[:, 2]], 1)


def write_stl(path, meshes, title):
    tris = np.concatenate([p[i] for p, i in meshes])
    n = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
    rec = np.zeros(len(tris), dtype=np.dtype([('n', '<f4', 3), ('v', '<f4', (3, 3)), ('a', '<u2')]))
    rec['n'], rec['v'] = n, tris
    with open(path, 'wb') as fh:
        fh.write(title.encode()[:80].ljust(80, b' '))
        fh.write(struct.pack('<I', len(tris)))
        fh.write(rec.tobytes())


def main(src, out):
    T = teeth(src)
    crowns = {}
    for f in sorted(T):
        cp, ci, h, A = crown_of(f, T[f][2])
        crowns[f] = (cp, ci)
        print(f'{f}: crown {h:.1f} mm, neck perimeter {A:.1f} mm, {len(ci)} triangles, open edges {watertight(ci)}')
    # wisdom teeth: the second molar, 92 %, set distally behind it (derived from BodyParts3D)
    for f8, f7, f6 in ((18, 17, 16), (28, 27, 26), (38, 37, 36), (48, 47, 46)):
        p7, i7 = crowns[f7]
        c7, c6 = p7.mean(0), crowns[f6][0].mean(0)
        d = c7 - c6
        d[2] = 0
        d /= np.linalg.norm(d)
        md = np.ptp(p7 @ d)
        p8 = (p7 - c7) * 0.92 + c7 + d * (md * 0.96 + 0.1)
        crowns[f8] = (p8, i7.copy())
    os.makedirs(out, exist_ok=True)
    os.makedirs(os.path.join(out, 'single-crowns'), exist_ok=True)
    centre = np.concatenate([p for p, _ in crowns.values()]).mean(0)
    for jaw, sel in (('upper', [f for f in crowns if f < 30]), ('lower', [f for f in crowns if f > 30])):
        meshes = []
        for f in sorted(sel):
            p, i = crowns[f]
            q = to_cad(p - centre)
            meshes.append((q, i))
            write_stl(os.path.join(out, 'single-crowns', f'crown-{f}.stl'), [(q, i)], f'BodyParts3D crown {f} (CC BY-SA 2.1 JP, DBCLS)')
        write_stl(os.path.join(out, f'{jaw}_teeth.stl'), meshes, f'BodyParts3D {jaw} crowns (CC BY-SA 2.1 JP, DBCLS)')
    print('written', out)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
