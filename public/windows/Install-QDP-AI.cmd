<# : batch part - runs the PowerShell part below, then waits so the result can be read
@echo off
set "QDP_SELF=%~f0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "iex ([IO.File]::ReadAllText($env:QDP_SELF))"
echo.
pause
exit /b
#>

# ============================================================================
#  Quick DICOM Planning - desktop AI service (Windows)
#
#  Installs the full DentalSegmentator model in the official nnU-Net v2 on this
#  computer, as a small background service that the Quick DICOM Planning web app
#  uses for its automatic segmentation (Segments panel -> Automatic (AI) -> Run on:
#  Desktop AI service). It listens on 127.0.0.1 only: the scan never leaves this
#  computer. With an NVIDIA graphics card it runs on the card (CUDA).
#
#  For the current user only (no admin rights). Everything goes to
#  %LOCALAPPDATA%\QuickDICOMPlanning-AI (Python, PyTorch, nnU-Net, the model:
#  about 1 GB, or 3 GB with NVIDIA support). Remove it with uninstall.cmd there.
#  Running this again updates it.
#
#  Model: Dot G, et al. DentalSegmentator. Journal of Dentistry (2024),
#  doi:10.1016/j.jdent.2024.105130; weights: Zenodo doi:10.5281/zenodo.10829675
#  (CC BY 4.0). nnU-Net: Isensee F, et al. Nat Methods 2021;18:203-211.
# ============================================================================

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Site = 'https://quickdicom.app'
$Root = Join-Path $env:LOCALAPPDATA 'QuickDICOMPlanning-AI'
$Port = 47423
$ZenodoRecord = '10829675'
$ModelZip = 'Dataset112_DentalSegmentator_v100.zip'
$Name = 'QDP AI service'

function Step([string]$Msg) { Write-Host ''; Write-Host "==> $Msg" -ForegroundColor Cyan }
function Fail([string]$Msg) {
  Write-Host ''
  Write-Host "Could not install the AI service: $Msg" -ForegroundColor Red
  Write-Host "Log and files: $Root"
  exit 1
}
function Download([string]$Url, [string]$Out) {
  # curl.exe (built into Windows 10 and 11) shows the progress and resumes nothing half-done
  & curl.exe -L --fail --retry 3 --progress-bar -o $Out $Url
  if ($LASTEXITCODE -ne 0) { Fail "download failed: $Url" }
}

Write-Host ''
Write-Host '  Quick DICOM Planning - desktop AI service' -ForegroundColor White
Write-Host '  The full DentalSegmentator model (nnU-Net) for the automatic segmentation.'
Write-Host "  Installs to $Root (current user only)."

if ([Environment]::Is64BitOperatingSystem -eq $false -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
  Fail 'this needs 64-bit Windows on an Intel / AMD processor (x64).'
}
New-Item -ItemType Directory -Force -Path $Root | Out-Null
Start-Transcript -Path (Join-Path $Root 'install-log.txt') -Force | Out-Null

# --- 0. a running service is stopped first (to update it) ----------------------------
try { Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/quit" -TimeoutSec 3 | Out-Null; Start-Sleep -Seconds 2 } catch { }

# --- 1. uv: installs Python and the packages (fast, all inside $Root) -----------------
Step 'Getting uv (Python installer)'
$env:UV_PYTHON_INSTALL_DIR = Join-Path $Root 'python'
$env:UV_CACHE_DIR = Join-Path $Root 'cache'
$env:UV_NO_MODIFY_PATH = '1'
$uvDir = Join-Path $Root 'uv'
$uv = Join-Path $uvDir 'uv.exe'
if (-not (Test-Path $uv)) {
  $zip = Join-Path $Root 'uv.zip'
  Download 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip' $zip
  Expand-Archive -Path $zip -DestinationPath $uvDir -Force
  Remove-Item $zip -Force
}
if (-not (Test-Path $uv)) { Fail 'uv.exe was not found after unpacking.' }

Step 'Python 3.12'
& $uv python install 3.12
if ($LASTEXITCODE -ne 0) { Fail 'Python could not be installed.' }
$venv = Join-Path $Root 'venv'
if (-not (Test-Path (Join-Path $venv 'Scripts\python.exe'))) {
  & $uv venv --python 3.12 $venv
  if ($LASTEXITCODE -ne 0) { Fail 'the Python environment could not be created.' }
}
$py = Join-Path $venv 'Scripts\python.exe'
$pyw = Join-Path $venv 'Scripts\pythonw.exe'

# --- 2. PyTorch (with CUDA for an NVIDIA card) and nnU-Net ----------------------------
$nvidia = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'NVIDIA' })
if ($nvidia.Count -gt 0) {
  Step ("PyTorch for the NVIDIA card (" + $nvidia[0].Name + ") - about 2.5 GB, this takes a while")
  $index = 'https://download.pytorch.org/whl/cu126'
} else {
  Step 'PyTorch (no NVIDIA card found: the service will run on the CPU, which is slow)'
  $index = 'https://download.pytorch.org/whl/cpu'
}
& $uv pip install --python $py --upgrade torch --index-url $index
if ($LASTEXITCODE -ne 0) { Fail 'PyTorch could not be installed.' }
Step 'nnU-Net v2'
# (only nnU-Net itself is upgraded: --upgrade would swap the CUDA PyTorch for the plain one)
& $uv pip install --python $py --upgrade-package nnunetv2 'nnunetv2>=2.6,<2.9'
if ($LASTEXITCODE -ne 0) { Fail 'nnU-Net could not be installed.' }

# --- 3. the model (Zenodo), checked against the checksum Zenodo publishes -------------
$modelDir = Join-Path $Root 'model'
$fold = Join-Path $modelDir 'Dataset112_DentalSegmentator_v100\nnUNetTrainer__nnUNetPlans__3d_fullres\fold_0\checkpoint_final.pth'
if (-not (Test-Path $fold)) {
  Step 'The DentalSegmentator model from Zenodo (230 MB)'
  $rec = Invoke-RestMethod -Uri "https://zenodo.org/api/records/$ZenodoRecord" -TimeoutSec 60
  $file = $rec.files | Where-Object { $_.key -eq $ModelZip } | Select-Object -First 1
  if (-not $file) { Fail "$ModelZip is not in the Zenodo record $ZenodoRecord." }
  $zip = Join-Path $Root $ModelZip
  Download ("https://zenodo.org/records/$ZenodoRecord/files/" + $ModelZip + '?download=1') $zip
  $want = ($file.checksum -replace '^md5:', '').ToLower()
  $got = (Get-FileHash -Path $zip -Algorithm MD5).Hash.ToLower()
  if ($want -ne $got) { Remove-Item $zip -Force; Fail "the model download is damaged (MD5 $got, Zenodo says $want) - please run this again." }
  if (Test-Path $modelDir) { Remove-Item $modelDir -Recurse -Force }
  Expand-Archive -Path $zip -DestinationPath $modelDir -Force
  Remove-Item $zip -Force
  if (-not (Test-Path $fold)) { Fail 'the model archive does not hold the expected files.' }
}

# --- 4. the service ---------------------------------------------------------------------
Step 'The service'
$server = Join-Path $Root 'qdp_ai_server.py'
Download "$Site/windows/ai/qdp_ai_server.py" $server
# a launcher without a console window
$vbs = Join-Path $Root 'start-service.vbs'
$launcher = @"
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "$Root"
sh.Run """$pyw"" ""$server"" --model ""$(Join-Path $modelDir 'Dataset112_DentalSegmentator_v100\nnUNetTrainer__nnUNetPlans__3d_fullres')""", 0, False
"@
# (Unicode: user folders with accents or other scripts)
[IO.File]::WriteAllText($vbs, $launcher, [Text.Encoding]::Unicode)
$stop = Join-Path $Root 'stop-service.cmd'
[IO.File]::WriteAllText($stop, "@echo off`r`npowershell.exe -NoProfile -Command `"try { Invoke-RestMethod -Method Post -Uri http://127.0.0.1:$Port/quit -TimeoutSec 3 | Out-Null; 'QDP AI service stopped.' } catch { 'QDP AI service was not running.' }`"`r`ntimeout /t 3 >nul`r`n", [Text.Encoding]::ASCII)

# shortcuts: Start menu (start / stop) and starting with Windows
$wsh = New-Object -ComObject WScript.Shell
$programs = Join-Path ([Environment]::GetFolderPath('Programs')) 'Quick DICOM Planning'
New-Item -ItemType Directory -Force -Path $programs | Out-Null
function Shortcut([string]$Path, [string]$Target, [string]$Arguments, [string]$Description) {
  $l = $wsh.CreateShortcut($Path)
  $l.TargetPath = $Target
  $l.Arguments = $Arguments
  $l.WorkingDirectory = $Root
  $l.Description = $Description
  $l.Save()
}
Shortcut (Join-Path $programs "$Name.lnk") 'wscript.exe' ('"' + $vbs + '"') 'Start the QDP AI service (automatic segmentation with the full model)'
Shortcut (Join-Path $programs "Stop $Name.lnk") $stop '' 'Stop the QDP AI service'
Shortcut (Join-Path ([Environment]::GetFolderPath('Startup')) "$Name.lnk") 'wscript.exe' ('"' + $vbs + '"') 'Start the QDP AI service with Windows'

# uninstall
$uninstall = @"
@echo off
echo Removing the QDP AI service...
powershell.exe -NoProfile -Command "try { Invoke-RestMethod -Method Post -Uri http://127.0.0.1:$Port/quit -TimeoutSec 3 | Out-Null } catch { }"
timeout /t 3 >nul
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\$Name.lnk" >nul 2>&1
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Quick DICOM Planning\$Name.lnk" >nul 2>&1
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Quick DICOM Planning\Stop $Name.lnk" >nul 2>&1
rmdir "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Quick DICOM Planning" >nul 2>&1
cd /d "%TEMP%"
rmdir /s /q "%LOCALAPPDATA%\QuickDICOMPlanning-AI"
echo Done.
pause
"@
[IO.File]::WriteAllText((Join-Path $Root 'uninstall.cmd'), $uninstall.Replace("`r`n", "`n").Replace("`n", "`r`n"), [Text.Encoding]::ASCII)

# --- 5. start it and check it answers ---------------------------------------------------
Step 'Starting the service'
Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $vbs + '"')
$status = $null
for ($i = 0; $i -lt 60 -and -not $status; $i++) {
  Start-Sleep -Seconds 2
  try { $status = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/status" -TimeoutSec 3 } catch { }
}
Stop-Transcript | Out-Null
Write-Host ''
if (-not $status) {
  Write-Host 'The service was installed but did not answer yet. See log.txt in:' -ForegroundColor Yellow
  Write-Host "  $Root"
  exit 1
}
if ($status.device -eq 'cuda') {
  Write-Host ("Done - the QDP AI service runs on " + $status.gpu + ".") -ForegroundColor Green
} else {
  Write-Host 'Done - the QDP AI service runs on the CPU (no NVIDIA card was found): it works, but slowly.' -ForegroundColor Yellow
}
Write-Host ''
Write-Host '  In Quick DICOM Planning: Segments panel -> Automatic (AI) -> Run on: Desktop AI service.'
Write-Host '  The service starts with Windows; Start menu -> Quick DICOM Planning -> QDP AI service / Stop QDP AI service.'
Write-Host "  To remove it: $Root\uninstall.cmd"
