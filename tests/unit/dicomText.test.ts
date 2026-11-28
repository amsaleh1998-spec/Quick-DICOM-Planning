import { describe, expect, it } from 'vitest';
import { charsetLabel, decodeDicomText, repairMojibake } from '../../src/dicomText';

const utf8 = (s: string) => new TextEncoder().encode(s);
/** ISO-8859-5 (Cyrillic): А..я = U+0410..U+044F -> 0xB0..0xEF */
const iso5 = (s: string) => Uint8Array.from(s, (ch) => (ch.charCodeAt(0) >= 0x410 && ch.charCodeAt(0) <= 0x44f ? ch.charCodeAt(0) - 0x360 : ch.charCodeAt(0)));
/** ISO-8859-6 (Arabic): U+0621..U+0652 -> 0xC1..0xF2 */
const iso6 = (s: string) => Uint8Array.from(s, (ch) => (ch.charCodeAt(0) >= 0x621 && ch.charCodeAt(0) <= 0x652 ? ch.charCodeAt(0) - 0x560 : ch.charCodeAt(0)));
const latin1 = (s: string) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

describe('DICOM text in its character set', () => {
  it('Specific Character Set terms', () => {
    expect(charsetLabel('ISO_IR 192')).toBe('utf-8');
    expect(charsetLabel('ISO_IR 144')).toBe('iso-8859-5');
    expect(charsetLabel('ISO_IR 127')).toBe('iso-8859-6');
    expect(charsetLabel('ISO_IR 100')).toBe('windows-1252');
    expect(charsetLabel('ISO 2022 IR 6\\ISO 2022 IR 87')).toBe('iso-2022-jp');
    expect(charsetLabel('\\ISO 2022 IR 149')).toBe('euc-kr');
    expect(charsetLabel('ISO 2022 IR 144')).toBe('iso-8859-5');
    expect(charsetLabel('ISO_IR 6')).toBeNull();
    expect(charsetLabel(undefined)).toBeNull();
  });

  it('Russian: UTF-8 and ISO-8859-5', () => {
    expect(decodeDicomText(utf8('Морозов^Николай'), 'utf-8')).toBe('Морозов^Николай');
    expect(decodeDicomText(iso5('Морозов^Николай'), charsetLabel('ISO_IR 144'))).toBe('Морозов^Николай');
  });

  it('Arabic: UTF-8 and ISO-8859-6', () => {
    expect(decodeDicomText(utf8('محمد^أحمد'), 'utf-8')).toBe('محمد^أحمد');
    expect(decodeDicomText(iso6('محمد^أحمد'), charsetLabel('ISO_IR 127'))).toBe('محمد^أحمد');
  });

  it('nothing declared: UTF-8 when the bytes are UTF-8, else Latin 1', () => {
    expect(decodeDicomText(utf8('Морозов^Николай'), null)).toBe('Морозов^Николай');
    expect(decodeDicomText(utf8('محمد'), null)).toBe('محمد');
    expect(decodeDicomText(latin1('Müller^Jürgen'), null)).toBe('Müller^Jürgen');
    expect(decodeDicomText(latin1('Müller'), charsetLabel('ISO_IR 100'))).toBe('Müller');
    expect(decodeDicomText(latin1('DOE^JOHN'), null)).toBe('DOE^JOHN');
  });

  it('names read before (UTF-8 bytes taken as Latin-1 characters) are repaired; real Latin-1 stays', () => {
    const garbled = (s: string) => String.fromCharCode(...utf8(s));
    expect(garbled('Морозов')).not.toBe('Морозов');
    expect(repairMojibake(garbled('Морозов^Николай'))).toBe('Морозов^Николай');
    expect(repairMojibake(garbled('محمد^أحمد'))).toBe('محمد^أحمد');
    expect(repairMojibake('Müller^Jürgen')).toBe('Müller^Jürgen');
    expect(repairMojibake('DOE^JOHN')).toBe('DOE^JOHN');
    expect(repairMojibake('Морозов')).toBe('Морозов');
    expect(repairMojibake(undefined)).toBeUndefined();
  });
});
