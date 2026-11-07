package anon

import (
	"crypto/sha256"
	"math/big"
	"strings"
)

// Options select what is kept. The zero value removes everything the DICOM Basic Application Level
// Confidentiality Profile (PS3.15 Annex E) removes, plus private tags, overlays and every other person name.
type Options struct {
	PatientName string // replacement Patient's Name (default "ANONYMOUS")
	PatientID   string // replacement Patient ID (default "ANON")

	KeepDates        bool // dates and times (Retain Longitudinal Temporal Information with Full Dates)
	KeepPatientChars bool // sex, age, size, weight … (Retain Patient Characteristics)
	KeepDescriptions bool // study/series/protocol descriptions, image comments (Retain Safe Descriptors-ish)
	KeepInstitution  bool // institution name/address/department (Retain Institution Identity)
	KeepDevice       bool // station name, serial numbers, software versions (Retain Device Identity)
	KeepUIDs         bool // study/series/instance UIDs unchanged (Retain UIDs)
	KeepPrivate      bool // vendor private tags (not recommended: they often hold names)
}

type action uint8

const (
	actRemove action = iota + 1 // X
	actEmpty                    // Z: keep the attribute with an empty value
	actName                     // replacement patient name
	actID                       // replacement patient ID
	actUID                      // U: replace consistently
	actKeep                     // K
)

type keepGroup uint8

const (
	kNone keepGroup = iota
	kDates
	kChars
	kDesc
	kInst
	kDevice
	kUIDs
)

type rule struct {
	act  action
	keep keepGroup // option that turns the rule into "keep"
}

// rules: PS3.15 Annex E Table E.1-1 (Basic Profile), simplified to one action per attribute.
var rules = map[uint32]rule{
	// ---- patient ----
	0x00100010: {actName, kNone},   // Patient's Name
	0x00100020: {actID, kNone},     // Patient ID
	0x00100021: {actRemove, kNone}, // Issuer of Patient ID
	0x00100022: {actRemove, kNone}, // Type of Patient ID
	0x00100024: {actRemove, kNone}, // Issuer of Patient ID Qualifiers Sequence
	0x00100026: {actRemove, kNone}, // Source Patient Group Identification Sequence
	0x00100027: {actRemove, kNone}, // Group of Patients Identification Sequence
	0x00100030: {actEmpty, kDates}, // Patient's Birth Date
	0x00100032: {actRemove, kDates},
	0x00100033: {actRemove, kDates},
	0x00100034: {actRemove, kDates},
	0x00100035: {actRemove, kDates},
	0x00100040: {actEmpty, kChars}, // Patient's Sex
	0x00100050: {actRemove, kNone}, // Patient's Insurance Plan Code Sequence
	0x00100101: {actRemove, kNone},
	0x00100102: {actRemove, kNone},
	0x00101000: {actRemove, kNone},  // Other Patient IDs
	0x00101001: {actRemove, kNone},  // Other Patient Names
	0x00101002: {actRemove, kNone},  // Other Patient IDs Sequence
	0x00101005: {actRemove, kNone},  // Patient's Birth Name
	0x00101010: {actRemove, kChars}, // Patient's Age
	0x00101020: {actRemove, kChars}, // Patient's Size
	0x00101021: {actRemove, kChars}, // Patient's Size Code Sequence
	0x00101022: {actRemove, kChars}, // Patient's Body Mass Index
	0x00101030: {actRemove, kChars}, // Patient's Weight
	0x00101040: {actRemove, kNone},  // Patient's Address
	0x00101050: {actRemove, kNone},  // Insurance Plan Identification
	0x00101060: {actRemove, kNone},  // Patient's Mother's Birth Name
	0x00101080: {actRemove, kNone},  // Military Rank
	0x00101081: {actRemove, kNone},  // Branch of Service
	0x00101090: {actRemove, kNone},  // Medical Record Locator
	0x00101100: {actRemove, kNone},  // Referenced Patient Photo Sequence
	0x00102000: {actRemove, kNone},  // Medical Alerts
	0x00102110: {actRemove, kNone},  // Allergies
	0x00102150: {actRemove, kNone},  // Country of Residence
	0x00102152: {actRemove, kNone},  // Region of Residence
	0x00102154: {actRemove, kNone},  // Patient's Telephone Numbers
	0x00102155: {actRemove, kNone},  // Patient's Telecom Information
	0x00102160: {actRemove, kChars}, // Ethnic Group
	0x00102180: {actRemove, kNone},  // Occupation
	0x001021A0: {actRemove, kChars}, // Smoking Status
	0x001021B0: {actRemove, kNone},  // Additional Patient History
	0x001021C0: {actRemove, kChars}, // Pregnancy Status
	0x001021D0: {actRemove, kDates}, // Last Menstrual Date
	0x001021F0: {actRemove, kNone},  // Patient's Religious Preference
	0x00102203: {actRemove, kChars}, // Patient's Sex Neutered
	0x00102297: {actRemove, kNone},  // Responsible Person
	0x00102299: {actRemove, kNone},  // Responsible Organization
	0x00104000: {actRemove, kNone},  // Patient Comments

	// ---- clinical trial ----
	0x00120010: {actRemove, kNone}, 0x00120020: {actRemove, kNone}, 0x00120021: {actRemove, kNone},
	0x00120030: {actRemove, kNone}, 0x00120031: {actRemove, kNone}, 0x00120040: {actRemove, kNone},
	0x00120042: {actRemove, kNone}, 0x00120050: {actRemove, kNone}, 0x00120051: {actRemove, kNone},
	0x00120060: {actRemove, kNone}, 0x00120071: {actRemove, kNone}, 0x00120072: {actRemove, kNone},
	0x00120081: {actRemove, kNone}, 0x00120082: {actRemove, kNone},

	// ---- visit / admission ----
	0x00380010: {actRemove, kNone}, 0x00380014: {actRemove, kNone}, 0x00380020: {actRemove, kDates},
	0x00380021: {actRemove, kDates}, 0x00380050: {actRemove, kNone}, 0x00380060: {actRemove, kNone},
	0x00380062: {actRemove, kNone}, 0x00380300: {actRemove, kNone}, 0x00380400: {actRemove, kNone},
	0x00380500: {actRemove, kNone}, 0x00381234: {actRemove, kNone}, 0x00384000: {actRemove, kNone},

	// ---- study / series / instance ----
	0x00080012: {actRemove, kDates},  // Instance Creation Date
	0x00080013: {actRemove, kDates},  // Instance Creation Time
	0x00080014: {actUID, kUIDs},      // Instance Creator UID
	0x00080015: {actRemove, kDates},  // Instance Coercion DateTime
	0x00080018: {actUID, kUIDs},      // SOP Instance UID
	0x00080020: {actEmpty, kDates},   // Study Date
	0x00080021: {actRemove, kDates},  // Series Date
	0x00080022: {actRemove, kDates},  // Acquisition Date
	0x00080023: {actEmpty, kDates},   // Content Date
	0x00080024: {actRemove, kDates},  // Overlay Date
	0x00080025: {actRemove, kDates},  // Curve Date
	0x0008002A: {actRemove, kDates},  // Acquisition DateTime
	0x00080030: {actEmpty, kDates},   // Study Time
	0x00080031: {actRemove, kDates},  // Series Time
	0x00080032: {actRemove, kDates},  // Acquisition Time
	0x00080033: {actEmpty, kDates},   // Content Time
	0x00080034: {actRemove, kDates},  // Overlay Time
	0x00080035: {actRemove, kDates},  // Curve Time
	0x00080050: {actEmpty, kNone},    // Accession Number
	0x00080051: {actRemove, kNone},   // Issuer of Accession Number Sequence
	0x00080058: {actUID, kUIDs},      // Failed SOP Instance UID List
	0x00080080: {actRemove, kInst},   // Institution Name
	0x00080081: {actRemove, kInst},   // Institution Address
	0x00080082: {actRemove, kInst},   // Institution Code Sequence
	0x00080090: {actEmpty, kNone},    // Referring Physician's Name
	0x00080092: {actRemove, kNone},   // Referring Physician's Address
	0x00080094: {actRemove, kNone},   // Referring Physician's Telephone Numbers
	0x00080096: {actRemove, kNone},   // Referring Physician Identification Sequence
	0x0008009C: {actRemove, kNone},   // Consulting Physician's Name
	0x0008009D: {actRemove, kNone},   // Consulting Physician Identification Sequence
	0x00080201: {actRemove, kDates},  // Timezone Offset From UTC
	0x00081010: {actRemove, kDevice}, // Station Name
	0x00081030: {actRemove, kDesc},   // Study Description
	0x0008103E: {actRemove, kDesc},   // Series Description
	0x00081040: {actRemove, kInst},   // Institutional Department Name
	0x00081041: {actRemove, kInst},   // Institutional Department Type Code Sequence
	0x00081048: {actRemove, kNone},   // Physician(s) of Record
	0x00081049: {actRemove, kNone},
	0x00081050: {actRemove, kNone}, // Performing Physician's Name
	0x00081052: {actRemove, kNone},
	0x00081060: {actRemove, kNone}, // Name of Physician(s) Reading Study
	0x00081062: {actRemove, kNone},
	0x00081070: {actRemove, kNone}, // Operators' Name
	0x00081072: {actRemove, kNone},
	0x00081080: {actRemove, kDesc}, // Admitting Diagnoses Description
	0x00081084: {actRemove, kDesc},
	0x00081110: {actRemove, kNone}, // Referenced Study Sequence
	0x00081111: {actRemove, kNone}, // Referenced Performed Procedure Step Sequence
	0x00081120: {actRemove, kNone}, // Referenced Patient Sequence
	0x00081155: {actUID, kUIDs},    // Referenced SOP Instance UID
	0x00081195: {actUID, kUIDs},    // Transaction UID
	0x00082111: {actRemove, kDesc}, // Derivation Description
	0x00083010: {actUID, kUIDs},    // Irradiation Event UID
	0x00084000: {actRemove, kNone}, // Identifying Comments

	0x00181000: {actRemove, kDevice}, // Device Serial Number
	0x00181002: {actUID, kDevice},    // Device UID
	0x00181004: {actRemove, kDevice}, // Plate ID
	0x00181005: {actRemove, kDevice}, // Generator ID
	0x00181007: {actRemove, kDevice}, // Cassette ID
	0x00181008: {actRemove, kDevice}, // Gantry ID
	0x00181009: {actRemove, kDevice}, // Unique Device Identifier
	0x0018100A: {actRemove, kDevice}, // UDI Sequence
	0x00181012: {actRemove, kDates},  // Date of Secondary Capture
	0x00181014: {actRemove, kDates},  // Time of Secondary Capture
	0x00181016: {actRemove, kDevice}, // Secondary Capture Device Manufacturer
	0x00181017: {actRemove, kDevice},
	0x00181018: {actRemove, kDevice},
	0x00181019: {actRemove, kDevice},
	0x00181020: {actRemove, kDevice}, // Software Versions
	0x00181030: {actRemove, kDesc},   // Protocol Name
	0x00181200: {actRemove, kDates},  // Date of Last Calibration
	0x00181201: {actRemove, kDates},  // Time of Last Calibration
	0x00181400: {actRemove, kDesc},   // Acquisition Device Processing Description
	0x00184000: {actRemove, kNone},   // Acquisition Comments
	0x0018700A: {actRemove, kDevice}, // Detector ID
	0x00189424: {actRemove, kDesc},   // Acquisition Protocol Description
	0x00189516: {actRemove, kDates},
	0x00189517: {actRemove, kDates},
	0x0018A003: {actRemove, kNone}, // Contribution Description

	0x0020000D: {actUID, kUIDs},   // Study Instance UID
	0x0020000E: {actUID, kUIDs},   // Series Instance UID
	0x00200010: {actEmpty, kNone}, // Study ID
	0x00200052: {actUID, kUIDs},   // Frame of Reference UID
	0x00200200: {actUID, kUIDs},   // Synchronization Frame of Reference UID
	0x00203401: {actRemove, kDevice},
	0x00203404: {actRemove, kDevice},
	0x00203406: {actRemove, kDevice},
	0x00204000: {actRemove, kDesc}, // Image Comments
	0x00209158: {actRemove, kDesc}, // Frame Comments
	0x00209161: {actUID, kUIDs},    // Concatenation UID
	0x00209164: {actUID, kUIDs},    // Dimension Organization UID

	0x00281199: {actUID, kUIDs}, // Palette Color LUT UID
	0x00281214: {actUID, kUIDs}, // Large Palette Color LUT UID

	0x00320012: {actRemove, kNone}, 0x00321000: {actRemove, kDates}, 0x00321001: {actRemove, kDates},
	0x00321010: {actRemove, kDates}, 0x00321011: {actRemove, kDates}, 0x00321020: {actRemove, kNone},
	0x00321021: {actRemove, kNone}, 0x00321030: {actRemove, kNone}, 0x00321032: {actRemove, kNone},
	0x00321033: {actRemove, kNone}, 0x00321040: {actRemove, kDates}, 0x00321041: {actRemove, kDates},
	0x00321050: {actRemove, kDates}, 0x00321051: {actRemove, kDates}, 0x00321060: {actRemove, kDesc},
	0x00321070: {actRemove, kNone}, 0x00324000: {actRemove, kNone},

	0x00400001: {actRemove, kDevice}, 0x00400002: {actRemove, kDates}, 0x00400003: {actRemove, kDates},
	0x00400004: {actRemove, kDates}, 0x00400005: {actRemove, kDates}, 0x00400006: {actRemove, kNone},
	0x00400007: {actRemove, kDesc}, 0x00400009: {actRemove, kNone}, 0x0040000B: {actRemove, kNone},
	0x00400010: {actRemove, kDevice}, 0x00400011: {actRemove, kDevice}, 0x00400241: {actRemove, kDevice},
	0x00400242: {actRemove, kDevice}, 0x00400243: {actRemove, kDevice}, 0x00400244: {actRemove, kDates},
	0x00400245: {actRemove, kDates}, 0x00400250: {actRemove, kDates}, 0x00400251: {actRemove, kDates},
	0x00400253: {actRemove, kNone}, 0x00400254: {actRemove, kDesc}, 0x00400275: {actRemove, kNone},
	0x00400280: {actRemove, kNone}, 0x00400555: {actRemove, kNone}, 0x00401001: {actRemove, kNone},
	0x00401004: {actRemove, kNone}, 0x00401005: {actRemove, kNone}, 0x00401010: {actRemove, kNone},
	0x00401011: {actRemove, kNone}, 0x00401101: {actRemove, kNone}, 0x00401102: {actRemove, kNone},
	0x00401103: {actRemove, kNone}, 0x00401104: {actRemove, kNone}, 0x00401400: {actRemove, kNone},
	0x00402001: {actRemove, kNone}, 0x00402008: {actRemove, kNone}, 0x00402009: {actRemove, kNone},
	0x00402010: {actRemove, kNone}, 0x00402011: {actRemove, kNone}, 0x00402016: {actEmpty, kNone},
	0x00402017: {actEmpty, kNone}, 0x00402400: {actRemove, kNone}, 0x00403001: {actRemove, kNone},
	0x00404023: {actUID, kUIDs}, 0x0040A027: {actRemove, kInst}, 0x0040A073: {actRemove, kNone},
	0x0040A075: {actRemove, kNone}, 0x0040A078: {actRemove, kNone}, 0x0040A07A: {actRemove, kNone},
	0x0040A07C: {actRemove, kNone}, 0x0040A088: {actRemove, kNone}, 0x0040A123: {actRemove, kNone},
	0x0040A124: {actUID, kUIDs}, 0x0040A730: {actRemove, kNone}, 0x0040DB0C: {actUID, kUIDs},
	0x0040DB0D: {actUID, kUIDs},
	0x00400512: {actRemove, kNone}, 0x00400513: {actRemove, kNone}, 0x0040051A: {actRemove, kDesc},
	0x00400551: {actRemove, kNone}, 0x00400562: {actRemove, kNone}, 0x00400600: {actRemove, kDesc},
	0x00400602: {actRemove, kDesc}, 0x00400610: {actRemove, kNone},

	0x00700084: {actEmpty, kNone},  // Content Creator's Name
	0x00700086: {actRemove, kNone}, // Content Creator's Identification Code Sequence
	0x00880140: {actUID, kUIDs},    // Storage Media File-set UID
	0x30060024: {actUID, kUIDs},    // Referenced Frame of Reference UID
	0x300600C2: {actUID, kUIDs},    // Related Frame of Reference UID
	0x300A0013: {actUID, kUIDs},    // Dose Reference UID

	0x04000100: {actRemove, kNone}, // Digital Signature UID
	0x04000402: {actRemove, kNone}, // Referenced Digital Signature Sequence
	0x04000403: {actRemove, kNone}, // Referenced SOP Instance MAC Sequence
	0x04000404: {actRemove, kNone}, // MAC
	0x04000550: {actRemove, kNone}, // Modified Attributes Sequence
	0x04000561: {actRemove, kNone}, // Original Attributes Sequence
	0x40000010: {actRemove, kNone}, // Arbitrary
	0x40004000: {actRemove, kNone}, // Text Comments
	0xFFFAFFFA: {actRemove, kNone}, // Digital Signatures Sequence
	0xFFFCFFFC: {actRemove, kNone}, // Data Set Trailing Padding

	// replaced by this tool
	0x00120062: {actRemove, kNone}, // Patient Identity Removed
	0x00120063: {actRemove, kNone}, // De-identification Method
	0x00120064: {actRemove, kNone}, // De-identification Method Code Sequence
}

// UIDs that name a class or a coding scheme, not an instance: never replaced.
var classUIDTags = map[uint32]bool{
	0x00020002: true, 0x00020010: true, 0x00020012: true, // meta: SOP class, transfer syntax, implementation
	0x00041510: true, 0x00041512: true, 0x0004151A: true, // DICOMDIR referenced class / transfer syntax
	0x00080016: true, 0x0008001A: true, 0x0008001B: true, // SOP Class UID, related / original specialized class
	0x00080062: true, 0x0008010C: true, 0x0008010D: true, // SOP Classes in Study, Coding Scheme UID
	0x00081150: true, 0x0008114A: true, 0x00081490: true, // Referenced SOP Class UID …
	0x0008051A: true, 0x00189368: true, 0x00400554: true,
	0x0040E001: true, 0x00720024: true, 0x00720526: true,
}

// Session holds what must be the same for every file of one run (the UID mapping secret).
type Session struct {
	Opts   Options
	secret []byte
}

// NewSession creates a session; secret makes the replacement UIDs unpredictable (random per run).
func NewSession(opts Options, secret []byte) *Session {
	if strings.TrimSpace(opts.PatientName) == "" {
		opts.PatientName = "ANONYMOUS"
	}
	if strings.TrimSpace(opts.PatientID) == "" {
		opts.PatientID = "ANON"
	}
	return &Session{Opts: opts, secret: append([]byte(nil), secret...)}
}

// NewUID returns the replacement for a UID: the same input always gives the same output in a session, so
// files keep belonging to the same study and series.
func (s *Session) NewUID(old string) string {
	h := sha256.New()
	h.Write(s.secret)
	h.Write([]byte(old))
	sum := h.Sum(nil)
	n := new(big.Int).SetBytes(sum[:16])
	return "2.25." + n.String()
}

func (s *Session) kept(k keepGroup) bool {
	o := s.Opts
	switch k {
	case kDates:
		return o.KeepDates
	case kChars:
		return o.KeepPatientChars
	case kDesc:
		return o.KeepDescriptions
	case kInst:
		return o.KeepInstitution
	case kDevice:
		return o.KeepDevice
	case kUIDs:
		return o.KeepUIDs
	}
	return false
}

// Stats counts what was changed in one file.
type Stats struct {
	Removed, Emptied, Replaced, UIDs, Private int
}

// Anonymize changes the file in place.
func (s *Session) Anonymize(f *File) Stats {
	var st Stats
	f.Data = s.clean(f.Data, &st, 0)

	ds := f.Data
	ds.Set(0x00120062, "CS", "YES")
	// De-identification Method (LO, 1-n): one value per kept group, each at most 64 characters
	method := []string{"PS3.15 Basic Application Confidentiality Profile"}
	for _, k := range []struct {
		on   bool
		name string
	}{
		{s.Opts.KeepDates, "Retained: dates and times"}, {s.Opts.KeepPatientChars, "Retained: patient characteristics"},
		{s.Opts.KeepDescriptions, "Retained: descriptions"}, {s.Opts.KeepInstitution, "Retained: institution identity"},
		{s.Opts.KeepDevice, "Retained: device identity"}, {s.Opts.KeepUIDs, "Retained: UIDs"},
		{s.Opts.KeepPrivate, "Retained: private attributes"},
	} {
		if k.on {
			method = append(method, k.name)
		}
	}
	ds.Set(0x00120063, "LO", strings.Join(method, `\`))
	if !s.Opts.KeepDates {
		ds.Set(0x00280303, "CS", "REMOVED") // Longitudinal Temporal Information Modified
	}

	// file meta information: rebuilt for the new SOP instance
	sopClass := ds.GetString(0x00080016)
	sopInst := ds.GetString(0x00080018)
	if f.Meta == nil {
		if sopClass == "" || sopInst == "" {
			return st // a raw data set without identity: written without meta information
		}
		f.Meta = &Dataset{}
		f.Meta.Set(0x00020001, "OB", "\x00\x01")
		f.Meta.Set(0x00020010, "UI", f.TransferSyntax)
	}
	m := f.Meta
	keepMeta := map[uint32]bool{0x00020001: true, 0x00020002: true, 0x00020003: true, 0x00020010: true}
	var elems []*Element
	for _, e := range m.Elements {
		if keepMeta[e.Tag] {
			elems = append(elems, e)
		}
	}
	m.Elements = elems
	if m.Get(0x00020001) == nil {
		m.Set(0x00020001, "OB", "\x00\x01")
	}
	if sopClass != "" {
		m.Set(0x00020002, "UI", sopClass)
	}
	if sopInst != "" {
		m.Set(0x00020003, "UI", sopInst)
	} else if old := m.GetString(0x00020003); old != "" && !s.Opts.KeepUIDs {
		m.Set(0x00020003, "UI", s.NewUID(old))
	}
	m.Set(0x00020012, "UI", ImplementationUID)
	m.Set(0x00020013, "SH", ImplementationName)
	return st
}

// ImplementationUID / ImplementationName identify this tool in the file meta information.
const (
	ImplementationUID  = "2.25.141346213650487466352651127427364563795"
	ImplementationName = "DICOM_ANON_1"
)

func (s *Session) clean(ds *Dataset, st *Stats, depth int) *Dataset {
	out := ds.Elements[:0:0]
	for _, e := range ds.Elements {
		if keep := s.cleanElement(e, st, depth); keep != nil {
			out = append(out, keep)
		}
	}
	ds.Elements = out
	return ds
}

// cleanElement returns the element to write (possibly changed) or nil to drop it.
func (s *Session) cleanElement(e *Element, st *Stats, depth int) *Element {
	g, el := e.Tag>>16, e.Tag&0xFFFF
	if g == 0x0002 && depth == 0 {
		return nil // meta group inside the data set (broken writers) – rebuilt separately
	}
	if el == 0 && g != 0x0002 {
		return nil // group lengths would be wrong after changes
	}
	if g%2 == 1 {
		if s.Opts.KeepPrivate {
			return e
		}
		st.Private++
		return nil
	}
	if (g >= 0x6000 && g <= 0x601E) || (g >= 0x5000 && g <= 0x501E) {
		st.Removed++ // overlays and curves (may contain burned-in text)
		return nil
	}
	if g == 0x4008 {
		st.Removed++ // results (retired)
		return nil
	}

	vr := e.VR
	if vr == "UN" || vr == "" {
		vr = DictVR(e.Tag)
	}

	r, listed := rules[e.Tag]
	act := r.act
	if listed && s.kept(r.keep) {
		act = actKeep
	}
	if !listed {
		switch {
		case vr == "PN":
			act = actRemove // any other person name
		case (vr == "DA" || vr == "DT" || vr == "TM") && !s.Opts.KeepDates:
			act = actRemove
		case vr == "UI" && !s.Opts.KeepUIDs && !classUIDTags[e.Tag]:
			act = actUID
		default:
			act = actKeep
		}
	}

	switch act {
	case actRemove:
		st.Removed++
		return nil
	case actEmpty:
		st.Emptied++
		return &Element{Tag: e.Tag, VR: e.VR}
	case actName:
		st.Replaced++
		return &Element{Tag: e.Tag, VR: e.VR, Value: padValue("PN", []byte(s.Opts.PatientName))}
	case actID:
		st.Replaced++
		return &Element{Tag: e.Tag, VR: e.VR, Value: padValue("LO", []byte(s.Opts.PatientID))}
	case actUID:
		if e.IsSeq || e.Encapsulated {
			return e
		}
		vals := strings.Split(e.String(), `\`)
		changed := false
		for i, v := range vals {
			v = strings.TrimSpace(v)
			if v == "" || strings.HasPrefix(v, "1.2.840.10008.") {
				continue
			}
			vals[i] = s.NewUID(v)
			changed = true
		}
		if !changed {
			return e
		}
		st.UIDs++
		return &Element{Tag: e.Tag, VR: e.VR, Value: padValue("UI", []byte(strings.Join(vals, `\`)))}
	}
	if e.IsSeq {
		for _, it := range e.Items {
			s.clean(it, st, depth+1)
		}
	}
	return e
}
