// Minimal ZIP writer/reader (deflate via the browser's CompressionStream).

let crcTable: Uint32Array | null = null;
function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  const t = crcTable;
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = t[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const canDeflate = typeof CompressionStream !== 'undefined';

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([data as BlobPart]).stream().pipeThrough(stream as unknown as TransformStream<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

/** Build a ZIP archive (deflated when the browser supports it). */
export async function writeZip(entries: ZipEntry[], onProgress?: (f: number) => void): Promise<Blob> {
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    let body = e.data;
    let method = 0;
    if (canDeflate && e.data.length > 64) {
      const d = await pipe(e.data, new CompressionStream('deflate-raw'));
      if (d.length < e.data.length) {
        body = d;
        method = 8;
      }
    }
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // UTF-8 names
    lh.setUint16(8, method, true);
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, body.length, true);
    lh.setUint32(22, e.data.length, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name as BlobPart, body as BlobPart);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, method, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, body.length, true);
    ch.setUint32(24, e.data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    const c = new Uint8Array(46 + name.length);
    c.set(new Uint8Array(ch.buffer), 0);
    c.set(name, 46);
    central.push(c);
    offset += 30 + name.length + body.length;
    onProgress?.((i + 1) / entries.length);
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...(central as BlobPart[]), end.buffer], { type: 'application/zip' });
}

/** Read all entries of a ZIP archive. */
export async function readZip(buf: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt ZIP directory');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(buf, p + 46, nameLen));
    const lNameLen = dv.getUint16(local + 26, true);
    const lExtraLen = dv.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = new Uint8Array(buf, start, csize);
    let data: Uint8Array;
    if (method === 0) data = raw.slice();
    else if (method === 8) {
      if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot decompress the project file');
      data = await pipe(raw, new DecompressionStream('deflate-raw'));
    } else throw new Error(`Unsupported ZIP compression method ${method}`);
    out.set(name, data);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export function isZip(buf: ArrayBuffer): boolean {
  return buf.byteLength >= 4 && new DataView(buf).getUint32(0, true) === 0x04034b50;
}

/** True when the file starts with a ZIP local-file header ("PK\x03\x04"). */
export async function isZipFile(file: Blob): Promise<boolean> {
  if (file.size < 4) return false;
  const b = new DataView(await file.slice(0, 4).arrayBuffer());
  return b.getUint32(0, true) === 0x04034b50;
}

/**
 * List a ZIP archive's entries as File objects without reading the whole archive into memory:
 * stored entries are lazy slices of the original file, deflated ones are inflated one by one.
 * Supports ZIP64 (archives over 4 GB or with more than 65535 entries).
 */
export async function zipEntriesAsFiles(file: Blob): Promise<File[]> {
  const size = file.size;
  const tailLen = Math.min(size, 65557 + 20 + 56);
  const tailStart = size - tailLen;
  const tail = new DataView(await file.slice(tailStart).arrayBuffer());
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP file');
  let count = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdOffset = tail.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    // ZIP64 end-of-central-directory locator sits right before the classic record
    const loc = eocd - 20;
    if (loc >= 0 && tail.getUint32(loc, true) === 0x07064b50) {
      const z64 = Number(tail.getBigUint64(loc + 8, true));
      const rec = new DataView(await file.slice(z64, z64 + 56).arrayBuffer());
      if (rec.getUint32(0, true) !== 0x06064b50) throw new Error('Corrupt ZIP64 directory');
      count = Number(rec.getBigUint64(32, true));
      cdSize = Number(rec.getBigUint64(40, true));
      cdOffset = Number(rec.getBigUint64(48, true));
    }
  }
  const cd = new DataView(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const dec = new TextDecoder();
  interface Ent {
    name: string;
    method: number;
    csize: number;
    local: number;
  }
  const ents: Ent[] = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.byteLength; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt ZIP directory');
    const method = cd.getUint16(p + 10, true);
    let csize = cd.getUint32(p + 20, true);
    let usize = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    let local = cd.getUint32(p + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, p + 46, nameLen));
    // ZIP64 extra field: 64-bit values for the fields that are 0xFFFFFFFF, in this order
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = cd.getUint16(e, true);
      const len = cd.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (usize === 0xffffffff) (usize = Number(cd.getBigUint64(q, true))), (q += 8);
        if (csize === 0xffffffff) (csize = Number(cd.getBigUint64(q, true))), (q += 8);
        if (local === 0xffffffff) local = Number(cd.getBigUint64(q, true));
      }
      e += 4 + len;
    }
    if (!name.endsWith('/')) ents.push({ name, method, csize, local });
    p = eEnd + commentLen;
  }
  const out: File[] = [];
  // local headers may carry different extra fields than the directory: read each one
  const BATCH = 64;
  for (let i = 0; i < ents.length; i += BATCH) {
    const part = await Promise.all(
      ents.slice(i, i + BATCH).map(async (en) => {
        const lh = new DataView(await file.slice(en.local, en.local + 30).arrayBuffer());
        if (lh.getUint32(0, true) !== 0x04034b50) throw new Error('Corrupt ZIP entry');
        const start = en.local + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
        const raw = file.slice(start, start + en.csize);
        const base = en.name.split('/').pop() || en.name;
        if (en.method === 0) return new File([raw], base);
        if (en.method === 8) {
          const s = raw.stream().pipeThrough(new DecompressionStream('deflate-raw') as unknown as TransformStream<Uint8Array, Uint8Array>);
          return new File([await new Response(s).blob()], base);
        }
        throw new Error(`Unsupported ZIP compression method ${en.method}`);
      }),
    );
    out.push(...part);
  }
  return out;
}
