#!/usr/bin/env python3
"""
Build the implant library (public/implants/) from manufacturer implant STLs laid out as

    <root>/<Brand>/Implants/<System>/<[prefix ]diameter x length mm>.stl

in the usual CAD library frame: the implant axis along z, the coronal end up (+z), the apex at
negative z and the origin at the implant's reference level (platform / shoulder).

    pip install numpy pyfqmr
    python3 scripts/make-implant-library.py "<root>" quick-dicom-implant-library-vN.qdplib \
        [--library-version N] [--previous quick-dicom-implant-library-vM.qdplib]

The library is private: the .qdplib file is handed to the people who use it, who import it in the
app (Implants panel -> Implant library). It is never put in the repository or on the website
(.gitignore keeps *.qdplib out).

Library version: every build is a new version of the library (`library` in index.json). Importing
a newer version replaces the older one in the app. Without --library-version the version is one
more than the one in --previous (or in the output file, if it exists), else 1.

What it writes: one library file (a ZIP) with
  - index.json: format, the library version, then brands -> systems (file, size in bytes) -> sizes, with the nominal diameter / length from the file name
    and what was measured on the mesh: the platform level (`zp`, the origin or the top of the mesh
    when that lies below it), the length from the platform to the apex (`len`), the widest
    diameter of the part in bone (`dia`), the diameter near the apex (`apex`), the height of the
    connection above the platform (`top`, where an abutment sits: tissue-level collars, ball heads);
  - systems/<name>.qdpi, one per system: a binary (header JSON + per size int16 positions in
    1/500 mm and uint16 triangle indices), deflate-compressed (zlib). Meshes are decimated to at
    most MAX_TRIS triangles (fine enough to show the threads).
"""
import json
import os
import re
import struct
import sys
import zipfile
import zlib

import numpy as np
import pyfqmr

QUANT = 500.0  # positions in 1/500 mm (int16: +-65 mm)
MAX_TRIS = 5000
NAME = re.compile(r'^(?:(.*?)\s+)?(\d+(?:\.\d+)?)\s*x\s*(\d+(?:\.\d+)?)\s*mm\.stl$', re.I)


def load_stl(path):
    b = open(path, 'rb').read()
    if b[:5].lower() == b'solid' and b'facet' in b[:400]:
        v = [list(map(float, l.split()[1:4])) for l in b.decode('latin1').splitlines() if l.strip().startswith('vertex')]
        tri = np.array(v, dtype=np.float64).reshape(-1, 3, 3)
    else:
        n = struct.unpack('<I', b[80:84])[0]
        rec = np.frombuffer(b[84:84 + n * 50], dtype=np.dtype([('n', '<f4', 3), ('v', '<f4', (3, 3)), ('a', '<u2')]))
        tri = rec['v'].astype(np.float64)
    # weld identical vertices
    flat = tri.reshape(-1, 3)
    key = np.round(flat * 1e4).astype(np.int64)
    _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
    pos = flat[first]
    idx = inv.reshape(-1, 3)
    idx = idx[(idx[:, 0] != idx[:, 1]) & (idx[:, 1] != idx[:, 2]) & (idx[:, 0] != idx[:, 2])]
    return pos, idx


def decimate(pos, idx):
    if len(idx) <= MAX_TRIS:
        return pos, idx
    s = pyfqmr.Simplify()
    s.setMesh(pos, idx)
    s.simplify_mesh(target_count=MAX_TRIS, aggressiveness=5, preserve_border=True, verbose=0)
    p, f, _ = s.getMesh()
    return np.asarray(p, dtype=np.float64), np.asarray(f, dtype=np.int64)


def clean(name):
    name = re.sub(r'#U([0-9a-fA-F]{4})', lambda m: chr(int(m.group(1), 16)), name)
    return name.replace(' _ ', ' / ')


def measure(pos, L):
    z = pos[:, 2]
    r = np.hypot(pos[:, 0], pos[:, 1])
    zmin, zmax = float(z.min()), float(z.max())
    zp = min(0.0, zmax)  # platform level
    # some libraries put the origin inside the implant: the whole mesh is the nominal length, so
    # the platform is its top
    if abs((zmax - zmin) - L) < 0.3 and abs(-zmin - L) > 0.5:
        zp = zmax
    length = zp - zmin
    bone = z <= zp + 1e-6
    dia = 2 * float(r[bone].max()) if bone.any() else 2 * float(r.max())
    near_apex = z <= zmin + min(1.5, length * 0.2)
    apex = 2 * float(r[near_apex].max())
    # the cone from the widest diameter at the platform to `apex` must enclose the whole part in
    # bone (the app draws it where the implant is covered, and measures nerve distances to it)
    r0 = dia / 2
    t = (zp - z[bone]) / max(length, 1e-6)
    ok = t > 0.02
    if ok.any():
        need = ((r[bone][ok] - r0 * (1 - t[ok])) / t[ok]).max()
        apex = max(apex, 2 * float(need))
    return {'zp': round(zp, 3), 'len': round(length, 3), 'dia': round(dia, 3), 'apex': round(min(apex, dia), 3), 'top': round(zmax - zp, 3)}


def library_version(out, args):
    if '--library-version' in args:
        return int(args[args.index('--library-version') + 1])
    previous = args[args.index('--previous') + 1] if '--previous' in args else out
    try:
        with zipfile.ZipFile(previous) as z:
            return json.loads(z.read('index.json')).get('library', 0) + 1
    except (OSError, KeyError, ValueError, zipfile.BadZipFile):
        return 1


def main():
    root, out = sys.argv[1], sys.argv[2]
    if not out.endswith('.qdplib'):
        sys.exit('The output is a library file: …/quick-dicom-implant-library-vN.qdplib')
    library = library_version(out, sys.argv[3:])
    print(f'Library version {library}', flush=True)
    index = {'format': 'qdp-implant-library', 'version': 1, 'library': library, 'quant': QUANT, 'brands': []}
    files = {}
    for brand in sorted(os.listdir(root), key=str.lower):
        bdir = os.path.join(root, brand, 'Implants')
        if not os.path.isdir(bdir):
            continue
        systems = []
        for system in sorted(os.listdir(bdir), key=str.lower):
            sdir = os.path.join(bdir, system)
            found = []
            for f in os.listdir(sdir):
                m = NAME.match(f)
                if m:
                    found.append((m.group(1) or '', float(m.group(2)), float(m.group(3)), f))
            if not found:
                continue
            found.sort(key=lambda x: (x[0], x[1], x[2]))
            sizes, blobs, off = [], [], 0
            for prefix, d, L, f in found:
                pos, idx = decimate(*load_stl(os.path.join(sdir, f)))
                info = measure(pos, L)
                q = np.round(pos * QUANT).astype(np.int16)
                ix = idx.astype(np.uint16)
                blob = q.tobytes() + ix.tobytes()
                label = f'{prefix + " " if prefix else ""}{d:g} × {L:g} mm'
                sizes.append({'label': label, 'prefix': prefix, 'd': d, 'L': L, **info, 'nv': len(pos), 'nt': len(idx), 'offset': off})
                blobs.append(blob)
                off += len(blob)
            slug = re.sub(r'[^a-z0-9]+', '-', f'{brand}-{system}'.lower().replace('+', ' plus')).strip('-')
            header = json.dumps({'format': 'QDPI', 'brand': clean(brand), 'system': clean(system), 'quant': QUANT, 'sizes': sizes}).encode()
            data = zlib.compress(b'QDPI' + struct.pack('<II', 1, len(header)) + header + b''.join(blobs), 9)
            name = f'systems/{slug}.qdpi'
            files[name] = data
            systems.append({'name': clean(system), 'file': name, 'bytes': len(data), 'sizes': [{k: s[k] for k in ('label', 'prefix', 'd', 'L', 'zp', 'len', 'dia', 'apex', 'top')} for s in sizes]})
            print(f'{brand} / {system}: {len(sizes)} sizes, {len(data) / 1e6:.2f} MB', flush=True)
        if systems:
            index['brands'].append({'name': clean(brand), 'systems': systems})
    with zipfile.ZipFile(out, 'w') as z:
        z.writestr('index.json', json.dumps(index, separators=(',', ':')), compress_type=zipfile.ZIP_DEFLATED)
        for name, data in files.items():
            z.writestr(name, data, compress_type=zipfile.ZIP_STORED)  # already compressed
    print(f'Wrote {out}: library version {library}, {len(files)} systems, {os.path.getsize(out) / 1e6:.1f} MB')


if __name__ == '__main__':
    main()
