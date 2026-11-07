// Scan import (STL / PLY / OBJ) and the ZIP container of projects.
import { describe, expect, it } from 'vitest';
import { readObj, readPly, readStl } from '../../src/meshio';
import { coneMesh, stlBytes } from '../../src/stl';
import { readZip, writeZip, isZip } from '../../src/zip';

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
// a tetrahedron, with a colour per vertex in the PLY
const PLY = `ply
format ascii 1.0
element vertex 4
property float x
property float y
property float z
property uchar red
property uchar green
property uchar blue
element face 4
property list uchar int vertex_indices
end_header
0 0 0 255 0 0
10 0 0 0 255 0
0 10 0 0 0 255
0 0 10 255 255 255
3 0 2 1
3 0 1 3
3 0 3 2
3 1 2 3
`;
const OBJ = `# tetrahedron
v 0 0 0
v 10 0 0
v 0 10 0
v 0 0 10
f 1 3 2
f 1 2 4
f 1/1 4/1 3/1
f 2//1 3//1 4//1
`;

describe('mesh files', () => {
  it('reads binary STL and welds shared vertices', () => {
    const tris = coneMesh([0, 0, 0], [0, 0, 5], 2, 2, 24);
    const m = readStl(stlBytes(tris, 'cyl').buffer as ArrayBuffer);
    expect(m.idx.length).toBe(tris.length / 3);
    expect(m.pos.length / 3).toBeLessThan(tris.length / 3); // welded
  });

  it('reads ASCII STL', () => {
    const m = readStl(enc('solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t\n'));
    expect(m.idx.length).toBe(3);
  });

  it('reads PLY with vertex colours', () => {
    const m = readPly(enc(PLY));
    expect(m.pos.length).toBe(12);
    expect(m.idx.length).toBe(12);
    expect(m.col).not.toBeNull();
    expect(Array.from(m.col!.slice(0, 3))).toEqual([255, 0, 0]);
  });

  it('reads OBJ with the different face formats', () => {
    const m = readObj(enc(OBJ));
    expect(m.pos.length).toBe(12);
    expect(m.idx.length).toBe(12);
  });
});

describe('zip (projects)', () => {
  it('round-trips entries', async () => {
    const big = new Uint8Array(200_000).map((_, i) => (i * 7) % 251);
    const blob = await writeZip([
      { name: 'project.json', data: new TextEncoder().encode('{"format":"test"}') },
      { name: 'volume.raw', data: big },
    ]);
    const buf = await blob.arrayBuffer();
    expect(isZip(buf)).toBe(true);
    const back = await readZip(buf);
    expect(new TextDecoder().decode(back.get('project.json'))).toBe('{"format":"test"}');
    expect(back.get('volume.raw')).toEqual(big);
  });
});
