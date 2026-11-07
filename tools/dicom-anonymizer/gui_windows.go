//go:build windows

// The window: list of scans (drop files/folders or use the buttons), output folder, options, log.
package main

import (
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"unsafe"

	"dicomanon/anon"
)

const (
	idList = 100 + iota
	idAddFolder
	idAddFiles
	idRemove
	idClear
	idOut
	idBrowseOut
	idName
	idID
	idKeepDates
	idKeepChars
	idKeepDesc
	idKeepInst
	idKeepDevice
	idKeepUIDs
	idKeepPrivate
	idRename
	idStart
	idOpenOut
	idProgress
	idLog
	idStatus
)

const (
	wmJobEvents = wmApp + 1
	wmJobDone   = wmApp + 2
)

type app struct {
	hwnd     uintptr
	instance uintptr
	font     uintptr
	dpi      int32

	inputs []string
	c      map[int]uintptr // controls by id
	labels map[string]uintptr

	mu       sync.Mutex
	events   []anon.Event
	posted   bool
	job      *anon.Job
	result   anon.Result
	jobErr   error
	running  bool
	closing  bool
	lastOut  string
	progress struct{ done, total int }
}

var theApp *app

func main() {
	runtime.LockOSThread() // all window calls on one OS thread
	call(pCoInitializeEx, 0, 0x2 /* COINIT_APARTMENTTHREADED */)
	icc := initCommonControlsEx{size: 8, icc: 0x20 | 0x4000 /* ICC_PROGRESS_CLASS | ICC_STANDARD_CLASSES */}
	call(pInitCommonControlsEx, uintptr(unsafe.Pointer(&icc)))

	a := &app{c: map[int]uintptr{}, labels: map[string]uintptr{}}
	theApp = a
	a.instance = call(pGetModuleHandle, 0)
	a.create()
	for _, p := range os.Args[1:] { // files/folders dropped on the .exe icon
		a.addInputs([]string{p})
	}

	var m msgT
	for {
		r := call(pGetMessage, uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if r == 0 || int32(r) == -1 {
			break
		}
		if call(pIsDialogMessage, a.hwnd, uintptr(unsafe.Pointer(&m))) != 0 {
			continue // Tab / Shift+Tab / Space between controls
		}
		call(pTranslateMessage, uintptr(unsafe.Pointer(&m)))
		call(pDispatchMessage, uintptr(unsafe.Pointer(&m)))
	}
}

func (a *app) px(v int32) int32 { return v * a.dpi / 96 }

func (a *app) create() {
	hdc := call(pGetDC, 0)
	a.dpi = int32(call(pGetDeviceCaps, hdc, logPixelsY))
	call(pReleaseDC, 0, hdc)
	if a.dpi <= 0 {
		a.dpi = 96
	}
	ncm := nonClientMetrics{}
	ncm.size = uint32(unsafe.Sizeof(ncm))
	if call(pSystemParametersInfo, spiGetNCM, uintptr(ncm.size), uintptr(unsafe.Pointer(&ncm)), 0) != 0 {
		a.font = call(pCreateFontIndirect, uintptr(unsafe.Pointer(&ncm.messageFont)))
	}

	icon := call(pLoadImage, a.instance, sptr("APP"), imageIcon, 0, 0, lrDefaultColor|lrShared)
	iconSm := call(pLoadImage, a.instance, sptr("APP"), imageIcon,
		call(pGetSystemMetrics, smCxSmIcon), call(pGetSystemMetrics, smCxSmIcon), lrDefaultColor)
	cls := wndClassEx{
		wndProc:    syscall.NewCallback(wndProc),
		instance:   a.instance,
		icon:       icon,
		iconSm:     iconSm,
		cursor:     call(pLoadCursor, 0, idcArrow),
		background: call(pGetSysColorBrush, colorBtnFace),
		className:  str("DicomAnonymizerWindow"),
	}
	cls.size = uint32(unsafe.Sizeof(cls))
	call(pRegisterClassEx, uintptr(unsafe.Pointer(&cls)))

	title := appName
	if version != "dev" {
		title += " " + version
	}
	a.hwnd = call(pCreateWindowEx, wsExControlParent|wsExAcceptFiles, sptr("DicomAnonymizerWindow"), sptr(title),
		wsOverlappedWindow, 0x80000000, 0x80000000, uintptr(a.px(760)), uintptr(a.px(720)),
		0, 0, a.instance, 0)
	a.build()
	call(pDragAcceptFiles, a.hwnd, 1)
	a.layout()
	call(pShowWindow, a.hwnd, swShow)
	call(pUpdateWindow, a.hwnd)
	a.log(anon.Info, "Drop CBCT/CT folders or DICOM files here, or use \"Add folder…\". The originals are never changed: "+
		"anonymized copies are written to the output folder.")
}

func (a *app) child(class, text string, style, exStyle uintptr, id int) uintptr {
	h := call(pCreateWindowEx, exStyle, sptr(class), sptr(text), wsChild|wsVisible|style, 0, 0, 10, 10,
		a.hwnd, uintptr(id), a.instance, 0)
	if a.font != 0 {
		sendMessage(h, wmSetFont, a.font, 1)
	}
	if id != 0 {
		a.c[id] = h
	}
	return h
}

func (a *app) label(key, text string) {
	a.labels[key] = a.child("STATIC", text, ssLeft|ssEndEllipsis, 0, 0)
}

func (a *app) button(id int, text string, def bool) {
	style := uintptr(bsPushButton)
	if def {
		style = bsDefPushButton
	}
	a.child("BUTTON", text, style|wsTabStop, 0, id)
}

func (a *app) check(id int, text string, on bool) {
	h := a.child("BUTTON", text, bsAutoCheckBox|wsTabStop, 0, id)
	if on {
		sendMessage(h, bmSetCheck, 1, 0)
	}
}

func (a *app) checked(id int) bool { return sendMessage(a.c[id], bmGetCheck, 0, 0) == 1 }

func (a *app) build() {
	o := defaultOptions()
	a.label("in", "1.  Scans to anonymize – drag folders or files into this window, or add them:")
	a.child("LISTBOX", "", lbsNotify|lbsHasStrings|lbsNoIntegralHeight|lbsExtendedSel|wsVScroll|wsHScroll|wsTabStop,
		wsExClientEdge, idList)
	a.button(idAddFolder, "Add folder…", false)
	a.button(idAddFiles, "Add files…", false)
	a.button(idRemove, "Remove", false)
	a.button(idClear, "Clear list", false)

	a.label("out", "2.  Save the anonymized copies in this folder:")
	a.child("EDIT", "", esAutoHScroll|wsTabStop, wsExClientEdge, idOut)
	a.button(idBrowseOut, "Browse…", false)

	a.label("name", "3.  New patient name:")
	a.child("EDIT", o.PatientName, esAutoHScroll|wsTabStop, wsExClientEdge, idName)
	a.label("id", "New patient ID:")
	a.child("EDIT", o.PatientID, esAutoHScroll|wsTabStop, wsExClientEdge, idID)

	a.labels["group"] = a.child("BUTTON", "Keep (everything below is removed unless ticked)", bsGroupBox, 0, 0)
	a.check(idKeepDates, "Dates and times", false)
	a.check(idKeepChars, "Sex, age, size, weight", false)
	a.check(idKeepDesc, "Study / series descriptions", false)
	a.check(idKeepInst, "Institution name and address", false)
	a.check(idKeepDevice, "Device (station, serial number)", false)
	a.check(idKeepUIDs, "Original UIDs", false)
	a.check(idKeepPrivate, "Private vendor tags (may hold names)", false)
	a.check(idRename, "Rename files and folders: Case 01\\IM000001.dcm (original names often contain the patient's name)", true)

	a.button(idStart, "Anonymize", true)
	a.button(idOpenOut, "Open output folder", false)
	call(pEnableWindow, a.c[idOpenOut], 0)
	a.child("msctls_progress32", "", pbsSmooth, 0, idProgress)
	a.child("STATIC", "", ssLeft|ssEndEllipsis, 0, idStatus)
	log := a.child("EDIT", "", esMultiline|esReadOnly|esAutoVScroll|wsVScroll|esNoHideSel|wsTabStop, wsExClientEdge, idLog)
	sendMessage(log, emSetLimit, 0, 0)
	sendMessage(a.c[idOut], emSetCueBnr, 1, sptr("e.g. D:\\Anonymized"))
}

func (a *app) move(h uintptr, x, y, w, hgt int32) {
	call(pMoveWindow, h, uintptr(x), uintptr(y), uintptr(w), uintptr(hgt), 1)
}

func (a *app) layout() {
	var r rect
	call(pGetClientRect, a.hwnd, uintptr(unsafe.Pointer(&r)))
	W, H := r.right, r.bottom
	m := a.px(12)
	gap := a.px(8)
	rowH := a.px(25)
	lblH := a.px(18)
	btnW := a.px(130)
	y := m

	a.move(a.labels["in"], m, y, W-2*m, lblH)
	y += lblH + a.px(4)
	listH := a.px(150)
	a.move(a.c[idList], m, y, W-2*m-btnW-gap, listH)
	bx := W - m - btnW
	for i, id := range []int{idAddFolder, idAddFiles, idRemove, idClear} {
		a.move(a.c[id], bx, y+int32(i)*(rowH+a.px(6)), btnW, rowH)
	}
	y += listH + a.px(12)

	a.move(a.labels["out"], m, y, W-2*m, lblH)
	y += lblH + a.px(4)
	a.move(a.c[idOut], m, y, W-2*m-btnW-gap, rowH-a.px(2))
	a.move(a.c[idBrowseOut], bx, y-a.px(1), btnW, rowH)
	y += rowH + a.px(12)

	nameLblW := a.px(140)
	a.move(a.labels["name"], m, y+a.px(4), nameLblW, lblH)
	a.move(a.c[idName], m+nameLblW, y, a.px(200), rowH-a.px(2))
	idx := m + nameLblW + a.px(200) + a.px(20)
	a.move(a.labels["id"], idx, y+a.px(4), a.px(100), lblH)
	a.move(a.c[idID], idx+a.px(100), y, a.px(150), rowH-a.px(2))
	y += rowH + a.px(10)

	// options group: three columns
	groupH := a.px(26) + 3*a.px(24) + a.px(6)
	a.move(a.labels["group"], m, y, W-2*m, groupH)
	colW := (W - 2*m - a.px(24)) / 3
	cx := m + a.px(12)
	cy := y + a.px(22)
	opts := []int{idKeepDates, idKeepChars, idKeepDesc, idKeepInst, idKeepDevice, idKeepUIDs, idKeepPrivate}
	for i, id := range opts {
		col, row := int32(i%3), int32(i/3)
		w := colW
		if id == idKeepPrivate {
			w = 2 * colW
		}
		a.move(a.c[id], cx+col*colW, cy+row*a.px(24), w-a.px(4), a.px(22))
	}
	y += groupH + a.px(8)
	a.move(a.c[idRename], m, y, W-2*m, a.px(22))
	y += a.px(22) + a.px(10)

	a.move(a.c[idStart], m, y, btnW, a.px(30))
	a.move(a.c[idOpenOut], m+btnW+gap, y, a.px(150), a.px(30))
	px := m + btnW + gap + a.px(150) + gap
	a.move(a.c[idProgress], px, y+a.px(4), W-m-px, a.px(22))
	y += a.px(30) + a.px(6)
	a.move(a.c[idStatus], m, y, W-2*m, lblH)
	y += lblH + a.px(4)
	logH := H - m - y
	if logH < a.px(40) {
		logH = a.px(40)
	}
	a.move(a.c[idLog], m, y, W-2*m, logH)
}

func wndProc(hwnd, msg, wParam, lParam uintptr) uintptr {
	a := theApp
	switch msg {
	case wmSize:
		if a != nil && a.hwnd != 0 {
			a.layout()
		}
		return 0
	case wmGetMinMaxInfo:
		if a != nil && a.dpi != 0 {
			mmi := *(**minMaxInfo)(unsafe.Pointer(&lParam)) // lParam points to a MINMAXINFO
			mmi.minTrackSize = point{a.px(640), a.px(620)}
		}
		return 0
	case wmDropFiles:
		paths := droppedFiles(wParam)
		if a.running {
			return 0
		}
		a.addInputs(paths)
		call(pSetForegroundWindow, hwnd)
		return 0
	case wmCommand:
		a.command(int(loword(wParam)), hiword(wParam))
		return 0
	case wmJobEvents:
		a.drainEvents()
		return 0
	case wmJobDone:
		a.jobFinished()
		return 0
	case wmClose:
		if a.running {
			if messageBox(hwnd, "Anonymization is still running. Stop it and quit?", mbYesNo|mbIconWarning) != idYes {
				return 0
			}
			a.closing = true
			a.job.Cancel()
			return 0 // closed when the job has stopped
		}
		call(pDestroyWindow, hwnd)
		return 0
	case wmDestroy:
		call(pPostQuitMessage, 0)
		return 0
	}
	return call(pDefWindowProc, hwnd, msg, wParam, lParam)
}

func (a *app) command(id int, code uint32) {
	if code != bnClicked && id != idList {
		return
	}
	switch id {
	case 1: // IDOK: Enter key (default button)
		a.start()
	case idAddFolder:
		a.addInputs(pickPaths(a.hwnd, true, "Choose folders with DICOM files (Ctrl+click for several)", "Add"))
	case idAddFiles:
		a.addInputs(pickPaths(a.hwnd, false, "Choose DICOM files", "Add"))
	case idRemove:
		a.removeSelected()
	case idClear:
		a.inputs = nil
		sendMessage(a.c[idList], lbResetContent, 0, 0)
	case idBrowseOut:
		if p := pickFolder(a.hwnd, "Folder for the anonymized copies"); p != "" {
			setText(a.c[idOut], p)
		}
	case idStart:
		if a.running {
			a.job.Cancel()
			setText(a.c[idStart], "Stopping…")
			call(pEnableWindow, a.c[idStart], 0)
			return
		}
		a.start()
	case idOpenOut:
		if a.lastOut != "" {
			call(pShellExecute, a.hwnd, sptr("open"), sptr(a.lastOut), 0, 0, swShowNorm)
		}
	}
}

func (a *app) addInputs(paths []string) {
	for _, p := range paths {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		p = filepath.Clean(p)
		dup := false
		for _, q := range a.inputs {
			if strings.EqualFold(q, p) {
				dup = true
			}
		}
		if dup {
			continue
		}
		info, err := os.Stat(p)
		if err != nil {
			a.log(anon.Error, fmt.Sprintf("%s: %v", p, err))
			continue
		}
		a.inputs = append(a.inputs, p)
		shown := p
		if info.IsDir() {
			shown = "[folder]  " + p
		}
		sendMessage(a.c[idList], lbAddString, 0, sptr(shown))
		sendMessage(a.c[idList], lbSetHorizExtent, uintptr(a.px(int32(9*len(shown)))), 0)
		if strings.TrimSpace(getText(a.c[idOut])) == "" {
			base := p
			if !info.IsDir() {
				base = filepath.Dir(p)
			}
			setText(a.c[idOut], filepath.Join(filepath.Dir(base), "Anonymized DICOM"))
		}
	}
}

func (a *app) removeSelected() {
	lb := a.c[idList]
	n := int(sendMessage(lb, lbGetSelCount, 0, 0))
	if n <= 0 {
		return
	}
	sel := make([]int32, n)
	sendMessage(lb, lbGetSelItems, uintptr(n), uintptr(unsafe.Pointer(&sel[0])))
	for i := n - 1; i >= 0; i-- {
		k := int(sel[i])
		if k >= 0 && k < len(a.inputs) {
			a.inputs = append(a.inputs[:k], a.inputs[k+1:]...)
			sendMessage(lb, lbDeleteString, uintptr(k), 0)
		}
	}
}

func (a *app) log(level anon.Level, text string) {
	prefix := ""
	switch level {
	case anon.Warn:
		prefix = "⚠ "
	case anon.Error:
		prefix = "✖ "
	}
	line := prefix + strings.ReplaceAll(text, "\n", "\r\n") + "\r\n"
	h := a.c[idLog]
	n := call(pGetWindowTextLength, h)
	sendMessage(h, emSetSel, n, n)
	sendMessage(h, emReplaceSel, 0, sptr(line))
}

func (a *app) setRunning(on bool) {
	a.running = on
	enable := uintptr(1)
	if on {
		enable = 0
	}
	for _, id := range []int{idList, idAddFolder, idAddFiles, idRemove, idClear, idOut, idBrowseOut, idName, idID,
		idKeepDates, idKeepChars, idKeepDesc, idKeepInst, idKeepDevice, idKeepUIDs, idKeepPrivate, idRename, idOpenOut} {
		call(pEnableWindow, a.c[id], enable)
	}
	call(pEnableWindow, a.c[idStart], 1)
	if on {
		setText(a.c[idStart], "Stop")
	} else {
		setText(a.c[idStart], "Anonymize")
	}
}

func (a *app) start() {
	if a.running {
		return
	}
	if len(a.inputs) == 0 {
		messageBox(a.hwnd, "Add the folders or files to anonymize first (drag them into the window or use \"Add folder…\").", mbOK|mbIconInfo)
		return
	}
	out := strings.TrimSpace(getText(a.c[idOut]))
	if out == "" {
		messageBox(a.hwnd, "Choose the folder for the anonymized copies (step 2).", mbOK|mbIconInfo)
		call(pSetFocus, a.c[idOut])
		return
	}
	if !filepath.IsAbs(out) {
		messageBox(a.hwnd, "Enter a full path for the output folder, e.g. D:\\Anonymized.", mbOK|mbIconInfo)
		return
	}
	o := anon.Options{
		PatientName:      strings.TrimSpace(getText(a.c[idName])),
		PatientID:        strings.TrimSpace(getText(a.c[idID])),
		KeepDates:        a.checked(idKeepDates),
		KeepPatientChars: a.checked(idKeepChars),
		KeepDescriptions: a.checked(idKeepDesc),
		KeepInstitution:  a.checked(idKeepInst),
		KeepDevice:       a.checked(idKeepDevice),
		KeepUIDs:         a.checked(idKeepUIDs),
		KeepPrivate:      a.checked(idKeepPrivate),
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		messageBox(a.hwnd, err.Error(), mbOK|mbIconError)
		return
	}
	job := &anon.Job{
		Inputs:  append([]string(nil), a.inputs...),
		OutDir:  out,
		Rename:  a.checked(idRename),
		Session: anon.NewSession(o, secret),
	}
	job.OnEvent = func(e anon.Event) {
		a.mu.Lock()
		a.events = append(a.events, e)
		post := !a.posted
		a.posted = true
		a.mu.Unlock()
		if post {
			call(pPostMessage, a.hwnd, wmJobEvents, 0, 0)
		}
	}
	a.job = job
	a.lastOut = out
	a.progress.done, a.progress.total = 0, 0
	sendMessage(a.c[idProgress], pbmSetPos, 0, 0)
	setText(a.c[idStatus], "Reading files…")
	a.log(anon.Info, "——— Anonymizing into "+out)
	a.setRunning(true)
	go func() {
		res, err := job.Run()
		a.mu.Lock()
		a.result, a.jobErr = res, err
		a.mu.Unlock()
		call(pPostMessage, a.hwnd, wmJobDone, 0, 0)
	}()
}

func (a *app) drainEvents() {
	a.mu.Lock()
	evs := a.events
	a.events = nil
	a.posted = false
	a.mu.Unlock()
	var lines []string
	flush := func() {
		if len(lines) > 0 {
			h := a.c[idLog]
			n := call(pGetWindowTextLength, h)
			sendMessage(h, emSetSel, n, n)
			sendMessage(h, emReplaceSel, 0, sptr(strings.Join(lines, "")))
			lines = lines[:0]
		}
	}
	for _, e := range evs {
		a.progress.done, a.progress.total = e.Done, e.Total
		if e.Text == "" {
			continue
		}
		prefix := ""
		switch e.Level {
		case anon.Warn:
			prefix = "⚠ "
		case anon.Error:
			prefix = "✖ "
		}
		lines = append(lines, prefix+strings.ReplaceAll(e.Text, "\n", "\r\n")+"\r\n")
	}
	flush()
	if a.progress.total > 0 {
		sendMessage(a.c[idProgress], pbmSetRange32, 0, uintptr(a.progress.total))
		sendMessage(a.c[idProgress], pbmSetPos, uintptr(a.progress.done), 0)
		setText(a.c[idStatus], fmt.Sprintf("%d of %d files", a.progress.done, a.progress.total))
	}
}

func (a *app) jobFinished() {
	a.drainEvents()
	a.mu.Lock()
	res, err := a.result, a.jobErr
	a.mu.Unlock()
	a.setRunning(false)
	if a.closing {
		call(pDestroyWindow, a.hwnd)
		return
	}
	if err != nil {
		a.log(anon.Error, err.Error())
		setText(a.c[idStatus], "Not started.")
		messageBox(a.hwnd, err.Error(), mbOK|mbIconError)
		return
	}
	if len(res.Cases) == 1 {
		a.lastOut = res.Cases[0]
	}
	call(pEnableWindow, a.c[idOpenOut], boolArg(res.Written > 0))
	status := fmt.Sprintf("Done: %d files anonymized", res.Written)
	if res.Failed > 0 {
		status += fmt.Sprintf(", %d failed (see the list below)", res.Failed)
	}
	if res.Canceled {
		status = fmt.Sprintf("Stopped: %d files anonymized", res.Written)
	}
	setText(a.c[idStatus], status+".")
	if a.progress.total > 0 && !res.Canceled {
		sendMessage(a.c[idProgress], pbmSetPos, uintptr(a.progress.total), 0)
	}
	call(pMessageBeep, mbIconInfo)
}

func boolArg(b bool) uintptr {
	if b {
		return 1
	}
	return 0
}
