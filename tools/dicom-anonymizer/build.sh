#!/bin/sh
# Builds the portable Windows app on any OS with Go installed:
#   ./build.sh [output.exe]            (default dist/DICOM-Anonymizer.exe)
# rsrc_windows_amd64.syso (icon, manifest, version info) is checked in; it is rebuilt when MinGW windres is
# available (Debian/Ubuntu: apt install binutils-mingw-w64-x86-64).
set -e
cd "$(dirname "$0")"
out="${1:-dist/DICOM-Anonymizer.exe}"
version="${VERSION:-1.0.0}"
if command -v x86_64-w64-mingw32-windres >/dev/null 2>&1; then
  x86_64-w64-mingw32-windres --preprocessor=cpp -O coff -I winres -i winres/app.rc -o rsrc_windows_amd64.syso
fi
mkdir -p "$(dirname "$out")"
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w -H windowsgui -X main.version=$version" -o "$out" .
echo "built $out"
