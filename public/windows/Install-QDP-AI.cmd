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
#  computer, as a small service that the Quick DICOM Planning web app uses for its
#  automatic segmentation (Segments panel -> Automatic (AI) -> Run on: Desktop AI
#  service). It listens on 127.0.0.1 only: the scan never leaves this computer.
#  With an NVIDIA graphics card it runs on the card (CUDA).
#
#  It runs only while it is needed: the app starts it when you segment (through a
#  qdp-ai: link registered here - the browser asks once whether it may open it),
#  and it closes itself when the segmentation is done, freeing the graphics card.
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

# --- 2. PyTorch: a build that really runs on this computer's NVIDIA card, else the CPU ---
# PyTorch's CUDA builds each cover a range of card generations (compute capability): the newest
# cards (RTX 50 series, 12.x) need CUDA 12.8 or later, the oldest (GTX 900 / 1000, 5.x - 6.x) 12.6
# or earlier. Each candidate is checked by running a small 3D network on the card.
$check = Join-Path $Root 'gpu_check.py'
[IO.File]::WriteAllText($check, @'
import sys
try:
    import torch
    assert torch.cuda.is_available(), 'PyTorch ' + torch.__version__ + ' sees no CUDA card'
    d = torch.device('cuda')
    F = torch.nn.functional
    x = torch.randn(1, 1, 24, 24, 24, device=d)
    y = F.leaky_relu(F.instance_norm(F.conv3d(x, torch.randn(4, 1, 3, 3, 3, device=d), padding=1)))
    y = F.conv_transpose3d(y, torch.randn(4, 2, 2, 2, 2, device=d), stride=2)
    with torch.autocast('cuda'):
        z = F.conv3d(x, torch.randn(4, 1, 3, 3, 3, device=d), padding=1)
    float(y.sum()) + float(z.float().sum())
    torch.cuda.synchronize()
    print('OK - PyTorch', torch.__version__, 'runs on', torch.cuda.get_device_name(0))
except Exception as e:
    print('FAIL -', type(e).__name__ + ':', (str(e).splitlines() or [''])[0][:200])
    sys.exit(1)
'@, [Text.Encoding]::ASCII)
function Gpu-Ok {
  $ErrorActionPreference = 'Continue'
  $out = & $py $check
  $ok = ($LASTEXITCODE -eq 0)
  Write-Host ('    ' + ($out | Select-Object -Last 1)) -ForegroundColor $(if ($ok) { 'Green' } else { 'Yellow' })
  return $ok
}
$gpuName = ''; $cc = 0.0; $driver = ''
try {
  $ErrorActionPreference = 'Continue'
  $smi = & nvidia-smi --query-gpu=name,compute_cap,driver_version --format=csv,noheader | Select-Object -First 1
  if ($smi) {
    $f = $smi -split ',\s*'
    $gpuName = $f[0]
    if ($f.Count -ge 2) { [double]::TryParse($f[1], [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$cc) | Out-Null }
    if ($f.Count -ge 3) { $driver = $f[2] }
  }
} catch { } finally { $ErrorActionPreference = 'Stop' }
if (-not $gpuName) {
  $nvidia = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'NVIDIA' })
  if ($nvidia.Count -gt 0) { $gpuName = $nvidia[0].Name }
}
$cudaOk = $false
if ($gpuName) {
  if ($cc -ge 12) { $builds = @('cu130', 'cu129', 'cu128', 'cu132') }
  elseif ($cc -ge 7.5) { $builds = @('cu128', 'cu126', 'cu129', 'cu130') }
  elseif ($cc -ge 5) { $builds = @('cu126', 'cu118') }
  else { $builds = @('cu128', 'cu126', 'cu130', 'cu118') }
  $about = ''
  if ($cc -gt 0) { $about = " (compute capability $cc" + $(if ($driver) { ", driver $driver" } else { '' }) + ')' }
  Step ("PyTorch for the NVIDIA card $gpuName$about - about 2.5 GB, this takes a while")
  # the PyTorch installed before may already run on it
  if (Test-Path (Join-Path $venv 'Lib\site-packages\torch')) {
    Write-Host '  checking the PyTorch already installed...'
    if (Gpu-Ok) { $cudaOk = $true }
  }
  foreach ($b in $builds) {
    if ($cudaOk) { break }
    Write-Host "  PyTorch build $b..."
    & $uv pip install --python $py --reinstall-package torch torch --index-url "https://download.pytorch.org/whl/$b"
    if ($LASTEXITCODE -ne 0) { Write-Host "    ($b is not available)"; continue }
    if (Gpu-Ok) { $cudaOk = $true }
  }
  if (-not $cudaOk) {
    Write-Host '  No PyTorch build runs on this card - the service will use the CPU (slow). Updating the NVIDIA driver and running this again may help.' -ForegroundColor Yellow
  }
} else {
  Step 'PyTorch (no NVIDIA card found: the service will run on the CPU, which is slow)'
}
if (-not $cudaOk) {
  & $uv pip install --python $py --reinstall-package torch torch --index-url 'https://download.pytorch.org/whl/cpu'
  if ($LASTEXITCODE -ne 0) { Fail 'PyTorch could not be installed.' }
}
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
# started directly with pythonw.exe (Python without a console window) - no launcher script between
$serviceArgs = '"' + $server + '" --model "' + (Join-Path $modelDir 'Dataset112_DentalSegmentator_v100\nnUNetTrainer__nnUNetPlans__3d_fullres') + '"'
Remove-Item (Join-Path $Root 'start-service.vbs') -Force -ErrorAction SilentlyContinue
# the app starts it when it is needed: a qdp-ai: link (current user; the link's text is not passed on)
$proto = 'HKCU:\Software\Classes\qdp-ai'
New-Item -Path "$proto\shell\open\command" -Force | Out-Null
Set-Item -Path $proto -Value 'URL:QDP AI service'
New-ItemProperty -Path $proto -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
Set-Item -Path "$proto\shell\open\command" -Value ('"' + $pyw + '" ' + $serviceArgs)
$stop = Join-Path $Root 'stop-service.cmd'
[IO.File]::WriteAllText($stop, "@echo off`r`npowershell.exe -NoProfile -Command `"try { Invoke-RestMethod -Method Post -Uri http://127.0.0.1:$Port/quit -TimeoutSec 3 | Out-Null; 'QDP AI service stopped.' } catch { 'QDP AI service was not running.' }`"`r`ntimeout /t 3 >nul`r`n", [Text.Encoding]::ASCII)

# Start menu: stop it (it closes itself after a segmentation anyway). It no longer starts with
# Windows, and is no longer started from the Start menu (the app starts it): older shortcuts go.
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
Shortcut (Join-Path $programs "Stop $Name.lnk") $stop '' 'Stop the QDP AI service'
Remove-Item (Join-Path $programs "$Name.lnk") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path ([Environment]::GetFolderPath('Startup')) "$Name.lnk") -Force -ErrorAction SilentlyContinue

# uninstall
$uninstall = @"
@echo off
echo Removing the QDP AI service...
powershell.exe -NoProfile -Command "try { Invoke-RestMethod -Method Post -Uri http://127.0.0.1:$Port/quit -TimeoutSec 3 | Out-Null } catch { }"
timeout /t 3 >nul
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\$Name.lnk" >nul 2>&1
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Quick DICOM Planning\$Name.lnk" >nul 2>&1
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Quick DICOM Planning\Stop $Name.lnk" >nul 2>&1
reg delete "HKCU\Software\Classes\qdp-ai" /f >nul 2>&1
rmdir "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Quick DICOM Planning" >nul 2>&1
cd /d "%TEMP%"
rmdir /s /q "%LOCALAPPDATA%\QuickDICOMPlanning-AI"
echo Done.
pause
"@
[IO.File]::WriteAllText((Join-Path $Root 'uninstall.cmd'), $uninstall.Replace("`r`n", "`n").Replace("`n", "`r`n"), [Text.Encoding]::ASCII)

# --- 5. start it once to check it, then stop it (the app starts it when it is needed) ----
Step 'Checking the service'
Start-Process -FilePath $pyw -ArgumentList $serviceArgs -WorkingDirectory $Root
$status = $null
for ($i = 0; $i -lt 90 -and (-not $status -or $status.device -eq 'starting'); $i++) {
  Start-Sleep -Seconds 2
  try { $status = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/status" -TimeoutSec 5 } catch { }
}
try { Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/quit" -TimeoutSec 3 | Out-Null } catch { }
Stop-Transcript | Out-Null
Write-Host ''
if (-not $status) {
  Write-Host 'The service was installed but did not answer. See log.txt in:' -ForegroundColor Yellow
  Write-Host "  $Root"
  exit 1
}
if ($status.device -eq 'cuda') {
  Write-Host ("Done - the QDP AI service runs on " + $status.gpu + ".") -ForegroundColor Green
} elseif ($status.gpuError) {
  Write-Host ("Done - but the graphics card " + $status.gpu + " cannot run the model (" + $status.gpuError + "): the service runs on the CPU, slowly. Updating the NVIDIA driver and running this again may help.") -ForegroundColor Yellow
} else {
  Write-Host 'Done - the QDP AI service runs on the CPU (no NVIDIA card was found): it works, but slowly.' -ForegroundColor Yellow
}
Write-Host ''
Write-Host '  In Quick DICOM Planning: Segments panel -> Automatic (AI) -> Run on: Desktop AI service.'
Write-Host '  It is not running now: the app starts it when you segment (the browser asks once whether it may'
Write-Host '  open it - shown as Python: allow it), and it closes itself when the segmentation is done.'
Write-Host "  To remove it: $Root\uninstall.cmd"
