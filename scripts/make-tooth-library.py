#!/usr/bin/env python3
"""
Build the waxup tooth library (public/library/teeth-generic.bin) from two STL files exported from a
dental CAD: the upper teeth (18-28) and the lower teeth (48-38), one closed shell per tooth, in the
usual CAD orientation (+z superior / occlusal plane roughly horizontal, +y anterior, right-handed).

    pip install numpy pyfqmr
    python3 scripts/make-tooth-library.py upper.stl lower.stl public/library/teeth-generic.json

What it does
  - splits each file into its teeth (connected shells) and numbers them (FDI) along the arch;
  - expresses each jaw in the app's axes: x = patient left, y = posterior, z = superior, with its
    occlusal plane (the mean height of its cusp tips) at z = 0, the midline at x = 0 and the front of
    the arch at y = 0 (the two files need not be in occlusion: the app places each jaw on the arch);
  - decimates every tooth to about 0.35 mm edges (fine enough for freeform brushing);
  - finds the cusp tips / incisal edge of every tooth ("tooth parts" that can be moved);
  - writes one binary (header JSON + per tooth int16 positions relative to the tooth centroid in
    1/2000 mm, and uint16 triangle indices), deflate-compressed and wrapped base64 in a small JSON
    file (served as data by any static host).
"""
import base64
import json
import struct
import sys
import zlib

import numpy as np
import pyfqmr

QUANT = 2000.0  # positions in 1/2000 mm


def load_stl(path):
    b = open(path, 'rb').read()
    n = struct.unpack('<I', b[80:84])[0]
    dt = np.dtype([('n', '<f4', 3), ('v', '<f4', (3, 3)), ('a', '<u2')])
    tri = np.frombuffer(b[84:84 + 50 * n], dtype=dt)['v'].reshape(-1, 3).astype(np.float64)
    q = np.round(tri * 1e4).astype(np.int64)
    uq, inv = np.unique(q, axis=0, return_inverse=True)
    return uq / 1e4, inv.reshape(-1, 3)


def shells(pos, idx):
    parent = np.arange(len(pos))

    def find(x):
        r = x
        while parent[r] != r:
            r = parent[r]
        while parent[x] != r:
            parent[x], x = r, parent[x]
        return r

    for a, b, c in idx:
        ra = find(a)
        parent[find(b)] = ra
        parent[find(c)] = ra
    roots = np.array([find(i) for i in range(len(pos))])
    tr = roots[idx[:, 0]]
    out = []
    for r in np.unique(tr):
        t = idx[tr == r]
        used = np.unique(t)
        remap = -np.ones(len(pos), dtype=np.int64)
        remap[used] = np.arange(len(used))
        out.append((pos[used], remap[t]))
    return out


def number_teeth(teeth, upper, left_axis_guess):
    """Order the shells of one jaw along the arch and give them FDI numbers."""
    c = np.array([p.mean(0) for p, _ in teeth])
    centre = c.mean(0)
    # order along the U by the angle around the arch centre (anterior = +y in the file)
    ang = np.arctan2(c[:, 0] - centre[0], c[:, 1] - centre[1])
    order = np.argsort(ang)
    half = len(order) // 2
    a, b = order[:half], order[half:]
    # which half is the patient's left
    if c[a].mean(0) @ left_axis_guess > c[b].mean(0) @ left_axis_guess:
        left, right = a, b
    else:
        left, right = b, a
    # from the midline outwards
    left = sorted(left, key=lambda i: abs(ang[i]))
    right = sorted(right, key=lambda i: abs(ang[i]))
    q_right, q_left = (1, 2) if upper else (4, 3)
    fdi = {}
    for k, i in enumerate(right):
        fdi[i] = q_right * 10 + k + 1
    for k, i in enumerate(left):
        fdi[i] = q_left * 10 + k + 1
    return fdi


def area(pos, idx):
    a, b, c = pos[idx[:, 0]], pos[idx[:, 1]], pos[idx[:, 2]]
    return 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1).sum()


def decimate(pos, idx):
    target = int(np.clip(area(pos, idx) / 0.055, 2500, 9000))
    s = pyfqmr.Simplify()
    s.setMesh(pos, idx)
    s.simplify_mesh(target_count=target, aggressiveness=5, preserve_border=True, verbose=False)
    v, f, _ = s.getMesh()
    return np.asarray(v, dtype=np.float64), np.asarray(f, dtype=np.int64)


def cusps(pos, fdi, occlusal, t, n):
    """
    Tooth parts that can be moved: the cusp tips (molars: the four main cusps, one per quarter of the
    occlusal table; premolars: buccal and lingual cusp; canine: the tip) or the incisal edge.
    pos: vertices relative to the centroid; t: mesio-distal direction (along the arch, right -> left),
    n: buccal direction; occlusal: towards the opposing jaw.
    """
    h = pos @ occlusal
    kind = fdi % 10
    u, w = pos @ t, pos @ n
    if kind <= 2:  # incisors: the incisal edge
        return [pos[h > h.max() - 0.6].mean(0)], 3.2
    if kind == 3:  # canine: the cusp tip
        return [pos[np.argmax(h)]], 3.4
    sectors = [w > 0, w <= 0] if kind <= 5 else [(w > 0) & (u > 0), (w > 0) & (u <= 0), (w <= 0) & (u > 0), (w <= 0) & (u <= 0)]
    tips = []
    for m in sectors:
        i = np.where(m)[0]
        tips.append(pos[i[np.argmax(h[i])]])
    return tips, 2.8 if kind <= 5 else 2.6


def jaw_frame(teeth, fdi, upper):
    """
    Library axes of one jaw: x = patient left, y = posterior, z = superior (rows of R, in file
    coordinates), and the origin: midline, front of the arch, occlusal plane (mean cusp height).
    The files are expected in the usual CAD orientation: +z superior, +y anterior (right-handed).
    """
    c = np.array([p.mean(0) for p, _ in teeth])
    w, v = np.linalg.eigh(np.cov((c - c.mean(0)).T))
    S = v[:, 0] * (1 if v[2, 0] > 0 else -1)
    by = {fdi[i]: c[i] for i in range(len(c))}
    qr, ql = (1, 2) if upper else (4, 3)
    L = np.mean([by[ql * 10 + k] - by[qr * 10 + k] for k in range(1, 8)], axis=0)
    L -= (L @ S) * S
    L /= np.linalg.norm(L)
    P = np.cross(S, L)  # S x L = P
    R = np.vstack([L, P, S])
    mids = np.array([(by[ql * 10 + k] + by[qr * 10 + k]) / 2 for k in range(1, 8)])
    origin = np.array([(mids @ L).mean(), (c @ P).min(), 0.0])
    return R, origin


def main(upper_path, lower_path, out_path):
    teeth_out = []
    blobs = []
    offset = 0
    arches = {}
    for jaw, path in (('upper', upper_path), ('lower', lower_path)):
        upper = jaw == 'upper'
        teeth = shells(*load_stl(path))
        assert len(teeth) == 16, f'{path}: {len(teeth)} shells, expected 16 teeth'
        # file: +z superior, +y anterior -> patient left = S x A
        fdi = number_teeth(teeth, upper, np.cross([0, 0, 1.0], [0, 1.0, 0]))
        R, origin = jaw_frame(teeth, fdi, upper)
        occl = np.array([0, 0, -1.0]) if upper else np.array([0, 0, 1.0])
        lib = {fdi[i]: (p @ R.T - origin, f) for i, (p, f) in enumerate(teeth)}
        # arch through the crown centroids, patient right -> left
        qr, ql = (1, 2) if upper else (4, 3)
        order = [qr * 10 + k for k in range(8, 0, -1)] + [ql * 10 + k for k in range(1, 9)]
        arch = np.array([lib[f][0].mean(0)[:2] for f in order])

        def dirs(f):
            i = order.index(f)
            d = arch[min(i + 1, 15)] - arch[max(i - 1, 0)]
            d /= np.linalg.norm(d)
            return np.array([d[0], d[1], 0.0]), np.array([d[1], -d[0], 0.0])  # tangent, buccal

        built = {}
        for f in order:
            p, tri = lib[f]
            dv, df = decimate(p, tri)
            c = dv.mean(0)
            t, n = dirs(f)
            tips, radius = cusps(dv - c, f, occl, t, n)
            built[f] = (dv, df, c, tips, radius)
        # occlusal plane: the mean height of the cusp tips of the jaw
        z0 = np.mean([(c + t)[2] for _, _, c, tips, _ in built.values() for t in tips])
        arches[jaw] = [[round(float(a), 3), round(float(b), 3)] for a, b in arch]
        for f in sorted(built):
            dv, df, c, tips, radius = built[f]
            rel = dv - c
            q = np.round(rel * QUANT)
            assert np.abs(q).max() < 32767
            pos_b = q.astype('<i2').tobytes()
            idx_b = df.astype('<u2').tobytes()
            pad = (-len(idx_b)) % 4
            teeth_out.append({
                'fdi': f,
                'jaw': jaw,
                'centroid': [round(float(c[0]), 4), round(float(c[1]), 4), round(float(c[2] - z0), 4)],
                'nv': len(dv),
                'nt': len(df),
                'offset': offset,
                'parts': [[round(float(x), 3) for x in t] for t in tips],
                'partRadius': radius,
            })
            blobs += [pos_b, idx_b, b'\0' * pad]
            offset += len(pos_b) + len(idx_b) + pad
            print(f'{f}: {len(lib[f][1])} -> {len(df)} triangles, {len(tips)} parts')
    teeth_out.sort(key=lambda t: t['fdi'])
    header = {
        'format': 'qdp-tooth-library',
        'version': 1,
        'name': 'Generic',
        'axes': 'per jaw: x patient left, y posterior, z superior; midline x = 0, front y = 0, occlusal plane z = 0; mm',
        'quant': 1 / QUANT,
        'arch': arches,
        'teeth': teeth_out,
    }
    hj = json.dumps(header, separators=(',', ':')).encode()
    hj += b' ' * ((-len(hj)) % 4)
    raw = b'QDPT' + struct.pack('<II', 1, len(hj)) + hj + b''.join(blobs)
    packed = zlib.compress(raw, 9)
    wrapper = {'format': 'qdp-tooth-library', 'encoding': 'deflate+base64', 'data': base64.b64encode(packed).decode()}
    open(out_path, 'w').write(json.dumps(wrapper))
    print(f'{out_path}: {len(raw) / 1e6:.2f} MB raw, {len(packed) / 1e6:.2f} MB compressed')


if __name__ == '__main__':
    main(*sys.argv[1:4])
