// DICOM text in the character set the file declares (Specific Character Set, 0008,0005): UTF-8,
// Cyrillic, Arabic, Greek, Hebrew, Latin 1–5/9, Thai, Japanese, Korean, Chinese. dicom-parser alone
// reads every byte as one Latin-1 character, which turns a Russian or Arabic name into "ÐÐ¾Ñ…".

import type { DataSet } from 'dicom-parser';

/** Specific Character Set defined terms -> TextDecoder labels (ISO 2022 forms: the same sets). */
const CHARSETS: Record<string, string> = {
  'ISO_IR 6': 'windows-1252',
  'ISO_IR 100': 'windows-1252', // Latin 1 (windows-1252 is its superset in browsers)
  'ISO_IR 101': 'iso-8859-2', // Latin 2
  'ISO_IR 109': 'iso-8859-3', // Latin 3
  'ISO_IR 110': 'iso-8859-4', // Latin 4
  'ISO_IR 144': 'iso-8859-5', // Cyrillic
  'ISO_IR 127': 'iso-8859-6', // Arabic
  'ISO_IR 126': 'iso-8859-7', // Greek
  'ISO_IR 138': 'iso-8859-8', // Hebrew
  'ISO_IR 148': 'windows-1254', // Latin 5 (Turkish)
  'ISO_IR 203': 'iso-8859-15', // Latin 9
  'ISO_IR 166': 'windows-874', // Thai
  'ISO_IR 13': 'shift_jis', // Japanese (JIS X 0201)
  'ISO_IR 192': 'utf-8',
  GB18030: 'gb18030',
  GBK: 'gbk',
  'ISO 2022 IR 87': 'iso-2022-jp', // Japanese kanji
  'ISO 2022 IR 159': 'iso-2022-jp',
  'ISO 2022 IR 149': 'euc-kr', // Korean
  'ISO 2022 IR 58': 'gbk', // Simplified Chinese (GB 2312)
};

const decoders = new Map<string, TextDecoder>();
function decoder(label: string, fatal = false): TextDecoder {
  const key = `${label}|${fatal}`;
  let d = decoders.get(key);
  if (!d) decoders.set(key, (d = new TextDecoder(label, { fatal })));
  return d;
}

/** The TextDecoder label for a Specific Character Set value (null: default repertoire / unknown). */
export function charsetLabel(specific: string | undefined): string | null {
  if (!specific) return null;
  // multi-valued (ISO 2022 code extensions): the first set beyond ASCII decides
  const terms = specific.split('\\').map((t) => t.trim().toUpperCase().replace(/^ISO 2022 IR (6|100|101|109|110|144|127|126|138|148|203|166|13)$/, 'ISO_IR $1'));
  for (const t of terms) {
    const label = CHARSETS[t] ?? CHARSETS[t.replace(/^ISO_IR(\d)/, 'ISO_IR $1')];
    if (label && t !== 'ISO_IR 6') return label;
  }
  return null;
}

/** Valid UTF-8 with characters beyond ASCII (text a device wrote in UTF-8 without saying so). */
function utf8Text(bytes: Uint8Array): string | null {
  let high = false;
  for (const b of bytes) if (b >= 0x80) high = true;
  if (!high) return null;
  try {
    return decoder('utf-8', true).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Text bytes in the data set's character set. Without a declared set: ASCII, or UTF-8 when the bytes
 * are valid UTF-8 (common in practice), else Latin 1.
 */
export function decodeDicomText(bytes: Uint8Array, label: string | null): string {
  if (label === 'euc-kr' || label === 'gbk') {
    // ISO 2022 escape sequences (ESC $ ) C, ESC $ A …) only switch sets: EUC / GB bytes follow
    const out: number[] = [];
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0x1b) {
        i += bytes[i + 1] === 0x24 ? (bytes[i + 2] === 0x29 || bytes[i + 2] === 0x28 ? 3 : 2) : 2;
        continue;
      }
      out.push(bytes[i]);
    }
    bytes = Uint8Array.from(out);
  }
  if (label) {
    try {
      return decoder(label).decode(bytes);
    } catch {
      /* unknown to this browser: below */
    }
  }
  return utf8Text(bytes) ?? decoder('windows-1252').decode(bytes);
}

/** A text element of the data set (trimmed, without padding), or undefined. */
export function dicomText(ds: DataSet, tag: string, label = charsetLabel(dicomAscii(ds, 'x00080005'))): string | undefined {
  const el = ds.elements[tag];
  if (!el || el.length <= 0) return el ? '' : undefined;
  const bytes = ds.byteArray.subarray(el.dataOffset, el.dataOffset + el.length);
  return decodeDicomText(bytes, label).replace(/\0/g, '').trim();
}

/** An ASCII-only element (CS, UI, DA, DS …): read as is. */
function dicomAscii(ds: DataSet, tag: string): string | undefined {
  try {
    return ds.string(tag)?.trim();
  } catch {
    return undefined;
  }
}

/**
 * Text read before character sets were supported (kept in projects and in the Recent list): UTF-8
 * bytes that were taken one by one as Latin-1 characters ("ÐÐ¾Ñ…") turned back into the text.
 */
export function repairMojibake(s: string | undefined): string | undefined {
  if (!s) return s;
  let high = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 0xff) return s; // real text beyond Latin 1: as it is
    if (c >= 0x80) high = true;
  }
  if (!high) return s;
  const bytes = Uint8Array.from(s, (ch) => ch.charCodeAt(0));
  return utf8Text(bytes) ?? s;
}
