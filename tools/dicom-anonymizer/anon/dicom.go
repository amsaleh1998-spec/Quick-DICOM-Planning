// Package anon reads DICOM files element by element, removes or replaces identifying attributes and writes the
// file back in its original transfer syntax. Pixel data (also compressed) is copied byte for byte.
package anon

import (
	"bytes"
	"compress/flate"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"strings"
)

const undefinedLength = 0xFFFFFFFF

const (
	tagItem          = 0xFFFEE000
	tagItemDelim     = 0xFFFEE00D
	tagSequenceDelim = 0xFFFEE0DD
	tagPixelData     = 0x7FE00010
)

// Transfer syntaxes that change how the data set is encoded.
const (
	tsImplicitLE = "1.2.840.10008.1.2"
	tsExplicitLE = "1.2.840.10008.1.2.1"
	tsDeflatedLE = "1.2.840.10008.1.2.1.99"
	tsExplicitBE = "1.2.840.10008.1.2.2"
)

// Element is one data element. Sequences hold their items; every other element holds its raw value bytes.
type Element struct {
	Tag uint32
	// VR as stored in the file (explicit VR) or looked up in the dictionary (implicit VR).
	VR    string
	Value []byte
	Items []*Dataset
	// IsSeq: the element is a sequence (Items is used).
	IsSeq bool
	// Undefined: the sequence was written with undefined length (kept that way).
	Undefined bool
	// Encapsulated: compressed pixel data; Value holds the fragment items without the sequence delimiter.
	Encapsulated bool
}

// Dataset is an ordered list of elements (a file's data set or a sequence item).
type Dataset struct {
	Elements []*Element
	// Undefined: the item had undefined length.
	Undefined bool
}

// File is a parsed DICOM file.
type File struct {
	// HasPreamble: the file started with the 128-byte preamble and "DICM".
	HasPreamble bool
	Preamble    []byte
	Meta        *Dataset // group 0002, nil when the file had none
	Data        *Dataset
	// TransferSyntax of the data set.
	TransferSyntax string
}

type encoding struct {
	implicit bool
	order    binary.ByteOrder
}

func (e encoding) String() string {
	switch {
	case e.implicit:
		return "implicit VR little endian"
	case e.order == binary.BigEndian:
		return "explicit VR big endian"
	}
	return "explicit VR little endian"
}

// ErrNotDICOM is returned for files that do not look like DICOM at all.
var ErrNotDICOM = errors.New("not a DICOM file")

func encodingFor(ts string) encoding {
	switch ts {
	case tsImplicitLE:
		return encoding{implicit: true, order: binary.LittleEndian}
	case tsExplicitBE:
		return encoding{order: binary.BigEndian}
	}
	return encoding{order: binary.LittleEndian}
}

// longVR: explicit VRs with a 2-byte reserved field and a 4-byte length.
func longVR(vr string) bool {
	switch vr {
	case "OB", "OD", "OF", "OL", "OV", "OW", "SQ", "SV", "UC", "UN", "UR", "UT", "UV":
		return true
	}
	return false
}

func validVR(b []byte) bool {
	if len(b) < 2 || b[0] < 'A' || b[0] > 'Z' || b[1] < 'A' || b[1] > 'Z' {
		return false
	}
	switch string(b[:2]) {
	case "AE", "AS", "AT", "CS", "DA", "DS", "DT", "FD", "FL", "IS", "LO", "LT", "OB", "OD", "OF", "OL", "OV", "OW",
		"PN", "SH", "SL", "SQ", "SS", "ST", "SV", "TM", "UC", "UI", "UL", "UN", "UR", "US", "UT", "UV":
		return true
	}
	return false
}

// DictVR returns the dictionary VR of a tag ("UN" when unknown).
func DictVR(tag uint32) string {
	g, e := tag>>16, tag&0xFFFF
	if e == 0 {
		return "UL" // group length
	}
	if g%2 == 1 {
		if e >= 0x10 && e <= 0xFF {
			return "LO" // private creator
		}
		return "UN"
	}
	if vr, ok := dictVR[tag]; ok {
		return vr
	}
	switch {
	case g >= 0x6000 && g <= 0x601E: // overlays: repeating group
		if vr, ok := dictVR[0x60000000|e]; ok {
			return vr
		}
	case g >= 0x5000 && g <= 0x501E: // curves
		if vr, ok := dictVR[0x50000000|e]; ok {
			return vr
		}
	}
	return "UN"
}

// Parse reads a DICOM file. Files without preamble ("raw" data sets) are accepted when they start with a
// plausible group 0002 or 0008 element.
func Parse(b []byte) (*File, error) {
	f := &File{}
	pos := 0
	switch {
	case len(b) >= 132 && string(b[128:132]) == "DICM":
		f.HasPreamble = true
		f.Preamble = append([]byte(nil), b[:128]...)
		pos = 132
	case len(b) >= 4 && string(b[:4]) == "DICM":
		pos = 4
	default:
		if !plausibleStart(b) {
			return nil, ErrNotDICOM
		}
	}

	// File meta information: always explicit VR little endian (tolerate implicit VR from broken writers).
	if pos+4 <= len(b) && binary.LittleEndian.Uint16(b[pos:]) == 0x0002 {
		meta := &Dataset{}
		r := &reader{b: b, pos: pos}
		for r.pos+8 <= len(b) && binary.LittleEndian.Uint16(b[r.pos:]) == 0x0002 {
			enc := encoding{order: binary.LittleEndian}
			if !validVR(b[r.pos+4:]) {
				enc.implicit = true
			}
			el, err := r.element(enc, 0)
			if err != nil {
				return nil, fmt.Errorf("file meta information: %w", err)
			}
			meta.Elements = append(meta.Elements, el)
		}
		f.Meta = meta
		pos = r.pos
		if ts := meta.Get(0x00020010); ts != nil {
			f.TransferSyntax = ts.String()
		}
	}
	if f.TransferSyntax == "" {
		if pos+6 <= len(b) && validVR(b[pos+4:]) {
			f.TransferSyntax = tsExplicitLE
		} else {
			f.TransferSyntax = tsImplicitLE
		}
	}

	body := b[pos:]
	if f.TransferSyntax == tsDeflatedLE {
		inflated, err := io.ReadAll(flate.NewReader(bytes.NewReader(body)))
		if err != nil {
			return nil, fmt.Errorf("deflated data set: %w", err)
		}
		body = inflated
	}
	enc := encodingFor(f.TransferSyntax)
	r := &reader{b: body}
	ds, err := r.dataset(enc, len(body), 0)
	if err != nil {
		return nil, err
	}
	if len(ds.Elements) == 0 && f.Meta == nil {
		return nil, ErrNotDICOM
	}
	f.Data = ds
	return f, nil
}

// plausibleStart: a raw data set starts with a small even group (0002, 0008) element.
func plausibleStart(b []byte) bool {
	if len(b) < 8 {
		return false
	}
	g := binary.LittleEndian.Uint16(b)
	e := binary.LittleEndian.Uint16(b[2:])
	if g != 0x0002 && g != 0x0008 {
		return false
	}
	if validVR(b[4:]) {
		return true
	}
	// implicit VR: the length must fit and the element number must be small
	l := binary.LittleEndian.Uint32(b[4:])
	return e < 0x0100 && l < 1024 && int(l)+8 <= len(b)
}

type reader struct {
	b   []byte
	pos int
}

var errTruncated = errors.New("file is truncated or damaged")

func (r *reader) need(n int) error {
	if n < 0 || r.pos+n > len(r.b) {
		return errTruncated
	}
	return nil
}

func (r *reader) tag(enc encoding) (uint32, error) {
	if err := r.need(4); err != nil {
		return 0, err
	}
	g := enc.order.Uint16(r.b[r.pos:])
	e := enc.order.Uint16(r.b[r.pos+2:])
	r.pos += 4
	return uint32(g)<<16 | uint32(e), nil
}

// dataset reads elements until end (an absolute position in r.b) or an item delimiter.
func (r *reader) dataset(enc encoding, end int, depth int) (*Dataset, error) {
	if depth > 64 {
		return nil, errors.New("sequences nested too deeply")
	}
	ds := &Dataset{}
	for r.pos < end {
		if end-r.pos < 8 {
			// trailing garbage / padding shorter than an element header
			if allZero(r.b[r.pos:end]) {
				r.pos = end
				break
			}
			return nil, errTruncated
		}
		if enc.order.Uint16(r.b[r.pos:]) == 0xFFFE && enc.order.Uint16(r.b[r.pos+2:]) == 0xE00D {
			r.pos += 8 // item delimiter
			ds.Undefined = true
			return ds, nil
		}
		el, err := r.element(enc, depth)
		if err != nil {
			return nil, err
		}
		ds.Elements = append(ds.Elements, el)
	}
	return ds, nil
}

func allZero(b []byte) bool {
	for _, c := range b {
		if c != 0 {
			return false
		}
	}
	return true
}

func (r *reader) element(enc encoding, depth int) (*Element, error) {
	start := r.pos
	tag, err := r.tag(enc)
	if err != nil {
		return nil, err
	}
	el := &Element{Tag: tag}
	var length uint32
	if tag>>16 == 0xFFFE || enc.implicit {
		if err := r.need(4); err != nil {
			return nil, err
		}
		length = enc.order.Uint32(r.b[r.pos:])
		r.pos += 4
		el.VR = DictVR(tag)
	} else {
		if err := r.need(4); err != nil {
			return nil, err
		}
		if !validVR(r.b[r.pos:]) {
			return nil, fmt.Errorf("invalid VR at byte %d (tag %s)", start, TagString(tag))
		}
		el.VR = string(r.b[r.pos : r.pos+2])
		if longVR(el.VR) {
			if err := r.need(8); err != nil {
				return nil, err
			}
			length = enc.order.Uint32(r.b[r.pos+4:])
			r.pos += 8
		} else {
			length = uint32(enc.order.Uint16(r.b[r.pos+2:]))
			r.pos += 4
		}
	}

	if tag>>16 == 0xFFFE {
		return nil, fmt.Errorf("unexpected %s at byte %d", TagString(tag), start)
	}

	switch {
	case el.VR == "SQ" || (length == undefinedLength && enc.implicit && tag != tagPixelData):
		el.VR = "SQ"
		return el, r.sequence(el, enc, length, depth)
	case length == undefinedLength && el.VR == "UN":
		// UN with undefined length: an implicit VR little endian sequence (PS3.5 6.2.2).
		el.VR = "SQ"
		return el, r.sequence(el, encoding{implicit: true, order: binary.LittleEndian}, length, depth)
	case length == undefinedLength:
		// Encapsulated (compressed) pixel data: fragment items up to the sequence delimiter.
		el.Encapsulated = true
		begin := r.pos
		for {
			t, err := r.tag(enc)
			if err != nil {
				return nil, err
			}
			if err := r.need(4); err != nil {
				return nil, err
			}
			l := enc.order.Uint32(r.b[r.pos:])
			r.pos += 4
			if t == tagSequenceDelim {
				el.Value = r.b[begin : r.pos-8]
				return el, nil
			}
			if t != tagItem || l == undefinedLength {
				return nil, fmt.Errorf("damaged encapsulated pixel data at byte %d", r.pos-8)
			}
			if err := r.need(int(l)); err != nil {
				return nil, err
			}
			r.pos += int(l)
		}
	}
	if err := r.need(int(length)); err != nil {
		return nil, fmt.Errorf("%s: %w", TagString(tag), err)
	}
	el.Value = r.b[r.pos : r.pos+int(length)]
	r.pos += int(length)
	if enc.implicit && el.VR == "UN" && (tag>>16)%2 == 0 && looksLikeSequence(el.Value) {
		// unknown public tag that holds items: parse it so its contents are cleaned too
		sub := &reader{b: el.Value}
		probe := &Element{Tag: tag, VR: "SQ"}
		if sub.sequence(probe, enc, length, depth) == nil {
			return probe, nil
		}
	}
	return el, nil
}

func looksLikeSequence(v []byte) bool {
	return len(v) >= 8 && v[0] == 0xFE && v[1] == 0xFF && v[2] == 0x00 && v[3] == 0xE0
}

func (r *reader) sequence(el *Element, enc encoding, length uint32, depth int) error {
	el.IsSeq = true
	el.Undefined = length == undefinedLength
	end := len(r.b)
	if !el.Undefined {
		if err := r.need(int(length)); err != nil {
			return fmt.Errorf("%s: %w", TagString(el.Tag), err)
		}
		end = r.pos + int(length)
	}
	for r.pos < end {
		t, err := r.tag(enc)
		if err != nil {
			return err
		}
		if err := r.need(4); err != nil {
			return err
		}
		l := enc.order.Uint32(r.b[r.pos:])
		r.pos += 4
		switch t {
		case tagSequenceDelim:
			if !el.Undefined {
				return fmt.Errorf("%s: unexpected sequence delimiter", TagString(el.Tag))
			}
			return nil
		case tagItem:
		default:
			return fmt.Errorf("%s: expected an item, found %s", TagString(el.Tag), TagString(t))
		}
		var item *Dataset
		if l == undefinedLength {
			item, err = r.dataset(enc, end, depth+1)
			if err != nil {
				return err
			}
			if !item.Undefined {
				return fmt.Errorf("%s: item without delimiter", TagString(el.Tag))
			}
		} else {
			if err := r.need(int(l)); err != nil {
				return fmt.Errorf("%s: %w", TagString(el.Tag), err)
			}
			itemEnd := r.pos + int(l)
			item, err = r.dataset(enc, itemEnd, depth+1)
			if err != nil {
				return err
			}
			if item.Undefined || r.pos != itemEnd {
				return fmt.Errorf("%s: damaged item", TagString(el.Tag))
			}
		}
		el.Items = append(el.Items, item)
	}
	if el.Undefined {
		return fmt.Errorf("%s: %w", TagString(el.Tag), errTruncated)
	}
	if r.pos != end {
		return fmt.Errorf("%s: damaged sequence", TagString(el.Tag))
	}
	return nil
}

// ---- access helpers ----

// Get returns the element with the tag (top level of the data set only) or nil.
func (ds *Dataset) Get(tag uint32) *Element {
	if ds == nil {
		return nil
	}
	for _, e := range ds.Elements {
		if e.Tag == tag {
			return e
		}
	}
	return nil
}

// GetString returns the trimmed text value of an element, or "".
func (ds *Dataset) GetString(tag uint32) string {
	return ds.Get(tag).String()
}

// Set replaces (or inserts in tag order) an element with a text value.
func (ds *Dataset) Set(tag uint32, vr, value string) {
	v := padValue(vr, []byte(value))
	for i, e := range ds.Elements {
		if e.Tag == tag {
			ds.Elements[i] = &Element{Tag: tag, VR: e.VR, Value: v}
			return
		}
		if e.Tag > tag {
			ds.Elements = append(ds.Elements, nil)
			copy(ds.Elements[i+1:], ds.Elements[i:])
			ds.Elements[i] = &Element{Tag: tag, VR: vr, Value: v}
			return
		}
	}
	ds.Elements = append(ds.Elements, &Element{Tag: tag, VR: vr, Value: v})
}

// Remove deletes the top-level element with the tag.
func (ds *Dataset) Remove(tag uint32) {
	for i, e := range ds.Elements {
		if e.Tag == tag {
			ds.Elements = append(ds.Elements[:i], ds.Elements[i+1:]...)
			return
		}
	}
}

// String returns a text value without padding.
func (e *Element) String() string {
	if e == nil || e.IsSeq || e.Encapsulated {
		return ""
	}
	return strings.TrimRight(string(e.Value), " \x00")
}

func padValue(vr string, v []byte) []byte {
	if len(v)%2 == 0 {
		return v
	}
	pad := byte(' ')
	if vr == "UI" || vr == "OB" || vr == "UN" {
		pad = 0
	}
	return append(append([]byte(nil), v...), pad)
}

// TagString formats a tag as (gggg,eeee).
func TagString(tag uint32) string {
	return fmt.Sprintf("(%04X,%04X)", tag>>16, tag&0xFFFF)
}

// ---- writing ----

// Bytes encodes the file. The data set keeps the transfer syntax it was read with.
func (f *File) Bytes() ([]byte, error) {
	var out bytes.Buffer
	if f.HasPreamble || f.Meta != nil {
		pre := f.Preamble
		if len(pre) != 128 {
			pre = make([]byte, 128)
		}
		out.Write(pre)
		out.WriteString("DICM")
	}
	if f.Meta != nil {
		// group length first, computed over the rest of the group
		var meta bytes.Buffer
		w := writer{enc: encoding{order: binary.LittleEndian}}
		for _, e := range f.Meta.Elements {
			if e.Tag == 0x00020000 {
				continue
			}
			if err := w.element(&meta, e); err != nil {
				return nil, err
			}
		}
		gl := make([]byte, 4)
		binary.LittleEndian.PutUint32(gl, uint32(meta.Len()))
		if err := w.element(&out, &Element{Tag: 0x00020000, VR: "UL", Value: gl}); err != nil {
			return nil, err
		}
		out.Write(meta.Bytes())
	}
	w := writer{enc: encodingFor(f.TransferSyntax)}
	var body bytes.Buffer
	if err := w.dataset(&body, f.Data); err != nil {
		return nil, err
	}
	if f.TransferSyntax == tsDeflatedLE {
		fw, _ := flate.NewWriter(&out, flate.DefaultCompression)
		if _, err := fw.Write(body.Bytes()); err != nil {
			return nil, err
		}
		if err := fw.Close(); err != nil {
			return nil, err
		}
		if out.Len()%2 == 1 {
			out.WriteByte(0)
		}
	} else {
		out.Write(body.Bytes())
	}
	return out.Bytes(), nil
}

type writer struct{ enc encoding }

func (w writer) dataset(buf *bytes.Buffer, ds *Dataset) error {
	for _, e := range ds.Elements {
		if err := w.element(buf, e); err != nil {
			return err
		}
	}
	return nil
}

func (w writer) header(buf *bytes.Buffer, tag uint32, vr string, length uint32) error {
	var b [12]byte
	o := w.enc.order
	o.PutUint16(b[0:], uint16(tag>>16))
	o.PutUint16(b[2:], uint16(tag))
	if tag>>16 == 0xFFFE || w.enc.implicit {
		o.PutUint32(b[4:], length)
		buf.Write(b[:8])
		return nil
	}
	if len(vr) != 2 {
		vr = "UN"
	}
	copy(b[4:], vr)
	if longVR(vr) {
		o.PutUint32(b[8:], length)
		buf.Write(b[:12])
		return nil
	}
	if length > 0xFFFF {
		return fmt.Errorf("%s: value too long for VR %s", TagString(tag), vr)
	}
	o.PutUint16(b[6:], uint16(length))
	buf.Write(b[:8])
	return nil
}

func (w writer) element(buf *bytes.Buffer, e *Element) error {
	switch {
	case e.IsSeq:
		var items bytes.Buffer
		for _, it := range e.Items {
			var body bytes.Buffer
			if err := w.dataset(&body, it); err != nil {
				return err
			}
			if it.Undefined {
				_ = w.header(&items, tagItem, "", undefinedLength)
				items.Write(body.Bytes())
				_ = w.header(&items, tagItemDelim, "", 0)
			} else {
				_ = w.header(&items, tagItem, "", uint32(body.Len()))
				items.Write(body.Bytes())
			}
		}
		if e.Undefined {
			if err := w.header(buf, e.Tag, "SQ", undefinedLength); err != nil {
				return err
			}
			buf.Write(items.Bytes())
			return w.header(buf, tagSequenceDelim, "", 0)
		}
		if err := w.header(buf, e.Tag, "SQ", uint32(items.Len())); err != nil {
			return err
		}
		buf.Write(items.Bytes())
		return nil
	case e.Encapsulated:
		vr := e.VR
		if !longVR(vr) {
			vr = "OB"
		}
		if err := w.header(buf, e.Tag, vr, undefinedLength); err != nil {
			return err
		}
		buf.Write(e.Value)
		return w.header(buf, tagSequenceDelim, "", 0)
	}
	v := e.Value
	if len(v)%2 == 1 {
		v = padValue(e.VR, v)
	}
	if err := w.header(buf, e.Tag, e.VR, uint32(len(v))); err != nil {
		return err
	}
	buf.Write(v)
	return nil
}
