import type { DataSet, Element } from 'dicom-parser';

/** One DICOM attribute, flattened to text for display (and saving in projects). */
export interface MetaEntry {
  /** "GGGG,EEEE" */
  tag: string;
  vr: string;
  name: string;
  value: string;
  /** sequence items, each a list of entries */
  items?: MetaEntry[][];
}

// ---- dictionary (common tags; anything else is shown as Unknown / Private) ----
// key: ggggeeee (lower-case hex) -> [VR, name]
const D: Record<string, [string, string]> = {
  '00020000': ['UL', 'File Meta Information Group Length'],
  '00020001': ['OB', 'File Meta Information Version'],
  '00020002': ['UI', 'Media Storage SOP Class UID'],
  '00020003': ['UI', 'Media Storage SOP Instance UID'],
  '00020010': ['UI', 'Transfer Syntax UID'],
  '00020012': ['UI', 'Implementation Class UID'],
  '00020013': ['SH', 'Implementation Version Name'],
  '00020016': ['AE', 'Source Application Entity Title'],
  '00080005': ['CS', 'Specific Character Set'],
  '00080008': ['CS', 'Image Type'],
  '00080012': ['DA', 'Instance Creation Date'],
  '00080013': ['TM', 'Instance Creation Time'],
  '00080016': ['UI', 'SOP Class UID'],
  '00080018': ['UI', 'SOP Instance UID'],
  '00080020': ['DA', 'Study Date'],
  '00080021': ['DA', 'Series Date'],
  '00080022': ['DA', 'Acquisition Date'],
  '00080023': ['DA', 'Content Date'],
  '0008002a': ['DT', 'Acquisition DateTime'],
  '00080030': ['TM', 'Study Time'],
  '00080031': ['TM', 'Series Time'],
  '00080032': ['TM', 'Acquisition Time'],
  '00080033': ['TM', 'Content Time'],
  '00080050': ['SH', 'Accession Number'],
  '00080060': ['CS', 'Modality'],
  '00080064': ['CS', 'Conversion Type'],
  '00080070': ['LO', 'Manufacturer'],
  '00080080': ['LO', 'Institution Name'],
  '00080081': ['ST', 'Institution Address'],
  '00080090': ['PN', "Referring Physician's Name"],
  '00081010': ['SH', 'Station Name'],
  '00081030': ['LO', 'Study Description'],
  '0008103e': ['LO', 'Series Description'],
  '00081040': ['LO', 'Institutional Department Name'],
  '00081050': ['PN', "Performing Physician's Name"],
  '00081070': ['PN', "Operators' Name"],
  '00081090': ['LO', "Manufacturer's Model Name"],
  '00081140': ['SQ', 'Referenced Image Sequence'],
  '00081150': ['UI', 'Referenced SOP Class UID'],
  '00081155': ['UI', 'Referenced SOP Instance UID'],
  '00082111': ['ST', 'Derivation Description'],
  '00100010': ['PN', "Patient's Name"],
  '00100020': ['LO', 'Patient ID'],
  '00100021': ['LO', 'Issuer of Patient ID'],
  '00100030': ['DA', "Patient's Birth Date"],
  '00100032': ['TM', "Patient's Birth Time"],
  '00100040': ['CS', "Patient's Sex"],
  '00101000': ['LO', 'Other Patient IDs'],
  '00101001': ['PN', 'Other Patient Names'],
  '00101010': ['AS', "Patient's Age"],
  '00101020': ['DS', "Patient's Size"],
  '00101030': ['DS', "Patient's Weight"],
  '00102160': ['SH', 'Ethnic Group'],
  '00104000': ['LT', 'Patient Comments'],
  '00120062': ['CS', 'Patient Identity Removed'],
  '00120063': ['LO', 'De-identification Method'],
  '00180010': ['LO', 'Contrast/Bolus Agent'],
  '00180015': ['CS', 'Body Part Examined'],
  '00180022': ['CS', 'Scan Options'],
  '00180050': ['DS', 'Slice Thickness'],
  '00180060': ['DS', 'KVP'],
  '00180088': ['DS', 'Spacing Between Slices'],
  '00180090': ['DS', 'Data Collection Diameter'],
  '00181000': ['LO', 'Device Serial Number'],
  '00181020': ['LO', 'Software Versions'],
  '00181030': ['LO', 'Protocol Name'],
  '00181100': ['DS', 'Reconstruction Diameter'],
  '00181110': ['DS', 'Distance Source to Detector'],
  '00181111': ['DS', 'Distance Source to Patient'],
  '00181120': ['DS', 'Gantry/Detector Tilt'],
  '00181130': ['DS', 'Table Height'],
  '00181140': ['CS', 'Rotation Direction'],
  '00181150': ['IS', 'Exposure Time'],
  '00181151': ['IS', 'X-Ray Tube Current'],
  '00181152': ['IS', 'Exposure'],
  '00181153': ['IS', 'Exposure in µAs'],
  '00181160': ['SH', 'Filter Type'],
  '00181164': ['DS', 'Imager Pixel Spacing'],
  '00181170': ['IS', 'Generator Power'],
  '00181190': ['DS', 'Focal Spot(s)'],
  '00181210': ['SH', 'Convolution Kernel'],
  '00185100': ['CS', 'Patient Position'],
  '00189302': ['CS', 'Acquisition Type'],
  '00189305': ['FD', 'Revolution Time'],
  '00189306': ['FD', 'Single Collimation Width'],
  '00189307': ['FD', 'Total Collimation Width'],
  '00189345': ['FD', 'CTDIvol'],
  '0020000d': ['UI', 'Study Instance UID'],
  '0020000e': ['UI', 'Series Instance UID'],
  '00200010': ['SH', 'Study ID'],
  '00200011': ['IS', 'Series Number'],
  '00200012': ['IS', 'Acquisition Number'],
  '00200013': ['IS', 'Instance Number'],
  '00200020': ['CS', 'Patient Orientation'],
  '00200032': ['DS', 'Image Position (Patient)'],
  '00200037': ['DS', 'Image Orientation (Patient)'],
  '00200052': ['UI', 'Frame of Reference UID'],
  '00200060': ['CS', 'Laterality'],
  '00201040': ['LO', 'Position Reference Indicator'],
  '00201041': ['DS', 'Slice Location'],
  '00204000': ['LT', 'Image Comments'],
  '00209113': ['SQ', 'Plane Position Sequence'],
  '00209116': ['SQ', 'Plane Orientation Sequence'],
  '00280002': ['US', 'Samples per Pixel'],
  '00280004': ['CS', 'Photometric Interpretation'],
  '00280006': ['US', 'Planar Configuration'],
  '00280008': ['IS', 'Number of Frames'],
  '00280010': ['US', 'Rows'],
  '00280011': ['US', 'Columns'],
  '00280030': ['DS', 'Pixel Spacing'],
  '00280034': ['IS', 'Pixel Aspect Ratio'],
  '00280100': ['US', 'Bits Allocated'],
  '00280101': ['US', 'Bits Stored'],
  '00280102': ['US', 'High Bit'],
  '00280103': ['US', 'Pixel Representation'],
  '00280106': ['US', 'Smallest Image Pixel Value'],
  '00280107': ['US', 'Largest Image Pixel Value'],
  '00280120': ['US', 'Pixel Padding Value'],
  '00280301': ['CS', 'Burned In Annotation'],
  '00281050': ['DS', 'Window Center'],
  '00281051': ['DS', 'Window Width'],
  '00281052': ['DS', 'Rescale Intercept'],
  '00281053': ['DS', 'Rescale Slope'],
  '00281054': ['LO', 'Rescale Type'],
  '00281055': ['LO', 'Window Center & Width Explanation'],
  '00282110': ['CS', 'Lossy Image Compression'],
  '00282112': ['DS', 'Lossy Image Compression Ratio'],
  '00289110': ['SQ', 'Pixel Measures Sequence'],
  '00289145': ['SQ', 'Pixel Value Transformation Sequence'],
  '00321060': ['LO', 'Requested Procedure Description'],
  '00400244': ['DA', 'Performed Procedure Step Start Date'],
  '00400245': ['TM', 'Performed Procedure Step Start Time'],
  '00400253': ['SH', 'Performed Procedure Step ID'],
  '00400254': ['LO', 'Performed Procedure Step Description'],
  '00540220': ['SQ', 'View Code Sequence'],
  '00880140': ['UI', 'Storage Media File-set UID'],
  '52009229': ['SQ', 'Shared Functional Groups Sequence'],
  '52009230': ['SQ', 'Per-frame Functional Groups Sequence'],
  '7fe00010': ['OW', 'Pixel Data'],
  'fffee000': ['--', 'Item'],
};

const STRING_VRS = new Set(['AE', 'AS', 'CS', 'DA', 'DS', 'DT', 'IS', 'LO', 'LT', 'PN', 'SH', 'ST', 'TM', 'UC', 'UI', 'UR', 'UT']);
const BINARY_VRS = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'OV', 'UN']);
const MAX_ITEMS = 40; // per sequence (per-frame sequences can have thousands)
const MAX_TEXT = 1024;

function displayTag(t: string): string {
  // "x00100010" -> "0010,0010"
  return `${t.slice(1, 5)},${t.slice(5, 9)}`.toUpperCase();
}

export function tagName(tag: string): string {
  const key = tag.replace(/^x/, '').toLowerCase();
  const d = D[key];
  if (d) return d[1];
  const group = parseInt(key.slice(0, 4), 16);
  if (group % 2 === 1) return 'Private tag';
  if (key.endsWith('0000')) return 'Group Length';
  return 'Unknown';
}

function readValue(ds: DataSet, el: Element, vr: string): string {
  const t = el.tag;
  try {
    if (STRING_VRS.has(vr)) {
      const s = ds.string(t) ?? '';
      const txt = s.replace(/\0/g, '').trim();
      return txt.length > MAX_TEXT ? txt.slice(0, MAX_TEXT) + ' …' : txt;
    }
    const n = (size: number) => Math.floor(el.length / size);
    const nums = (size: number, fn: (i: number) => number | undefined) => {
      const count = Math.min(n(size), 32);
      const out: string[] = [];
      for (let i = 0; i < count; i++) {
        const v = fn(i);
        if (v !== undefined) out.push(Number.isInteger(v) ? String(v) : String(+v.toPrecision(7)));
      }
      return out.join('\\') + (n(size) > count ? ` … (${n(size)} values)` : '');
    };
    switch (vr) {
      case 'US':
        return nums(2, (i) => ds.uint16(t, i));
      case 'SS':
        return nums(2, (i) => ds.int16(t, i));
      case 'UL':
        return nums(4, (i) => ds.uint32(t, i));
      case 'SL':
        return nums(4, (i) => ds.int32(t, i));
      case 'FL':
        return nums(4, (i) => ds.float(t, i));
      case 'FD':
        return nums(8, (i) => (ds as unknown as { double: (t: string, i: number) => number }).double(t, i));
      case 'AT': {
        const g = ds.uint16(t, 0);
        const e = ds.uint16(t, 1);
        return g !== undefined && e !== undefined ? `(${g.toString(16).padStart(4, '0')},${e.toString(16).padStart(4, '0')})`.toUpperCase() : '';
      }
    }
  } catch {
    /* fall through to binary */
  }
  return binaryOrText(ds, el, vr);
}

/** Unknown/binary values: printable text if it looks like text, else a byte count (+ hex for short values). */
function binaryOrText(ds: DataSet, el: Element, vr: string): string {
  if (el.tag === 'x7fe00010') return `<pixel data, ${el.length >= 0 ? el.length.toLocaleString() : 'encapsulated'} bytes>`;
  const len = Math.max(0, el.length);
  const bytes = ds.byteArray.subarray(el.dataOffset, el.dataOffset + Math.min(len, 256));
  if (!BINARY_VRS.has(vr) || vr === 'UN') {
    let printable = bytes.length > 0;
    for (const b of bytes) if (!(b === 0 || b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127))) printable = false;
    if (printable) {
      const s = String.fromCharCode(...bytes).replace(/\0/g, '').trim();
      return len > 256 ? s + ' …' : s;
    }
  }
  if (len <= 16) return Array.from(bytes as Uint8Array, (b: number) => b.toString(16).padStart(2, '0')).join(' ');
  return `<binary, ${len.toLocaleString()} bytes>`;
}

/** Flatten a parsed data set into display entries (sequences nested). */
export function extractMeta(ds: DataSet, depth = 0): MetaEntry[] {
  const out: MetaEntry[] = [];
  const keys = Object.keys(ds.elements).sort();
  for (const k of keys) {
    const el = ds.elements[k];
    const key = k.slice(1).toLowerCase();
    const vr = el.vr ?? D[key]?.[0] ?? (el.items ? 'SQ' : 'UN');
    const entry: MetaEntry = { tag: displayTag(k), vr, name: tagName(k), value: '' };
    if (el.items) {
      const items = el.items;
      entry.value = `${items.length} item${items.length === 1 ? '' : 's'}`;
      if (depth < 4) {
        entry.items = items.slice(0, MAX_ITEMS).map((it) => (it.dataSet ? extractMeta(it.dataSet, depth + 1) : []));
        if (items.length > MAX_ITEMS) entry.value += ` (first ${MAX_ITEMS} shown)`;
      }
    } else {
      entry.value = readValue(ds, el, vr);
    }
    out.push(entry);
  }
  return out;
}

// ---- patient name helpers (DICOM PN: Family^Given^Middle^Prefix^Suffix) -------

export function splitPersonName(pn: string | undefined): { last: string; first: string } {
  const alpha = (pn ?? '').split('=')[0];
  const [last = '', first = '', middle = ''] = alpha.split('^').map((s) => s.trim());
  return { last, first: [first, middle].filter(Boolean).join(' ') };
}

export function joinPersonName(last: string, first: string): string {
  return `${last.trim()}^${first.trim()}`.replace(/\^$/, '');
}

/** "DOE, John" style label; empty when unknown. */
export function formatPatientName(pn: string | undefined): string {
  const { last, first } = splitPersonName(pn);
  if (!last && !first) return '';
  return last && first ? `${last.toUpperCase()}, ${first}` : last.toUpperCase() || first;
}

/** YYYYMMDD -> YYYY-MM-DD (as is when not a DICOM date). */
export function formatDicomDate(d: string | undefined): string {
  if (!d) return '';
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(d.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : d;
}

/** A folder name for a patient: "DOE Jane (ID 12345)", safe on Windows and macOS. */
export function patientFolderName(p: { name?: string; id?: string; birthDate?: string }, index: number): string {
  const { last, first } = splitPersonName(p.name);
  const who = [last.toUpperCase(), first].filter(Boolean).join(' ');
  const parts = [who || `Patient ${index + 1}`];
  if (p.id) parts.push(`(ID ${p.id})`);
  else if (p.birthDate) parts.push(`(born ${formatDicomDate(p.birthDate)})`);
  return parts
    .join(' ')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .slice(0, 120);
}
