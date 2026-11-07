//go:build windows

// Minimal Win32 bindings for the window (no cgo, no third-party packages).
package main

import (
	"syscall"
	"unsafe"
)

var (
	user32   = syscall.NewLazyDLL("user32.dll")
	gdi32    = syscall.NewLazyDLL("gdi32.dll")
	shell32  = syscall.NewLazyDLL("shell32.dll")
	ole32    = syscall.NewLazyDLL("ole32.dll")
	comctl32 = syscall.NewLazyDLL("comctl32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")

	pRegisterClassEx      = user32.NewProc("RegisterClassExW")
	pCreateWindowEx       = user32.NewProc("CreateWindowExW")
	pDefWindowProc        = user32.NewProc("DefWindowProcW")
	pDestroyWindow        = user32.NewProc("DestroyWindow")
	pGetMessage           = user32.NewProc("GetMessageW")
	pIsDialogMessage      = user32.NewProc("IsDialogMessageW")
	pTranslateMessage     = user32.NewProc("TranslateMessage")
	pDispatchMessage      = user32.NewProc("DispatchMessageW")
	pPostQuitMessage      = user32.NewProc("PostQuitMessage")
	pPostMessage          = user32.NewProc("PostMessageW")
	pSendMessage          = user32.NewProc("SendMessageW")
	pShowWindow           = user32.NewProc("ShowWindow")
	pUpdateWindow         = user32.NewProc("UpdateWindow")
	pMoveWindow           = user32.NewProc("MoveWindow")
	pGetClientRect        = user32.NewProc("GetClientRect")
	pEnableWindow         = user32.NewProc("EnableWindow")
	pSetWindowText        = user32.NewProc("SetWindowTextW")
	pGetWindowText        = user32.NewProc("GetWindowTextW")
	pGetWindowTextLength  = user32.NewProc("GetWindowTextLengthW")
	pLoadCursor           = user32.NewProc("LoadCursorW")
	pLoadImage            = user32.NewProc("LoadImageW")
	pMessageBox           = user32.NewProc("MessageBoxW")
	pMessageBeep          = user32.NewProc("MessageBeep")
	pGetDC                = user32.NewProc("GetDC")
	pReleaseDC            = user32.NewProc("ReleaseDC")
	pSystemParametersInfo = user32.NewProc("SystemParametersInfoW")
	pGetSysColorBrush     = user32.NewProc("GetSysColorBrush")
	pSetFocus             = user32.NewProc("SetFocus")
	pGetSystemMetrics     = user32.NewProc("GetSystemMetrics")
	pSetForegroundWindow  = user32.NewProc("SetForegroundWindow")

	pCreateFontIndirect = gdi32.NewProc("CreateFontIndirectW")
	pGetDeviceCaps      = gdi32.NewProc("GetDeviceCaps")

	pDragAcceptFiles = shell32.NewProc("DragAcceptFiles")
	pDragQueryFile   = shell32.NewProc("DragQueryFileW")
	pDragFinish      = shell32.NewProc("DragFinish")
	pShellExecute    = shell32.NewProc("ShellExecuteW")

	pCoInitializeEx   = ole32.NewProc("CoInitializeEx")
	pCoCreateInstance = ole32.NewProc("CoCreateInstance")
	pCoTaskMemFree    = ole32.NewProc("CoTaskMemFree")

	pInitCommonControlsEx = comctl32.NewProc("InitCommonControlsEx")
	pGetModuleHandle      = kernel32.NewProc("GetModuleHandleW")
)

const (
	wmCreate         = 0x0001
	wmDestroy        = 0x0002
	wmSize           = 0x0005
	wmSetText        = 0x000C
	wmClose          = 0x0010
	wmGetMinMaxInfo  = 0x0024
	wmSetFont        = 0x0030
	wmSetIcon        = 0x0080
	wmCommand        = 0x0111
	wmDropFiles      = 0x0233
	wmApp            = 0x8000
	wmCtlColorStatic = 0x0138

	wsOverlappedWindow = 0x00CF0000
	wsChild            = 0x40000000
	wsVisible          = 0x10000000
	wsTabStop          = 0x00010000
	wsGroup            = 0x00020000
	wsVScroll          = 0x00200000
	wsHScroll          = 0x00100000
	wsClipChildren     = 0x02000000
	wsExClientEdge     = 0x00000200
	wsExControlParent  = 0x00010000
	wsExAcceptFiles    = 0x00000010

	bsPushButton    = 0x0
	bsDefPushButton = 0x1
	bsAutoCheckBox  = 0x3
	bsGroupBox      = 0x7
	bmGetCheck      = 0x00F0
	bmSetCheck      = 0x00F1
	bnClicked       = 0

	esMultiline   = 0x0004
	esAutoVScroll = 0x0040
	esAutoHScroll = 0x0080
	esNoHideSel   = 0x0100
	esReadOnly    = 0x0800
	emSetSel      = 0x00B1
	emReplaceSel  = 0x00C2
	emSetLimit    = 0x00C5
	emSetCueBnr   = 0x1501

	lbsNotify           = 0x0001
	lbsHasStrings       = 0x0040
	lbsNoIntegralHeight = 0x0100
	lbsExtendedSel      = 0x0800
	lbAddString         = 0x0180
	lbDeleteString      = 0x0182
	lbResetContent      = 0x0184
	lbGetCount          = 0x018B
	lbGetSelCount       = 0x0190
	lbGetSelItems       = 0x0191
	lbSetHorizExtent    = 0x0194
	lbnSelChange        = 1

	pbmSetPos     = 0x0402
	pbmSetRange32 = 0x0406
	pbmSetMarquee = 0x040A
	pbsMarquee    = 0x08
	pbsSmooth     = 0x01

	ssLeft         = 0x0
	ssEndEllipsis  = 0x4000
	ssPathEllipsis = 0x8000

	mbOK          = 0x0
	mbYesNo       = 0x4
	mbIconError   = 0x10
	mbIconWarning = 0x30
	mbIconInfo    = 0x40
	idYes         = 6

	swShow     = 5
	swShowNorm = 1

	colorBtnFace = 15
	idcArrow     = 32512
	logPixelsY   = 90
	spiGetNCM    = 0x0029

	imageIcon      = 1
	lrDefaultColor = 0x0
	lrShared       = 0x8000
	smCxIcon       = 11
	smCxSmIcon     = 49
)

type point struct{ x, y int32 }

type rect struct{ left, top, right, bottom int32 }

type msgT struct {
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      point
	private uint32
}

type wndClassEx struct {
	size       uint32
	style      uint32
	wndProc    uintptr
	clsExtra   int32
	wndExtra   int32
	instance   uintptr
	icon       uintptr
	cursor     uintptr
	background uintptr
	menuName   *uint16
	className  *uint16
	iconSm     uintptr
}

type minMaxInfo struct {
	reserved, maxSize, maxPosition, minTrackSize, maxTrackSize point
}

type logFont struct {
	height, width, escapement, orientation, weight int32
	italic, underline, strikeOut, charSet          byte
	outPrecision, clipPrecision, quality, pitch    byte
	faceName                                       [32]uint16
}

type nonClientMetrics struct {
	size                         uint32
	borderWidth                  int32
	scrollWidth, scrollHeight    int32
	captionWidth, captionHeight  int32
	captionFont                  logFont
	smCaptionWidth, smCaptionHgt int32
	smCaptionFont                logFont
	menuWidth, menuHeight        int32
	menuFont                     logFont
	statusFont                   logFont
	messageFont                  logFont
	paddedBorderWidth            int32
}

type initCommonControlsEx struct {
	size, icc uint32
}

type guid struct {
	d1     uint32
	d2, d3 uint16
	d4     [8]byte
}

// comObject is the memory layout of every COM interface pointer: a pointer to its method table.
type comObject struct{ vtbl *[64]uintptr }

func (o *comObject) call(method int, args ...uintptr) uintptr {
	r, _, _ := syscall.SyscallN(o.vtbl[method], append([]uintptr{uintptr(unsafe.Pointer(o))}, args...)...)
	return r
}

func (o *comObject) release() { o.call(2) }

func call(p *syscall.LazyProc, args ...uintptr) uintptr {
	r, _, _ := p.Call(args...)
	return r
}

func str(s string) *uint16 {
	p, err := syscall.UTF16PtrFromString(s)
	if err != nil {
		p, _ = syscall.UTF16PtrFromString("?")
	}
	return p
}

func sptr(s string) uintptr { return uintptr(unsafe.Pointer(str(s))) }

func utf16PtrToString(p *uint16) string {
	if p == nil {
		return ""
	}
	n := 0
	for q := unsafe.Pointer(p); *(*uint16)(q) != 0; q = unsafe.Add(q, 2) {
		n++
	}
	return syscall.UTF16ToString(unsafe.Slice(p, n))
}

func sendMessage(hwnd uintptr, msg uint32, w, l uintptr) uintptr {
	return call(pSendMessage, hwnd, uintptr(msg), w, l)
}

func getText(hwnd uintptr) string {
	n := call(pGetWindowTextLength, hwnd)
	buf := make([]uint16, n+1)
	call(pGetWindowText, hwnd, uintptr(unsafe.Pointer(&buf[0])), n+1)
	return syscall.UTF16ToString(buf)
}

func setText(hwnd uintptr, s string) { call(pSetWindowText, hwnd, sptr(s)) }

func loword(x uintptr) uint32 { return uint32(x) & 0xFFFF }
func hiword(x uintptr) uint32 { return (uint32(x) >> 16) & 0xFFFF }

func messageBox(owner uintptr, text string, flags uintptr) uintptr {
	return call(pMessageBox, owner, sptr(text), sptr(appName), flags)
}

var (
	clsidFileOpenDialog = guid{0xDC1C5A9C, 0xE88A, 0x4DDE, [8]byte{0xA5, 0xA1, 0x60, 0xF8, 0x2A, 0x20, 0xAE, 0xF7}}
	iidIFileOpenDialog  = guid{0xD57C7288, 0xD4AD, 0x4768, [8]byte{0xBE, 0x02, 0x9D, 0x96, 0x95, 0x32, 0xD9, 0x60}}
)

const (
	fosPickFolders     = 0x00000020
	fosForceFileSystem = 0x00000040
	fosAllowMulti      = 0x00000200
	fosPathMustExist   = 0x00000800
	fosFileMustExist   = 0x00001000
	sigdnFileSysPath   = 0x80058000

	// IFileOpenDialog method indices (IUnknown 0-2, IModalWindow 3, IFileDialog 4-26, IFileOpenDialog 27-28)
	fdShow       = 3
	fdSetOptions = 9
	fdGetOptions = 10
	fdSetTitle   = 17
	fdSetOkLabel = 18
	fdGetResult  = 20
	fdGetResults = 27
	// IShellItemArray / IShellItem
	siaGetCount  = 7
	siaGetItemAt = 8
	siGetDisplay = 5
)

// pickPaths shows the Windows file or folder picker (several items can be selected).
func pickPaths(owner uintptr, folders bool, title, okLabel string) []string {
	var dlg *comObject
	hr := call(pCoCreateInstance, uintptr(unsafe.Pointer(&clsidFileOpenDialog)), 0, 1, /* CLSCTX_INPROC_SERVER */
		uintptr(unsafe.Pointer(&iidIFileOpenDialog)), uintptr(unsafe.Pointer(&dlg)))
	if int32(hr) < 0 || dlg == nil {
		messageBox(owner, "The Windows file dialog is not available.", mbOK|mbIconError)
		return nil
	}
	defer dlg.release()
	var opts uint32
	dlg.call(fdGetOptions, uintptr(unsafe.Pointer(&opts)))
	opts |= fosForceFileSystem | fosAllowMulti | fosPathMustExist
	if folders {
		opts |= fosPickFolders
	} else {
		opts |= fosFileMustExist
	}
	dlg.call(fdSetOptions, uintptr(opts))
	dlg.call(fdSetTitle, sptr(title))
	if okLabel != "" {
		dlg.call(fdSetOkLabel, sptr(okLabel))
	}
	if int32(dlg.call(fdShow, owner)) < 0 {
		return nil // cancelled
	}
	var items *comObject
	if int32(dlg.call(fdGetResults, uintptr(unsafe.Pointer(&items)))) < 0 || items == nil {
		return nil
	}
	defer items.release()
	var n uint32
	items.call(siaGetCount, uintptr(unsafe.Pointer(&n)))
	var paths []string
	for i := uint32(0); i < n; i++ {
		var item *comObject
		if int32(items.call(siaGetItemAt, uintptr(i), uintptr(unsafe.Pointer(&item)))) < 0 || item == nil {
			continue
		}
		var name *uint16
		if int32(item.call(siGetDisplay, sigdnFileSysPath, uintptr(unsafe.Pointer(&name)))) >= 0 && name != nil {
			paths = append(paths, utf16PtrToString(name))
			call(pCoTaskMemFree, uintptr(unsafe.Pointer(name)))
		}
		item.release()
	}
	return paths
}

// pickFolder shows the folder picker for one folder.
func pickFolder(owner uintptr, title string) string {
	var dlg *comObject
	hr := call(pCoCreateInstance, uintptr(unsafe.Pointer(&clsidFileOpenDialog)), 0, 1,
		uintptr(unsafe.Pointer(&iidIFileOpenDialog)), uintptr(unsafe.Pointer(&dlg)))
	if int32(hr) < 0 || dlg == nil {
		return ""
	}
	defer dlg.release()
	var opts uint32
	dlg.call(fdGetOptions, uintptr(unsafe.Pointer(&opts)))
	dlg.call(fdSetOptions, uintptr(opts|fosPickFolders|fosForceFileSystem|fosPathMustExist))
	dlg.call(fdSetTitle, sptr(title))
	if int32(dlg.call(fdShow, owner)) < 0 {
		return ""
	}
	var item *comObject
	if int32(dlg.call(fdGetResult, uintptr(unsafe.Pointer(&item)))) < 0 || item == nil {
		return ""
	}
	defer item.release()
	var name *uint16
	if int32(item.call(siGetDisplay, sigdnFileSysPath, uintptr(unsafe.Pointer(&name)))) < 0 || name == nil {
		return ""
	}
	defer call(pCoTaskMemFree, uintptr(unsafe.Pointer(name)))
	return utf16PtrToString(name)
}

// droppedFiles reads the paths of a WM_DROPFILES message.
func droppedFiles(hdrop uintptr) []string {
	defer call(pDragFinish, hdrop)
	n := call(pDragQueryFile, hdrop, 0xFFFFFFFF, 0, 0)
	var paths []string
	for i := uintptr(0); i < n; i++ {
		l := call(pDragQueryFile, hdrop, i, 0, 0)
		buf := make([]uint16, l+1)
		call(pDragQueryFile, hdrop, i, uintptr(unsafe.Pointer(&buf[0])), l+1)
		paths = append(paths, syscall.UTF16ToString(buf))
	}
	return paths
}
