// Readers for surface meshes (intraoral scans, wax-ups …): STL (binary / ASCII), PLY (ASCII /
// binary, with vertex colours) and OBJ. Everything becomes an indexed triangle mesh in the
// file's own units (mm for dental scans).

export interface MeshData {
  /** xyz per vertex */
  pos: Float32Array;
  /** 3 vertex indices per triangle */
  idx: Uint32Array;
  /** optional rgb per vertex */
  col: Uint8Array | null;
}

export function meshStats(m: MeshData) {
  return { vertices: m.pos.length / 3, triangles: m.idx.length / 3 };
}

/** Parse a mesh file by its extension / content. */
export async function readMeshFile(file: File): Promise<MeshData> {
  const buf = await file.arrayBuffer();
  const name = file.name.toLowerCase();
  const head = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 512)));
  const m: MeshData =
    name.endsWith('.ply') || head.startsWith('ply') ? readPly(buf) : name.endsWith('.obj') ? readObj(buf) : readStl(buf);
  if (!m.idx.length) throw new Error(`No triangles found in “${file.name}”.`);
  return m;
}

// ---- STL ---------------------------------------------------------------------------

export function readStl(buf: ArrayBuffer): MeshData {
  const dv = new DataView(buf);
  if (buf.byteLength >= 84) {
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === buf.byteLength) return weld(binaryStlSoup(dv, n));
  }
  const text = new TextDecoder('latin1').decode(buf);
  if (/^\s*solid/.test(text) && /facet/.test(text)) return weld(asciiStlSoup(text));
  // some exporters write a wrong triangle count: trust the file size
  if (buf.byteLength > 84 && (buf.byteLength - 84) % 50 === 0) return weld(binaryStlSoup(dv, (buf.byteLength - 84) / 50));
  throw new Error('Not a valid STL file.');
}

function binaryStlSoup(dv: DataView, n: number): Float32Array {
  const out = new Float32Array(n * 9);
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50 + 12;
    for (let k = 0; k < 9; k++) out[t * 9 + k] = dv.getFloat32(o + k * 4, true);
  }
  return out;
}

function asciiStlSoup(text: string): Float32Array {
  const re = /vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g;
  const vals: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) vals.push(+m[1], +m[2], +m[3]);
  return new Float32Array(vals.slice(0, vals.length - (vals.length % 9)));
}

/** Merge identical vertices of a triangle soup (exact float match) into an indexed mesh. */
export function weld(soup: Float32Array): MeshData {
  const nv = soup.length / 3;
  let cap = 1;
  while (cap < nv * 2) cap <<= 1;
  const mask = cap - 1;
  const table = new Int32Array(cap).fill(-1);
  const bits = new Uint32Array(soup.buffer, soup.byteOffset, soup.length);
  const pos = new Float32Array(soup.length);
  const posBits = new Uint32Array(pos.buffer);
  const idx = new Uint32Array(nv);
  let n = 0;
  for (let v = 0; v < nv; v++) {
    const x = bits[v * 3], y = bits[v * 3 + 1], z = bits[v * 3 + 2];
    let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & mask;
    for (;;) {
      const e = table[h];
      if (e < 0) {
        table[h] = n;
        pos[n * 3] = soup[v * 3];
        pos[n * 3 + 1] = soup[v * 3 + 1];
        pos[n * 3 + 2] = soup[v * 3 + 2];
        idx[v] = n++;
        break;
      }
      if (posBits[e * 3] === x && posBits[e * 3 + 1] === y && posBits[e * 3 + 2] === z) {
        idx[v] = e;
        break;
      }
      h = (h + 1) & mask;
    }
  }
  return dropDegenerate({ pos: pos.slice(0, n * 3), idx, col: null });
}

function dropDegenerate(m: MeshData): MeshData {
  const idx = m.idx;
  let w = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (a === b || b === c || a === c) continue;
    idx[w++] = a;
    idx[w++] = b;
    idx[w++] = c;
  }
  return { ...m, idx: w === idx.length ? idx : idx.slice(0, w) };
}

// ---- PLY ---------------------------------------------------------------------------

type PlyType = 'char' | 'uchar' | 'short' | 'ushort' | 'int' | 'uint' | 'float' | 'double';
const PLY_ALIASES: Record<string, PlyType> = {
  char: 'char', int8: 'char', uchar: 'uchar', uint8: 'uchar', short: 'short', int16: 'short', ushort: 'ushort',
  uint16: 'ushort', int: 'int', int32: 'int', uint: 'uint', uint32: 'uint', float: 'float', float32: 'float',
  double: 'double', float64: 'double',
};
const PLY_SIZE: Record<PlyType, number> = { char: 1, uchar: 1, short: 2, ushort: 2, int: 4, uint: 4, float: 4, double: 8 };

interface PlyProp {
  name: string;
  type: PlyType;
  /** list properties: type of the count */
  countType?: PlyType;
}
interface PlyElement {
  name: string;
  count: number;
  props: PlyProp[];
}

export function readPly(buf: ArrayBuffer): MeshData {
  const bytes = new Uint8Array(buf);
  // header ends with "end_header\n"
  const headText = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  const endIdx = headText.indexOf('end_header');
  if (endIdx < 0) throw new Error('Not a valid PLY file (no end_header).');
  let bodyStart = endIdx + 'end_header'.length;
  while (bodyStart < bytes.length && bytes[bodyStart] !== 10) bodyStart++;
  bodyStart++;
  const lines = headText.slice(0, endIdx).split(/\r?\n/);
  let format = 'ascii';
  const elements: PlyElement[] = [];
  for (const line of lines) {
    const w = line.trim().split(/\s+/);
    if (w[0] === 'format') format = w[1];
    else if (w[0] === 'element') elements.push({ name: w[1], count: +w[2], props: [] });
    else if (w[0] === 'property' && elements.length) {
      const el = elements[elements.length - 1];
      if (w[1] === 'list') el.props.push({ name: w[4], type: PLY_ALIASES[w[3]], countType: PLY_ALIASES[w[2]] });
      else el.props.push({ name: w[2], type: PLY_ALIASES[w[1]] });
    }
  }
  const vEl = elements.find((e) => e.name === 'vertex');
  if (!vEl) throw new Error('PLY file without vertices.');
  const nv = vEl.count;
  const pos = new Float32Array(nv * 3);
  const vp = vEl.props.map((p) => p.name);
  const ix = vp.indexOf('x'), iy = vp.indexOf('y'), iz = vp.indexOf('z');
  const ir = vp.findIndex((n) => n === 'red' || n === 'r' || n === 'diffuse_red');
  const ig = vp.findIndex((n) => n === 'green' || n === 'g' || n === 'diffuse_green');
  const ib = vp.findIndex((n) => n === 'blue' || n === 'b' || n === 'diffuse_blue');
  const hasCol = ir >= 0 && ig >= 0 && ib >= 0;
  const col = hasCol ? new Uint8Array(nv * 3) : null;
  const colScale = (t: PlyType) => (t === 'float' || t === 'double' ? 255 : 1);
  const tris: number[] = [];
  const faceTris = (list: number[]) => {
    for (let k = 1; k + 1 < list.length; k++) tris.push(list[0], list[k], list[k + 1]);
  };

  if (format === 'ascii') {
    const body = new TextDecoder('latin1').decode(bytes.subarray(bodyStart));
    const tok = body.split(/\s+/).filter((s) => s.length);
    let p = 0;
    for (const el of elements) {
      for (let r = 0; r < el.count; r++) {
        const vals: number[] = [];
        let list: number[] | null = null;
        for (const prop of el.props) {
          if (prop.countType) {
            const c = +tok[p++];
            const l: number[] = [];
            for (let k = 0; k < c; k++) l.push(+tok[p++]);
            if (prop.name === 'vertex_indices' || prop.name === 'vertex_index') list = l;
            vals.push(NaN);
          } else vals.push(+tok[p++]);
        }
        if (el === vEl) {
          pos[r * 3] = vals[ix];
          pos[r * 3 + 1] = vals[iy];
          pos[r * 3 + 2] = vals[iz];
          if (col) {
            col[r * 3] = clamp255(vals[ir] * colScale(el.props[ir].type));
            col[r * 3 + 1] = clamp255(vals[ig] * colScale(el.props[ig].type));
            col[r * 3 + 2] = clamp255(vals[ib] * colScale(el.props[ib].type));
          }
        } else if (el.name === 'face' && list) faceTris(list);
      }
    }
  } else {
    const le = format === 'binary_little_endian';
    if (!le && format !== 'binary_big_endian') throw new Error(`Unsupported PLY format “${format}”.`);
    const dv = new DataView(buf);
    let o = bodyStart;
    const read = (t: PlyType): number => {
      let v: number;
      switch (t) {
        case 'char': v = dv.getInt8(o); break;
        case 'uchar': v = dv.getUint8(o); break;
        case 'short': v = dv.getInt16(o, le); break;
        case 'ushort': v = dv.getUint16(o, le); break;
        case 'int': v = dv.getInt32(o, le); break;
        case 'uint': v = dv.getUint32(o, le); break;
        case 'float': v = dv.getFloat32(o, le); break;
        default: v = dv.getFloat64(o, le);
      }
      o += PLY_SIZE[t];
      return v;
    };
    for (const el of elements) {
      // fast path: fixed-size rows we don't need
      const fixed = el.props.every((pp) => !pp.countType);
      if (el !== vEl && el.name !== 'face' && fixed) {
        o += el.count * el.props.reduce((a, pp) => a + PLY_SIZE[pp.type], 0);
        continue;
      }
      for (let r = 0; r < el.count; r++) {
        if (el === vEl) {
          for (let q = 0; q < el.props.length; q++) {
            const prop = el.props[q];
            if (prop.countType) {
              const c = read(prop.countType);
              o += c * PLY_SIZE[prop.type];
              continue;
            }
            const v = read(prop.type);
            if (q === ix) pos[r * 3] = v;
            else if (q === iy) pos[r * 3 + 1] = v;
            else if (q === iz) pos[r * 3 + 2] = v;
            else if (col && q === ir) col[r * 3] = clamp255(v * colScale(prop.type));
            else if (col && q === ig) col[r * 3 + 1] = clamp255(v * colScale(prop.type));
            else if (col && q === ib) col[r * 3 + 2] = clamp255(v * colScale(prop.type));
          }
        } else {
          for (const prop of el.props) {
            if (prop.countType) {
              const c = read(prop.countType);
              if (el.name === 'face' && (prop.name === 'vertex_indices' || prop.name === 'vertex_index')) {
                if (c === 3) tris.push(read(prop.type), read(prop.type), read(prop.type));
                else {
                  const l: number[] = [];
                  for (let k = 0; k < c; k++) l.push(read(prop.type));
                  faceTris(l);
                }
              } else o += c * PLY_SIZE[prop.type];
            } else o += PLY_SIZE[prop.type];
          }
        }
      }
    }
  }
  if (!tris.length) throw new Error('This PLY file has no faces (a point cloud) – export the scan as a mesh.');
  return dropDegenerate({ pos, idx: Uint32Array.from(tris), col });
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

// ---- OBJ ---------------------------------------------------------------------------

export function readObj(buf: ArrayBuffer): MeshData {
  const text = new TextDecoder('utf-8').decode(buf);
  const pos: number[] = [];
  const cols: number[] = [];
  let anyCol = false;
  const tris: number[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('v ')) {
      const w = line.split(/\s+/);
      pos.push(+w[1], +w[2], +w[3]);
      if (w.length >= 7) {
        anyCol = true;
        const s = Math.max(+w[4], +w[5], +w[6]) <= 1 ? 255 : 1;
        cols.push(clamp255(+w[4] * s), clamp255(+w[5] * s), clamp255(+w[6] * s));
      } else cols.push(200, 200, 200);
    } else if (line.startsWith('f ')) {
      const nvNow = pos.length / 3;
      const ids = line
        .split(/\s+/)
        .slice(1)
        .map((t) => {
          const i = parseInt(t.split('/')[0], 10);
          return i < 0 ? nvNow + i : i - 1;
        });
      for (let k = 1; k + 1 < ids.length; k++) tris.push(ids[0], ids[k], ids[k + 1]);
    }
  }
  return dropDegenerate({ pos: Float32Array.from(pos), idx: Uint32Array.from(tris), col: anyCol ? Uint8Array.from(cols) : null });
}

// ---- helpers -------------------------------------------------------------------------

/** Area-weighted vertex normals. */
export function vertexNormals(pos: Float32Array, idx: Uint32Array): Float32Array {
  const n = new Float32Array(pos.length);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) {
      n[v] += nx;
      n[v + 1] += ny;
      n[v + 2] += nz;
    }
  }
  for (let v = 0; v < n.length; v += 3) {
    const l = Math.hypot(n[v], n[v + 1], n[v + 2]) || 1;
    n[v] /= l;
    n[v + 1] /= l;
    n[v + 2] /= l;
  }
  return n;
}
