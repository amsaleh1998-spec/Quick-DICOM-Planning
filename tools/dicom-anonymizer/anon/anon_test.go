package anon

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// builder writes data elements for tests.
type builder struct {
	buf      bytes.Buffer
	implicit bool
	order    binary.ByteOrder
}

func newBuilder(implicit bool, order binary.ByteOrder) *builder {
	return &builder{implicit: implicit, order: order}
}

func (b *builder) el(tag uint32, vr string, value []byte) *builder {
	w := writer{enc: encoding{implicit: b.implicit, order: b.order}}
	_ = w.element(&b.buf, &Element{Tag: tag, VR: vr, Value: value})
	return b
}

func (b *builder) str(tag uint32, vr, s string) *builder {
	return b.el(tag, vr, padValue(vr, []byte(s)))
}

// seq writes a sequence with undefined length (or defined length if defined) holding the given items.
func (b *builder) seq(tag uint32, defined bool, items ...[]byte) *builder {
	var body bytes.Buffer
	w := writer{enc: encoding{implicit: b.implicit, order: b.order}}
	for _, it := range items {
		_ = w.header(&body, tagItem, "", uint32(len(it)))
		body.Write(it)
	}
	if defined {
		_ = w.header(&b.buf, tag, "SQ", uint32(body.Len()))
		b.buf.Write(body.Bytes())
	} else {
		_ = w.header(&b.buf, tag, "SQ", undefinedLength)
		b.buf.Write(body.Bytes())
		_ = w.header(&b.buf, tagSequenceDelim, "", 0)
	}
	return b
}

func part10(ts string, body []byte) []byte {
	meta := newBuilder(false, binary.LittleEndian).
		el(0x00020001, "OB", []byte{0, 1}).
		str(0x00020002, "UI", "1.2.840.10008.5.1.4.1.1.2").
		str(0x00020003, "UI", "1.2.3.4.5.6").
		str(0x00020010, "UI", ts).
		str(0x00020016, "AE", "SECRET_AE")
	gl := make([]byte, 4)
	binary.LittleEndian.PutUint32(gl, uint32(meta.buf.Len()))
	head := newBuilder(false, binary.LittleEndian).el(0x00020000, "UL", gl)
	out := append(make([]byte, 128), "DICM"...)
	out = append(out, head.buf.Bytes()...)
	out = append(out, meta.buf.Bytes()...)
	return append(out, body...)
}

func sampleBody(implicit bool, order binary.ByteOrder) []byte {
	item := newBuilder(implicit, order).
		str(0x00081150, "UI", "1.2.840.10008.5.1.4.1.1.2").
		str(0x00081155, "UI", "1.2.3.4.5.6").
		str(0x00100010, "PN", "Doe^John").buf.Bytes()
	pix := make([]byte, 8)
	for i := range pix {
		pix[i] = byte(i * 17)
	}
	return newBuilder(implicit, order).
		str(0x00080016, "UI", "1.2.840.10008.5.1.4.1.1.2").
		str(0x00080018, "UI", "1.2.3.4.5.6").
		str(0x00080020, "DA", "20260101").
		str(0x00080060, "CS", "CT").
		str(0x00080070, "LO", "ACME").
		str(0x00080080, "LO", "Smile Clinic").
		str(0x00080090, "PN", "Dr^Who").
		seq(0x00081140, true, item).
		str(0x00090010, "LO", "ACME 1").
		str(0x00091001, "LO", "Doe^John").
		str(0x00100010, "PN", "Doe^John").
		str(0x00100020, "LO", "PX-778899").
		str(0x00100030, "DA", "19700412").
		str(0x0020000D, "UI", "1.2.3.100").
		str(0x0020000E, "UI", "1.2.3.200").
		str(0x00200032, "DS", `0\0\1.5`).
		str(0x00321032, "PN", "Ref^Erring").
		str(0x300E0008, "PN", "Re^Viewer"). // not in the rules: removed because it is a person name
		str(0x60003000, "OW", "\x00\x00").
		el(0x7FE00010, "OW", pix).buf.Bytes()
}

func TestRoundTripUnchanged(t *testing.T) {
	for _, tc := range []struct {
		ts       string
		implicit bool
		order    binary.ByteOrder
	}{
		{tsExplicitLE, false, binary.LittleEndian},
		{tsImplicitLE, true, binary.LittleEndian},
		{tsExplicitBE, false, binary.BigEndian},
	} {
		in := part10(tc.ts, sampleBody(tc.implicit, tc.order))
		f, err := Parse(in)
		if err != nil {
			t.Fatalf("%s: %v", tc.ts, err)
		}
		out, err := f.Bytes()
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(in, out) {
			t.Errorf("%s: parse+write changed the file", tc.ts)
		}
	}
}

func TestAnonymize(t *testing.T) {
	for _, tc := range []struct {
		ts       string
		implicit bool
		order    binary.ByteOrder
	}{
		{tsExplicitLE, false, binary.LittleEndian},
		{tsImplicitLE, true, binary.LittleEndian},
		{tsExplicitBE, false, binary.BigEndian},
	} {
		f, err := Parse(part10(tc.ts, sampleBody(tc.implicit, tc.order)))
		if err != nil {
			t.Fatal(err)
		}
		s := NewSession(Options{}, []byte("secret"))
		s.Anonymize(f)
		out, err := f.Bytes()
		if err != nil {
			t.Fatal(err)
		}
		for _, leak := range []string{"Doe", "PX-778899", "Smile", "Who", "Erring", "Viewer", "SECRET_AE", "19700412", "20260101", "1.2.3.4.5.6", "1.2.3.100"} {
			if bytes.Contains(out, []byte(leak)) {
				t.Errorf("%s: %q still in the output", tc.ts, leak)
			}
		}
		g, err := Parse(out)
		if err != nil {
			t.Fatalf("%s: output does not parse: %v", tc.ts, err)
		}
		d := g.Data
		if d.GetString(0x00100010) != "ANONYMOUS" || d.GetString(0x00100020) != "ANON" {
			t.Errorf("%s: name/ID not replaced", tc.ts)
		}
		if e := d.Get(0x00080090); e == nil || len(e.Value) != 0 {
			t.Errorf("%s: referring physician should be kept empty", tc.ts)
		}
		for _, tag := range []uint32{0x00080080, 0x00091001, 0x00090010, 0x00321032, 0x300E0008, 0x60003000} {
			if d.Get(tag) != nil {
				t.Errorf("%s: %s not removed", tc.ts, TagString(tag))
			}
		}
		if d.GetString(0x00080070) != "ACME" || d.GetString(0x00200032) != `0\0\1.5` {
			t.Errorf("%s: technical attributes must be kept", tc.ts)
		}
		if !bytes.Equal(d.Get(0x7FE00010).Value, f.Data.Get(0x7FE00010).Value) {
			t.Errorf("%s: pixel data changed", tc.ts)
		}
		sop := d.GetString(0x00080018)
		if !strings.HasPrefix(sop, "2.25.") || sop != s.NewUID("1.2.3.4.5.6") {
			t.Errorf("%s: SOP Instance UID %q", tc.ts, sop)
		}
		if g.Meta.GetString(0x00020003) != sop || g.Meta.Get(0x00020016) != nil {
			t.Errorf("%s: file meta not updated", tc.ts)
		}
		ref := d.Get(0x00081140)
		if ref == nil || len(ref.Items) != 1 {
			t.Fatalf("%s: referenced image sequence lost", tc.ts)
		}
		it := ref.Items[0]
		if it.GetString(0x00081155) != sop || it.GetString(0x00081150) != "1.2.840.10008.5.1.4.1.1.2" {
			t.Errorf("%s: reference not remapped consistently", tc.ts)
		}
		if it.GetString(0x00100010) != "ANONYMOUS" {
			t.Errorf("%s: name inside a sequence not replaced", tc.ts)
		}
	}
}

func TestKeepOptions(t *testing.T) {
	f, err := Parse(part10(tsExplicitLE, sampleBody(false, binary.LittleEndian)))
	if err != nil {
		t.Fatal(err)
	}
	NewSession(Options{KeepDates: true, KeepUIDs: true, KeepInstitution: true, KeepPrivate: true,
		PatientName: "Case^7", PatientID: "7"}, nil).Anonymize(f)
	d := f.Data
	if d.GetString(0x00080020) != "20260101" || d.GetString(0x00100030) != "19700412" {
		t.Error("dates not kept")
	}
	if d.GetString(0x00080018) != "1.2.3.4.5.6" || d.GetString(0x00080080) != "Smile Clinic" {
		t.Error("UIDs / institution not kept")
	}
	if d.GetString(0x00091001) == "" {
		t.Error("private tag not kept")
	}
	if d.GetString(0x00100010) != "Case^7" || d.GetString(0x00100020) != "7" {
		t.Error("replacement name/ID not used")
	}
}

func TestImplicitDefinedLengthSequenceIsCleaned(t *testing.T) {
	// a defined-length sequence in implicit VR is only recognised through the dictionary
	item := newBuilder(true, binary.LittleEndian).str(0x00100010, "PN", "Doe^John").buf.Bytes()
	body := newBuilder(true, binary.LittleEndian).
		str(0x00080016, "UI", "1.2.840.10008.5.1.4.1.1.2").
		str(0x00080018, "UI", "1.2.3.4").
		seq(0x00081120, true, item). // Referenced Patient Sequence: removed
		seq(0x00081250, true, item). // Related Series Sequence: kept, name inside removed
		buf.Bytes()
	f, err := Parse(body) // raw data set without preamble
	if err != nil {
		t.Fatal(err)
	}
	NewSession(Options{}, nil).Anonymize(f)
	out, _ := f.Bytes()
	if bytes.Contains(out, []byte("Doe")) {
		t.Error("name inside an implicit VR sequence survived")
	}
	if f.Meta == nil || f.Meta.GetString(0x00020010) != tsImplicitLE {
		t.Error("raw data set should get file meta information")
	}
	if _, err := Parse(out); err != nil {
		t.Fatal(err)
	}
}

func TestEncapsulatedPixelDataCopied(t *testing.T) {
	var frag bytes.Buffer
	w := writer{enc: encoding{order: binary.LittleEndian}}
	_ = w.header(&frag, tagItem, "", 0) // empty basic offset table
	_ = w.header(&frag, tagItem, "", 6)
	frag.Write([]byte{1, 2, 3, 4, 5, 6})
	b := newBuilder(false, binary.LittleEndian).
		str(0x00080016, "UI", "1.2.840.10008.5.1.4.1.1.2").
		str(0x00080018, "UI", "1.2.3.4").
		str(0x00100010, "PN", "Doe^John")
	_ = w.header(&b.buf, tagPixelData, "OB", undefinedLength)
	b.buf.Write(frag.Bytes())
	_ = w.header(&b.buf, tagSequenceDelim, "", 0)
	f, err := Parse(part10("1.2.840.10008.1.2.4.70", b.buf.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	NewSession(Options{}, nil).Anonymize(f)
	out, _ := f.Bytes()
	g, err := Parse(out)
	if err != nil {
		t.Fatal(err)
	}
	px := g.Data.Get(tagPixelData)
	if px == nil || !px.Encapsulated || !bytes.Equal(px.Value, frag.Bytes()) {
		t.Error("compressed pixel data not copied unchanged")
	}
}

func TestNotDICOM(t *testing.T) {
	for _, b := range [][]byte{[]byte("hello world, this is text"), {}, make([]byte, 200)} {
		if _, err := Parse(b); err != ErrNotDICOM {
			t.Errorf("%q: got %v", b[:min(len(b), 10)], err)
		}
	}
}

func TestTruncatedFileFails(t *testing.T) {
	in := part10(tsExplicitLE, sampleBody(false, binary.LittleEndian))
	if _, err := Parse(in[:len(in)-3]); err == nil {
		t.Error("truncated file should not parse")
	}
}

func TestJob(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "DOE JOHN")
	_ = os.MkdirAll(filepath.Join(src, "sub"), 0o755)
	_ = os.WriteFile(filepath.Join(src, "a.dcm"), part10(tsExplicitLE, sampleBody(false, binary.LittleEndian)), 0o644)
	_ = os.WriteFile(filepath.Join(src, "sub", "Doe_John_2"), part10(tsImplicitLE, sampleBody(true, binary.LittleEndian)), 0o644)
	_ = os.WriteFile(filepath.Join(src, "readme.txt"), []byte("John Doe"), 0o644)
	out := filepath.Join(dir, "out")
	var logs []string
	run := func(rename bool) Result {
		j := &Job{Inputs: []string{src}, OutDir: out, Rename: rename, Session: NewSession(Options{}, []byte("k")),
			OnEvent: func(e Event) {
				if e.Text != "" {
					logs = append(logs, e.Text)
				}
			}}
		res, err := j.Run()
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	res := run(true)
	if res.Written != 2 || res.Skipped != 1 || res.Failed != 0 {
		t.Fatalf("result %+v, log %v", res, logs)
	}
	for _, p := range []string{"Case 01/IM000001.dcm", "Case 01/IM000002.dcm"} {
		if _, err := os.Stat(filepath.Join(out, p)); err != nil {
			t.Error(err)
		}
	}
	// a second run never overwrites: new case folder; keeping names keeps the relative paths
	res = run(true)
	if _, err := os.Stat(filepath.Join(out, "Case 02", "IM000002.dcm")); err != nil || res.Written != 2 {
		t.Error("second run should write Case 02")
	}
	run(false)
	if _, err := os.Stat(filepath.Join(out, "DOE JOHN (anonymized)", "sub", "Doe_John_2")); err != nil {
		t.Error(err)
	}
}
