package anon

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Level of a log message.
type Level int

const (
	Info Level = iota
	Warn
	Error
)

// Event reports progress to the user interface. Calls are serialised.
type Event struct {
	Level Level
	Text  string // log line ("" for progress-only events)
	Done  int    // files processed so far
	Total int    // files found so far
}

// Job anonymizes the DICOM files in Inputs (files and folders, searched recursively) into OutDir.
type Job struct {
	Inputs []string
	OutDir string
	// Rename: name the output "Case 01\Series 01 CT\IM000001.dcm" instead of keeping the original file and
	// folder names (which often contain the patient's name).
	Rename  bool
	Session *Session
	OnEvent func(Event)
	cancel  atomic.Bool
	mu      sync.Mutex
	done    int
	total   int
}

// Cancel stops the job after the files that are being written.
func (j *Job) Cancel() { j.cancel.Store(true) }

func (j *Job) emit(level Level, format string, a ...any) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.OnEvent != nil {
		j.OnEvent(Event{Level: level, Text: fmt.Sprintf(format, a...), Done: j.done, Total: j.total})
	}
}

func (j *Job) progress(doneDelta, totalDelta int) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.done += doneDelta
	j.total += totalDelta
	if j.OnEvent != nil {
		j.OnEvent(Event{Done: j.done, Total: j.total})
	}
}

// Result of a whole job.
type Result struct {
	Written, Skipped, Failed int
	Cases                    []string // output folders
	Canceled                 bool
}

// a case is one input folder, or all loose input files together
type inputCase struct {
	name  string // original name (used when not renaming)
	root  string // folder the relative output paths start from
	files []string
}

// Run processes all inputs. It returns an error only when nothing could be done at all.
func (j *Job) Run() (Result, error) {
	var res Result
	start := time.Now()
	if j.Session == nil {
		return res, errors.New("no session")
	}
	if strings.TrimSpace(j.OutDir) == "" {
		return res, errors.New("choose an output folder")
	}
	outAbs, err := filepath.Abs(j.OutDir)
	if err != nil {
		return res, err
	}
	if err := os.MkdirAll(outAbs, 0o755); err != nil {
		return res, fmt.Errorf("cannot create the output folder: %w", err)
	}

	cases, err := j.collect(outAbs)
	if err != nil {
		return res, err
	}
	if len(cases) == 0 {
		return res, errors.New("nothing to do: add files or folders first")
	}
	for _, c := range cases {
		if j.cancel.Load() {
			break
		}
		dir, w, s, f := j.runCase(c, outAbs)
		res.Written += w
		res.Skipped += s
		res.Failed += f
		if dir != "" {
			res.Cases = append(res.Cases, dir)
		}
	}
	res.Canceled = j.cancel.Load()
	secs := time.Since(start).Seconds()
	switch {
	case res.Canceled:
		j.emit(Warn, "Stopped. %d files were written.", res.Written)
	default:
		j.emit(Info, "Done in %.1f s: %d files anonymized, %d skipped, %d failed.", secs, res.Written, res.Skipped, res.Failed)
	}
	return res, nil
}

// collect expands the inputs into cases. Folders inside the output folder are skipped.
func (j *Job) collect(outAbs string) ([]*inputCase, error) {
	var cases []*inputCase
	loose := &inputCase{name: "Files"}
	for _, in := range j.Inputs {
		abs, err := filepath.Abs(in)
		if err != nil {
			j.emit(Error, "%s: %v", in, err)
			continue
		}
		info, err := os.Stat(abs)
		if err != nil {
			j.emit(Error, "%s: %v", in, err)
			continue
		}
		if !info.IsDir() {
			loose.files = append(loose.files, abs)
			continue
		}
		c := &inputCase{name: filepath.Base(abs), root: abs}
		err = filepath.WalkDir(abs, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				j.emit(Warn, "%s: %v", p, err)
				if d != nil && d.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			if d.IsDir() {
				if p != abs && within(p, outAbs) {
					return fs.SkipDir
				}
				return nil
			}
			if d.Type().IsRegular() {
				c.files = append(c.files, p)
			}
			return nil
		})
		if err != nil {
			j.emit(Error, "%s: %v", abs, err)
		}
		cases = append(cases, c)
	}
	if len(loose.files) > 0 {
		loose.root = commonDir(loose.files)
		cases = append(cases, loose)
	}
	return cases, nil
}

// within reports whether p is dir or inside dir.
func within(p, dir string) bool {
	rel, err := filepath.Rel(dir, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func commonDir(files []string) string {
	dir := filepath.Dir(files[0])
	for _, f := range files[1:] {
		for !within(f, dir) {
			parent := filepath.Dir(dir)
			if parent == dir {
				return dir
			}
			dir = parent
		}
	}
	return dir
}

type fileInfo struct {
	path     string
	series   string
	seriesNo int
	modality string
	desc     string
	instance int
	out      string
}

// runCase anonymizes one case; returns its output folder and counts.
func (j *Job) runCase(c *inputCase, outAbs string) (string, int, int, int) {
	j.progress(0, len(c.files))

	// pass 1: identify the DICOM files and their series
	var files []*fileInfo
	var notDicom []string
	dicomdir := 0
	for _, p := range c.files {
		if j.cancel.Load() {
			return "", 0, 0, 0
		}
		b, err := os.ReadFile(p)
		if err != nil {
			j.emit(Error, "%s: %v", p, err)
			j.progress(1, 0)
			continue
		}
		f, err := Parse(b)
		if err != nil {
			if errors.Is(err, ErrNotDICOM) {
				notDicom = append(notDicom, filepath.Base(p))
			} else {
				j.emit(Error, "%s: not anonymized, %v", p, err)
			}
			j.progress(1, 0)
			continue
		}
		if f.Meta != nil && f.Meta.GetString(0x00020002) == "1.2.840.10008.1.3.10" || f.Data.Get(0x00041220) != nil {
			dicomdir++ // DICOMDIR: an index that repeats the patient's name; viewers do not need it
			j.progress(1, 0)
			continue
		}
		fi := &fileInfo{path: p, series: f.Data.GetString(0x0020000E), modality: f.Data.GetString(0x00080060),
			desc: f.Data.GetString(0x0008103E)}
		fi.seriesNo, _ = strconv.Atoi(f.Data.GetString(0x00200011))
		fi.instance, _ = strconv.Atoi(f.Data.GetString(0x00200013))
		files = append(files, fi)
	}

	if len(files) == 0 {
		j.emit(Warn, "%s: no DICOM files found.", c.root)
		return "", 0, len(c.files), 0
	}

	caseDir := j.caseDir(c, outAbs)
	if err := os.MkdirAll(caseDir, 0o755); err != nil {
		j.emit(Error, "cannot create %s: %v", caseDir, err)
		return "", 0, 0, len(files)
	}
	j.planNames(c, files, caseDir)

	// pass 2: anonymize in parallel
	var written, failed atomic.Int64
	var warnOnce sync.Map
	work := make(chan *fileInfo)
	var wg sync.WaitGroup
	workers := runtime.NumCPU()
	if workers > 8 {
		workers = 8
	}
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for fi := range work {
				if j.cancel.Load() {
					continue
				}
				warns, err := j.anonymizeFile(fi.path, fi.out)
				if err != nil {
					failed.Add(1)
					j.emit(Error, "%s: not anonymized, %v", fi.path, err)
				} else {
					written.Add(1)
					for _, w := range warns {
						if _, seen := warnOnce.LoadOrStore(w, true); !seen {
							j.emit(Warn, "%s", w)
						}
					}
				}
				j.progress(1, 0)
			}
		}()
	}
	for _, fi := range files {
		if j.cancel.Load() {
			break
		}
		work <- fi
	}
	close(work)
	wg.Wait()

	series := map[string]bool{}
	for _, fi := range files {
		series[fi.series] = true
	}
	msg := fmt.Sprintf("%s → %s: %d files anonymized (%d series)", displayInput(c), caseDir, written.Load(), len(series))
	var skips []string
	if dicomdir > 0 {
		skips = append(skips, "DICOMDIR left out (it repeats the patient's name)")
	}
	if len(notDicom) > 0 {
		names := notDicom
		if len(names) > 5 {
			names = append(names[:5:5], "…")
		}
		skips = append(skips, fmt.Sprintf("%d non-DICOM files left out (%s)", len(notDicom), strings.Join(names, ", ")))
	}
	if len(skips) > 0 {
		msg += "; " + strings.Join(skips, "; ")
	}
	j.emit(Info, "%s.", msg)
	return caseDir, int(written.Load()), dicomdir + len(notDicom), int(failed.Load())
}

func displayInput(c *inputCase) string {
	if c.name == "Files" && len(c.files) > 0 && c.root != "" && filepath.Base(c.root) != c.name {
		return fmt.Sprintf("%d files from %s", len(c.files), c.root)
	}
	return c.root
}

// caseDir picks a new, unused output folder for the case.
func (j *Job) caseDir(c *inputCase, outAbs string) string {
	if j.Rename {
		for n := 1; ; n++ {
			d := filepath.Join(outAbs, fmt.Sprintf("Case %02d", n))
			if _, err := os.Stat(d); errors.Is(err, fs.ErrNotExist) {
				return d
			}
		}
	}
	base := c.name
	d := filepath.Join(outAbs, base+" (anonymized)")
	for n := 2; ; n++ {
		if _, err := os.Stat(d); errors.Is(err, fs.ErrNotExist) {
			return d
		}
		d = filepath.Join(outAbs, fmt.Sprintf("%s (anonymized %d)", base, n))
	}
}

// planNames sets each file's output path.
func (j *Job) planNames(c *inputCase, files []*fileInfo, caseDir string) {
	if !j.Rename {
		for _, fi := range files {
			rel, err := filepath.Rel(c.root, fi.path)
			if err != nil || strings.HasPrefix(rel, "..") {
				rel = filepath.Base(fi.path)
			}
			fi.out = filepath.Join(caseDir, rel)
		}
		return
	}
	bySeries := map[string][]*fileInfo{}
	var order []string
	for _, fi := range files {
		if _, ok := bySeries[fi.series]; !ok {
			order = append(order, fi.series)
		}
		bySeries[fi.series] = append(bySeries[fi.series], fi)
	}
	sort.SliceStable(order, func(a, b int) bool {
		sa, sb := bySeries[order[a]][0], bySeries[order[b]][0]
		if sa.seriesNo != sb.seriesNo {
			return sa.seriesNo < sb.seriesNo
		}
		return order[a] < order[b]
	})
	for i, uid := range order {
		list := bySeries[uid]
		sort.SliceStable(list, func(a, b int) bool {
			if list[a].instance != list[b].instance {
				return list[a].instance < list[b].instance
			}
			return list[a].path < list[b].path
		})
		dir := caseDir
		if len(order) > 1 {
			name := fmt.Sprintf("Series %02d", i+1)
			if m := safeName(list[0].modality); m != "" {
				name += " " + m
			}
			dir = filepath.Join(caseDir, name)
		}
		for k, fi := range list {
			fi.out = filepath.Join(dir, fmt.Sprintf("IM%06d.dcm", k+1))
		}
	}
}

// safeName keeps letters and digits only (modality codes).
func safeName(s string) string {
	var b strings.Builder
	for _, r := range s {
		if (r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
		}
	}
	if b.Len() > 8 {
		return b.String()[:8]
	}
	return b.String()
}

// anonymizeFile reads, cleans, verifies and writes one file. It returns warnings worth showing once.
func (j *Job) anonymizeFile(in, out string) ([]string, error) {
	b, err := os.ReadFile(in)
	if err != nil {
		return nil, err
	}
	f, err := Parse(b)
	if err != nil {
		return nil, err
	}
	ids := identifiers(f.Data)
	j.Session.Anonymize(f)
	enc, err := f.Bytes()
	if err != nil {
		return nil, err
	}
	// verify: the result must parse again, and the old name/ID must be gone
	check, err := Parse(enc)
	if err != nil {
		return nil, fmt.Errorf("internal check failed: %v", err)
	}
	var warns []string
	if leaks := FindText(check.Data, ids, j.Session.Opts); len(leaks) > 0 {
		warns = append(warns, fmt.Sprintf("Check %s: the original patient name or ID still appears in %s (kept by your options).",
			filepath.Base(out), strings.Join(leaks, ", ")))
	}
	if burned := burnedIn(check.Data); burned != "" {
		warns = append(warns, burned)
	}
	if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
		return nil, err
	}
	fh, err := os.OpenFile(out, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return nil, err
	}
	if _, err := fh.Write(enc); err != nil {
		fh.Close()
		os.Remove(out)
		return nil, err
	}
	if err := fh.Close(); err != nil {
		os.Remove(out)
		return nil, err
	}
	return warns, nil
}

// identifiers returns the parts of the patient's name and ID that are long enough to search for.
func identifiers(ds *Dataset) []string {
	var ids []string
	add := func(s string) {
		s = strings.TrimSpace(s)
		if len(s) >= 3 {
			ids = append(ids, strings.ToUpper(s))
		}
	}
	name := ds.GetString(0x00100010)
	for _, part := range strings.FieldsFunc(name, func(r rune) bool { return r == '^' || r == ' ' || r == '=' || r == ',' }) {
		add(part)
	}
	add(ds.GetString(0x00100020))
	return ids
}

// FindText lists the tags (outside pixel data) whose value contains one of ids.
func FindText(ds *Dataset, ids []string, opts Options) []string {
	if len(ids) == 0 {
		return nil
	}
	replacement := strings.ToUpper(opts.PatientName + " " + opts.PatientID)
	var useful []string
	for _, id := range ids {
		if !strings.Contains(replacement, id) {
			useful = append(useful, id)
		}
	}
	var found []string
	var walk func(ds *Dataset)
	walk = func(ds *Dataset) {
		for _, e := range ds.Elements {
			if e.IsSeq {
				for _, it := range e.Items {
					walk(it)
				}
				continue
			}
			if e.Encapsulated || e.Tag == tagPixelData || len(e.Value) < 3 {
				continue
			}
			v := bytes.ToUpper(e.Value)
			for _, id := range useful {
				if bytes.Contains(v, []byte(id)) {
					found = append(found, TagString(e.Tag))
					break
				}
			}
		}
	}
	walk(ds)
	return found
}

// burnedIn warns about image types that often show the name in the pixels.
func burnedIn(ds *Dataset) string {
	mod := ds.GetString(0x00080060)
	cls := ds.GetString(0x00080016)
	switch {
	case strings.EqualFold(ds.GetString(0x00280301), "YES"):
	case mod == "US" || mod == "SC" || mod == "OT" || mod == "XC" || mod == "ES" || mod == "DOC":
	case strings.HasPrefix(cls, "1.2.840.10008.5.1.4.1.1.7"): // secondary capture
	default:
		return ""
	}
	return "Some images (" + mod + ") may show the patient's name inside the picture itself; metadata cleaning cannot remove that – check them."
}
