#!/bin/bash
# =============================================================================
#  Quick DICOM Planning - macOS helper ("open the whole series")
#
#  A web app only receives the single file that was double-clicked. This helper
#  creates a tiny app, "Quick DICOM Planning (whole series)", that opens
#  .dcm/.dicom/.dic/.ima files: it packs all files of that folder into one
#  uncompressed bundle and opens the installed Quick DICOM Planning app with it,
#  so the whole scan opens without any prompt.
#
#  Install (Terminal):
#    curl -fsSL https://amsaleh1998-spec.github.io/Quick-DICOM-Planning/mac/install-helper.sh | bash
#  Installs for the current user only (no admin password).
#  Remove: bash ~/Library/Application\ Support/QuickDICOMPlanning/uninstall.sh
# =============================================================================

main() {
  set -u
  local NAME="Quick DICOM Planning"
  local HELPER="$NAME (whole series)"
  local BUNDLE_ID="io.github.amsaleh1998-spec.quickdicomplanning.series"
  local BASE="$HOME/Library/Application Support/QuickDICOMPlanning"
  local DEST="$HOME/Applications/$HELPER.app"
  local PB=/usr/libexec/PlistBuddy
  local LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister

  echo ""
  echo "  $NAME - macOS helper"
  echo ""

  if [ "$(uname -s)" != "Darwin" ]; then
    echo "  This helper is for macOS. On Windows use Install-QuickDICOM-Helper.cmd."
    return 1
  fi

  # --- 1. find the installed web app (Chrome / Edge / Brave / Chromium app shim) ------
  local APP="" d a
  for d in "$HOME/Applications" "/Applications"; do
    [ -d "$d" ] || continue
    while IFS= read -r -d '' a; do
      case "$a" in *"whole series"*) continue ;; esac
      APP="$a"
      break
    done < <(find "$d" -maxdepth 3 -type d -name "$NAME.app" -print0 2>/dev/null)
    [ -n "$APP" ] && break
  done
  if [ -z "$APP" ]; then
    echo "  The installed $NAME app was not found."
    echo ""
    echo "  1. Open https://amsaleh1998-spec.github.io/Quick-DICOM-Planning/ in Chrome or Edge"
    echo "     and click \"Install app\"."
    echo "  2. Run this command again."
    return 1
  fi
  echo "  Found the installed app: $APP"

  # --- 2. launcher script ---------------------------------------------------------------
  mkdir -p "$BASE" "$HOME/Applications"
  printf '%s\n' "$APP" > "$BASE/app-path.txt"
  echo "$(date '+%Y-%m-%d %H:%M:%S')  installed; app $APP" >> "$BASE/log.txt"

  cat > "$BASE/open-series.sh" <<'LAUNCHER'
#!/bin/bash
# Quick DICOM Planning - opens the whole folder of a double-clicked DICOM file.
FILE="$1"
BASE="$HOME/Library/Application Support/QuickDICOMPlanning"
LOG="$BASE/log.txt"
log() {
  if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 200000 ]; then : > "$LOG"; fi
  echo "$(date '+%Y-%m-%d %H:%M:%S')  $*" >> "$LOG"
}
log "---- double-click: $FILE"
APP="$(cat "$BASE/app-path.txt" 2>/dev/null)"
if [ -z "$APP" ] || [ ! -d "$APP" ]; then
  log "WARNING: app not found at '$APP' (reinstalled? run the installer again)"
fi
start_app() {
  log "opening with: $APP  file: $1"
  if open -a "$APP" "$1" >> "$LOG" 2>&1; then log "opened"; else log "OPEN FAILED"; fi
}
[ -n "$FILE" ] && [ -f "$FILE" ] || { log "no such file"; exit 0; }

DIR="$(dirname "$FILE")"
shopt -s nocasematch
SKIP='\.(txt|xml|ini|htm|html|pdf|jpg|jpeg|png|bmp|gif|tif|tiff|exe|dll|lnk|zip|rar|7z|db|log|json|csv|inf|bat|cmd|ps1|vbs|url|iso|stl|ply|obj|mp4|avi|doc|docx|xls|xlsx|app|dmg|pkg|sh|command)$'
NAMES=()
while IFS= read -r -d '' f; do
  n="$(basename "$f")"
  case "$n" in .*) continue ;; esac
  [[ "$n" =~ $SKIP ]] && continue
  [ -s "$f" ] || continue
  NAMES+=("$n")
done < <(find "$DIR" -maxdepth 1 -type f -print0 2>>"$LOG")
shopt -u nocasematch
log "folder: $DIR  -> ${#NAMES[@]} files"
if [ "${#NAMES[@]}" -le 1 ]; then start_app "$FILE"; exit 0; fi

# one uncompressed bundle (a ZIP named .dcm, which the app unpacks) in the temp folder
# not in the system temp folder: Chrome may refuse to let web apps read files there
OUT="$HOME/.quick-dicom-planning/bundles"
mkdir -p "$OUT"
find "$OUT" -type f -mmin +720 -delete 2>/dev/null
LEAF="$(printf '%s' "$(basename "$DIR")" | tr -c 'A-Za-z0-9._ -' '_')"
[ -n "$LEAF" ] || LEAF="series"
BUNDLE="$OUT/${LEAF}_$(date '+%Y%m%d_%H%M%S').dcm"
START=$(date +%s)
if (cd "$DIR" && zip -0 -q -X "$BUNDLE" "${NAMES[@]}") >> "$LOG" 2>&1 && [ -s "$BUNDLE" ]; then
  log "bundle: $BUNDLE  $(( $(wc -c < "$BUNDLE") / 1048576 )) MB in $(( $(date +%s) - START )) s"
  start_app "$BUNDLE"
else
  log "ERROR: could not create the bundle -> opening only the clicked file"
  rm -f "$BUNDLE"
  start_app "$FILE"
fi
LAUNCHER
  chmod +x "$BASE/open-series.sh"

  cat > "$BASE/uninstall.sh" <<UNINSTALL
#!/bin/bash
echo "Removing the $NAME macOS helper..."
"$LSREG" -u "$DEST" >/dev/null 2>&1
rm -rf "$DEST" "$BASE" "$HOME/.quick-dicom-planning"
echo "Done. DICOM files open with $NAME directly again (Finder - Get Info - Open with)."
UNINSTALL
  chmod +x "$BASE/uninstall.sh"

  # --- 3. the helper app (AppleScript droplet) -----------------------------------------
  local SRC
  SRC="$(mktemp -t qdp-helper).applescript"
  cat > "$SRC" <<'APPLESCRIPT'
on open theItems
	set f to POSIX path of (item 1 of theItems)
	set launcher to (POSIX path of (path to home folder)) & "Library/Application Support/QuickDICOMPlanning/open-series.sh"
	do shell script "nohup /bin/bash " & quoted form of launcher & " " & quoted form of f & " >/dev/null 2>&1 &"
end open

on run
	display dialog "Quick DICOM Planning (whole series)" & return & return & "Double-click a DICOM file in Finder to open its whole folder in Quick DICOM Planning." buttons {"OK"} default button 1
end run
APPLESCRIPT
  rm -rf "$DEST"
  if ! osacompile -o "$DEST" "$SRC" </dev/null; then
    echo "  Could not build the helper app (osacompile failed)."
    rm -f "$SRC"
    return 1
  fi
  rm -f "$SRC"

  local PLIST="$DEST/Contents/Info.plist"
  "$PB" -c "Delete :CFBundleIdentifier" "$PLIST" >/dev/null 2>&1
  "$PB" -c "Add :CFBundleIdentifier string $BUNDLE_ID" "$PLIST"
  "$PB" -c "Delete :CFBundleDocumentTypes" "$PLIST" >/dev/null 2>&1
  "$PB" -c "Add :CFBundleDocumentTypes array" "$PLIST"
  "$PB" -c "Add :CFBundleDocumentTypes:0 dict" "$PLIST"
  "$PB" -c "Add :CFBundleDocumentTypes:0:CFBundleTypeName string DICOM image" "$PLIST"
  "$PB" -c "Add :CFBundleDocumentTypes:0:CFBundleTypeRole string Viewer" "$PLIST"
  "$PB" -c "Add :CFBundleDocumentTypes:0:LSHandlerRank string Default" "$PLIST"
  "$PB" -c "Add :CFBundleDocumentTypes:0:CFBundleTypeExtensions array" "$PLIST"
  local i=0 e
  for e in dcm dicom dic ima; do
    "$PB" -c "Add :CFBundleDocumentTypes:0:CFBundleTypeExtensions:$i string $e" "$PLIST"
    i=$((i + 1))
  done
  "$PB" -c "Delete :LSUIElement" "$PLIST" >/dev/null 2>&1
  "$PB" -c "Add :LSUIElement bool true" "$PLIST"
  # use the web app's icon
  if [ -f "$APP/Contents/Resources/app.icns" ]; then
    cp "$APP/Contents/Resources/app.icns" "$DEST/Contents/Resources/applet.icns" 2>/dev/null
  fi
  codesign --force --deep --sign - "$DEST" >/dev/null 2>&1 || true
  "$LSREG" -f "$DEST" >/dev/null 2>&1 || true
  echo "  Created: $DEST"

  # --- 4. make it the default app for DICOM files ---------------------------------------
  local RESULT
  RESULT="$(osascript -l JavaScript - "$BUNDLE_ID" "$DEST" 2>/dev/null <<'JXA'
ObjC.import('CoreServices');
ObjC.import('AppKit');
ObjC.import('UniformTypeIdentifiers');
function run(argv) {
  const id = argv[0];
  const done = [];
  for (const ext of ['dcm', 'dicom', 'dic', 'ima']) {
    try {
      const t = $.UTType.typeWithFilenameExtension(ext);
      if (!t || t.isNil()) continue;
      $.LSSetDefaultRoleHandlerForContentType(t.identifier, 0xffffffff, $(id));
      done.push(ext);
    } catch (e) {}
  }
  try {
    const u = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenContentType($.UTType.typeWithFilenameExtension('dcm'));
    return (u && !u.isNil()) ? ObjC.unwrap(u.path) : '';
  } catch (e) { return ''; }
}
JXA
)" || RESULT=""

  echo ""
  if [ "$RESULT" = "$DEST" ]; then
    echo "  Installed. Double-clicking a DICOM file now opens the whole series."
  else
    echo "  Installed. LAST STEP (once):"
    echo "    In Finder select any .dcm file - File - Get Info (Cmd+I) - \"Open with\":"
    echo "    choose \"$HELPER\" and click \"Change All...\""
  fi
  echo ""
  echo "  The first time, macOS may ask to let the helper access a folder (Documents,"
  echo "  Desktop, Dropbox ...). Click Allow so it can read the other files of the scan."
  echo "  Log: $BASE/log.txt"
  echo "  Remove: bash \"$BASE/uninstall.sh\""
  echo ""
}

main "$@"
